import { randomUUID } from 'node:crypto';
import type { RunHandle, RunResult, StagnationBounds } from '../adapters/runner/types.js';
import type { Sandbox, SandboxProvider } from '../adapters/sandbox/types.js';
import type { Tracker } from '../adapters/tracker/types.js';
import type { Workspace } from '../adapters/workspace/types.js';
import type { JobSpec, Workflow } from '../core/workflow.js';
import { Worker } from './worker.js';
import { FrozenFormatError, frozenWorkflow, workflowVersion } from './workflow-version.js';
import type { DecisionOutcome, DecisionRequest, EffectOutcome, OutboxRow, RunRecord, Store, WorkflowVersion } from '../store/types.js';
import { agentOutputKey, parseAgentOutput, type AgentOutput } from '../core/agent-output.js';
import { OutputPolicy, PolicedTracker } from '../publish/output-policy.js';
import { blockedLabelChange } from '../core/engine.js';
import { reduce } from '../core/reduce.js';
import type { StoredEvent } from '../core/upcast.js';
import type { InternalEvent, QueueName, FactoryEvent, TicketState } from '../core/types.js';
import type { EgressPolicy } from '../network/levels.js';
import type { StartFrom, StartOpts, StartOutcome } from './launch.js';
import type { DaemonDeps, ProjectRuntime } from './daemon.js';

/** Meta key of the head a ticket's tests step started on (ORC-123). */
export const redBaseKey = (projectId: string, ticketId: string): string => `red-base:${projectId}:${ticketId}`;

/**
 * The run's output, validated again: absent or invalid, the agent submitted none (ORC-289). A store
 * that cannot be read rejects: that is the infrastructure's, not the agent's.
 */
export async function storedOutput(store: Store, runId: string): Promise<AgentOutput | undefined> {
  const raw = await store.getMeta(agentOutputKey(runId));
  if (raw === undefined) return undefined;
  try {
    const parsed = parseAgentOutput(JSON.parse(raw));
    return parsed.ok ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** What only the runner knows of an attempt's end (ORC-136), kept on its row: recover() sends the same result if the process dies before it does. */
export function endFacts({ stagnation, infra, usageLimit, overBudget }: Pick<RunResult, 'stagnation' | 'infra' | 'usageLimit' | 'overBudget'>): Pick<RunResult, 'stagnation' | 'infra' | 'usageLimit' | 'overBudget'> {
  return { ...(stagnation ? { stagnation } : {}), ...(infra ? { infra } : {}), ...(usageLimit ? { usageLimit } : {}), ...(overBudget ? { overBudget } : {}) };
}

/**
 * What a run's stagnation is watched against (ORC-136, ORC-187). Only a dev job has its worktree read for a loop: `decide`
 * blocks no ticket on a question, whose checkout stays out of it.
 */
export function stagnationBounds(wf: Workflow, job: JobSpec): { stagnation: StagnationBounds & { silentMs: number } } {
  return { stagnation: { silentMs: wf.limits.silentAfterMs, ...(job.queue === 'dev' ? { repeats: wf.limits.repeatedFailures } : {}) } };
}

/** A read or write of the factory's state, as its caller takes its failure (`sessionFor`, `move`): as it is by default. */
export type StateIo = <T>(io: Promise<T>) => Promise<T>;

/** An outbox effect's idempotency key (ORC-162): `<ticket:seq:i>@<installation>`, and whether the row runs again. */
export interface EffectKey {
  id: string;
  replay: boolean;
  /** The inbox event the effect's decision came from. */
  eventId: string;
}

/** The inbox id of an attempt's result, and its key among the results kept (`deliver`). */
export const endKey = (runId: string): string => `attempt:${runId}:finished`;

/** The sandboxes of the take-overs (ORC-234): one per ticket, `take-over-<project>-<ticket>`, no attempt of an agent. */
export const takeOverKey = (projectId: string, ticketId: string): string => `take-over-${projectId}-${ticketId}`;

/** The daemon's state and what every part of it uses (ORC-394): the projects' workflows, a ticket's projection and its changes, the log. */
export abstract class DaemonBase {
  protected background = new Map<Promise<void>, string | undefined>();
  /** Runs whose event stream is still open (the runner is working, nothing for the factory to do): drained() does not wait for them. */
  protected liveRuns = new Set<string>();
  protected handles = new Map<string, RunHandle>();
  /**
   * The attempts this process follows (ORC-344), until their end is delivered: the token of their lease, which each of its
   * writes of them carries, when they last showed progress, how long a silence their lease outlives, and whether a stop
   * was asked of them. `ending`: their stream is over, their end on its way: no beat renews them, none takes them over.
   */
  protected held = new Map<string, { token: number; seenAt: number; silentMs: number; stopped?: true; ending?: true }>();
  protected beating = false;
  protected stopping = false;
  protected newId: () => string;
  /** Inbox writes in flight (accept). */
  protected writes = new Set<Promise<void>>();
  /** False until `replayInbox()` when `holdInboxUntilReplay` is set: `accept` then only writes. */
  protected dispatchOpen: boolean;
  /** The inbox worker (ORC-149): one task per ticket, a decision transaction per event. */
  protected readonly worker: Worker;
  /** The policy every published text goes through (ORC-214), and the tracker without it, for the live relay alone: its words are the factory's. */
  protected readonly policy: OutputPolicy;
  protected readonly relayTracker: Tracker;
  /** Versions of the projects' workflows, by workflow object. */
  private versionOfWorkflow = new WeakMap<Workflow, WorkflowVersion>();
  /** The frozen versions refused for their format (ORC-393), and the tickets whose refusal is logged, once each. */
  private refusedVersions = new Map<string, FrozenFormatError>();
  private refusedTickets = new Set<string>();
  /** Workflows by version hash: the current ones and those tickets are frozen on. */
  protected workflows = new Map<string, Workflow>();
  /** Dequeued items whose start has not taken its slot yet, per queue: drain hands out no more than the free slots. */
  protected admitting: Record<QueueName, number> = { dev: 0, questions: 0 };
  /** Runs of this daemon's launches that ended without letting go of their hold on the ticket (ORC-359): dead, whatever its time. */
  protected droppedHolds = new Set<string>();
  /** Until when each account's usage limit holds its launches (ORC-357), as last read from the store or written to it: read again at each drain and each start outside one. */
  protected usageHolds = new Map<string, number>();
  /** The holds the store failed to record (ORC-357): they still hold this daemon's launches. */
  protected unrecordedHolds = new Map<string, number>();
  /** Drains run one at a time. */
  protected draining: Promise<void> = Promise.resolve();
  protected instance: Promise<string> | undefined;
  /** Results this process could not write, the database down (ORC-343): written again at each beat (`supervise`), by id. */
  protected unwritten = new Map<string, { what: string; write: () => Promise<void> }>();

  constructor(protected d: DaemonDeps) {
    this.policy = d.outputPolicy ?? new OutputPolicy();
    this.relayTracker = d.tracker;
    this.d = { ...d, tracker: new PolicedTracker(d.tracker, this.policy, (m) => this.log('warn', m)) };
    this.newId = d.newId ?? randomUUID;
    this.dispatchOpen = !d.holdInboxUntilReplay;
    this.worker = new Worker({
      store: d.store,
      log: (level, message) => this.log(level, message),
      prepare: (event) => this.prepared(event),
      request: (event) => this.request(event),
      committed: (event, outcome) => this.committed(event, outcome),
      execute: (row) => this.execute(row),
      noEffect: (projectId) => this.noEffect(projectId),
      ...(d.keptEffectsDir ? { keep: (row: OutboxRow) => this.keep(row, d.keptEffectsDir!) } : {}),
      leaseMs: d.effectLeaseMs,
      retry: d.processRetry,
      left: (row) => void this.freeSlot(row),
      deadLettered: (row) => void this.freeSlot(row),
      effectRetry: d.effectRetry,
      now: () => d.clock.now(),
    });
  }

  project(id: string): ProjectRuntime {
    const p = this.d.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    return p;
  }

  protected log(level: 'info' | 'warn' | 'error', message: string): void {
    this.d.bus.publish({ kind: 'log', level, message, at: this.d.clock.now() });
  }

  protected track(p: Promise<void>, runId?: string): void {
    const wrapped = p.catch((err: unknown) => this.log('error', (err as Error).message)).finally(() => this.background.delete(wrapped));
    this.background.set(wrapped, runId);
  }

  /**
   * The only way the orchestrator changes a ticket outside a decision (an effect recording what it
   * did): through `reduce`, on the projection read again under the ticket's lock.
   */
  protected async apply(t: TicketState, ...events: InternalEvent[]): Promise<TicketState> {
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
      await this.setLabels(t.projectId, t.ticketId, label.add, label.remove).catch((e: Error) => this.log('warn', `could not set the label of ${t.ticketId}: ${e.message}`));
    }
    return next;
  }

  /** The version of a project's workflow now: a ticket's first decision freezes it (ORC-149). */
  protected currentVersion(project: ProjectRuntime): WorkflowVersion {
    let v = this.versionOfWorkflow.get(project.workflow);
    if (!v) {
      v = workflowVersion(project.workflow);
      this.versionOfWorkflow.set(project.workflow, v);
      this.workflows.set(v.hash, project.workflow);
    }
    return v;
  }

  /** The workflow of a version a ticket is frozen on: one of another format refuses the ticket (ORC-393). */
  protected workflowOf(version: WorkflowVersion, projectId: string, ticketId: string | undefined): Workflow {
    let wf = this.workflows.get(version.hash);
    if (!wf) {
      try {
        wf = frozenWorkflow(version);
      } catch (err) {
        if (err instanceof FrozenFormatError) this.refuse(version.hash, projectId, ticketId, err);
        throw err;
      }
      this.workflows.set(version.hash, wf);
    }
    return wf;
  }

  /** A ticket refused for the format of its frozen version: in the daemon's log, and told on the ticket (ORC-419), once per ticket while its notice holds. */
  private refuse(hash: string, projectId: string, ticketId: string | undefined, err: FrozenFormatError): void {
    this.refusedVersions.set(hash, err);
    const key = `${ticketId ?? ''}:${hash}`;
    if (this.refusedTickets.has(key)) return;
    this.refusedTickets.add(key);
    this.log('error', `${ticketId ?? 'an event'} refused: ${err.message}`);
    // A notice that fails lets the ticket's next event log and tell it again.
    if (ticketId) this.track(this.tellRefusal(projectId, ticketId, hash).catch((e: Error) => {
      this.refusedTickets.delete(key);
      this.log('warn', `could not post the refusal of ${ticketId}: ${e.message}`);
    }));
  }

  /** The notice of a ticket refused for the format of its frozen version (ORC-419): a write to the tracker, outside any decision. */
  protected abstract tellRefusal(projectId: string, ticketId: string, hash: string): Promise<void>;

  /** The project as a ticket sees it: with the workflow version the ticket is frozen on. */
  /** `known`: the ticket, when the caller has just read it (`null`: read, and not tracked). */
  protected async runtimeFor(projectId: string, ticketId: string | undefined, known?: TicketState | null): Promise<ProjectRuntime | undefined> {
    const found = projectId === '*' ? this.d.projects[0] : this.project(projectId);
    if (!found || !ticketId) return found;
    // A replayed ticket (ORC-376) runs on its clone, and reads the ticket as it was.
    const replayed = await this.d.replays?.of(found.id, ticketId);
    const project = replayed ? { ...found, repoPath: replayed.repoPath, replayed } : found;
    const hash = (known === undefined ? await this.d.store.getTicket(project.id, ticketId) : known)?.workflowHash;
    if (!hash || hash === this.currentVersion(project).hash) return project;
    let workflow = this.workflows.get(hash);
    if (!workflow) {
      // A ticket refused for its version's format (ORC-393) has no runtime: nothing is launched, executed nor kept for it.
      const refused = this.refusedVersions.get(hash);
      if (refused) {
        this.refuse(hash, project.id, ticketId, refused);
        return undefined;
      }
      const stored = await this.d.store.getWorkflowVersion(hash);
      if (!stored) throw new Error(`workflow version ${hash} of ${ticketId} is not stored`);
      try {
        workflow = this.workflowOf(stored, project.id, ticketId);
      } catch (err) {
        if (err instanceof FrozenFormatError) return undefined;
        throw err;
      }
    }
    return { ...project, workflow };
  }

  protected async ticket(projectId: string, ticketId: string): Promise<TicketState> {
    const t = await this.d.store.getTicket(projectId, ticketId);
    if (!t) throw new Error(`unknown ticket ${ticketId}`);
    return t;
  }

  /** A project without effects (ORC-231): the outbox keeps its effects, and the orchestrator makes none of its writes outside it. */
  protected noEffect(projectId: string): boolean {
    return this.d.projects.find((p) => p.id === projectId)?.effects === 'none';
  }

  /** Whether `what`, a write to Linear made outside the outbox, is left out because its project has no effects: said in the log. */
  protected silenced(projectId: string, what: string): boolean {
    if (!this.noEffect(projectId)) return false;
    this.log('info', `${what} not made: the project has no effects`);
    return true;
  }

  /**
   * Labels written by the factory (ORC-346): what the write set goes into the labels known (`labelsWritten`), so a pass
   * that reads the ticket after its webhook was lost sees no human change. Its webhook is known by its actor.
   */
  protected async setLabels(projectId: string, ticketId: string, add: string[], remove: string[]): Promise<void> {
    await this.d.labelsWritten?.(projectId, ticketId, await this.d.tracker.setLabels(ticketId, add, remove));
  }

  // Provided by the classes above (ORC-394), each in its module.
  abstract accept(event: FactoryEvent | StoredEvent): Promise<boolean>;
  abstract wake(): void;
  protected abstract submitResult(event: FactoryEvent): Promise<void>;
  protected abstract deliver(id: string, what: string, write: () => Promise<void>): Promise<void>;
  protected abstract follow(runId: string, handle: RunHandle, token: number, silentMs: number): void;
  protected abstract stopRun(runId: string): void;
  protected abstract destroySandbox(id: string, runId: string, owner?: RunRecord): Promise<void>;
  protected abstract openSandbox(sandboxes: SandboxProvider, project: ProjectRuntime, ticketId: string, ws: Workspace, runId: string, ticketSession: boolean, policy: EgressPolicy, services?: readonly string[]): Promise<Sandbox>;
  protected abstract prepared(event: FactoryEvent): Promise<FactoryEvent>;
  protected abstract request(event: FactoryEvent): DecisionRequest;
  protected abstract freeSlot(row: StoredEvent): Promise<void>;
  protected abstract committed(event: FactoryEvent, outcome: Extract<DecisionOutcome, { status: 'committed' }>): Promise<void>;
  protected abstract execute(row: OutboxRow): Promise<EffectOutcome | void>;
  protected abstract keep(row: OutboxRow, dir: string): Promise<void>;
  protected abstract drain(queue: QueueName): Promise<void>;
  protected abstract startRun(project: ProjectRuntime, ticketId: string, opts: StartOpts, from?: StartFrom): Promise<StartOutcome>;
  protected abstract startHandled(mark: string): Promise<boolean>;
}
