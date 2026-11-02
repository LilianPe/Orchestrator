import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Forge, ForgeWriter, MergeResult } from '../adapters/forge/types.js';
import type { RoleResolver } from '../adapters/roles/types.js';
import type { RunHandle, RunResult, Runner } from '../adapters/runner/types.js';
import {
  DEFAULT_REQUIREMENTS,
  PACK_TARGET,
  SANDBOX_HOME,
  WORKSPACE_TARGET,
  type Sandbox,
  type SandboxMount,
  type SandboxProvider,
} from '../adapters/sandbox/types.js';
import { ActivityRelay } from '../adapters/tracker/activity-relay.js';
import { labelEchoKey, type ActivityInput, type Tracker } from '../adapters/tracker/types.js';
import type { Workspace, WorkspaceManager } from '../adapters/workspace/types.js';
import type { JobSpec, Workflow } from '../config/workflow-schema.js';
import type { EffectRetry } from '../runtime/outbox.js';
import { Worker } from '../runtime/worker.js';
import { workflowVersion } from '../runtime/workflow-version.js';
import {
  LEASE_MS,
  type DecisionOutcome,
  type DecisionRequest,
  type EffectOutcome,
  type OutboxRow,
  type RunRecord,
  type Store,
  type WorkflowVersion,
} from '../store/types.js';
import type { EventBus } from './bus.js';
import type { Clock } from './clock.js';
import type { Effect } from './decision.js';
import { NO_PLAN, planDecision } from './decision-plan.js';
import { blockedLabelChange, HUMAN_EVENTS, mayCheck, RECONCILE_MS, reconcileTicket, refusesDevWork, sensitivePathsAtLaunch, taintedKnowledge } from './engine.js';
import { attemptLabels, packFingerprints } from './attempt-labels.js';
import { pickupFailures } from './pickup.js';
import { buildPrompt, formatFeedback, formatVerifyFailures } from './prompt.js';
import { reduce } from './reduce.js';
import type { StoredEvent } from './upcast.js';
import type { Scheduler } from './scheduler.js';
import {
  CREATES_TICKET,
  type EventPayloads,
  type FeedbackItem,
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
  /** One reconciliation of a project (ORC-185): Linear and GitHub compared to the factory's state, into the inbox. */
  reconcile?: (project: ProjectRuntime) => Promise<void>;
  /** The factory's writes on the forge (ORC-148: the merge); absent with the `gh` CLI, which merges nothing. */
  forgeWriter?: ForgeWriter;
  runner: Runner;
  workspaces: WorkspaceManager;
  verify: Verifier;
  projects: ProjectRuntime[];
  packDir: string;
  /** `--settings` file for runs; defaults to <packDir>/settings.json. */
  settingsPath?: string;
  /**
   * Each attempt runs in a sandbox of its own (ORC-204), made at its launch and destroyed when it
   * ends; `setup` runs there too. Absent: runs and `setup` on the host (fake runner, tests).
   */
  sandboxes?: SandboxProvider;
  /** Where each ticket's Claude session dir lives on the host (`<sessionsDir>/<project>/<ticket>`); required with `sandboxes`. */
  sessionsDir?: string;
  /** Other host paths every sandbox mounts (the factory's install, for `factory-agent`). */
  sandboxMounts?: readonly SandboxMount[];
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
  /** Lease of a claimed outbox row or queue item (ORC-149, ORC-150); default 60 s, renewed every 20 s while it runs. */
  effectLeaseMs?: number;
  /** Retries of an effect that throws (ORC-150); default `EFFECT_RETRY` (8 attempts, 1 s doubled, 5 min at most). */
  effectRetry?: EffectRetry;
  /** Retries of an inbox row whose processing throws (ORC-149); default `PROCESS_RETRY`. */
  processRetry?: { attempts: number; baseMs: number };
  /** The factory build's commit, labelled on each attempt; defaults to `FACTORY_COMMIT`, else null (ORC-226). */
  factoryCommit?: string | null;
  /**
   * Resolves the roles of a human event's signed actor before its decision (ORC-186): `decide` then
   * checks the authorization matrix on them. Without it (tests), no event carries roles and nothing is
   * checked; the daemon always passes one.
   */
  roles?: RoleResolver;
}

interface StartOpts {
  job: string;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
  /** Those the start was decided with: kept pending or queued with it, completed at the launch (ORC-274). */
  sensitivePaths?: readonly string[];
  /** A queued item's place in its queue, kept when it goes back there. */
  enqueuedAt?: number;
  /** The start mark its launch names its run in (ORC-277, `startHandled`): an outbox effect's, or its queued item's. */
  startMark?: string;
}

/** A drain's hooks on a start it hands out of the queue (`startRun`). */
interface StartFrom {
  admitted?: () => void;
  recorded?: () => Promise<void>;
}

const ECHO_MS = 60_000;
/** The `meta` key of the installation's id (`instanceId`). */
const INSTANCE_KEY = 'instance-id';

/** An outbox effect's idempotency key (ORC-162): `<ticket:seq:i>@<installation>`, and whether the row runs again. */
interface EffectKey {
  id: string;
  replay: boolean;
}

export function logicalFromName(states: Workflow['states'], name: string): LogicalState | undefined {
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

/** Where a sandboxed run reads its `--settings` file, next to the pack (ORC-204). */
export const SETTINGS_TARGET = '/factory/settings.json';

/** Why the factory's merge is refused when the PR's head moved since the review (ORC-148). */
const PUSHED = 'la branche a reçu un push depuis la review';

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
  private instance: Promise<string> | undefined;

  constructor(private d: OrchestratorDeps) {
    this.newId = d.newId ?? randomUUID;
    this.dispatchOpen = !d.holdInboxUntilReplay;
    this.worker = new Worker({
      store: d.store,
      log: (level, message) => this.log(level, message),
      prepare: async (event) => this.withRoles(await this.withSnapshot(event)),
      request: (event) => this.request(event),
      committed: (event, outcome) => this.committed(event, outcome),
      execute: (row) => this.execute(row),
      leaseMs: d.effectLeaseMs,
      retry: d.processRetry,
      left: (row) => void this.freeSlot(row),
      deadLettered: (row) => void this.freeSlot(row),
      effectRetry: d.effectRetry,
      now: () => d.clock.now(),
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
      if (fresh) this.wake();
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

  /** An inbox row was written outside `accept` (a timer's firing, ORC-161): the worker processes it now. */
  wake(): void {
    if (this.dispatchOpen) this.worker.kickInBackground();
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

  /**
   * One poll of the worker's loop (`startWorker`), for a caller that drives its own clock: the
   * scenario harness's `advance` (ORC-228), as the poller would once the simulated time passed.
   */
  async poll(): Promise<void> {
    if (this.dispatchOpen && !this.stopping) await this.worker.poll();
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
      const kick = () => (this.stopping || !this.dispatchOpen ? Promise.resolve(0) : this.worker.kick());
      const handed = await kick();
      await this.worker.settle();
      const pending = this.pendingBackground();
      await Promise.all(pending);
      // What settled may have written rows (a run's result once its pump ends): read the inbox again.
      const more = await kick();
      if (handed === 0 && more === 0 && pending.length === 0 && this.writes.size === 0 && this.pendingBackground().length === 0) return;
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
    await this.destroyDeadSandboxes();
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
      // Its start, taken up again, does not launch it again (`startHandled`, ORC-277): this is the only notice.
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

  /** The sandboxes a crash left behind (ORC-204): every one whose attempt this process is not running. */
  private async destroyDeadSandboxes(): Promise<void> {
    const sandboxes = this.d.sandboxes;
    if (!sandboxes) return;
    let live: Awaited<ReturnType<SandboxProvider['list']>>;
    try {
      live = await sandboxes.list();
    } catch (err) {
      this.log('error', `sandboxes not listed, those of dead attempts are left: ${(err as Error).message}`);
      return;
    }
    for (const { runId, sandbox } of live) if (!this.handles.has(runId)) await this.destroySandbox(sandbox.id);
  }

  /** Logged, never thrown: a sandbox left behind is recover()'s at the next start. */
  private async destroySandbox(id: string): Promise<void> {
    await this.d.sandboxes?.destroy(id).catch((err: Error) => this.log('error', `sandbox ${id} not destroyed: ${err.message}`));
  }

  /**
   * The attempt's sandbox (ORC-204): the worktree, the git dir its `.git` file points into (at the
   * same path, so git works there; it shows the repository's other refs until ORC-205), the ticket's
   * Claude session dir as `~/.claude` (`--resume` across attempts), the pack and the run settings
   * read-only. A `trunk-readonly` job gets its worktree read-write too: only `--permission-mode plan`
   * keeps it from writing, as on the host. `claude-api` is an open network until ORC-213.
   */
  private async openSandbox(sandboxes: SandboxProvider, project: ProjectRuntime, ticketId: string, ws: Workspace, runId: string): Promise<Sandbox> {
    if (!this.d.sessionsDir) throw new Error('sessionsDir is required with sandboxes');
    const sessionDir = join(this.d.sessionsDir, project.id, ticketId);
    mkdirSync(sessionDir, { recursive: true });
    const gitDir = await this.d.workspaces.gitCommonDir(ws.path);
    return sandboxes.create({
      runId,
      ticketId,
      workspacePath: ws.path,
      network: 'claude-api',
      requirements: DEFAULT_REQUIREMENTS,
      mounts: [
        { host: gitDir, target: gitDir, readOnly: false },
        { host: sessionDir, target: `${SANDBOX_HOME}/.claude`, readOnly: false },
        { host: this.d.packDir, target: PACK_TARGET, readOnly: true },
        { host: this.settingsPath(), target: SETTINGS_TARGET, readOnly: true },
        ...(this.d.sandboxMounts ?? []),
      ],
    });
  }

  private settingsPath(): string {
    return this.d.settingsPath ?? join(this.d.packDir, 'settings.json');
  }

  /**
   * The repository's `setup` in a worktree just made: in its sandbox, on the host without one. A
   * failure removes the worktree, so the next attempt makes it again and runs `setup` again.
   */
  private async runSetup(project: ProjectRuntime, ticketId: string, ws: Workspace, sandbox: Sandbox | undefined): Promise<void> {
    const commands = project.workflow.workspace.setup;
    let failed: string | undefined;
    if (sandbox) {
      // ponytail: setup shares the attempt's `claude-api` sandbox, an open network until ORC-213; it gets
      // a `full` sandbox of its own once the network levels are real.
      for (const command of commands) {
        if ((await this.d.sandboxes!.exec(sandbox.id, ['sh', '-c', command])).code !== 0) {
          failed = command;
          break;
        }
      }
    } else {
      const res = await this.d.verify(ws.path, commands);
      if (!res.ok) failed = res.failures[0]!.command;
    }
    if (failed === undefined) return;
    if (sandbox) await this.destroySandbox(sandbox.id);
    await this.d.workspaces
      .cleanup(project.id, project.repoPath, ticketId)
      .catch((err: Error) => this.log('warn', `worktree of ${ticketId} not removed after its failed setup: ${err.message}`));
    throw new Error(`Le setup du worktree a échoué : ${failed}`);
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
    let before = t.blocked;
    let next = await this.d.store.updateTicket(t.projectId, t.ticketId, (from) => ((before = from.blocked), step(from)));
    if (!next) {
      next = step(t);
      await this.d.store.putTicket(next);
    }
    this.d.bus.publish({ kind: 'ticket', ticket: next });
    // Blocked or unblocked outside a decision (recover, a launch error, a refused pickup): the label
    // `decide` keeps in step with its own changes follows here (ORC-170). A failed write does not undo the change.
    const label = blockedLabelChange(before, next.blocked);
    if (label) {
      await this.setLabels(t.ticketId, label.add, label.remove).catch((e: Error) => this.log('warn', `could not set the label of ${t.ticketId}: ${e.message}`));
    }
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
  /** `known`: the ticket, when the caller has just read it (`null`: read, and not tracked). */
  private async runtimeFor(projectId: string, ticketId: string | undefined, known?: TicketState | null): Promise<ProjectRuntime | undefined> {
    const project = projectId === '*' ? this.d.projects[0] : this.project(projectId);
    if (!project || !ticketId) return project;
    const hash = (known === undefined ? await this.d.store.getTicket(project.id, ticketId) : known)?.workflowHash;
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

  /**
   * A human event `decide` may check gets its actor's roles before its decision (ORC-186), journaled
   * with it, so that `decide` stays pure and a replay checks the matrix on the same roles. No actor, no
   * roles: the event is then refused whatever it asks. A resolution that fails throws: the event waits
   * and is retried, never decided on roles that may be wrong. An event the matrix will not check (on a
   * ticket the factory does not track, or that no rule with a run answers in the ticket's workflow)
   * gets none, and never waits on Linear or GitHub.
   */
  private async withRoles(event: FactoryEvent): Promise<FactoryEvent> {
    const resolver = this.d.roles;
    if (!resolver || event.roles !== undefined || event.projectId === '*' || !event.ticketId || !HUMAN_EVENTS.has(event.type)) return event;
    const known = await this.d.store.getTicket(event.projectId, event.ticketId);
    if (!known && !CREATES_TICKET.has(event.type)) return event;
    const project = await this.runtimeFor(event.projectId, event.ticketId, known ?? null);
    if (!project || !mayCheck(event, project.workflow)) return event;
    return { ...event, roles: event.actor ? await resolver.rolesOf(event.projectId, event.actor) : [] };
  }

  /** The decision transaction of an event (ORC-149): `decide` runs in the store, under the ticket's lock. */
  private request(event: FactoryEvent): DecisionRequest {
    const project = event.projectId === '*' ? this.d.projects[0] : this.project(event.projectId);
    const now = this.d.clock.now();
    if (!project) return { event, workflow: { hash: '', definition: null }, decide: () => NO_PLAN };
    return {
      event,
      workflow: this.currentVersion(project),
      decide: (known, version) => planDecision({ event, known, workflow: this.workflowOf(version), hash: version.hash, now }),
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
    if (outcome.preempted.length > 0) {
      this.log('warn', `${event.type} ${event.id} cancelled the effects held back by their retry: ${outcome.preempted.join(', ')}`);
    }
    if (outcome.plan.ticket) bus.publish({ kind: 'ticket', ticket: outcome.plan.ticket });
  }

  /**
   * Executes one outbox row of a decision, after its commit, for the outbox executor (ORC-150):
   * throws when the effect failed. The executor retries it, then lets it die; its result comes back
   * through the inbox (`effect:<id>`), and a dead one blocks the ticket by `decide`.
   */
  private async execute(row: OutboxRow): Promise<EffectOutcome | void> {
    const project = await this.runtimeFor(row.projectId, row.ticketId);
    if (!project) return;
    const effect = row.effect;
    if (effect.kind === 'settle') {
      if (row.ticketId) await this.settle(project, row.ticketId);
      return;
    }
    this.d.bus.publish({ kind: 'command', projectId: project.id, ticketId: row.ticketId, command: effect });
    const key: EffectKey = { id: `${row.id}@${await this.instanceId()}`, replay: row.attempts > 1 };
    const outcome = await this.exec(project, row.ticketId, effect, key);
    if (outcome?.deduplicated) this.log('info', `effect ${row.id} (${effect.kind}) already made${outcome.ref ? ` (${outcome.ref})` : ''}: not written again`);
    return outcome;
  }

  /**
   * This installation's id, drawn once and kept in the store: it salts the keys of the effects
   * written outside (ORC-162), so that another instance on the same Linear workspace, or this one
   * after its journal restarted from zero, never takes an effect of its own for one of theirs.
   */
  private instanceId(): Promise<string> {
    this.instance ??= (async () => {
      const known = await this.d.store.getMeta(INSTANCE_KEY);
      if (known) return known;
      await this.d.store.setMeta(INSTANCE_KEY, randomUUID().replaceAll('-', '').slice(0, 12));
      // Read back: of two daemons starting together on one store, both keep the one written last.
      return (await this.d.store.getMeta(INSTANCE_KEY))!;
    })().catch((err: unknown) => {
      // Not kept: the next effect reads the store again.
      this.instance = undefined;
      throw err;
    });
    return this.instance;
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
   *
   * An item is handed out under a lease (ORC-150), renewed while its start runs, and leaves the
   * queue only once its start is recorded (the run written) or it is dropped; it goes back in line
   * when it gets no slot. A crash between the two leaves it in the queue: the next start hands it
   * out again once the lease expires.
   */
  private async drainNow(queue: QueueName): Promise<void> {
    if (this.stopping) return;
    const leaseMs = this.d.effectLeaseMs ?? LEASE_MS;
    const n = (await this.d.store.listQueue()).filter((q) => q.queue === queue).length;
    for (let i = 0; i < n; i++) {
      if ((await this.isPaused()) || (await this.overBudget()) || this.d.scheduler.free(queue) - this.admitting[queue] <= 0) return;
      const claim = await this.d.scheduler.next(queue, leaseMs);
      if (!claim) return;
      const item = claim.item;
      this.admitting[queue]++;
      let done = false;
      const admitted = () => {
        if (done) return;
        done = true;
        this.admitting[queue]--;
      };
      const renew = setInterval(() => {
        this.d.store.renewQueued(claim, leaseMs).catch((err: unknown) => this.log('warn', `lease of queued ${item.job} on ${item.ticketId}: ${(err as Error).message}`));
      }, Math.max(1, Math.floor(leaseMs / 3)));
      renew.unref();
      let finished = false;
      const taken = () => this.d.store.finishQueued(claim).then(() => void (finished = true));
      this.worker
        .exclusive(item, async () => {
          const project = await this.runtimeFor(item.projectId, item.ticketId);
          // Launched before a crash cut it before it left the queue: recover()'s, not launched again (ORC-277).
          const launched = item.startMark !== undefined && (await this.startHandled(item.startMark));
          const outcome = project && !launched ? await this.startRun(project, item.ticketId, item, { admitted, recorded: taken }) : 'done';
          clearInterval(renew);
          if (outcome === 'queued') await this.d.store.releaseQueued(claim);
          else if (!finished) await this.d.store.finishQueued(claim);
        })
        .catch(async (err: unknown) => {
          clearInterval(renew);
          this.log('error', `start ${item.job} on ${item.ticketId}: ${(err as Error).message}`);
          // Back in line: the item is tried again at the next drain.
          await this.d.store.releaseQueued(claim).catch(() => false);
        })
        .finally(admitted);
    }
  }

  /**
   * `key`: the idempotency key of the effect (ORC-162, docs/idempotence.md). Only a replay (a row
   * claimed before) looks for what an earlier execution wrote: a first execution has nothing to find.
   * A replay that finds the effect already made writes nothing and says so.
   */
  private async exec(project: ProjectRuntime, ticketId: string | undefined, c: Effect, key: EffectKey): Promise<EffectOutcome | void> {
    const { store, tracker, clock } = this.d;
    if (c.kind === 'set_paused') {
      await store.setMeta('paused', c.paused ? '1' : '0');
      if (!c.paused) {
        await this.drain('dev');
        await this.drain('questions');
      }
      return;
    }
    if (c.kind === 'reconcile') {
      // Never fails: a dead effect would disarm the next timer its decision armed, and stop the 5-minute chain.
      await this.d.reconcile?.(project).catch((err: Error) => this.log('warn', `reconcile ${project.id}: ${err.message}`));
      return;
    }
    if (!ticketId) return;
    const t = await this.ticket(project.id, ticketId);
    switch (c.kind) {
      case 'start_run': {
        // A replay (a lost lease) must not start again what was handled: launched, set pending
        // behind the run it started, or queued (`startHandled`).
        const mark = `effect:${key.id}:started`;
        if (key.replay && (await this.startHandled(mark))) return { deduplicated: true };
        await this.startRun(project, ticketId, { ...c, startMark: mark });
        await store.setMeta(mark, '1');
        return;
      }
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
              : { ...base, id: `check:${run.id}`, type: 'verify.failed', payload: { runId: run.id, job: job.name, failures: res.failures, ...(res.tree ? { tree: res.tree } : {}) } };
            await this.submitResult(event);
          })(),
        );
        return;
      }
      case 'move':
        return this.move(project, t, c.to, c.keepReviewSha);
      case 'merge':
        return this.merge(project, t, c.sha, key);
      case 'labels':
        return this.setLabels(ticketId, c.add, c.remove);
      case 'comment': {
        const found = key.replay ? await tracker.findComment(ticketId, key.id) : undefined;
        if (found !== undefined) return { deduplicated: true, ref: found };
        return tracker.comment(ticketId, c.body, key.id);
      }
      case 'activity': {
        const fromRun = c.runId ? (await store.getRun(c.runId))?.linearSessionId : undefined;
        const session = c.linearSessionId ?? fromRun ?? (await this.sessionFor(t));
        return this.activityOnce(session, { type: c.type, body: c.body }, key);
      }
      case 'post_output': {
        const run = await store.getRun(c.runId);
        if (!run) return;
        const session = run.linearSessionId ?? (await this.sessionFor(t));
        return this.activityOnce(session, { type: 'response', body: run.lastText.trim() || 'Terminé.' }, key);
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

  /** An activity of an outbox effect, written unless its first execution already wrote it (ORC-162). */
  private async activityOnce(session: string, a: ActivityInput, key: EffectKey): Promise<EffectOutcome | void> {
    const found = key.replay ? await this.d.tracker.findActivity(session, key.id) : undefined;
    if (found !== undefined) return { deduplicated: true, ref: found };
    await this.d.tracker.activity(session, a, key.id);
  }

  private async sessionFor(t: TicketState): Promise<string> {
    if (t.linearSessionId) return t.linearSessionId;
    const s = await this.d.tracker.ensureSession(t.ticketId);
    await this.apply(await this.ticket(t.projectId, t.ticketId), { type: 'session.linked', linearSessionId: s });
    return s;
  }

  /** Labels written by the factory, echoed so that their webhook is not read as a human's change. */
  private async setLabels(ticketId: string, add: string[], remove: string[]): Promise<void> {
    for (const l of add) await this.d.store.putEcho(labelEchoKey(ticketId, l, 'added'), this.d.clock.now() + ECHO_MS);
    for (const l of remove) await this.d.store.putEcho(labelEchoKey(ticketId, l, 'removed'), this.d.clock.now() + ECHO_MS);
    await this.d.tracker.setLabels(ticketId, add, remove);
  }

  /**
   * Plans each project's reconciliation in the store (ORC-185), in `RECONCILE_MS` (the connection to Linear passes
   * at once), unless a timer already plans it (a restart): its firings then arm the next ones. The timer of a
   * project gone from the configuration is deleted: it would fire for a project the factory no longer knows.
   */
  async armReconciliation(): Promise<void> {
    const timers = (await this.d.store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'reconcile');
    for (const t of timers) if (!this.d.projects.some((p) => p.id === t.projectId)) await this.d.store.deleteTimersFor(t.projectId, t.ticketId);
    for (const p of this.d.projects) {
      const ticketId = reconcileTicket(p.id);
      if (timers.some((t) => t.ticketId === ticketId)) continue;
      await this.d.store.putTimer({ key: `${ticketId}:reconcile`, projectId: p.id, ticketId, kind: 'reconcile', payload: {}, fireAt: this.d.clock.now() + RECONCILE_MS });
    }
    this.wake();
  }

  private async move(project: ProjectRuntime, t: TicketState, to: LogicalState, keepReviewSha?: boolean): Promise<void> {
    const stateName = project.workflow.states[to];
    // The loader refuses a move to an undeclared status; a version frozen before it may still hold one.
    if (!stateName) throw new Error(`no status for "${to}" in the workflow of ${project.id}`);
    await this.d.store.putEcho(`state:${t.ticketId}:${stateName}`, this.d.clock.now() + ECHO_MS);
    await this.d.tracker.moveTo(t.ticketId, stateName);
    // Only a move that concludes the factory's work records the commit shown; a move back keeps the reviewed one.
    const reviewSha = to !== 'human_review' ? undefined : keepReviewSha ? t.reviewSha : await this.headShown(project, t);
    await this.apply(await this.ticket(project.id, t.ticketId), { type: 'status.recorded', to, ...(reviewSha ? { reviewSha } : {}) });
  }

  /**
   * The head of the ticket's open PR as the factory shows it in Human Review (ORC-148): the only commit a Done merges.
   * Recorded only when it is the commit the ticket's worktree ended its run on: a head pushed meanwhile, which the
   * run (a review) never read, is no reviewed commit. Unread (no branch, no PR, no worktree, the forge down) or
   * different, none is recorded: a Done is refused until the factory moves the ticket to Human Review again.
   */
  private async headShown(project: ProjectRuntime, t: TicketState): Promise<string | undefined> {
    if (!t.branch || !t.worktreePath) return undefined;
    try {
      const [pr, local] = await Promise.all([this.d.forge.findPr(project.repoPath, t.branch), this.d.workspaces.head(t.worktreePath)]);
      if (pr?.state !== 'OPEN' || !pr.headSha) return undefined;
      if (pr.headSha === local) return pr.headSha;
      this.log('warn', `head of ${t.ticketId}'s PR (${pr.headSha}) is not the commit its run ended on (${local ?? 'unread'}): no reviewed commit`);
      return undefined;
    } catch (err) {
      this.log('warn', `head of ${t.ticketId}'s PR unread at Human Review: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * The `merge` effect (ORC-148). The forge is read first, as only it knows the checks of the reviewed commit: the
   * PR still open, its head still that commit, its checks green. Then merged with that head imposed, so a push in
   * between is refused by GitHub itself. A refusal reaches the human through `pr.merge_refused`, and is decided once:
   * its mark, written before the event, makes a replay (a lost lease, a failed inbox write) send the same refusal
   * again (the inbox drops the copy by its id) instead of reading the forge anew, where checks green since would merge.
   */
  private async merge(project: ProjectRuntime, t: TicketState, sha: string, key: EffectKey): Promise<EffectOutcome | void> {
    if (t.prNumber === undefined) return;
    const mark = `effect:${key.id}:refused`;
    const refused = key.replay ? await this.d.store.getMeta(mark) : undefined;
    if (refused) return this.refuseMerge(project, t, key, refused);
    const writer = this.d.forgeWriter;
    const pr = t.branch ? await this.d.forge.findPr(project.repoPath, t.branch) : undefined;
    let reason: string;
    if (pr?.number === t.prNumber && pr.state === 'MERGED') {
      if (pr.headSha === sha) return { deduplicated: true };
      // Merged on GitHub meanwhile, on another head: no refusal to answer, the merge's own events deliver the ticket.
      this.log('info', `merge of ${t.ticketId} dropped: PR #${pr.number} already merged on ${pr.headSha}`);
      return;
    }
    if (!t.branch) reason = 'la branche du ticket est inconnue';
    else if (pr && pr.number !== t.prNumber) reason = `la PR de la branche (#${pr.number}) n'est pas celle du ticket (#${t.prNumber})`;
    else if (!writer) reason = "la GitHub App de l'usine est requise pour merger";
    else if (pr?.state !== 'OPEN') reason = "la PR n'est plus ouverte";
    else if (pr.headSha !== sha) reason = PUSHED;
    else if (pr.checks !== 'pass' && pr.checks !== 'none') reason = `les checks du commit relu ne sont pas verts (${pr.failedChecks.join(', ') || pr.checks})`;
    else {
      // No check at all: the forge merges only in a repository with no CI (`mergePr`, `unchecked`).
      const res: MergeResult = await writer.mergePr(project.repoPath, t.prNumber, sha, pr.checks === 'none' ? { unchecked: true } : undefined);
      if (res.merged) return res.deduplicated ? { deduplicated: true } : undefined;
      reason =
        res.reason === 'head_moved'
          ? PUSHED
          : res.reason === 'checks_missing'
            ? "aucun check n'a tourné sur le commit relu, alors que le dépôt a une CI ou que l'usine ne peut pas vérifier qu'il n'en a pas (CI pas encore lancée, checks qui viennent d'apparaître, ou GitHub App sans la permission Actions en lecture)"
            : `GitHub refuse le merge (${res.message})`;
    }
    await this.d.store.setMeta(mark, reason);
    await this.refuseMerge(project, t, key, reason);
  }

  /** The `pr.merge_refused` of a merge effect, keyed by it. A failed write throws, so that the outbox retries the effect. */
  private async refuseMerge(project: ProjectRuntime, t: TicketState, key: EffectKey, reason: string): Promise<void> {
    await this.accept({
      ...TRUSTED,
      id: `merge-refused:${key.id}`,
      type: 'pr.merge_refused',
      at: this.d.clock.now(),
      projectId: project.id,
      ticketId: t.ticketId,
      payload: { number: t.prNumber!, url: t.prUrl ?? '', branch: t.branch ?? '', reason, headMoved: reason === PUSHED },
    });
  }

  /**
   * `admitted` is called once the start took its slot, or will not take one (`drainNow`); `recorded`
   * once the run is written. Resolves `queued` when the start went to the queue, `done` otherwise
   * (started, set pending, refused or blocked).
   */
  private async startRun(
    project: ProjectRuntime,
    ticketId: string,
    opts: StartOpts,
    from: StartFrom = {},
  ): Promise<'queued' | 'done'> {
    const { admitted, recorded } = from;
    const job = project.workflow.jobs[opts.job];
    if (!job) {
      this.log('error', `unknown job ${opts.job}`);
      return 'done';
    }
    const t = await this.ticket(project.id, ticketId);
    // As decide refuses it, also for the starts it does not see: the pending job by settle, the queue by drain.
    const refused = refusesDevWork(t, job);
    if (refused === 'undelegated') {
      this.log('warn', `refused ${job.name} on ${ticketId}: the ticket is not delegated to ${PRODUCT_NAME}`);
      return 'done';
    }
    if (refused === 'merged') {
      this.log('info', `refused ${job.name} on ${ticketId}: its PR is merged`);
      return 'done';
    }
    // A decision that starts a dev job unblocks the ticket first: blocked now, it was blocked since
    // (a failed launch whose notice failed, a stop, recover()), and a retried or queued start must
    // not launch a run on it.
    if (job.queue === 'dev' && t.blocked) {
      this.log('warn', `refused ${job.name} on ${ticketId}: the ticket is blocked (${t.blockReason ?? 'no reason'})`);
      return 'done';
    }
    if (job.workspace === 'knowledge' && this.d.knowledgeConfigured === false) {
      this.log('info', `skipped ${job.name} on ${ticketId}: no knowledge repo configured`);
      if (opts.linearSessionId) {
        await this.d.tracker
          .activity(opts.linearSessionId, { type: 'response', body: `Aucune base de connaissance n'est configurée pour ${PRODUCT_NAME} : je ne peux rien retenir.` })
          .catch((err: Error) => this.log('warn', `could not answer ${ticketId}: ${err.message}`));
      }
      return 'done';
    }
    // Handed out of the queue: back in line through its claim (`releaseQueued`), not as a new request.
    const fromQueue = recorded !== undefined;
    const item = {
      projectId: project.id,
      ticketId,
      job: job.name,
      queue: job.queue,
      input: opts.input,
      inputText: opts.inputText,
      linearSessionId: opts.linearSessionId,
      resume: opts.resume,
      sensitivePaths: opts.sensitivePaths,
      priority: t.priority,
      enqueuedAt: opts.enqueuedAt ?? this.d.clock.now(),
      // Its own mark, not the effect's: the effect's is `1` once the start is queued.
      startMark: opts.startMark === undefined || fromQueue ? opts.startMark : `${opts.startMark}:queued`,
    };
    if (job.queue === 'dev' && (t.activeRunId || t.verifyingRunId)) {
      await this.apply(t, {
        type: 'pending.set',
        job: { job: job.name, input: opts.input, inputText: opts.inputText, resume: opts.resume, sensitivePaths: opts.sensitivePaths },
      });
      return 'done';
    }
    // Back in line: through its claim for a start handed out of the queue, as a new request otherwise.
    const requeue = async (): Promise<'queued'> => {
      if (!fromQueue) await this.d.scheduler.enqueue(item);
      return 'queued';
    };
    if (this.stopping || (await this.isPaused())) return requeue();
    if (await this.overBudget()) {
      const queued = await requeue();
      await this.noteBudget(project, ticketId);
      return queued;
    }
    const key = `${ticketId}:${job.queue}`;
    // A start from a decision leaves alone the slots a drain promised to the items it dequeued.
    const promised = admitted ? 0 : this.admitting[job.queue];
    const slot = this.d.scheduler.free(job.queue) > promised ? this.d.scheduler.tryAcquire(job.queue, key) : null;
    admitted?.();
    if (slot === null) return requeue();
    try {
      await this.launch(project, ticketId, job, opts, slot, key, recorded);
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
      // The ticket is blocked: a failed notice must not fail the effect, whose retry would start again.
      try {
        const session = opts.linearSessionId ?? (await this.sessionFor(fresh));
        await this.d.tracker.activity(session, { type: 'error', body: reason });
      } catch (e) {
        this.log('warn', `could not post the launch error of ${ticketId}: ${(e as Error).message}`);
      }
    }
    return 'done';
  }

  /**
   * Whether the start a mark (`StartOpts.startMark`) names was handled (ORC-277). A launch writes the
   * mark with its run's id before it puts the run on the ticket and writes it; an outbox effect sets
   * it to `1` once its start is handled. A run id whose run was never written is a launch cut before
   * it, which nothing launched: the start runs again. A written run, even never started by the
   * runner, is recover()'s (a dev ticket blocked, a question to ask again): never launched again.
   */
  private async startHandled(mark: string): Promise<boolean> {
    const value = await this.d.store.getMeta(mark);
    if (value === undefined) return false;
    return value === '1' || (await this.d.store.getRun(value)) !== undefined;
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

  private async launch(
    project: ProjectRuntime,
    ticketId: string,
    job: JobSpec,
    opts: StartOpts,
    slot: number,
    key: string,
    recorded?: () => Promise<void>,
  ): Promise<void> {
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

    // Read while the workspace is prepared; a pack it cannot read gives null fingerprints (ORC-226).
    const pack = packFingerprints(this.d.packDir, (err) => this.log('warn', `attempt labels: pack not fingerprinted: ${err.message}`));
    const runId = this.newId();
    const ws = await workspaces.prepare({
      projectId: project.id,
      repoPath: project.repoPath,
      ticketId,
      title: issue.title,
      kind: job.workspace,
      slot,
      portBase: wf.workspace.portBase,
      runId,
    });
    const sandbox = this.d.sandboxes && (await this.openSandbox(this.d.sandboxes, project, ticketId, ws, runId));
    // Until pump has it, the sandbox is the launch's: whatever ends the launch before destroys it.
    let handedOver = false;
    try {
      if (ws.fresh && wf.workspace.setup.length) await this.runSetup(project, ticketId, ws, sandbox);
      t = await this.ticket(project.id, ticketId);
      if (job.queue === 'dev') t = await this.apply(t, { type: 'workspace.prepared', path: ws.path, port: ws.port, branch: ws.branch });
      if (job.onStart.move && t.logical !== job.onStart.move) await this.move(project, t, job.onStart.move);
      t = await this.ticket(project.id, ticketId);

      const linearSessionId = opts.linearSessionId ?? (await this.sessionFor(t));
      t = await this.ticket(project.id, ticketId);

      // The feedback the run reads, taken at the launch whoever started it (a decision, settle, the queue):
      // its taint completes the one the start was decided with (I12, ORC-274).
      const kind = opts.input ?? job.input;
      const read: FeedbackItem[] = [];
      if (kind === 'feedback') {
        read.push(...t.pendingFeedback);
        // Review comments are external content: whoever can comment on the PR wrote them, and nothing
        // authenticates them as the team's (ORC-160). Untrusted, whatever the forge says.
        if (t.prNumber) {
          const comments = await forge.unresolvedReviewComments(project.repoPath, t.prNumber);
          read.push(...comments.map((c) => ({ ...c, taint: 'untrusted' as const })));
        }
      }
      const sensitivePaths = sensitivePathsAtLaunch(opts.sensitivePaths, read);
      if (sensitivePaths && job.workspace === 'knowledge') {
        // As decide refuses it (I12), for what it could not see: untrusted content read at the launch.
        this.d.scheduler.release(key);
        this.log('warn', `refused ${job.name} on ${ticketId}: it would write the knowledge base from untrusted content`);
        await tracker
          .activity(linearSessionId, { type: 'response', body: taintedKnowledge(job.name, 'read') })
          .catch((err: Error) => this.log('warn', `could not answer ${ticketId}: ${err.message}`));
        return;
      }

      const wantsResume = opts.resume ?? job.session === 'resume';
      const resume = wantsResume && !!t.claudeSessionId;
      const claudeSessionId = resume ? t.claudeSessionId! : this.newId();

      let input: { kind: InputKind; text: string } | undefined;
      if (kind === 'feedback') {
        input = { kind, text: read.length ? formatFeedback(read) : '(aucun retour écrit : relisez la PR et le fil Linear)' };
      } else if (kind === 'verify_failures') {
        input = { kind, text: formatVerifyFailures(JSON.parse(opts.inputText ?? '[]') as VerifyFailure[]) };
      } else if (kind === 'ci_failures') {
        input = { kind, text: opts.inputText ?? 'La CI de la PR est en échec. Lancez `gh pr checks` pour le détail.' };
      } else if (kind === 'thread') {
        input = { kind, text: opts.inputText ?? '' };
      }

      const promptInput = {
        skill: job.skill,
        issue: { identifier: issue.identifier, title: issue.title, description: issue.description, url: issue.url },
        branch: job.queue === 'dev' ? t.branch : undefined,
        prUrl: t.prUrl,
        input,
        reviewRounds: wf.limits.reviewRounds,
      };
      const prompt = buildPrompt(promptInput);
      const labels = attemptLabels({ job, prompt, promptInput, workflow: wf, pack: await pack, factoryCommit: this.d.factoryCommit });

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
        labels,
        sensitivePaths,
      };
      // The mark, then the ticket, then the run (`startHandled`, ORC-277): a dev ticket holds its run
      // before the run is written, so recover() blocks it whichever write a crash falls after.
      if (opts.startMark) await store.setMeta(opts.startMark, runId);
      await this.apply(t, { type: 'run.started', runId, job: job.name, queue: job.queue, claudeSessionId, feedbackConsumed: kind === 'feedback' });
      await store.putRun(run);
      // The run is written: a queued item it came from leaves the queue now (a crash from here on is recover()'s).
      // Logged, not thrown: the run is launched either way, and a queue item left behind is refused
      // when handed out again (its ticket has a run, or is blocked, or its mark names this run).
      await recorded?.().catch((err: Error) => this.log('warn', `queued ${job.name} on ${ticketId} not taken out of the queue: ${err.message}`));
      if (this.d.beforeRun) await this.d.beforeRun(run).catch((err: Error) => this.log('warn', `beforeRun: ${err.message}`));

      const handle = this.d.runner.start({
        runId,
        cwd: sandbox ? WORKSPACE_TARGET : ws.path,
        prompt,
        claudeSessionId,
        resume,
        model: job.model,
        pluginDir: sandbox ? PACK_TARGET : this.d.packDir,
        settingsPath: sandbox ? SETTINGS_TARGET : this.settingsPath(),
        readOnly: job.workspace === 'trunk-readonly',
        limits: job.limits,
        env: { ...this.d.agentEnv(run), ...(ws.port !== undefined ? { PORT: String(ws.port) } : {}) },
        sensitivePaths,
        ...(sandbox ? { sandboxId: sandbox.id } : {}),
      });
      this.handles.set(runId, handle);
      this.liveRuns.add(runId);
      this.track(this.pump(project, run, handle, sandbox?.id), runId);
      handedOver = true;
    } finally {
      if (sandbox && !handedOver) await this.destroySandbox(sandbox.id);
    }
  }

  /** Streams a run to its end, destroys its sandbox whatever the outcome, then writes its result to the inbox. */
  private async pump(project: ProjectRuntime, run: RunRecord, handle: RunHandle, sandboxId?: string): Promise<void> {
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
        ...(result.tokens ? { tokens: result.tokens } : {}),
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
    } finally {
      if (sandboxId) await this.destroySandbox(sandboxId);
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
