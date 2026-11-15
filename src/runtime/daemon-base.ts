import { randomUUID } from 'node:crypto';
import type { RunHandle } from '../adapters/runner/types.js';
import type { Sandbox, SandboxProvider } from '../adapters/sandbox/types.js';
import type { Tracker } from '../adapters/tracker/types.js';
import type { Workspace } from '../adapters/workspace/types.js';
import type { Workflow } from '../core/workflow.js';
import { Worker } from './worker.js';
import { FrozenFormatError, frozenWorkflow, workflowVersion } from './workflow-version.js';
import type { DecisionOutcome, DecisionRequest, EffectOutcome, OutboxRow, RunRecord, WorkflowVersion } from '../store/types.js';
import { OutputPolicy, PolicedTracker } from '../publish/output-policy.js';
import { blockedLabelChange } from '../core/engine.js';
import { reduce } from '../core/reduce.js';
import type { StoredEvent } from '../core/upcast.js';
import type { InternalEvent, QueueName, FactoryEvent, TicketState } from '../core/types.js';
import type { EgressPolicy } from '../network/levels.js';
import type { DaemonDeps, ProjectRuntime, StartFrom, StartOpts, StartOutcome } from './daemon.js';

/** Meta key of the head a ticket's tests step started on (ORC-123). */
export const redBaseKey = (projectId: string, ticketId: string): string => `red-base:${projectId}:${ticketId}`;

/** A read or write of the factory's state, as its caller takes its failure (`sessionFor`, `move`): as it is by default. */
export type StateIo = <T>(io: Promise<T>) => Promise<T>;

export interface EffectKey {
  id: string;
  replay: boolean;
  /** The inbox event the effect's decision came from. */
  eventId: string;
}

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

  /**
   * The one way in for an event (ORC-147): writes it to the inbox and resolves once the row is
   * committed, then lets the worker process it from the inbox. Resolves `false` for an id the
   * inbox already holds (a duplicate: nothing more happens). Rejects when the write fails: the
   * event was not taken, and the producer must report it (a webhook answers 500).
   */

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
  protected workflowOf(version: WorkflowVersion, ticketId: string | undefined): Workflow {
    let wf = this.workflows.get(version.hash);
    if (!wf) {
      try {
        wf = frozenWorkflow(version);
      } catch (err) {
        if (err instanceof FrozenFormatError) this.refuse(version.hash, ticketId, err);
        throw err;
      }
      this.workflows.set(version.hash, wf);
    }
    return wf;
  }

  /** A ticket refused for the format of its frozen version: in the daemon's log, once per ticket. */
  private refuse(hash: string, ticketId: string | undefined, err: FrozenFormatError): void {
    this.refusedVersions.set(hash, err);
    const key = `${ticketId ?? ''}:${hash}`;
    if (this.refusedTickets.has(key)) return;
    this.refusedTickets.add(key);
    this.log('error', `${ticketId ?? 'an event'} refused: ${err.message}`);
  }

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
        this.refuse(hash, ticketId, refused);
        return undefined;
      }
      const stored = await this.d.store.getWorkflowVersion(hash);
      if (!stored) throw new Error(`workflow version ${hash} of ${ticketId} is not stored`);
      try {
        workflow = this.workflowOf(stored, ticketId);
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

  /**
   * An event that starts tracking a ticket must carry its snapshot, so that `decide` and a replay of the
   * journal never read the tracker. A producer that could not fill it gets it filled here, before journaling.
   * An issue the tracker no longer finds (deleted meanwhile, ORC-302) leaves it without one: its decision
   * ignores it, journaled, instead of retrying a read that would fail again. Any other read error throws: retried.
   */

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
   * An effect of a project without effects (ORC-231), kept instead of made: what it would have written, as a JSON file and its row in
   * `artifacts`, once by the row's id. A `publish` keeps the PR it would have opened, its title, its body and the ticket's diff, then
   * goes on as a publication does (`publish.done`), so the run ends as it would have; a `reconcile` reads nothing and keeps nothing.
   */
  protected async setLabels(projectId: string, ticketId: string, add: string[], remove: string[]): Promise<void> {
    await this.d.labelsWritten?.(projectId, ticketId, await this.d.tracker.setLabels(ticketId, add, remove));
  }

  /**
   * Plans each project's reconciliation in the store (ORC-185), in `RECONCILE_MS` (the connection to Linear passes
   * at once), unless a timer already plans it (a restart): its firings then arm the next ones. The timer of a
   * project gone from the configuration is deleted: it would fire for a project the factory no longer knows.
   */

  // Provided by the classes above (ORC-394), each in its module.
  abstract accept(event: FactoryEvent | StoredEvent): Promise<boolean>;
  abstract wake(): void;
  protected abstract submitResult(event: FactoryEvent): Promise<void>;
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
