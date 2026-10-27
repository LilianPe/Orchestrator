import type { OutboxEffect } from '../core/decision.js';
import { TRUSTED, type InputKind, type QueueName, type FactoryEvent, type RunOutcome, type TicketState } from '../core/types.js';
import type { StoredEvent } from '../core/upcast.js';

/**
 * Lease of a claimed outbox row or queue item (ORC-129): 60 s, renewed every 20 s by its holder
 * while the effect runs. A holder that dies leaves the row to another once it expires.
 */
export const LEASE_MS = 60_000;

export interface RunRecord {
  id: string;
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  /** `interrupted`: cut by a daemon shutdown; recover() settles it on the next start. */
  status: 'running' | 'interrupted' | RunOutcome;
  claudeSessionId: string;
  linearSessionId?: string;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  turns: number;
  lastText: string;
  token: string;
  cwd: string;
}

export interface TimerRecord {
  key: string;
  projectId: string;
  ticketId: string;
  job: string;
  fireAt: number;
  /** Id of the event whose decision armed the timer (ORC-149): a failed effect of that decision disarms it. */
  armedBy?: string;
}

export interface QueueItem {
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
  priority: number;
  enqueuedAt: number;
}

/** A workflow definition and its hash (`workflowHash`): what a ticket's run is frozen on (ORC-149). */
export interface WorkflowVersion {
  hash: string;
  definition: unknown;
}

/** What a decision writes, besides the journal row of its event and the inbox mark. */
export interface DecisionPlan {
  /** The new projection of the ticket; undefined leaves it unwritten (unmanaged ticket, global event). */
  ticket?: TicketState;
  /** Written to the outbox in this order, with ids `ticket:seq:i` (i from 1). */
  effects: OutboxEffect[];
  timers: TimerRecord[];
  /** Deletes the ticket's armed timers before writing `timers` (a stop of the ticket's work). */
  clearTimers: boolean;
  /** Why the decision did nothing, logged after the commit (a fenced result, an unmanaged ticket). */
  note?: string;
}

/**
 * One event's decision transaction (ORC-149). The store takes the ticket's lock, checks the inbox
 * row is the next one of its ticket, reads the projection and the workflow version the ticket is
 * frozen on, calls `decide` (pure, synchronous), then writes the journal, the projection, the
 * outbox, the timers and the inbox mark in one transaction: all of it, or nothing.
 */
export interface DecisionRequest {
  /** The event of inbox row `event.id`, as journaled (snapshot filled). */
  event: FactoryEvent;
  /** The project's workflow now: a ticket without a frozen version is frozen on it. */
  workflow: WorkflowVersion;
  decide(ticket: TicketState | undefined, workflow: WorkflowVersion): DecisionPlan;
}

export type DecisionOutcome =
  | {
      status: 'committed';
      seq: number;
      effectIds: string[];
      known: TicketState | undefined;
      plan: DecisionPlan;
      /**
       * Pending rows of the ticket a stop cancelled (ORC-150): held back by their backoff, they do
       * not hold a stop of the ticket's work (`clearTimers`); they go `failed`, with no result event.
       */
      preempted: string[];
    }
  /** Already journaled (an older engine journaled it before marking it): marked processed, nothing else. */
  | { status: 'duplicate' }
  /** No longer pending: another worker processed it. */
  | { status: 'processed' }
  /**
   * Not this row's turn: an older row of the ticket is still pending, or an effect of the ticket is
   * unfinished (running, or pending; one held back by its backoff only holds events that do not stop
   * the ticket's work).
   */
  | { status: 'waiting'; reason: string };

/** An outbox row written by a decision (ORC-149), executed after the commit. */
export interface OutboxRow {
  /** `ticket:seq:i`; the ticket part is `*` for an event without a ticket. */
  id: string;
  projectId: string;
  ticketId?: string;
  eventId: string;
  seq: number;
  i: number;
  effect: OutboxEffect;
  /**
   * `pending` (new, or waiting for its retry), `running` (claimed), `done`, `dead` (out of
   * attempts, ORC-150), `failed` (skipped: an earlier effect of its decision went dead).
   */
  status: 'pending' | 'running' | 'done' | 'failed' | 'dead';
  /** Claims so far, this one included: a claim whose lease expired (its worker died) counts too. */
  attempts: number;
  /** The last failure of the effect (a retried or dead row). */
  error?: string;
  /** The claim token of a running row, set by `claimEffect`: only its holder may renew or settle it. */
  lease?: string;
}

/**
 * The inbox event that carries an outbox row's result back to the worker (ORC-150), written in the
 * transaction that settles the row: `effect:<id>`, `effect.done` or `effect.failed` (dead).
 */
export function effectResult(row: Pick<OutboxRow, 'id' | 'projectId' | 'ticketId' | 'eventId' | 'effect' | 'attempts'>, at: number, error?: string): FactoryEvent {
  const base = { effectId: row.id, kind: row.effect.kind, eventId: row.eventId, attempts: row.attempts };
  const head = { ...TRUSTED, id: `effect:${row.id}`, at, projectId: row.projectId, ...(row.ticketId === undefined ? {} : { ticketId: row.ticketId }) };
  return error === undefined ? { ...head, type: 'effect.done', payload: base } : { ...head, type: 'effect.failed', payload: { ...base, error } };
}

/** A queue item handed out under a lease (ORC-150): it stays in the queue until its start is recorded. */
export interface QueueClaim {
  id: string;
  lease: string;
  item: QueueItem;
}

/**
 * The state port. Asynchronous because Postgres is (ORC-132): `SqliteStore` implements it by
 * wrapping its synchronous calls, `PgStore` natively.
 */
export interface Store {
  getTicket(projectId: string, ticketId: string): Promise<TicketState | undefined>;
  putTicket(t: TicketState): Promise<void>;
  listTickets(): Promise<TicketState[]>;
  /**
   * The inbox (ORC-147): every event is written here, durably, before anything acts on it. False
   * when an event with this id is already in the inbox, processed or not: the id is the dedup key.
   */
  appendInbox(e: FactoryEvent | StoredEvent): Promise<boolean>;
  /** Inbox events not processed yet, oldest first, except the ids in `exclude`. */
  pendingInbox(limit: number, exclude?: readonly string[]): Promise<StoredEvent[]>;
  /** Marks an inbox event processed: `pendingInbox` no longer returns it. */
  markInboxProcessed(id: string): Promise<void>;
  /** The decision transaction of an inbox row (ORC-149): see `DecisionRequest`. */
  decide(req: DecisionRequest): Promise<DecisionOutcome>;
  /**
   * Claims the ticket's first unfinished outbox row, in `seq`, `i` order, under a lease of
   * `leaseMs`, and counts the attempt: a pending row past its backoff, or a running one whose lease
   * expired (its worker died). `busy` when that row cannot be taken now: running under a live
   * lease, being claimed by another executor (`SKIP LOCKED` on Postgres), or waiting for its retry.
   */
  claimEffect(projectId: string, ticketId: string | undefined, leaseMs: number): Promise<OutboxRow | 'busy' | undefined>;
  /**
   * Extends the lease of a running outbox row while its effect runs. False when the row is no
   * longer running under `lease` (its lease expired and another worker claimed it).
   */
  renewEffect(id: string, lease: string, leaseMs: number): Promise<boolean>;
  /**
   * Settles a running outbox row: done, and its result `effect:<id>` (`effect.done`) written to the
   * inbox in the same transaction (ORC-150). Only under the claim token `lease`: false, and nothing
   * changed, when the lease was lost to another worker. Without `lease`: the legacy queue rows of
   * `claim` (Postgres), no inbox event. `at`: the time of the result event (the store's clock by
   * default; the orchestrator passes its own, the time of every event it writes).
   */
  completeEffect(id: string, lease?: string, at?: number): Promise<boolean>;
  /**
   * A running outbox row failed and has attempts left: back to `pending`, claimable again in
   * `delayMs` (the backoff), with its error. Same guard as `completeEffect`.
   */
  retryEffect(id: string, lease: string, error: string, delayMs: number): Promise<boolean>;
  /**
   * A running outbox row failed for the last time (ORC-150), in one transaction: the row goes
   * `dead` with its error, the later rows of its decision are skipped (`failed`, `settle` aside),
   * the timers its decision armed are deleted, and its result `effect:<id>` (`effect.failed`) is
   * written to the inbox. Same guard as `completeEffect`.
   */
  failEffect(id: string, lease: string, error: string, at?: number): Promise<boolean>;
  /**
   * Tickets whose first unfinished outbox row is claimable: pending and past its backoff, or
   * running under an expired lease.
   */
  effectTickets(): Promise<{ projectId: string; ticketId?: string }[]>;
  /** The decision outbox rows of a ticket (`undefined`: of the events without a ticket), in order. */
  listEffects(projectId: string, ticketId?: string): Promise<OutboxRow[]>;
  /** A workflow version a ticket is frozen on, by hash. */
  getWorkflowVersion(hash: string): Promise<WorkflowVersion | undefined>;
  /**
   * Read-modify-write of a ticket under its lock, outside a decision (an effect recording what it
   * did): `undefined` when the ticket does not exist (nothing written).
   */
  updateTicket(projectId: string, ticketId: string, f: (t: TicketState) => TicketState): Promise<TicketState | undefined>;
  /** Journals an event. False when an event with this id was already journaled. */
  recordEvent(e: FactoryEvent): Promise<boolean>;
  recentEvents(limit: number, ticketId?: string): Promise<FactoryEvent[]>;
  putRun(r: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  runsByStatus(status: RunRecord['status']): Promise<RunRecord[]>;
  findRunByToken(token: string): Promise<RunRecord | undefined>;
  putTimer(t: TimerRecord): Promise<void>;
  /**
   * The timers due at `now`, except those whose arming decision still has an effect to run
   * (ORC-149): a timer never fires before the effects of its decision, and a failed one disarms it.
   */
  dueTimers(now: number): Promise<TimerRecord[]>;
  /** With `fireAt`, deletes the timer only while it is still armed for that time: a re-armed timer stays. */
  deleteTimer(key: string, fireAt?: number): Promise<void>;
  deleteTimersFor(projectId: string, ticketId: string): Promise<void>;
  /** Deletes the timers armed by the decision of an event (`armedBy`). */
  deleteTimersArmedBy(eventId: string): Promise<void>;
  /** Queues an item (deduped by ticket + job) and returns its id. */
  enqueue(q: QueueItem): Promise<string>;
  /**
   * Hands out the next item of a queue under a lease of `leaseMs` (ORC-150), without taking it out:
   * an item handed out and lost before its start (a crash) is handed out again once the lease
   * expires. Not an item another holder has under a live lease.
   */
  claimQueued(queue: QueueName, leaseMs: number): Promise<QueueClaim | undefined>;
  /** Extends the lease of a handed-out item; false when the claim is no longer its holder's. */
  renewQueued(claim: QueueClaim, leaseMs: number): Promise<boolean>;
  /** The item's start is recorded (or the item is dropped): out of the queue for good. */
  finishQueued(claim: QueueClaim): Promise<boolean>;
  /** The item goes back in line, at its place (no free slot, paused, over budget). */
  releaseQueued(claim: QueueClaim): Promise<boolean>;
  /** Items waiting in line: not handed out, or handed out under a lease that expired (their holder died). */
  listQueue(): Promise<QueueItem[]>;
  /**
   * Takes the ticket's items out of the queue, of every queue or of `queue` only, handed-out ones
   * included (a stop): their claim then settles nothing.
   */
  removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): Promise<void>;
  putEcho(key: string, until: number): Promise<void>;
  isEcho(key: string, now: number): Promise<boolean>;
  costSince(ts: number): Promise<number>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
