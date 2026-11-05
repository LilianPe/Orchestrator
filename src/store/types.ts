import type { AttemptLabels } from '../core/attempt-labels.js';
import type { DeadLetter, RepairAction } from '../core/dead-letter.js';
import type { OutboxEffect } from '../core/decision.js';
import { TRUSTED, type EffectResultPayload, type InputKind, type TimerFired, type QueueName, type FactoryEvent, type RunOutcome, type TicketState, type TokenUsage } from '../core/types.js';
import type { StoredEvent } from '../core/upcast.js';

/**
 * Lease of a claimed outbox row or queue item (ORC-129): 60 s, renewed every 20 s by its holder
 * while the effect runs. A holder that dies leaves the row to another once it expires.
 */
export const LEASE_MS = 60_000;

/** The heartbeat of an attempt (ORC-220): every 30 s, as the MVP doc says. */
export const RUN_BEAT_MS = 30_000;
/** Lease of an attempt: three beats, as for an outbox row (`LEASE_MS`), so one missed beat is no expiry. */
export const RUN_LEASE_MS = 3 * RUN_BEAT_MS;
/**
 * Automatic relaunches after a cut, per ticket and per sliding window (ORC-220): a crash loop must not launch an
 * agent at each restart, without limit and out of the budget's reach. Read by `decide`: changing them changes what
 * a replay of a `run.lost` or a `verify.lost` decides, as any change of the engine does (ORC-174).
 */
export const CUT_RELAUNCHES = 3;
export const CUT_WINDOW_MS = 3_600_000;

export type SessionRole = 'implementer' | 'reviewer' | 'answerer';

export interface RunRecord {
  id: string;
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  /** `interrupted`: cut by a daemon shutdown; recover() settles it on the next start. */
  status: 'running' | 'interrupted' | RunOutcome;
  claudeSessionId: string;
  /**
   * Whose session `claudeSessionId` is (ORC-217): the implementer's is the ticket's, resumed across
   * attempts; a reviewer's or an answerer's is fresh. Absent on knowledge runs and older records.
   */
  sessionRole?: SessionRole;
  linearSessionId?: string;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  turns: number;
  lastText: string;
  token: string;
  cwd: string;
  /** What the attempt ran with, set at creation and never changed after (ORC-226). Absent on older records. */
  labels?: AttemptLabels;
  /**
   * Paths the attempt must not write, set at its launch from what it read (I12, ORC-274) and handed to
   * the runner. Absent on a trusted attempt and on records older than ORC-274.
   */
  sensitivePaths?: readonly string[];
  /** Tokens the runner reported at the end of the attempt (ORC-235); absent when it reported none. */
  tokens?: TokenUsage;
  /** Renewed by the heartbeat while the attempt lives (ORC-220, `renewRun`); absent on older records. */
  leaseUntil?: number;
  /** What the attempt was given to read (ORC-220): a relaunch of its step reads the same, the feedback it consumed included. */
  input?: { kind: InputKind; text: string };
}

/**
 * An armed timer (ORC-161): a kind and what it carries (`TimerFired`), due at `fireAt`. One timer per
 * `key` (`<ticket>:<slot>`): a decision that arms the same key again pushes it back.
 */
export type TimerRecord = TimerFired & {
  key: string;
  projectId: string;
  ticketId: string;
  fireAt: number;
  /** Id of the event whose decision armed the timer (ORC-149): a failed effect of that decision disarms it. */
  armedBy?: string;
};

export interface QueueItem {
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
  /** Those its start was decided with; the launch adds them when what the run reads then is untrusted (ORC-274). */
  sensitivePaths?: readonly string[];
  /** The lost attempt whose step it starts again (ORC-220). */
  relaunchOf?: string;
  priority: number;
  enqueuedAt: number;
  /**
   * The start mark its launch writes its run's id in (ORC-277), for an item queued by an outbox
   * effect: a launch cut before the item left the queue is not launched again when handed out.
   */
  startMark?: string;
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
  /** The decider's clock (`updatedAt` of the projection, base of the timers), recorded for replay (ORC-174). */
  at?: number;
  /** Why `decide` decided so (`Decision.trace`), recorded for replay (ORC-174). */
  trace?: string[];
}

/**
 * What the decision transaction recorded of a committed decision (ORC-174), beside its journal
 * row: its inputs (the projection read under the lock, the frozen workflow version, the clock) and
 * its outputs (the new projection, the outbox effects, the timers). The replay oracle runs the
 * decision again from the inputs and compares the outputs, bit for bit.
 */
export interface DecisionRecord {
  eventId: string;
  projectId: string;
  ticketId?: string;
  seq: number;
  /** `DecisionPlan.at`; absent when nothing decided (an event of an unknown project). */
  at?: number;
  /** The workflow version the decision ran on; empty when nothing decided (an unknown project). */
  workflowHash: string;
  /** The projection read under the ticket's lock, before the decision. */
  before?: TicketState;
  ticket?: TicketState;
  effects: OutboxEffect[];
  timers: TimerRecord[];
  clearTimers: boolean;
  trace?: string[];
}

/** The hash a decision ran on: the frozen version, or none when the request had no workflow (an unknown project). */
export function decidedOn(req: DecisionRequest, frozen: WorkflowVersion): string {
  return req.workflow.hash === '' ? '' : frozen.hash;
}

/** The record of a committed decision, written in its transaction (ORC-174). */
export function decisionRecord(event: FactoryEvent, seq: number, known: TicketState | undefined, workflowHash: string, plan: DecisionPlan): DecisionRecord {
  return {
    eventId: event.id,
    projectId: event.projectId,
    ...(event.ticketId === undefined ? {} : { ticketId: event.ticketId }),
    seq,
    ...(plan.at === undefined ? {} : { at: plan.at }),
    workflowHash,
    ...(known === undefined ? {} : { before: known }),
    ...(plan.ticket === undefined ? {} : { ticket: plan.ticket }),
    effects: plan.effects,
    timers: plan.timers,
    clearTimers: plan.clearTimers,
    ...(plan.trace === undefined ? {} : { trace: plan.trace }),
  };
}

/** A journal row of a ticket and, when a decision transaction journaled it (ORC-174), its decision. */
export interface JournalEntry {
  /** As journaled: an older engine may have written it in an older `schemaVersion`. */
  event: StoredEvent;
  decision?: DecisionRecord;
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

/**
 * A write refused: it would replace the row of a ticket another project holds (ORC-291). Postgres keeps one row
 * per ticket, whatever its project. Retried, it would be refused again: the worker sets the event aside at once.
 */
export class TicketHeldError extends Error {
  constructor(ticketId: string, holder: string, writer: string) {
    super(`ticket ${ticketId} is held by project ${holder}: refused, a write for project ${writer} would replace it`);
  }
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
  /** `backoff`: held by an effect in backoff only; a later row of the ticket (a stop) may still pass. */
  | { status: 'waiting'; reason: string; backoff?: true };

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
 * What an executed effect reports beyond success (ORC-162): `deduplicated` when it found the effect
 * already made by an earlier execution and wrote nothing, `ref` for the object made or found.
 */
export type EffectOutcome = Pick<EffectResultPayload, 'deduplicated' | 'ref'>;

/**
 * The inbox event that carries an outbox row's result back to the worker (ORC-150), written in the
 * transaction that settles the row: `effect:<id>`, `effect.done` or `effect.failed` (dead).
 */
export function effectResult(
  row: Pick<OutboxRow, 'id' | 'projectId' | 'ticketId' | 'eventId' | 'effect' | 'attempts'>,
  at: number,
  error?: string,
  outcome?: EffectOutcome,
): FactoryEvent {
  const base: EffectResultPayload = { effectId: row.id, kind: row.effect.kind, eventId: row.eventId, attempts: row.attempts, ...outcome };
  const head = { ...TRUSTED, id: `effect:${row.id}`, at, projectId: row.projectId, ...(row.ticketId === undefined ? {} : { ticketId: row.ticketId }) };
  return error === undefined ? { ...head, type: 'effect.done', payload: base } : { ...head, type: 'effect.failed', payload: { ...base, error } };
}

/**
 * What the measures of a ticket are computed from (ORC-235): facts the store keeps anyway, plus
 * the time each inbox event was acked.
 */
export interface MeasureFacts {
  /** The ticket's dev session as its projection knows it: the factory may have linked it, which the journal does not hold. */
  devSession: string | undefined;
  /** The ticket's journal, in order. */
  events: FactoryEvent[];
  /** The ticket's attempts, oldest first. */
  runs: RunRecord[];
  /** The ticket's decision outbox rows, in order. */
  effects: OutboxRow[];
  /** Ack time of the ticket's inbox events that were acked (`markAcked`), by event id. */
  acks: Record<string, number>;
}

/** One request the egress proxy journaled (`EgressEntry`, ORC-213), as stored (ORC-296): `at` in ms. */
export interface EgressRecord {
  at: number;
  method: string;
  host: string;
  port?: number;
  path?: string;
  ok: boolean;
  reason?: string;
  up: number;
  down: number;
}

/** One refusal of the pack's PreToolUse hook (ORC-285), as stored (ORC-296): a known rule, the command capped. */
export interface RefusalRecord {
  at: number;
  tool: string;
  rule: string;
  command: string;
}

/**
 * The security log of a sandboxed run (ORC-296), read from its two journals when its sandbox is
 * destroyed: the proxy's (the daemon's) and the hook's (written from the sandbox, untrusted). `at`: when
 * it was read. `skipped`: lines left out, malformed or forged.
 */
export interface SecurityLog {
  runId: string;
  projectId: string;
  ticketId: string;
  at: number;
  egress: EgressRecord[];
  refusals: RefusalRecord[];
  skipped: { egress: number; refusals: number };
}

/** What the security logs hold over a period (ORC-296): requests per host, refusals per rule, most first. */
export interface SecurityStats {
  hosts: { host: string; requests: number; refused: number }[];
  rules: { rule: string; refusals: number }[];
}

/** The inbox event of a timer's firing (ORC-161), written by `fireTimer`: its id `timer:<key>:<fireAt>` names that firing, once. */
export function timerEvent(t: TimerRecord, at: number): FactoryEvent<'timer.fired'> {
  return {
    ...TRUSTED,
    id: `timer:${t.key}:${t.fireAt}`,
    type: 'timer.fired',
    at,
    projectId: t.projectId,
    ticketId: t.ticketId,
    payload: { kind: t.kind, payload: t.payload } as FactoryEvent<'timer.fired'>['payload'],
  };
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
   * default; the orchestrator passes its own, the time of every event it writes). `outcome`: what
   * the result carries beyond success, a replay found already made (ORC-162).
   */
  completeEffect(id: string, lease?: string, at?: number, outcome?: EffectOutcome): Promise<boolean>;
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
  /**
   * The journal of a ticket (`undefined`: of the project's events without a ticket), in journal
   * order, each row with the decision recorded with it (ORC-174): what `factory replay` exports.
   */
  ticketJournal(projectId: string, ticketId?: string): Promise<JournalEntry[]>;
  /**
   * Sets aside an inbox row whose decision threw (ORC-175), in one transaction under the ticket's
   * lock: the row is marked processed (it is not retried), its event (the one a failed repair carries,
   * `deadLetteredEvent`) goes to `dead_letter`, open, its failures counted, and the event that blocks
   * its ticket (`deadLetterNotice`) is written to the inbox. False, and nothing written, when the row
   * is no longer pending (another worker processed it).
   */
  deadLetter(row: StoredEvent, error: string, at: number): Promise<boolean>;
  /** The dead letters, of a ticket (any project) or all of them, open ones first, then oldest first. */
  deadLetters(ticketId?: string): Promise<DeadLetter[]>;
  /** The dead letter of an event, by its id. */
  getDeadLetter(eventId: string): Promise<DeadLetter | undefined>;
  /**
   * Repairs an open dead letter (`factory run repair`), in one transaction: its status becomes the
   * action's, and the repair event (`repairEvent`) is written to the inbox, decided and journaled like
   * any event. `undefined`, and nothing written, when no open dead letter has this event id.
   */
  repairDeadLetter(eventId: string, action: RepairAction, by: string, at: number): Promise<DeadLetter | undefined>;
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
  /** The heartbeat of an attempt (ORC-220): its lease up to `until`. Nothing is written once it is no longer `running`. */
  renewRun(id: string, until: number): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  runsByStatus(status: RunRecord['status']): Promise<RunRecord[]>;
  findRunByToken(token: string): Promise<RunRecord | undefined>;
  putTimer(t: TimerRecord): Promise<void>;
  /**
   * The timers due at `now`, oldest first, except those whose arming decision still has an effect
   * to run (ORC-149): a timer never fires before the effects of its decision, and a failed one
   * disarms it. Reading changes nothing: a timer stays due until `fireTimer` fires it.
   */
  dueTimers(now: number): Promise<TimerRecord[]>;
  /**
   * Fires a due timer (ORC-161), in one transaction: writes its event (`timerEvent`, stamped `at`) to
   * the inbox and deletes the timer, both or neither. Only the timer as read: one re-armed for another
   * time (pushed back) or deleted meanwhile (a stop) is left as it is, and nothing is written. True
   * when the inbox got a new row.
   */
  fireTimer(timer: TimerRecord, at: number): Promise<boolean>;
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
  /**
   * Records the first sign of life the factory gave for an inbox event (ORC-235): the ack of its
   * webhook, at `at`. A later call leaves the first time.
   */
  markAcked(eventId: string, at: number): Promise<void>;
  /** The facts the measures of a ticket are computed from (ORC-235). */
  measureFacts(projectId: string, ticketId: string): Promise<MeasureFacts>;
  /**
   * The ticket and PR whose journaled merge (`pr.merged`) has `sha` as its merge commit or head
   * (ORC-278): what a revert on the default branch names. The first such merge of the project.
   */
  mergedPrOf(projectId: string, sha: string): Promise<{ ticketId: string; number: number } | undefined>;
  /** Writes a run's security log (ORC-296), once: false, and nothing written, when the run has one already. */
  putSecurityLog(log: SecurityLog): Promise<boolean>;
  /** The security log of a run (ORC-296), its entries in journal order. */
  securityLog(runId: string): Promise<SecurityLog | undefined>;
  /** Requests per host and refusals per rule of the entries dated in `[since, until)` (ORC-296). */
  securityStats(since: number, until: number): Promise<SecurityStats>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
