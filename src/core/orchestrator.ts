import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Forge } from '../adapters/forge/types.js';
import type { RunHandle, RunResult, Runner } from '../adapters/runner/types.js';
import { ActivityRelay } from '../adapters/tracker/activity-relay.js';
import type { Tracker } from '../adapters/tracker/types.js';
import type { WorkspaceManager } from '../adapters/workspace/types.js';
import type { JobSpec, Workflow } from '../config/workflow-schema.js';
import type { RunRecord, Store } from '../store/types.js';
import type { EventBus } from './bus.js';
import type { Clock } from './clock.js';
import type { Command } from './commands.js';
import { decide } from './engine.js';
import { pickupFailures } from './pickup.js';
import { buildPrompt, formatFeedback, formatVerifyFailures } from './prompt.js';
import type { Scheduler } from './scheduler.js';
import {
  newTicketState,
  type EventType,
  type InputKind,
  type LogicalState,
  type QueueName,
  type RelaisEvent,
  type TicketState,
  type VerifyFailure,
} from './types.js';
import type { Verifier } from './verify.js';

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
}

interface StartOpts {
  job: string;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
}

const CREATES_TICKET = new Set<EventType>(['ticket.delegated', 'session.mentioned', 'command', 'session.prompted']);
const SETTLES_RUN = new Set<EventType>(['run.finished', 'verify.passed', 'verify.failed']);
const ECHO_MS = 60_000;
const MAX_QUESTION_SESSIONS = 50;

export function logicalFromName(states: Record<LogicalState, string>, name: string): LogicalState | undefined {
  return (Object.entries(states) as [LogicalState, string][]).find(([, n]) => n === name)?.[0];
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export class Orchestrator {
  private chain: Promise<void> = Promise.resolve();
  private background = new Map<Promise<void>, string | undefined>();
  /** Runs whose event stream is still open (the runner is working, nothing for Relais to do): idle() does not wait for them. */
  private liveRuns = new Set<string>();
  private handles = new Map<string, RunHandle>();
  private stopping = false;
  /** French notices for Linear, collected by recover() and posted once Linear is reachable. */
  private recoveryNotices: ({ ticket: { projectId: string; ticketId: string } } | { sessionId: string }) & {
    type: 'elicitation' | 'error';
    body: string;
  }[] = [];
  private newId: () => string;

  constructor(private d: OrchestratorDeps) {
    this.newId = d.newId ?? randomUUID;
  }

  submit(event: RelaisEvent): Promise<void> {
    const next = this.chain
      .then(() => this.handle(event))
      .catch((err: unknown) => this.log('error', `event ${event.id} (${event.type}): ${(err as Error).message}`));
    this.chain = next;
    return next;
  }

  async idle(): Promise<void> {
    for (;;) {
      // Note: setImmediate is incompatible with fake timers (vi.useFakeTimers fakes it by default).
      // Let promise continuations of a just-released/finished runner settle before sampling the state.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const chain = this.chain;
      await chain;
      const pending = this.pendingBackground();
      await Promise.all(pending);
      if (chain === this.chain && pending.length === 0 && this.pendingBackground().length === 0) return;
    }
  }

  private pendingBackground(): Promise<void>[] {
    return [...this.background].filter(([, runId]) => runId === undefined || !this.liveRuns.has(runId)).map(([p]) => p);
  }

  /**
   * Settles runs cut by a crash (`running`) or a shutdown (`interrupted`) and blocks their tickets.
   * The matching Linear notices are posted by announceRecovery().
   */
  recover(): void {
    const { store } = this.d;
    const block = (t: TicketState, reason: string): void => {
      t.activeRunId = undefined;
      t.verifyingRunId = undefined;
      t.blocked = true;
      t.blockReason = reason;
      this.putTicket(t);
      this.recoveryNotices.push({ ticket: { projectId: t.projectId, ticketId: t.ticketId }, type: 'elicitation', body: reason });
    };
    const cut = [...store.runsByStatus('running'), ...store.runsByStatus('interrupted')];
    for (const run of cut) {
      store.putRun({ ...run, status: run.status === 'interrupted' ? 'stopped' : 'failure', endedAt: run.endedAt ?? this.d.clock.now() });
      if (run.queue === 'questions' && run.linearSessionId) {
        this.recoveryNotices.push({
          sessionId: run.linearSessionId,
          type: 'error',
          body: 'Relais a redémarré pendant ma réponse. Reposez la question dans ce fil.',
        });
      }
    }
    for (const t of store.listTickets()) {
      if (t.activeRunId) {
        const r = store.getRun(t.activeRunId);
        if (!r || r.status !== 'running') block(t, 'Relais a redémarré pendant le run. Répondez dans le fil pour relancer.');
      }
      if (t.verifyingRunId) block(t, 'Relais a redémarré pendant les vérifications. Répondez dans le fil pour relancer.');
    }
  }

  /** Best effort: posts the notices collected by recover(); a failure is logged, never retried. */
  announceRecovery(): Promise<void> {
    const notices = this.recoveryNotices;
    this.recoveryNotices = [];
    const next = this.chain.then(async () => {
      for (const n of notices) {
        try {
          let session: string;
          if ('sessionId' in n) session = n.sessionId;
          else {
            const t = this.d.store.getTicket(n.ticket.projectId, n.ticket.ticketId);
            if (!t) continue;
            session = await this.sessionFor(t);
          }
          await this.d.tracker.activity(session, { type: n.type, body: n.body });
        } catch (err) {
          this.log('warn', `recovery notice not posted: ${(err as Error).message}`);
        }
      }
    });
    this.chain = next;
    return next;
  }

  async tick(): Promise<void> {
    const next = this.chain
      .then(async () => {
        await this.drain('dev');
        await this.drain('questions');
      })
      .catch((err: unknown) => this.log('error', `tick: ${(err as Error).message}`));
    this.chain = next;
    return next;
  }

  stopAll(): void {
    this.stopping = true;
    for (const h of this.handles.values()) h.stop();
    // Stopped runs are no longer "live": idle() must wait for their pumps to persist the final status.
    this.liveRuns.clear();
  }

  project(id: string): ProjectRuntime {
    const p = this.d.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    return p;
  }

  isPaused(): boolean {
    return this.d.store.getMeta('paused') === '1';
  }

  private overBudget(): boolean {
    const budget = this.d.dailyBudgetUsd;
    return budget !== undefined && this.d.store.costSince(startOfUtcDay(this.d.clock.now())) >= budget;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.d.bus.publish({ kind: 'log', level, message, at: this.d.clock.now() });
  }

  private track(p: Promise<void>, runId?: string): void {
    const wrapped = p.catch((err: unknown) => this.log('error', (err as Error).message)).finally(() => this.background.delete(wrapped));
    this.background.set(wrapped, runId);
  }

  private putTicket(t: TicketState): void {
    t.updatedAt = this.d.clock.now();
    this.d.store.putTicket(t);
    this.d.bus.publish({ kind: 'ticket', ticket: t });
  }

  private ticket(projectId: string, ticketId: string): TicketState {
    const t = this.d.store.getTicket(projectId, ticketId);
    if (!t) throw new Error(`unknown ticket ${ticketId}`);
    return t;
  }

  private async createTicket(project: ProjectRuntime, ticketId: string): Promise<TicketState> {
    const issue = await this.d.tracker.getIssue(ticketId);
    const logical = logicalFromName(project.workflow.states, issue.stateName) ?? 'todo';
    const t = newTicketState(project.id, ticketId, issue.title, logical, this.d.clock.now(), issue.priority);
    this.putTicket(t);
    return t;
  }

  private async handle(event: RelaisEvent): Promise<void> {
    const { store, bus } = this.d;
    if (!store.recordEvent(event)) return;
    bus.publish({ kind: 'event', event });

    if (event.projectId === '*') {
      const workflow = this.d.projects[0]?.workflow;
      if (!workflow) return;
      for (const c of decide(event, undefined, { workflow })) await this.exec(this.d.projects[0]!, undefined, c);
      return;
    }

    const project = this.project(event.projectId);
    let ticket = event.ticketId ? store.getTicket(project.id, event.ticketId) : undefined;
    if (!ticket && event.ticketId) {
      if (!CREATES_TICKET.has(event.type)) {
        this.log('info', `ignored ${event.type} for unmanaged ticket ${event.ticketId}`);
        return;
      }
      ticket = await this.createTicket(project, event.ticketId);
    }

    let activeJob = ticket?.activeRunId ? store.getRun(ticket.activeRunId)?.job : undefined;
    if (ticket) {
      if (event.type === 'ticket.delegated') {
        ticket.delegated = true;
        if (event.payload.linearSessionId && !ticket.linearSessionId) ticket.linearSessionId = event.payload.linearSessionId;
      }
      if (event.type === 'ticket.undelegated') ticket.delegated = false;
      if ((event.type === 'session.mentioned' || event.type === 'command') && event.payload.linearSessionId !== ticket.linearSessionId) {
        const ids = ticket.questionSessionIds.filter((id) => id !== event.payload.linearSessionId);
        ticket.questionSessionIds = [...ids, event.payload.linearSessionId].slice(-MAX_QUESTION_SESSIONS);
      }
      if (event.type === 'ticket.moved' && event.payload.to) ticket.logical = event.payload.to;
      if (event.type === 'run.finished') {
        const run = store.getRun(event.payload.runId);
        if (run) {
          this.d.scheduler.release(`${run.ticketId}:${run.queue}`);
          if (run.queue === 'dev' && ticket.activeRunId === run.id) ticket.activeRunId = undefined;
        }
        ticket.costUsd += event.payload.costUsd;
        activeJob = event.payload.job;
      }
      if (event.type === 'verify.passed' || event.type === 'verify.failed') {
        if (event.payload.runId !== ticket.verifyingRunId) {
          this.log('info', `ignored stale ${event.type} for ${ticket.ticketId} (run ${event.payload.runId})`);
          return;
        }
        ticket.verifyingRunId = undefined;
      }
      this.putTicket(ticket);
    }

    const commands = decide(event, ticket, { workflow: project.workflow, activeJob });
    for (const c of commands) {
      bus.publish({ kind: 'command', projectId: project.id, ticketId: ticket?.ticketId, command: c });
      try {
        await this.exec(project, ticket?.ticketId, c);
      } catch (err) {
        const message = (err as Error).message;
        this.log('error', `command ${c.kind} for ${ticket?.ticketId ?? '*'}: ${message}`);
        if (!ticket) throw err;
        await this.failTicket(project, ticket.ticketId, `Erreur : ${message}`);
        break;
      }
    }

    if (ticket && SETTLES_RUN.has(event.type)) await this.settle(project, ticket.ticketId);
  }

  private async failTicket(project: ProjectRuntime, ticketId: string, reason: string): Promise<void> {
    const t = this.d.store.getTicket(project.id, ticketId);
    if (!t) return;
    t.blocked = true;
    t.blockReason = reason;
    this.putTicket(t);
    try {
      const session = await this.sessionFor(t);
      await this.d.tracker.activity(session, { type: 'error', body: reason });
    } catch (err) {
      this.log('warn', `could not post error activity for ${ticketId}: ${(err as Error).message}`);
    }
  }

  private async settle(project: ProjectRuntime, ticketId: string): Promise<void> {
    const t = this.ticket(project.id, ticketId);
    if (!t.activeRunId && !t.verifyingRunId && t.pendingJob) {
      const pending = t.pendingJob;
      t.pendingJob = undefined;
      this.putTicket(t);
      await this.startRun(project, ticketId, pending);
    }
    await this.drain('dev');
    await this.drain('questions');
  }

  private async drain(queue: QueueName): Promise<void> {
    if (this.stopping) return;
    const n = this.d.store.listQueue().filter((q) => q.queue === queue).length;
    for (let i = 0; i < n; i++) {
      if (this.isPaused() || this.overBudget() || !this.d.scheduler.hasFree(queue)) return;
      const item = this.d.scheduler.next(queue);
      if (!item) return;
      await this.startRun(this.project(item.projectId), item.ticketId, item);
    }
  }

  private async exec(project: ProjectRuntime, ticketId: string | undefined, c: Command): Promise<void> {
    const { store, tracker, clock } = this.d;
    if (c.kind === 'set_paused') {
      store.setMeta('paused', c.paused ? '1' : '0');
      if (!c.paused) {
        await this.drain('dev');
        await this.drain('questions');
      }
      return;
    }
    if (!ticketId) return;
    const t = this.ticket(project.id, ticketId);
    switch (c.kind) {
      case 'start_run':
        return this.startRun(project, ticketId, c);
      case 'stop_run': {
        if (c.linearSessionId) {
          for (const r of store.runsByStatus('running')) {
            if (r.projectId === project.id && r.ticketId === ticketId && r.linearSessionId === c.linearSessionId) this.handles.get(r.id)?.stop();
          }
          return;
        }
        t.pendingJob = undefined;
        t.verifyingRunId = undefined;
        this.putTicket(t);
        store.removeFromQueue(project.id, ticketId);
        store.deleteTimersFor(project.id, ticketId);
        if (t.activeRunId) this.handles.get(t.activeRunId)?.stop();
        return;
      }
      case 'run_verify': {
        const run = store.getRun(c.runId);
        const job = project.workflow.jobs[c.job];
        if (!run || !job) return;
        t.verifyingRunId = run.id;
        this.putTicket(t);
        this.track(
          (async () => {
            const res = await this.d.verify(run.cwd, job.verify);
            const base = { at: clock.now(), projectId: project.id, ticketId };
            const event: RelaisEvent = res.ok
              ? { ...base, id: `verify:${run.id}`, type: 'verify.passed', payload: { runId: run.id, job: job.name } }
              : { ...base, id: `verify:${run.id}`, type: 'verify.failed', payload: { runId: run.id, job: job.name, failures: res.failures } };
            void this.submit(event);
          })(),
        );
        return;
      }
      case 'move':
        return this.move(project, t, c.to);
      case 'labels': {
        for (const l of c.add) store.putEcho(`label:${ticketId}:${l}`, clock.now() + ECHO_MS);
        await tracker.setLabels(ticketId, c.add, c.remove);
        return;
      }
      case 'comment':
        return tracker.comment(ticketId, c.body);
      case 'activity': {
        const fromRun = c.runId ? store.getRun(c.runId)?.linearSessionId : undefined;
        const session = c.linearSessionId ?? fromRun ?? (await this.sessionFor(t));
        return tracker.activity(session, { type: c.type, body: c.body });
      }
      case 'post_output': {
        const run = store.getRun(c.runId);
        if (!run) return;
        const session = run.linearSessionId ?? (await this.sessionFor(t));
        return tracker.activity(session, { type: 'response', body: run.lastText.trim() || 'Terminé.' });
      }
      case 'link_pr':
        if (t.linearSessionId) await tracker.addExternalUrl(t.linearSessionId, 'Pull request', c.url);
        return;
      case 'set_debounce':
        store.putTimer({ key: `${ticketId}:${c.job}`, projectId: project.id, ticketId, job: c.job, fireAt: clock.now() + c.ms });
        return;
      case 'append_feedback':
        t.pendingFeedback.push(c.item);
        return this.putTicket(t);
      case 'cleanup':
        await this.d.workspaces.cleanup(project.id, project.repoPath, ticketId);
        t.worktreePath = undefined;
        t.port = undefined;
        return this.putTicket(t);
      case 'block':
        t.blocked = true;
        t.blockReason = c.reason;
        return this.putTicket(t);
      case 'unblock':
        t.blocked = false;
        t.blockReason = undefined;
        return this.putTicket(t);
      case 'patch_ticket':
        Object.assign(t, c.patch);
        return this.putTicket(t);
    }
  }

  private async sessionFor(t: TicketState): Promise<string> {
    if (t.linearSessionId) return t.linearSessionId;
    const s = await this.d.tracker.ensureSession(t.ticketId);
    t.linearSessionId = s;
    this.putTicket(t);
    return s;
  }

  private async move(project: ProjectRuntime, t: TicketState, to: LogicalState): Promise<void> {
    const stateName = project.workflow.states[to];
    this.d.store.putEcho(`state:${t.ticketId}:${stateName}`, this.d.clock.now() + ECHO_MS);
    await this.d.tracker.moveTo(t.ticketId, stateName);
    const fresh = this.ticket(project.id, t.ticketId);
    fresh.logical = to;
    this.putTicket(fresh);
  }

  private async startRun(project: ProjectRuntime, ticketId: string, opts: StartOpts): Promise<void> {
    const job = project.workflow.jobs[opts.job];
    if (!job) return this.log('error', `unknown job ${opts.job}`);
    const t = this.ticket(project.id, ticketId);
    if (job.queue === 'dev' && !t.delegated) {
      return this.log('warn', `refused ${job.name} on ${ticketId}: the ticket is not delegated to Relais`);
    }
    if (job.workspace === 'knowledge' && this.d.knowledgeConfigured === false) {
      this.log('info', `skipped ${job.name} on ${ticketId}: no knowledge repo configured`);
      if (opts.linearSessionId) {
        await this.d.tracker
          .activity(opts.linearSessionId, { type: 'response', body: "Aucune base de connaissance n'est configurée pour Relais : je ne peux rien retenir." })
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
      enqueuedAt: this.d.clock.now(),
    };
    if (job.queue === 'dev' && (t.activeRunId || t.verifyingRunId)) {
      t.pendingJob = { job: job.name, input: opts.input, inputText: opts.inputText, resume: opts.resume };
      return this.putTicket(t);
    }
    if (this.stopping || this.isPaused()) return this.d.scheduler.enqueue(item);
    if (this.overBudget()) {
      this.d.scheduler.enqueue(item);
      await this.noteBudget(project, ticketId);
      return;
    }
    const key = `${ticketId}:${job.queue}`;
    const slot = this.d.scheduler.tryAcquire(job.queue, key);
    if (slot === null) return this.d.scheduler.enqueue(item);
    try {
      await this.launch(project, ticketId, job, opts, slot, key);
    } catch (err) {
      this.d.scheduler.release(key);
      const fresh = this.ticket(project.id, ticketId);
      if (fresh.activeRunId) {
        const r = this.d.store.getRun(fresh.activeRunId);
        if (r && r.status === 'running' && !this.handles.has(r.id)) this.d.store.putRun({ ...r, status: 'failure', endedAt: this.d.clock.now() });
        if (!this.handles.has(fresh.activeRunId)) fresh.activeRunId = undefined;
      }
      fresh.blocked = true;
      fresh.blockReason = `Erreur au lancement : ${(err as Error).message}`;
      this.putTicket(fresh);
      const session = opts.linearSessionId ?? (await this.sessionFor(fresh));
      await this.d.tracker.activity(session, { type: 'error', body: fresh.blockReason });
    }
  }

  private async noteBudget(project: ProjectRuntime, ticketId: string): Promise<void> {
    const day = new Date(this.d.clock.now()).toISOString().slice(0, 10);
    const key = `budget:${day}:${project.id}:${ticketId}`;
    if (this.d.store.getMeta(key)) return;
    this.d.store.setMeta(key, '1');
    await this.d.tracker.comment(
      ticketId,
      "Budget journalier de Relais atteint : ce ticket reste en file jusqu'à demain (ou jusqu'à une hausse du plafond).",
    );
  }

  private async launch(project: ProjectRuntime, ticketId: string, job: JobSpec, opts: StartOpts, slot: number, key: string): Promise<void> {
    const { tracker, store, clock, workspaces, forge } = this.d;
    const wf = project.workflow;
    const issue = await tracker.getIssue(ticketId);
    let t = this.ticket(project.id, ticketId);

    if (job.pickup && !t.claudeSessionId) {
      const failures = await pickupFailures(wf.tracker.pickup.checks, issue, project.repoPath, workspaces);
      if (failures.length) {
        this.d.scheduler.release(key);
        t.blocked = true;
        t.blockReason = failures.join(' ');
        this.putTicket(t);
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
    t = this.ticket(project.id, ticketId);
    if (job.queue === 'dev') {
      t.worktreePath = ws.path;
      t.port = ws.port;
      if (ws.branch) t.branch = ws.branch;
      this.putTicket(t);
    }
    if (job.onStart.move && t.logical !== job.onStart.move) await this.move(project, t, job.onStart.move);
    t = this.ticket(project.id, ticketId);

    const linearSessionId = opts.linearSessionId ?? (await this.sessionFor(t));
    t = this.ticket(project.id, ticketId);

    const wantsResume = opts.resume ?? job.session === 'resume';
    const resume = wantsResume && !!t.claudeSessionId;
    const claudeSessionId = resume ? t.claudeSessionId! : this.newId();
    if (job.queue === 'dev' && !t.claudeSessionId) t.claudeSessionId = claudeSessionId;

    const kind = opts.input ?? job.input;
    let input: { kind: InputKind; text: string } | undefined;
    if (kind === 'feedback') {
      const items = [...t.pendingFeedback];
      if (t.prNumber) items.push(...(await forge.unresolvedReviewComments(project.repoPath, t.prNumber)));
      t.pendingFeedback = [];
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
    store.putRun(run);
    if (job.queue === 'dev') t.activeRunId = runId;
    this.putTicket(t);
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
      const rec = store.getRun(run.id) ?? run;
      const interrupted = this.stopping && result.outcome === 'stopped';
      store.putRun({
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
        const rec = store.getRun(run.id) ?? run;
        store.putRun({ ...rec, status: 'failure', endedAt: clock.now(), lastText: message });
      } catch (e) {
        this.log('error', `could not record failure of run ${run.id}: ${(e as Error).message}`);
      }
      result = { outcome: 'failure', costUsd: 0, turns: 0, lastText: message };
    }
    await this.submit({
      id: `run:${run.id}:finished`,
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
