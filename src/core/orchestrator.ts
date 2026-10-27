import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Forge } from '../adapters/forge/types.js';
import type { RunHandle, RunResult, Runner } from '../adapters/runner/types.js';
import { ActivityRelay } from '../adapters/tracker/activity-relay.js';
import type { Tracker } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { JobSpec, Workflow } from '../config/workflow-schema.js';
import { Worker } from '../runtime/worker.js';
import { workflowVersion } from '../runtime/workflow-version.js';
import type { DecisionOutcome, DecisionPlan, DecisionRequest, OutboxRow, RunRecord, Store, WorkflowVersion } from '../store/types.js';
import type { EventBus } from './bus.js';
import type { Clock } from './clock.js';
import type { Effect, OutboxEffect } from './decision.js';
import { decide, isFenced, refusesDevWork } from './engine.js';
import { pickupFailures } from './pickup.js';
import { buildPrompt, formatFeedback, formatVerifyFailures } from './prompt.js';
import { reduce } from './reduce.js';
import type { StoredEvent } from './upcast.js';
import type { Scheduler } from './scheduler.js';
import {
  CREATES_TICKET,
  type EventPayloads,
  type EventType,
  type InputKind,
  type InternalEvent,
  type IssueSnapshot,
  type LogicalState,
  type QueueName,
  type FactoryEvent,
  type TicketState,
  type VerifyFailure,
  TRUSTED,
} from './types.js';
import type { Verifier } from './verify.js';
import { PRODUCT_NAME } from '../product.js';

export interface ProjectRuntime {
  id: string;
  repoPath: string;
  teamKey: string;
  workflow: Workflow;
}

export interface OrchestratorDeps {
  store: Store;
  clock: Clock;
  bus: EventBus;
  scheduler: Scheduler;
  tracker: Tracker;
  forge: Forge;
  runner: Runner;
  workspaces: WorkspaceManager;
  verify: Verifier;
  projects: ProjectRuntime[];
  packDir: string;
  /** `--settings` file for runs; defaults to <packDir>/settings.json. */
  settingsPath?: string;
  agentEnv: (run: RunRecord) => Record<string, string>;
  dailyBudgetUsd?: number;
  newId?: () => string;
  activityIntervalMs?: number;
  beforeRun?: (run: RunRecord) => Promise<void>;
  /** False when no knowledge repo is configured: `knowledge` jobs (learn, remember) are then skipped. Default true. */
  knowledgeConfigured?: boolean;
  /**
   * Retries of the inbox write of a run or check result (ORC-147): `attempts` writes in all, the
   * n-th retry after `baseMs * 2^(n-1)`. Default 5 writes from 200 ms (about 3 s in all).
   */
  inboxRetry?: { attempts: number; baseMs: number };
  /**
   * The daemon's start: events accepted before `replayInbox()` are only written, not processed,
   * so the inbox is not dispatched before the tracker is connected. Default false (tests).
   */
  holdInboxUntilReplay?: boolean;
  /** Lease of a claimed outbox row (ORC-149); default 60 s, renewed every 20 s while the effect runs. */
  effectLeaseMs?: number;
  /** Retries of an inbox row whose processing throws (ORC-149); default `PROCESS_RETRY`. */
  processRetry?: { attempts: number; baseMs: number };
}

interface StartOpts {
  job: string;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
  /** A queued item's place in its queue, kept when it goes back there. */
  enqueuedAt?: number;
}

/** Events after which `handle` settles the ticket: the pending job starts once nothing is in flight. */
export const SETTLES_RUN: ReadonlySet<EventType> = new Set<EventType>(['run.finished', 'verify.passed', 'verify.failed']);
const ECHO_MS = 60_000;

export function logicalFromName(states: Record<LogicalState, string>, name: string): LogicalState | undefined {
  return (Object.entries(states) as [LogicalState, string][]).find(([, n]) => n === name)?.[0];
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

type RecoveryNotice = ({ ticket: { projectId: string; ticketId: string } } | { sessionId: string }) & {
  type: 'elicitation' | 'error';
  body: string;
};

export class Orchestrator {
  private background = new Map<Promise<void>, string | undefined>();
  /** Runs whose event stream is still open (the runner is working, nothing for the factory to do): drained() does not wait for them. */
  private liveRuns = new Set<string>();
  private handles = new Map<string, RunHandle>();
  private stopping = false;
  /** French notices for Linear, collected by recover() and posted once Linear is reachable. */
  private recoveryNotices: RecoveryNotice[] = [];
  private newId: () => string;
  /** Inbox writes in flight (accept). */
  private writes = new Set<Promise<void>>();
  /** False until `replayInbox()` when `holdInboxUntilReplay` is set: `accept` then only writes. */
  private dispatchOpen: boolean;
  /** The inbox worker (ORC-149): one task per ticket, a decision transaction per event. */
  private readonly worker: Worker;
  /** Versions of the projects' workflows, by workflow object. */
  private versionOfWorkflow = new WeakMap<Workflow, WorkflowVersion>();
  /** Workflows by version hash: the current ones and those tickets are frozen on. */
  private workflows = new Map<string, Workflow>();
  /** Dequeued items whose start has not taken its slot yet, per queue: drain hands out no more than the free slots. */
  private admitting: Record<QueueName, number> = { dev: 0, questions: 0 };
  /** Drains run one at a time. */
  private draining: Promise<void> = Promise.resolve();

  constructor(private d: OrchestratorDeps) {
    this.newId = d.newId ?? randomUUID;
    this.dispatchOpen = !d.holdInboxUntilReplay;
    this.worker = new Worker({
      store: d.store,
      log: (level, message) => this.log(level, message),
      prepare: (event) => this.withSnapshot(event),
      request: (event) => this.request(event),
      committed: (event, outcome) => this.committed(event, outcome),
      execute: (row) => this.execute(row),
      effectFailed: (row, err) => this.effectFailed(row, err),
      leaseMs: d.effectLeaseMs,
      retry: d.processRetry,
      left: (row) => void this.freeSlot(row),
    });
  }

  /**
   * The one way in for an event (ORC-147): writes it to the inbox and resolves once the row is
   * committed, then lets the worker process it from the inbox. Resolves `false` for an id the
   * inbox already holds (a duplicate: nothing more happens). Rejects when the write fails: the
   * event was not taken, and the producer must report it (a webhook answers 500).
   */
  accept(event: FactoryEvent | StoredEvent): Promise<boolean> {
    const write = this.d.store.appendInbox(event).then((fresh) => {
      if (fresh && this.dispatchOpen) this.worker.kickInBackground();
      return fresh;
    });
    // drained() waits for writes in flight too: their event is about to be processed.
    const tracked: Promise<void> = write.then(
      () => void this.writes.delete(tracked),
      () => void this.writes.delete(tracked),
    );
    this.writes.add(tracked);
    return write;
  }


  /**
   * Processes the inbox rows and outbox effects a previous process left (written, then a crash or
   * a failed processing), oldest first. `factory up` calls it once at start, after `recover()`,
   * through `startWorker`.
   */
  async replayInbox(): Promise<void> {
    this.dispatchOpen = true;
    await this.worker.kick();
  }

  /** `replayInbox`, then polls the store: rows written by another process, leases that expired. */
  startWorker(intervalMs = 1000): Promise<void> {
    this.worker.start(intervalMs);
    return this.replayInbox();
  }

  /**
   * For the results the orchestrator produces itself (run finished, checks): nobody resends them,
   * so a failed inbox write is retried with a bounded backoff before giving up with an error (the
   * run's slot is then held until `recover()` at the next start).
   */
  private async submitResult(event: FactoryEvent): Promise<void> {
    const { attempts, baseMs } = this.d.inboxRetry ?? { attempts: 5, baseMs: 200 };
    for (let n = 1; ; n++) {
      try {
        await this.accept(event);
        return;
      } catch (err) {
        if (n >= attempts) {
          this.log('error', `event ${event.id} (${event.type}) not written to the inbox after ${n} attempts, lost: ${(err as Error).message}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (n - 1)));
      }
    }
  }

  /**
   * Waits until this process has nothing left to do with the inbox and the outbox (ORC-149, in
   * place of the event chain's `idle()`): no inbox write in flight, no pending row or claimable
   * effect it can still process, no worker task running, and no background work (checks, the end
   * of a run) about to write to the inbox. Runs still streaming are not waited for. Rows this
   * process skipped (a failed processing) or left to another worker do not count.
   */
  async drained(): Promise<void> {
    for (;;) {
      // Note: setImmediate is incompatible with fake timers (vi.useFakeTimers fakes it by default).
      // Let promise continuations of a just-released/finished runner settle before sampling the state.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(this.writes);
      // After stopAll(), only what is already handed out (or accepted here) is finished: a daemon
      // shutting down does not take up the rows another process left.
      const handed = this.stopping || !this.dispatchOpen ? 0 : await this.worker.kick();
      await this.worker.settle();
      const pending = this.pendingBackground();
      await Promise.all(pending);
      if (handed === 0 && pending.length === 0 && this.writes.size === 0 && this.pendingBackground().length === 0) return;
    }
  }

  private pendingBackground(): Promise<void>[] {
    return [...this.background].filter(([, runId]) => runId === undefined || !this.liveRuns.has(runId)).map(([p]) => p);
  }

  /**
   * Settles runs cut by a crash (`running`) or a shutdown (`interrupted`) and blocks their tickets.
   * The matching Linear notices are posted by announceRecovery().
   *
   * A run or check whose result is in the inbox, written before the crash and not yet processed,
   * is left alone: the inbox replay settles it with its real result, which a block would fence.
   */
  async recover(): Promise<void> {
    const { store } = this.d;
    const finished = new Set<string>();
    const checked = new Set<string>();
    for (const row of await store.pendingInbox(Number.MAX_SAFE_INTEGER)) {
      if (row.type === 'run.finished') finished.add((row.payload as EventPayloads['run.finished']).runId);
      if (row.type === 'verify.passed' || row.type === 'verify.failed') checked.add((row.payload as EventPayloads['verify.passed']).runId);
    }
    const block = (t: TicketState, reason: string): Promise<TicketState> => {
      this.recoveryNotices.push({ ticket: { projectId: t.projectId, ticketId: t.ticketId }, type: 'elicitation', body: reason });
      return this.apply(t, { type: 'run.interrupted', reason });
    };
    const cut = [...(await store.runsByStatus('running')), ...(await store.runsByStatus('interrupted'))];
    for (const run of cut) {
      await store.putRun({ ...run, status: run.status === 'interrupted' ? 'stopped' : 'failure', endedAt: run.endedAt ?? this.d.clock.now() });
      if (run.queue === 'questions' && run.linearSessionId) {
        this.recoveryNotices.push({
          sessionId: run.linearSessionId,
          type: 'error',
          body: `${PRODUCT_NAME} a redémarré pendant ma réponse. Reposez la question dans ce fil.`,
        });
      }
    }
    for (let t of await store.listTickets()) {
      if (t.activeRunId && !finished.has(t.activeRunId)) {
        const r = await store.getRun(t.activeRunId);
        if (!r || r.status !== 'running') t = await block(t, `${PRODUCT_NAME} a redémarré pendant le run. Répondez dans le fil pour relancer.`);
      }
      if (t.verifyingRunId && !checked.has(t.verifyingRunId)) await block(t, `${PRODUCT_NAME} a redémarré pendant les vérifications. Répondez dans le fil pour relancer.`);
    }
  }

  /**
   * Blocks a ticket from outside an event (the agent's question through /agent/ask). It runs in
   * the ticket's worker task, so its read-modify-write never interleaves with a decision's, and
   * after the events accepted before it (their inbox write in flight included).
   */
  async blockTicket(projectId: string, ticketId: string, reason: string): Promise<void> {
    await Promise.all(this.writes);
    await this.worker.kick();
    await this.worker.exclusive({ projectId, ticketId }, async () => {
      const t = await this.d.store.getTicket(projectId, ticketId);
      if (t) await this.apply(t, { type: 'ticket.blocked', reason });
    });
  }

  /** Best effort: posts the notices collected by recover(); a failure is logged, never retried. */
  async announceRecovery(): Promise<void> {
    const notices = this.recoveryNotices;
    this.recoveryNotices = [];
    for (const n of notices) {
      const post = async () => {
        let session: string;
        if ('sessionId' in n) session = n.sessionId;
        else {
          const t = await this.d.store.getTicket(n.ticket.projectId, n.ticket.ticketId);
          if (!t) return;
          session = await this.sessionFor(t);
        }
        await this.d.tracker.activity(session, { type: n.type, body: n.body });
      };
      try {
        await ('sessionId' in n ? post() : this.worker.exclusive(n.ticket, post));
      } catch (err) {
        this.log('warn', `recovery notice not posted: ${(err as Error).message}`);
      }
    }
  }

  async tick(): Promise<void> {
    try {
      await this.drain('dev');
      await this.drain('questions');
    } catch (err) {
      this.log('error', `tick: ${(err as Error).message}`);
    }
  }

  stopAll(): void {
    this.stopping = true;
    this.worker.stop();
    for (const h of this.handles.values()) h.stop();
    // Stopped runs are no longer "live": drained() must wait for their pumps to persist the final status.
    this.liveRuns.clear();
  }

  project(id: string): ProjectRuntime {
    const p = this.d.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    return p;
  }

  async isPaused(): Promise<boolean> {
    return (await this.d.store.getMeta('paused')) === '1';
  }

  private async overBudget(): Promise<boolean> {
    const budget = this.d.dailyBudgetUsd;
    return budget !== undefined && (await this.d.store.costSince(startOfUtcDay(this.d.clock.now()))) >= budget;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.d.bus.publish({ kind: 'log', level, message, at: this.d.clock.now() });
  }

  private track(p: Promise<void>, runId?: string): void {
    const wrapped = p.catch((err: unknown) => this.log('error', (err as Error).message)).finally(() => this.background.delete(wrapped));
    this.background.set(wrapped, runId);
  }

  /**
   * The only way the orchestrator changes a ticket outside a decision (an effect recording what it
   * did): through `reduce`, on the projection read again under the ticket's lock.
   */
  private async apply(t: TicketState, ...events: InternalEvent[]): Promise<TicketState> {
    const now = this.d.clock.now();
    const step = (from: TicketState): TicketState => {
      let next = from;
      for (const e of events) next = reduce(next, e)!;
      return { ...next, updatedAt: now };
    };
    let next = await this.d.store.updateTicket(t.projectId, t.ticketId, step);
    if (!next) {
      next = step(t);
      await this.d.store.putTicket(next);
    }
    this.d.bus.publish({ kind: 'ticket', ticket: next });
    return next;
  }

  /** The version of a project's workflow now: a ticket's first decision freezes it (ORC-149). */
  private currentVersion(project: ProjectRuntime): WorkflowVersion {
    let v = this.versionOfWorkflow.get(project.workflow);
    if (!v) {
      v = workflowVersion(project.workflow);
      this.versionOfWorkflow.set(project.workflow, v);
      this.workflows.set(v.hash, project.workflow);
    }
    return v;
  }

  private workflowOf(version: WorkflowVersion): Workflow {
    let wf = this.workflows.get(version.hash);
    if (!wf) {
      wf = version.definition as Workflow;
      this.workflows.set(version.hash, wf);
    }
    return wf;
  }

  /** The project as a ticket sees it: with the workflow version the ticket is frozen on. */
  private async runtimeFor(projectId: string, ticketId: string | undefined): Promise<ProjectRuntime | undefined> {
    const project = projectId === '*' ? this.d.projects[0] : this.project(projectId);
    if (!project || !ticketId) return project;
    const hash = (await this.d.store.getTicket(project.id, ticketId))?.workflowHash;
    if (!hash || hash === this.currentVersion(project).hash) return project;
    let workflow = this.workflows.get(hash);
    if (!workflow) {
      const stored = await this.d.store.getWorkflowVersion(hash);
      if (!stored) throw new Error(`workflow version ${hash} of ${ticketId} is not stored`);
      workflow = this.workflowOf(stored);
    }
    return { ...project, workflow };
  }

  private async ticket(projectId: string, ticketId: string): Promise<TicketState> {
    const t = await this.d.store.getTicket(projectId, ticketId);
    if (!t) throw new Error(`unknown ticket ${ticketId}`);
    return t;
  }

  /**
   * An event that starts tracking a ticket must carry its snapshot, so that `decide` and a replay of the
   * journal never read the tracker. A producer that could not fill it gets it filled here, before journaling.
   */
  private async withSnapshot(event: FactoryEvent): Promise<FactoryEvent> {
    if (event.projectId === '*' || !event.ticketId || !CREATES_TICKET.has(event.type)) return event;
    const payload = event.payload as { issue?: IssueSnapshot };
    if (payload.issue || (await this.d.store.getTicket(event.projectId, event.ticketId))) return event;
    const project = this.project(event.projectId);
    const issue = await this.d.tracker.getIssue(event.ticketId);
    const logical = logicalFromName(project.workflow.states, issue.stateName) ?? 'todo';
    return { ...event, payload: { ...payload, issue: { title: issue.title, logical, priority: issue.priority } } } as FactoryEvent;
  }

  /** The decision transaction of an event (ORC-149): `decide` runs in the store, under the ticket's lock. */
  private request(event: FactoryEvent): DecisionRequest {
    const project = event.projectId === '*' ? this.d.projects[0] : this.project(event.projectId);
    const now = this.d.clock.now();
    const none: DecisionPlan = { effects: [], timers: [], clearTimers: false };
    if (!project) return { event, workflow: { hash: '', definition: null }, decide: () => none };
    return {
      event,
      workflow: this.currentVersion(project),
      decide: (known, version) => {
        const workflow = this.workflowOf(version);
        if (event.projectId === '*') return { ...none, effects: decide(undefined, event, workflow).effects };
        if (!known && event.ticketId && !CREATES_TICKET.has(event.type)) {
          return { ...none, note: `ignored ${event.type} for unmanaged ticket ${event.ticketId}` };
        }
        const decision = decide(known, event, workflow);
        let next = reduce(known, event);
        for (const e of decision.events) next = reduce(next, e);
        const ticket = next && { ...next, updatedAt: now, workflowHash: version.hash };
        const effects: OutboxEffect[] = [...decision.effects];
        // After the effects, as before: start the ticket's pending job, then drain the queues.
        if (ticket && SETTLES_RUN.has(event.type)) effects.push({ kind: 'settle' });
        return {
          ticket,
          effects,
          timers: ticket
            ? decision.timers.map((t) => ({
                key: `${ticket.ticketId}:${t.job}`,
                projectId: project.id,
                ticketId: ticket.ticketId,
                job: t.job,
                fireAt: now + t.ms,
                armedBy: event.id,
              }))
            : [],
          // A stop deletes the ticket's timers before this decision arms its own, as `stop_run` did.
          clearTimers: decision.effects.some((c) => c.kind === 'stop_run' && !c.linearSessionId),
          note: isFenced(decision) ? `ignored stale ${event.type} for ${event.ticketId ?? '*'}: ${decision.trace[0]}` : undefined,
        };
      },
    };
  }

  /**
   * A run result left for the next start (behind a failed event, or failing itself past its last
   * retry) still frees its run's slot: otherwise, slot after slot, it would stop every launch until
   * a restart. The slots are in memory, so the replay at the next start frees nothing twice.
   */
  private async freeSlot(row: StoredEvent): Promise<void> {
    if (row.type !== 'run.finished') return;
    const run = await this.d.store.getRun((row.payload as EventPayloads['run.finished']).runId).catch(() => undefined);
    if (run) this.d.scheduler.release(`${run.ticketId}:${run.queue}`);
  }

  /** After the commit, before the effects. */
  private async committed(event: FactoryEvent, outcome: Extract<DecisionOutcome, { status: 'committed' }>): Promise<void> {
    const { bus, scheduler } = this.d;
    // First, and without a store read: a finished run's slot is freed whatever follows.
    if (event.type === 'run.finished' && outcome.known && event.ticketId) {
      const hash = outcome.known.workflowHash;
      const workflow = (hash && this.workflows.get(hash)) || this.project(event.projectId).workflow;
      const queue = workflow.jobs[event.payload.job]?.queue;
      if (queue) scheduler.release(`${event.ticketId}:${queue}`);
    }
    bus.publish({ kind: 'event', event });
    if (outcome.plan.note) this.log('info', outcome.plan.note);
    if (outcome.plan.ticket) bus.publish({ kind: 'ticket', ticket: outcome.plan.ticket });
  }

  /** Executes one outbox row of a decision, after its commit (the executors of ORC-150 take this over). */
  private async execute(row: OutboxRow): Promise<void> {
    const project = await this.runtimeFor(row.projectId, row.ticketId);
    if (!project) return;
    const effect = row.effect;
    if (effect.kind === 'settle') {
      if (row.ticketId) await this.settle(project, row.ticketId);
      return;
    }
    this.d.bus.publish({ kind: 'command', projectId: project.id, ticketId: row.ticketId, command: effect });
    await this.exec(project, row.ticketId, effect);
  }

  /**
   * An effect threw: the worker skips the decision's later effects, and the ticket is blocked with
   * the error. The timers the decision armed go too, as when they were armed after the effects.
   */
  private async effectFailed(row: OutboxRow, err: Error): Promise<void> {
    const { store } = this.d;
    this.log('error', `command ${row.effect.kind} for ${row.ticketId ?? '*'}: ${err.message}`);
    if (!row.ticketId || row.effect.kind === 'settle') return;
    await store.deleteTimersArmedBy(row.eventId);
    const project = await this.runtimeFor(row.projectId, row.ticketId);
    if (project) await this.failTicket(project, row.ticketId, `Erreur : ${err.message}`);
  }

  private async failTicket(project: ProjectRuntime, ticketId: string, reason: string): Promise<void> {
    const found = await this.d.store.getTicket(project.id, ticketId);
    if (!found) return;
    const t = await this.apply(found, { type: 'ticket.blocked', reason });
    try {
      const session = await this.sessionFor(t);
      await this.d.tracker.activity(session, { type: 'error', body: reason });
    } catch (err) {
      this.log('warn', `could not post error activity for ${ticketId}: ${(err as Error).message}`);
    }
  }

  private async settle(project: ProjectRuntime, ticketId: string): Promise<void> {
    const t = await this.ticket(project.id, ticketId);
    if (!t.activeRunId && !t.verifyingRunId && t.pendingJob) {
      const pending = t.pendingJob;
      await this.apply(t, { type: 'pending.cleared' });
      await this.startRun(project, ticketId, pending);
    }
    await this.drain('dev');
    await this.drain('questions');
  }

  /** Starts queued items while slots are free, one drain at a time. */
  private drain(queue: QueueName): Promise<void> {
    const next = this.draining.then(() => this.drainNow(queue));
    this.draining = next.catch(() => undefined);
    return next;
  }

  /**
   * Each item starts in its own ticket's task, without waiting for it (a long `prepare` holds only
   * that ticket); `admitting` counts the starts not past their slot yet, so a drain hands out no
   * more items than free slots.
   */
  private async drainNow(queue: QueueName): Promise<void> {
    if (this.stopping) return;
    const n = (await this.d.store.listQueue()).filter((q) => q.queue === queue).length;
    for (let i = 0; i < n; i++) {
      if ((await this.isPaused()) || (await this.overBudget()) || this.d.scheduler.free(queue) - this.admitting[queue] <= 0) return;
      const item = await this.d.scheduler.next(queue);
      if (!item) return;
      this.admitting[queue]++;
      let done = false;
      const admitted = () => {
        if (done) return;
        done = true;
        this.admitting[queue]--;
      };
      this.worker
        .exclusive(item, async () => {
          const project = await this.runtimeFor(item.projectId, item.ticketId);
          if (project) await this.startRun(project, item.ticketId, item, admitted);
        })
        .catch((err: unknown) => this.log('error', `start ${item.job} on ${item.ticketId}: ${(err as Error).message}`))
        .finally(admitted);
    }
  }

  private async exec(project: ProjectRuntime, ticketId: string | undefined, c: Effect): Promise<void> {
    const { store, tracker, clock } = this.d;
    if (c.kind === 'set_paused') {
      await store.setMeta('paused', c.paused ? '1' : '0');
      if (!c.paused) {
        await this.drain('dev');
        await this.drain('questions');
      }
      return;
    }
    if (!ticketId) return;
    const t = await this.ticket(project.id, ticketId);
    switch (c.kind) {
      case 'start_run':
        return this.startRun(project, ticketId, c);
      case 'stop_run': {
        if (c.linearSessionId) {
          for (const r of await store.runsByStatus('running')) {
            if (r.projectId === project.id && r.ticketId === ticketId && r.linearSessionId === c.linearSessionId) this.handles.get(r.id)?.stop();
          }
          return;
        }
        // The ticket's timers were deleted by the decision itself (`clearTimers`).
        // The ticket's dev work only: a question waiting for its slot is still answered.
        await store.removeFromQueue(project.id, ticketId, 'dev');
        if (t.activeRunId) this.handles.get(t.activeRunId)?.stop();
        return;
      }
      case 'run_verify': {
        const run = await store.getRun(c.runId);
        const job = project.workflow.jobs[c.job];
        if (!run || !job) return;
        this.track(
          (async () => {
            const res = await this.d.verify(run.cwd, job.verify);
            const base = { ...TRUSTED, at: clock.now(), projectId: project.id, ticketId };
            const event: FactoryEvent = res.ok
              ? { ...base, id: `check:${run.id}`, type: 'verify.passed', payload: { runId: run.id, job: job.name } }
              : { ...base, id: `check:${run.id}`, type: 'verify.failed', payload: { runId: run.id, job: job.name, failures: res.failures } };
            await this.submitResult(event);
          })(),
        );
        return;
      }
      case 'move':
        return this.move(project, t, c.to);
      case 'labels': {
        for (const l of c.add) await store.putEcho(`label:${ticketId}:${l}`, clock.now() + ECHO_MS);
        await tracker.setLabels(ticketId, c.add, c.remove);
        return;
      }
      case 'comment':
        return tracker.comment(ticketId, c.body);
      case 'activity': {
        const fromRun = c.runId ? (await store.getRun(c.runId))?.linearSessionId : undefined;
        const session = c.linearSessionId ?? fromRun ?? (await this.sessionFor(t));
        return tracker.activity(session, { type: c.type, body: c.body });
      }
      case 'post_output': {
        const run = await store.getRun(c.runId);
        if (!run) return;
        const session = run.linearSessionId ?? (await this.sessionFor(t));
        return tracker.activity(session, { type: 'response', body: run.lastText.trim() || 'Terminé.' });
      }
      case 'link_pr':
        if (t.linearSessionId) await tracker.addExternalUrl(t.linearSessionId, 'Pull request', c.url);
        return;
      case 'cleanup':
        await this.d.workspaces.cleanup(project.id, project.repoPath, ticketId);
        await this.apply(await this.ticket(project.id, ticketId), { type: 'workspace.released' });
        return;
    }
  }

  private async sessionFor(t: TicketState): Promise<string> {
    if (t.linearSessionId) return t.linearSessionId;
    const s = await this.d.tracker.ensureSession(t.ticketId);
    await this.apply(await this.ticket(t.projectId, t.ticketId), { type: 'session.linked', linearSessionId: s });
    return s;
  }

  private async move(project: ProjectRuntime, t: TicketState, to: LogicalState): Promise<void> {
    const stateName = project.workflow.states[to];
    await this.d.store.putEcho(`state:${t.ticketId}:${stateName}`, this.d.clock.now() + ECHO_MS);
    await this.d.tracker.moveTo(t.ticketId, stateName);
    await this.apply(await this.ticket(project.id, t.ticketId), { type: 'status.recorded', to });
  }

  /** `admitted` is called once the start took its slot, or will not take one (`drainNow`). */
  private async startRun(project: ProjectRuntime, ticketId: string, opts: StartOpts, admitted?: () => void): Promise<void> {
    const job = project.workflow.jobs[opts.job];
    if (!job) return this.log('error', `unknown job ${opts.job}`);
    const t = await this.ticket(project.id, ticketId);
    // As decide refuses it, also for the starts it does not see: the pending job by settle, the queue by drain.
    const refused = refusesDevWork(t, job);
    if (refused === 'undelegated') {
      return this.log('warn', `refused ${job.name} on ${ticketId}: the ticket is not delegated to ${PRODUCT_NAME}`);
    }
    if (refused === 'merged') return this.log('info', `refused ${job.name} on ${ticketId}: its PR is merged`);
    if (job.workspace === 'knowledge' && this.d.knowledgeConfigured === false) {
      this.log('info', `skipped ${job.name} on ${ticketId}: no knowledge repo configured`);
      if (opts.linearSessionId) {
        await this.d.tracker
          .activity(opts.linearSessionId, { type: 'response', body: `Aucune base de connaissance n'est configurée pour ${PRODUCT_NAME} : je ne peux rien retenir.` })
          .catch((err: Error) => this.log('warn', `could not answer ${ticketId}: ${err.message}`));
      }
      return;
    }
    const item = {
      projectId: project.id,
      ticketId,
      job: job.name,
      queue: job.queue,
      input: opts.input,
      inputText: opts.inputText,
      linearSessionId: opts.linearSessionId,
      resume: opts.resume,
      priority: t.priority,
      enqueuedAt: opts.enqueuedAt ?? this.d.clock.now(),
    };
    if (job.queue === 'dev' && (t.activeRunId || t.verifyingRunId)) {
      await this.apply(t, { type: 'pending.set', job: { job: job.name, input: opts.input, inputText: opts.inputText, resume: opts.resume } });
      return;
    }
    if (this.stopping || (await this.isPaused())) return this.d.scheduler.enqueue(item);
    if (await this.overBudget()) {
      await this.d.scheduler.enqueue(item);
      await this.noteBudget(project, ticketId);
      return;
    }
    const key = `${ticketId}:${job.queue}`;
    // A start from a decision leaves alone the slots a drain promised to the items it dequeued.
    const promised = admitted ? 0 : this.admitting[job.queue];
    const slot = this.d.scheduler.free(job.queue) > promised ? this.d.scheduler.tryAcquire(job.queue, key) : null;
    admitted?.();
    if (slot === null) return this.d.scheduler.enqueue(item);
    try {
      await this.launch(project, ticketId, job, opts, slot, key);
    } catch (err) {
      this.d.scheduler.release(key);
      let fresh = await this.ticket(project.id, ticketId);
      const events: InternalEvent[] = [];
      if (fresh.activeRunId) {
        const r = await this.d.store.getRun(fresh.activeRunId);
        if (r && r.status === 'running' && !this.handles.has(r.id)) await this.d.store.putRun({ ...r, status: 'failure', endedAt: this.d.clock.now() });
        if (!this.handles.has(fresh.activeRunId)) events.push({ type: 'run.cleared' });
      }
      const reason = `Erreur au lancement : ${(err as Error).message}`;
      fresh = await this.apply(fresh, ...events, { type: 'ticket.blocked', reason });
      const session = opts.linearSessionId ?? (await this.sessionFor(fresh));
      await this.d.tracker.activity(session, { type: 'error', body: reason });
    }
  }

  private async noteBudget(project: ProjectRuntime, ticketId: string): Promise<void> {
    const day = new Date(this.d.clock.now()).toISOString().slice(0, 10);
    const key = `budget:${day}:${project.id}:${ticketId}`;
    if (await this.d.store.getMeta(key)) return;
    await this.d.store.setMeta(key, '1');
    await this.d.tracker.comment(
      ticketId,
      `Budget journalier de ${PRODUCT_NAME} atteint : ce ticket reste en file jusqu'à demain (ou jusqu'à une hausse du plafond).`,
    );
  }

  private async launch(project: ProjectRuntime, ticketId: string, job: JobSpec, opts: StartOpts, slot: number, key: string): Promise<void> {
    const { tracker, store, clock, workspaces, forge } = this.d;
    const wf = project.workflow;
    const issue = await tracker.getIssue(ticketId);
    let t = await this.ticket(project.id, ticketId);

    if (job.pickup && !t.claudeSessionId) {
      const failures = await pickupFailures(wf.tracker.pickup.checks, issue, project.repoPath, workspaces);
      if (failures.length) {
        this.d.scheduler.release(key);
        t = await this.apply(t, { type: 'ticket.blocked', reason: failures.join(' ') });
        const session = await this.sessionFor(t);
        await tracker.activity(session, {
          type: 'elicitation',
          body: `Je ne peux pas commencer ce ticket :\n${failures.map((f) => `- ${f}`).join('\n')}\nCorrigez puis répondez dans ce fil.`,
        });
        return;
      }
    }

    const runId = this.newId();
    const ws = await workspaces.prepare({
      projectId: project.id,
      repoPath: project.repoPath,
      ticketId,
      title: issue.title,
      kind: job.workspace,
      slot,
      portBase: wf.workspace.portBase,
      setup: wf.workspace.setup,
      runId,
    });
    t = await this.ticket(project.id, ticketId);
    if (job.queue === 'dev') t = await this.apply(t, { type: 'workspace.prepared', path: ws.path, port: ws.port, branch: ws.branch });
    if (job.onStart.move && t.logical !== job.onStart.move) await this.move(project, t, job.onStart.move);
    t = await this.ticket(project.id, ticketId);

    const linearSessionId = opts.linearSessionId ?? (await this.sessionFor(t));
    t = await this.ticket(project.id, ticketId);

    const wantsResume = opts.resume ?? job.session === 'resume';
    const resume = wantsResume && !!t.claudeSessionId;
    const claudeSessionId = resume ? t.claudeSessionId! : this.newId();

    const kind = opts.input ?? job.input;
    let input: { kind: InputKind; text: string } | undefined;
    if (kind === 'feedback') {
      const items = [...t.pendingFeedback];
      if (t.prNumber) items.push(...(await forge.unresolvedReviewComments(project.repoPath, t.prNumber)));
      input = { kind, text: items.length ? formatFeedback(items) : '(aucun retour écrit : relisez la PR et le fil Linear)' };
    } else if (kind === 'verify_failures') {
      input = { kind, text: formatVerifyFailures(JSON.parse(opts.inputText ?? '[]') as VerifyFailure[]) };
    } else if (kind === 'ci_failures') {
      input = { kind, text: opts.inputText ?? 'La CI de la PR est en échec. Lancez `gh pr checks` pour le détail.' };
    } else if (kind === 'thread') {
      input = { kind, text: opts.inputText ?? '' };
    }

    const prompt = buildPrompt({
      skill: job.skill,
      issue: { identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.url },
      branch: job.queue === 'dev' ? t.branch : undefined,
      prUrl: t.prUrl,
      input,
      reviewRounds: wf.limits.reviewRounds,
    });

    const run: RunRecord = {
      id: runId,
      projectId: project.id,
      ticketId,
      job: job.name,
      queue: job.queue,
      status: 'running',
      claudeSessionId,
      linearSessionId,
      startedAt: clock.now(),
      costUsd: 0,
      turns: 0,
      lastText: '',
      token: this.newId(),
      cwd: ws.path,
    };
    await store.putRun(run);
    await this.apply(t, { type: 'run.started', runId, job: job.name, queue: job.queue, claudeSessionId, feedbackConsumed: kind === 'feedback' });
    if (this.d.beforeRun) await this.d.beforeRun(run).catch((err: Error) => this.log('warn', `beforeRun: ${err.message}`));

    const handle = this.d.runner.start({
      runId,
      cwd: ws.path,
      prompt,
      claudeSessionId,
      resume,
      model: job.model,
      pluginDir: this.d.packDir,
      settingsPath: this.d.settingsPath ?? join(this.d.packDir, 'settings.json'),
      readOnly: job.workspace === 'trunk-readonly',
      limits: job.limits,
      env: { ...this.d.agentEnv(run), ...(ws.port !== undefined ? { PORT: String(ws.port) } : {}) },
    });
    this.handles.set(runId, handle);
    this.liveRuns.add(runId);
    this.track(this.pump(project, run, handle), runId);
  }

  private async pump(project: ProjectRuntime, run: RunRecord, handle: RunHandle): Promise<void> {
    const { tracker, bus, store, clock } = this.d;
    let result: RunResult;
    try {
      const relay = new ActivityRelay(
        (a) => (run.linearSessionId ? tracker.activity(run.linearSessionId, a) : Promise.resolve()),
        this.d.activityIntervalMs ?? 2000,
        () => clock.now(),
      );
      for await (const ev of handle.events) {
        bus.publish({ kind: 'run', runId: run.id, ticketId: run.ticketId, ev });
        relay.push(ev);
      }
      this.liveRuns.delete(run.id);
      result = await handle.done;
      await relay.flush();
      this.handles.delete(run.id);
      const rec = (await store.getRun(run.id)) ?? run;
      const interrupted = this.stopping && result.outcome === 'stopped';
      await store.putRun({
        ...rec,
        status: interrupted ? 'interrupted' : result.outcome,
        endedAt: clock.now(),
        costUsd: result.costUsd,
        turns: result.turns,
        lastText: result.lastText,
      });
      // Shutdown, not a user stop: keep the ticket's activeRunId so the next start's recover() blocks it and tells Linear.
      if (interrupted) return;
    } catch (err) {
      const message = (err as Error).message;
      this.liveRuns.delete(run.id);
      this.log('error', `run ${run.id} failed: ${message}`);
      try {
        handle.stop();
      } catch {
        /* best effort */
      }
      this.handles.delete(run.id);
      try {
        const rec = (await store.getRun(run.id)) ?? run;
        await store.putRun({ ...rec, status: 'failure', endedAt: clock.now(), lastText: message });
      } catch (e) {
        this.log('error', `could not record failure of run ${run.id}: ${(e as Error).message}`);
      }
      result = { outcome: 'failure', costUsd: 0, turns: 0, lastText: message };
    }
    await this.submitResult({
      ...TRUSTED,
      id: `attempt:${run.id}:finished`,
      type: 'run.finished',
      at: clock.now(),
      projectId: project.id,
      ticketId: run.ticketId,
      payload: {
        runId: run.id,
        job: run.job,
        outcome: result.outcome,
        costUsd: result.costUsd,
        turns: result.turns,
        lastText: result.lastText,
      },
    });
  }
}
