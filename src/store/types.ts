import type { OutboxEffect } from '../core/decision.js';
import type { InputKind, QueueName, FactoryEvent, RunOutcome, TicketState } from '../core/types.js';
import type { StoredEvent } from '../core/upcast.js';

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
  | { status: 'committed'; seq: number; effectIds: string[]; known: TicketState | undefined; plan: DecisionPlan }
  /** Already journaled (an older engine journaled it before marking it): marked processed, nothing else. */
  | { status: 'duplicate' }
  /** No longer pending: another worker processed it. */
  | { status: 'processed' }
  /** Not this row's turn: an older row of the ticket is still pending, or an effect of the ticket is unfinished. */
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
  status: 'pending' | 'running' | 'done' | 'failed';
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
   * `leaseMs`: a pending row, or a running one whose lease expired (its worker died). `busy` when
   * that row is running under a live lease: another worker is executing the ticket's effects.
   */
  claimEffect(projectId: string, ticketId: string | undefined, leaseMs: number): Promise<OutboxRow | 'busy' | undefined>;
  /** Extends the lease of a running outbox row while its effect runs. */
  renewEffect(id: string, leaseMs: number): Promise<void>;
  /** Settles an outbox row: done. */
  completeEffect(id: string): Promise<void>;
  /** Settles an outbox row: failed, not retried. */
  failEffect(id: string): Promise<void>;
  /** Tickets whose first unfinished outbox row is claimable (pending, or running under an expired lease). */
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
  dueTimers(now: number): Promise<TimerRecord[]>;
  /** With `fireAt`, deletes the timer only while it is still armed for that time: a re-armed timer stays. */
  deleteTimer(key: string, fireAt?: number): Promise<void>;
  deleteTimersFor(projectId: string, ticketId: string): Promise<void>;
  /** Queues an item (deduped by ticket + job) and returns its id. */
  enqueue(q: QueueItem): Promise<string>;
  /** Takes the next item of a queue out of the store: it is not handed out again. */
  dequeue(queue: QueueName): Promise<QueueItem | undefined>;
  listQueue(): Promise<QueueItem[]>;
  /** Drops the ticket's queued runs, of every queue or of `queue` only. */
  removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): Promise<void>;
  putEcho(key: string, until: number): Promise<void>;
  isEcho(key: string, now: number): Promise<boolean>;
  costSince(ts: number): Promise<number>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
