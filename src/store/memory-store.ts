import { randomUUID } from 'node:crypto';
import {
  deadLetteredEvent,
  deadLetterNotice,
  REPAIRED_STATUS,
  repairEvent,
  type DeadLetter,
  type DeadLetterStatus,
  type RepairAction,
} from '../core/dead-letter.js';
import type { ReviewLens } from '../core/workflow.js';
import type { Finding } from '../core/agent-output.js';
import type { KeptFinding, ReviewDefect } from '../core/audit.js';
import type { Baseline, BaselineMeasure } from '../core/baseline.js';
import type { DryRun } from '../core/dry-run.js';
import type { GhostJudgment, GhostReplay, GhostTicket } from '../ghost/replay.js';
import { LIFT_ON_WAIT, type OutboxEffect } from '../core/decision.js';
import { findingRowId, type ReviewFinding } from '../core/review.js';
import { claims, holds } from '../core/routing.js';
import type { QueueName, FactoryEvent, TicketState } from '../core/types.js';
import { normalizeTicket, upcastTimer, type StoredEvent, type StoredTimer } from '../core/upcast.js';
import {
  TicketHeldError,
  blockMoves,
  byMostRefused,
  decidedOn,
  decisionRecord,
  effectResult,
  keptSecurityLog,
  timerEvent,
  timerRowId,
  PAUSE_ACCEPTED,
  pauseAcceptedValue,
  queueRank,
  approvedCard,
  maturityCard,
  type Artifact,
  type BlockEntry,
  type ChangelogEntry,
  type DecisionOutcome,
  type DecisionRecord,
  type DecisionRequest,
  type EffectOutcome,
  type FindingsRecord,
  type JournalEntry,
  type KnownFlakyTest,
  type MaturityCard,
  type MaturityPoint,
  type MeasureFacts,
  type OutboxRow,
  type QueueClaim,
  type QueueItem,
  type QueueRetry,
  type RunRecord,
  type SecurityLog,
  type SecurityStats,
  type Store,
  type TimerRecord,
  type WorkflowVersion,
} from './types.js';

/** A deep copy, as a database hands back: a caller changing what it read or wrote changes nothing kept. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Ascending by each key in turn, as an `ORDER BY` (Array.prototype.sort is stable: ties keep the insertion order). */
function sortBy<T>(xs: T[], ...keys: ((x: T) => number | string)[]): T[] {
  return xs.sort((a, b) => {
    for (const k of keys) {
      const [x, y] = [k(a), k(b)];
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
}

interface InboxRow {
  seq: number;
  processedAt: number | null;
  ackedAt: number | null;
  event: StoredEvent;
}

interface EventRow {
  ticketId: string | null;
  event: FactoryEvent;
}

interface OutboxRecord {
  id: string;
  projectId: string;
  ticketId: string | null;
  eventId: string;
  seq: number;
  i: number;
  status: OutboxRow['status'];
  leaseUntil: number | null;
  lease: string | null;
  attempts: number;
  availableAt: number;
  error: string | null;
  effect: OutboxEffect;
}

function outboxRow(r: OutboxRecord): OutboxRow {
  return copy({
    id: r.id,
    projectId: r.projectId,
    ...(r.ticketId === null ? {} : { ticketId: r.ticketId }),
    eventId: r.eventId,
    seq: r.seq,
    i: r.i,
    effect: r.effect,
    status: r.status,
    attempts: r.attempts,
    ...(r.error === null ? {} : { error: r.error }),
    ...(r.lease === null ? {} : { lease: r.lease }),
  });
}

interface DeadLetterRecord {
  eventId: string;
  projectId: string;
  ticketId: string | null;
  status: DeadLetterStatus;
  failures: number;
  error: string;
  createdAt: number;
  resolvedBy: string | null;
  event: StoredEvent;
}

function deadLetterRow(r: DeadLetterRecord): DeadLetter {
  return copy({
    eventId: r.eventId,
    projectId: r.projectId,
    ...(r.ticketId === null ? {} : { ticketId: r.ticketId }),
    event: r.event,
    error: r.error,
    failures: r.failures,
    status: r.status,
    ...(r.resolvedBy === null ? {} : { resolvedBy: r.resolvedBy }),
  });
}

interface QueueRecord {
  /** The queue and arrival of the first request: a later one for the same ticket and job replaces the item, not these. */
  queue: QueueName;
  enqueuedAt: number;
  rank: number;
  lease: string | null;
  leaseUntil: number | null;
  item: QueueItem;
}

const queueKey = (projectId: string, ticketId: string, job: string) => `${projectId}:${ticketId}:${job}`;
const open = (r: OutboxRecord) => r.status === 'pending' || r.status === 'running';
/** The lease token of a stored attempt (ORC-344), 0 on a record from before it. */
const leaseToken = (r: RunRecord) => r.leaseToken ?? 0;

/**
 * The store of the tests and of the harness's fake adapters (ORC-178): the `Store` port in this process's memory, held to
 * the same contract as PgStore (test/helpers/store-suite.ts). Never a daemon's: its state dies with the process. Each
 * method runs with no await inside, so a decision or a settlement is whole to every other call, as a transaction is.
 */
export class MemoryStore implements Store {
  private readonly tickets = new Map<string, TicketState>();
  private readonly events = new Map<string, EventRow>();
  private readonly inbox = new Map<string, InboxRow>();
  /** The inbox rows not processed yet, in arrival order: what every read of the inbox walks. */
  private readonly unprocessed = new Map<string, InboxRow>();
  private inboxSeq = 0;
  /** Events journaled per ticket (`null`: without one), the `seq` of the next decision. */
  private readonly journaled = new Map<string | null, number>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly timers = new Map<string, TimerRecord>();
  private readonly queue = new Map<string, QueueRecord>();
  private readonly meta = new Map<string, string>();
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly workflowVersions = new Map<string, unknown>();
  private readonly decisionTrace = new Map<string, DecisionRecord>();
  private readonly deadLetterRows = new Map<string, DeadLetterRecord>();
  private readonly securityLogs = new Map<string, SecurityLog>();
  private readonly artifactRows = new Map<string, Artifact>();
  private readonly changelogRows = new Map<string, ChangelogEntry>();
  private readonly baselines: { projectId: string; since: number; until: number; measure: BaselineMeasure; computedAt: number; value: unknown }[] = [];
  private readonly dryRuns = new Map<string, DryRun>();
  private readonly ghostReplayRows = new Map<string, GhostReplay>();
  private readonly ghostTicketRows = new Map<string, GhostTicket>();
  private readonly ghostJudgmentRows = new Map<string, GhostJudgment>();
  private readonly maturity = new Map<string, MaturityCard[]>();
  private readonly flaky = new Map<string, KnownFlakyTest>();
  private findings: (FindingsRecord & { n: number; finding: Finding })[] = [];
  private readonly defects = new Map<string, ReviewDefect>();

  /** `now` is the store's clock, like PgStore's injectable one: inbox stamps, leases, backoffs, due rows. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  async getTicket(projectId: string, ticketId: string): Promise<TicketState | undefined> {
    return this.ticketRow(projectId, ticketId);
  }

  async putTicket(t: TicketState): Promise<void> {
    this.writeTicket(t);
  }

  async listTickets(): Promise<TicketState[]> {
    return [...this.tickets.values()].map((t) => normalizeTicket(copy(t)));
  }

  /** The inbox (ORC-147): `seq` keeps the arrival order, the id dedups. */
  async appendInbox(e: FactoryEvent | StoredEvent): Promise<boolean> {
    const fresh = this.appendResult(e);
    const paused = pauseAcceptedValue(e);
    if (fresh && paused !== undefined) this.meta.set(PAUSE_ACCEPTED, paused);
    return fresh;
  }

  async inboxHas(id: string): Promise<boolean> {
    return this.inbox.has(id);
  }

  async pendingInbox(limit: number, exclude: readonly string[] = []): Promise<StoredEvent[]> {
    const skip = new Set(exclude);
    return this.pending()
      .slice(0, limit + skip.size)
      .filter((r) => !skip.has(r.event.id))
      .slice(0, limit)
      .map((r) => copy(r.event));
  }

  private pending(): InboxRow[] {
    return [...this.unprocessed.values()];
  }

  async markInboxProcessed(id: string): Promise<void> {
    this.markProcessed(id);
  }

  /** False when the row was no longer pending. */
  private markProcessed(id: string): boolean {
    const row = this.inbox.get(id);
    if (!row || row.processedAt !== null) return false;
    this.processed(row);
    return true;
  }

  private processed(row: InboxRow): void {
    row.processedAt = this.now();
    this.unprocessed.delete(row.event.id);
  }

  /**
   * The decision transaction (ORC-149): everything read and checked before the first write, so a refusal (a claim held
   * by another project, a `decide` that throws) leaves nothing behind, as a rollback does.
   */
  async decide(req: DecisionRequest): Promise<DecisionOutcome> {
    const { event } = req;
    const ticketId = event.ticketId ?? null;
    const row = this.inbox.get(event.id);
    if (!row) throw new Error(`event ${event.id} is not in the inbox`);
    if (row.processedAt !== null) return { status: 'processed' };
    const mine = this.pending().filter((r) => r.event.projectId === event.projectId && (r.event.ticketId ?? null) === ticketId);
    const first = mine[0];
    // Only results of done effects ahead: a stop may pass them, as it passes the effects in backoff.
    let jumped = false;
    if (first && first.event.id !== event.id) {
      const ahead = mine.filter((r) => r.seq < row.seq);
      if (!ahead.every((r) => r.event.type === 'effect.done')) return { status: 'waiting', reason: `${first.event.id} comes first` };
      jumped = true;
    }
    const openRows = this.openEffects(event.projectId, ticketId);
    // Held back by its backoff (nothing running): a stop of the ticket's work may go first (ORC-150).
    const backedOff = openRows.length > 0 && openRows.every((r) => r.status === 'pending') && openRows[0]!.availableAt > this.now();
    if (openRows.length > 0 && !backedOff) return { status: 'waiting', reason: `effect ${openRows[0]!.id} is unfinished` };
    if (jumped && !backedOff) return { status: 'waiting', reason: `${first!.event.id} comes first` };
    if (this.events.has(event.id)) {
      this.processed(row);
      return { status: 'duplicate' };
    }

    const known = ticketId === null ? undefined : this.ticketRow(event.projectId, ticketId);
    const frozen = this.frozenWorkflow(known, req.workflow);
    const plan = req.decide(known, frozen);
    const preempted = openRows.map((r) => r.id);
    if (preempted.length > 0 && !plan.clearTimers) return { status: 'waiting', reason: `effect ${preempted[0]} waits for its retry`, backoff: true };
    if (plan.ticket) this.refuseClaim(req.peers ?? [], known, plan.ticket);

    for (const r of openRows) Object.assign(r, { status: 'failed', error: `cancelled by ${event.id}` });
    const seq = this.journal(event.id, ticketId, event);
    this.decisionTrace.set(event.id, copy(decisionRecord(event, seq, known, decidedOn(req, frozen), plan)));
    // Every version a decision ran on is kept, projection written or not: its replay needs it (ORC-174).
    if (req.workflow.hash !== '' && frozen.hash === req.workflow.hash && !this.workflowVersions.has(req.workflow.hash)) {
      this.workflowVersions.set(req.workflow.hash, copy(req.workflow.definition));
    }
    if (plan.ticket) this.writeTicket(plan.ticket);
    if (plan.clearTimers && ticketId !== null) this.clearTimers(event.projectId, ticketId);
    for (const t of plan.timers) this.writeTimer(t);
    const effectIds = plan.effects.map((effect, k) => {
      const id = `${ticketId ?? '*'}:${seq}:${k + 1}`;
      this.outbox.set(id, {
        id, projectId: event.projectId, ticketId, eventId: event.id, seq, i: k + 1,
        status: 'pending', leaseUntil: null, lease: null, attempts: 0, availableAt: 0, error: null, effect: copy(effect),
      });
      return id;
    });
    this.processed(row);
    return { status: 'committed', seq, effectIds, known, plan, preempted };
  }

  private refuseClaim(peers: readonly string[], known: TicketState | undefined, next: TicketState): void {
    if (!claims(known, next)) return;
    const holder = peers.find((p) => {
      const held = this.ticketRow(p, next.ticketId);
      return held && holds(held);
    });
    if (holder !== undefined) throw new TicketHeldError(next.ticketId, holder, next.projectId);
  }

  private frozenWorkflow(known: TicketState | undefined, current: WorkflowVersion): WorkflowVersion {
    const hash = known?.workflowHash;
    if (!hash || hash === current.hash) return current;
    if (!this.workflowVersions.has(hash)) throw new Error(`workflow version ${hash} of ${known.ticketId} is not stored`);
    return { hash, definition: copy(this.workflowVersions.get(hash)) };
  }

  async ticketJournal(projectId: string, ticketId?: string): Promise<JournalEntry[]> {
    return [...this.events.values()]
      .filter((e) => e.ticketId === (ticketId ?? null) && e.event.projectId === projectId)
      .map((e) => {
        const decision = this.decisionTrace.get(e.event.id);
        return copy({ event: e.event as StoredEvent, ...(decision ? { decision } : {}) });
      });
  }

  async getWorkflowVersion(hash: string): Promise<WorkflowVersion | undefined> {
    return this.workflowVersions.has(hash) ? { hash, definition: copy(this.workflowVersions.get(hash)) } : undefined;
  }

  private openEffects(projectId: string, ticketId: string | null): OutboxRecord[] {
    return sortBy(
      [...this.outbox.values()].filter((r) => r.projectId === projectId && r.ticketId === ticketId && open(r)),
      (r) => r.seq,
      (r) => r.i,
    );
  }

  async claimEffect(projectId: string, ticketId: string | undefined, leaseMs: number): Promise<OutboxRow | 'busy' | undefined> {
    const row = this.openEffects(projectId, ticketId ?? null)[0];
    if (!row) return undefined;
    const now = this.now();
    if (row.status === 'running' && (row.leaseUntil ?? 0) >= now) return 'busy';
    // Waiting for its retry: the ticket's later rows wait behind it.
    if (row.status === 'pending' && row.availableAt > now) return 'busy';
    Object.assign(row, { status: 'running', leaseUntil: now + leaseMs, lease: randomUUID(), attempts: row.attempts + 1 });
    return outboxRow(row);
  }

  async renewEffect(id: string, lease: string, leaseMs: number): Promise<boolean> {
    const row = this.heldRow(id, lease);
    if (row) row.leaseUntil = this.now() + leaseMs;
    return row !== undefined;
  }

  /** The running row under `lease` (any running row without one), or undefined: the guard of every settlement. */
  private heldRow(id: string, lease: string | undefined): OutboxRecord | undefined {
    const row = this.outbox.get(id);
    return row && row.status === 'running' && (lease === undefined || row.lease === lease) ? row : undefined;
  }

  async completeEffect(id: string, lease?: string, at = this.now(), outcome?: EffectOutcome): Promise<boolean> {
    const row = this.heldRow(id, lease);
    if (!row) return false;
    Object.assign(row, { status: 'done', leaseUntil: null });
    this.appendResult(effectResult(outboxRow(row), at, undefined, outcome));
    return true;
  }

  async retryEffect(id: string, lease: string, error: string, delayMs: number): Promise<boolean> {
    const row = this.heldRow(id, lease);
    if (row) Object.assign(row, { status: 'pending', lease: null, leaseUntil: null, availableAt: this.now() + delayMs, error });
    return row !== undefined;
  }

  async failEffect(id: string, lease: string, error: string, at = this.now()): Promise<boolean> {
    const row = this.heldRow(id, lease);
    if (!row) return false;
    Object.assign(row, { status: 'dead', leaseUntil: null, error });
    for (const r of this.outbox.values()) {
      if (r.eventId === row.eventId && r.status === 'pending' && r.effect.kind !== 'settle') r.status = 'failed';
    }
    this.deleteArmedBy(row.eventId);
    this.appendResult(effectResult(outboxRow(row), at, error));
    return true;
  }

  /**
   * Writes an inbox row; false when the id is already there. Also an event the store writes itself (an effect's
   * result, a dead letter's notice, a repair, a timer's firing), with the change that causes it.
   */
  private appendResult(e: FactoryEvent | StoredEvent): boolean {
    if (this.inbox.has(e.id)) return false;
    const row: InboxRow = { seq: ++this.inboxSeq, processedAt: null, ackedAt: null, event: copy(e) as StoredEvent };
    this.inbox.set(e.id, row);
    this.unprocessed.set(e.id, row);
    return true;
  }

  async deadLetter(row: StoredEvent, error: string, at: number, holder?: string, attempts?: number): Promise<boolean> {
    if (!this.markProcessed(row.id)) return false;
    const event = deadLetteredEvent(row);
    const kept = this.deadLetterRows.get(event.id);
    const failures = (kept?.failures ?? 0) + 1;
    this.deadLetterRows.set(
      event.id,
      kept
        ? { ...kept, status: 'open', failures, error }
        : { eventId: event.id, projectId: event.projectId, ticketId: event.ticketId ?? null, status: 'open', failures, error, createdAt: at, resolvedBy: null, event: copy(event) },
    );
    const notice = deadLetterNotice({ event, error, failures }, at, holder, attempts);
    if (notice) this.appendResult(notice);
    return true;
  }

  async deadLetters(ticketId?: string): Promise<DeadLetter[]> {
    const rows = [...this.deadLetterRows.values()].filter((r) => ticketId === undefined || r.ticketId === ticketId);
    return sortBy(rows, (r) => (r.status === 'open' ? 0 : 1), (r) => r.createdAt, (r) => r.eventId).map(deadLetterRow);
  }

  async getDeadLetter(eventId: string): Promise<DeadLetter | undefined> {
    const row = this.deadLetterRows.get(eventId);
    return row && deadLetterRow(row);
  }

  async repairDeadLetter(eventId: string, action: RepairAction, by: string, at: number): Promise<DeadLetter | undefined> {
    const row = this.deadLetterRows.get(eventId);
    if (!row || row.status !== 'open') return undefined;
    Object.assign(row, { status: REPAIRED_STATUS[action], resolvedBy: by });
    const dl = deadLetterRow(row);
    this.appendResult(repairEvent(dl, action, by, at));
    return dl;
  }

  async effectTickets(): Promise<{ projectId: string; ticketId?: string }[]> {
    const now = this.now();
    // The first open row of each ticket, in one pass: only it may be handed out.
    const heads = new Map<string, OutboxRecord>();
    for (const r of this.outbox.values()) {
      if (!open(r)) continue;
      const key = `${r.projectId}\0${r.ticketId}`;
      const head = heads.get(key);
      if (!head || r.seq < head.seq || (r.seq === head.seq && r.i < head.i)) heads.set(key, r);
    }
    return [...heads.values()]
      .filter((r) => (r.status === 'pending' && r.availableAt <= now) || (r.status === 'running' && (r.leaseUntil ?? 0) < now))
      .map((r) => ({ projectId: r.projectId, ...(r.ticketId === null ? {} : { ticketId: r.ticketId }) }));
  }

  async listEffects(projectId: string, ticketId?: string): Promise<OutboxRow[]> {
    const rows = [...this.outbox.values()].filter((r) => r.projectId === projectId && r.ticketId === (ticketId ?? null));
    return sortBy(rows, (r) => r.seq, (r) => r.i).map(outboxRow);
  }

  async updateTicket(projectId: string, ticketId: string, f: (t: TicketState) => TicketState): Promise<TicketState | undefined> {
    const t = this.ticketRow(projectId, ticketId);
    if (!t) return undefined;
    const next = f(t);
    this.writeTicket(next);
    return next;
  }

  private ticketRow(projectId: string, ticketId: string): TicketState | undefined {
    const t = this.tickets.get(`${projectId}\0${ticketId}`);
    return t && normalizeTicket(copy(t));
  }

  private writeTicket(t: TicketState): void {
    this.tickets.set(`${t.projectId}\0${t.ticketId}`, copy(t));
  }

  private writeTimer(t: TimerRecord): void {
    this.timers.set(timerRowId(t), copy(t));
  }

  private clearTimers(projectId: string, ticketId: string): void {
    for (const [key, t] of this.timers) if (t.projectId === projectId && t.ticketId === ticketId) this.timers.delete(key);
  }

  async recordEvent(e: FactoryEvent): Promise<boolean> {
    if (this.events.has(e.id)) return false;
    this.journal(e.id, e.ticketId ?? null, e);
    return true;
  }

  /** Writes a journal row; returns its position in its ticket's journal. */
  private journal(id: string, ticketId: string | null, e: FactoryEvent): number {
    const seq = (this.journaled.get(ticketId) ?? 0) + 1;
    this.journaled.set(ticketId, seq);
    this.events.set(id, { ticketId, event: copy(e) });
    return seq;
  }

  async recentEvents(limit: number, ticketId?: string): Promise<FactoryEvent[]> {
    const rows = [...this.events.values()].filter((e) => !ticketId || e.ticketId === ticketId).reverse();
    return sortBy(rows, (e) => -e.event.at)
      .slice(0, limit)
      .map((e) => copy(e.event));
  }

  /** A run's `labels` keep what it was created with: a later write cannot change them (ORC-226). */
  async putRun(r: RunRecord, fence?: number): Promise<boolean> {
    const kept = this.runs.get(r.id);
    if (kept && fence !== undefined && leaseToken(kept) !== fence) return false;
    const next = copy(r);
    if (kept && Object.hasOwn(kept, 'labels')) next.labels = copy(kept.labels);
    this.runs.set(r.id, next);
    return true;
  }

  async renewRun(id: string, until: number, fence?: number): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running' || (fence !== undefined && leaseToken(run) !== fence)) return false;
    run.leaseUntil = until;
    return true;
  }

  async claimRun(id: string, fence: number): Promise<number | undefined> {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running' || leaseToken(run) !== fence) return undefined;
    run.leaseToken = fence + 1;
    return fence + 1;
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(id);
    return run && copy(run);
  }

  async runsByStatus(status: RunRecord['status']): Promise<RunRecord[]> {
    return sortBy([...this.runs.values()].filter((r) => r.status === status), (r) => r.startedAt).map(copy);
  }

  async ticketRuns(projectId: string, ticketId: string): Promise<RunRecord[]> {
    return sortBy([...this.runs.values()].filter((r) => r.projectId === projectId && r.ticketId === ticketId), (r) => r.startedAt).map(copy);
  }

  async findRunByToken(token: string): Promise<RunRecord | undefined> {
    const run = [...this.runs.values()].find((r) => r.token === token);
    return run && copy(run);
  }

  async putTimer(t: TimerRecord): Promise<void> {
    this.writeTimer(t);
  }

  async dueTimers(now: number): Promise<TimerRecord[]> {
    const armedOpen = new Set([...this.outbox.values()].filter(open).map((r) => r.eventId));
    const due = [...this.timers.values()].filter((t) => t.fireAt <= now && !armedOpen.has(t.armedBy ?? ''));
    return sortBy(due, (t) => t.fireAt).map((t) => upcastTimer(copy(t) as StoredTimer));
  }

  async fireTimer(t: TimerRecord, at: number): Promise<boolean> {
    const key = timerRowId(t);
    if (this.timers.get(key)?.fireAt !== t.fireAt) return false;
    this.timers.delete(key);
    return this.appendResult(timerEvent(t, at));
  }

  async deleteTimersFor(projectId: string, ticketId: string): Promise<void> {
    this.clearTimers(projectId, ticketId);
  }

  async deleteTimersArmedBy(eventId: string): Promise<void> {
    this.deleteArmedBy(eventId);
  }

  private deleteArmedBy(eventId: string): void {
    for (const [key, t] of this.timers) if (t.armedBy === eventId) this.timers.delete(key);
  }

  /**
   * Deduped by ticket + job. A request for an item being handed out takes the row back from its
   * claim: the claim's finish no longer removes it, so the newer request stays in line.
   */
  async enqueue(item: QueueItem): Promise<string> {
    const key = queueKey(item.projectId, item.ticketId, item.job);
    const kept = this.queue.get(key);
    this.queue.set(key, { queue: kept?.queue ?? item.queue, enqueuedAt: kept?.enqueuedAt ?? item.enqueuedAt, rank: queueRank(item.priority), lease: null, leaseUntil: null, item: copy(item) });
    return key;
  }

  /** One process serves this store: the lease only brings back an item lost by a crash. */
  async claimQueued(queue: QueueName, leaseMs: number): Promise<QueueClaim | undefined> {
    const now = this.now();
    const row = this.lineUp().find((r) => r.queue === queue && (r.leaseUntil === null || r.leaseUntil < now));
    if (!row) return undefined;
    Object.assign(row, { lease: randomUUID(), leaseUntil: now + leaseMs });
    return { id: queueKey(row.item.projectId, row.item.ticketId, row.item.job), lease: row.lease!, item: copy(row.item) };
  }

  private lineUp(): QueueRecord[] {
    return sortBy([...this.queue.values()], (r) => r.rank, (r) => r.enqueuedAt);
  }

  private claimed(claim: QueueClaim): QueueRecord | undefined {
    const row = this.queue.get(claim.id);
    return row?.lease === claim.lease ? row : undefined;
  }

  async renewQueued(claim: QueueClaim, leaseMs: number): Promise<boolean> {
    const row = this.claimed(claim);
    if (row) row.leaseUntil = this.now() + leaseMs;
    return row !== undefined;
  }

  async finishQueued(claim: QueueClaim): Promise<boolean> {
    const row = this.claimed(claim);
    if (row) this.queue.delete(claim.id);
    return row !== undefined;
  }

  async releaseQueued(claim: QueueClaim, retry?: QueueRetry): Promise<boolean> {
    const row = this.claimed(claim);
    if (!row) return false;
    // A retry's wait is a lease nobody holds: no claim takes the item before it ends.
    Object.assign(row, { lease: null, leaseUntil: retry?.notBefore ?? null });
    if (retry?.failedStarts !== undefined) row.item = { ...row.item, failedStarts: retry.failedStarts };
    return true;
  }

  async listQueue(): Promise<QueueItem[]> {
    const now = this.now();
    return this.lineUp()
      .filter((r) => r.leaseUntil === null || r.leaseUntil < now)
      .map((r) => copy(r.item));
  }

  async queuedItems(projectId: string, ticketId: string): Promise<QueueItem[]> {
    return [...this.queue.values()].filter((r) => r.item.projectId === projectId && r.item.ticketId === ticketId).map((r) => copy(r.item));
  }

  async removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): Promise<void> {
    for (const [key, r] of this.queue) {
      if (r.item.projectId === projectId && r.item.ticketId === ticketId && (queue === undefined || r.queue === queue)) this.queue.delete(key);
    }
  }

  async markAcked(eventId: string, at: number): Promise<void> {
    const row = this.inbox.get(eventId);
    if (row && row.ackedAt === null) row.ackedAt = at;
  }

  async measureFacts(projectId: string, ticketId: string): Promise<MeasureFacts> {
    const events = [...this.events.values()].filter((e) => e.ticketId === ticketId && e.event.projectId === projectId).map((e) => copy(e.event));
    const acks: Record<string, number> = {};
    for (const e of events) {
      const at = this.inbox.get(e.id)?.ackedAt;
      if (at !== null && at !== undefined) acks[e.id] = at;
    }
    const ids = new Set(events.map((e) => e.id));
    const liftedOnWait = [...this.decisionTrace.entries()]
      .filter(([id, d]) => ids.has(id) && (d.trace ?? []).some((t) => t.startsWith(`${LIFT_ON_WAIT}:`)))
      .map(([id]) => id);
    return {
      devSession: this.ticketRow(projectId, ticketId)?.linearSessionId,
      events,
      runs: await this.ticketRuns(projectId, ticketId),
      effects: await this.listEffects(projectId, ticketId),
      acks,
      liftedOnWait,
    };
  }

  async mergedPrOf(projectId: string, sha: string): Promise<{ ticketId: string; number: number } | undefined> {
    for (const { ticketId, event } of this.events.values()) {
      const p = (event as { payload?: { number?: number; mergeSha?: string; headSha?: string } }).payload;
      if (event.type === 'pr.merged' && event.projectId === projectId && ticketId !== null && (p?.mergeSha === sha || p?.headSha === sha)) {
        return { ticketId, number: Number(p?.number) };
      }
    }
    return undefined;
  }

  async putSecurityLog(log: SecurityLog): Promise<boolean> {
    if (this.securityLogs.has(log.runId)) return false;
    this.securityLogs.set(log.runId, copy(keptSecurityLog(log)));
    return true;
  }

  async securityLog(runId: string): Promise<SecurityLog | undefined> {
    const log = this.securityLogs.get(runId);
    return log && copy(log);
  }

  async putArtifact(a: Artifact): Promise<boolean> {
    if (this.artifactRows.has(a.id)) return false;
    this.artifactRows.set(a.id, copy(a));
    return true;
  }

  async artifacts(ticketId: string): Promise<Artifact[]> {
    return [...this.artifactRows.values()].filter((a) => a.ticketId === ticketId).map(copy);
  }

  async appendChangelog(e: ChangelogEntry): Promise<boolean> {
    if (this.changelogRows.has(e.id)) return false;
    this.changelogRows.set(e.id, copy(e));
    return true;
  }

  async changelog(since: number, until: number, projectId?: string): Promise<ChangelogEntry[]> {
    const rows = [...this.changelogRows.values()].filter((e) => e.at >= since && e.at < until && (projectId === undefined || e.projectId === projectId));
    // Most recent first, then by id descending.
    return sortBy(rows, (e) => e.at, (e) => e.id)
      .reverse()
      .map(copy);
  }

  async knownFlakyTests(projectId: string): Promise<KnownFlakyTest[]> {
    return sortBy([...this.flaky.values()].filter((t) => t.projectId === projectId), (t) => t.addedAt, (t) => t.test).map(copy);
  }

  async putKnownFlakyTest(t: KnownFlakyTest): Promise<void> {
    this.flaky.set(`${t.projectId}\0${t.test}`, copy(t));
  }

  async deleteKnownFlakyTest(projectId: string, test: string): Promise<boolean> {
    return this.flaky.delete(`${projectId}\0${test}`);
  }

  async maturityCards(projectId?: string): Promise<MaturityCard[]> {
    if (projectId !== undefined) return copy(this.maturity.get(projectId) ?? []);
    return [...this.maturity.keys()].sort().flatMap((p) => copy(this.maturity.get(p)!));
  }

  async putMaturityCards(projectId: string, points: readonly MaturityPoint[], at: number): Promise<void> {
    const before = new Map((this.maturity.get(projectId) ?? []).map((c) => [c.key, c]));
    this.maturity.set(projectId, copy(points.map((p) => maturityCard(projectId, p, at, before.get(p.key)))));
  }

  private maturityCardAt(projectId: string, key: string): { cards: MaturityCard[]; i: number } | undefined {
    const cards = this.maturity.get(projectId) ?? [];
    const i = cards.findIndex((c) => c.key === key);
    return i < 0 ? undefined : { cards, i };
  }

  async setMaturityCardValue(projectId: string, key: string, value: string, at: number): Promise<boolean> {
    const found = this.maturityCardAt(projectId, key);
    if (!found) return false;
    const stored = found.cards[found.i]!;
    found.cards[found.i] = copy(maturityCard(projectId, { ...stored, value }, at, stored));
    return true;
  }

  async approveMaturityCard(projectId: string, key: string, value: string, by: string, at: number): Promise<MaturityCard | 'changed' | 'unchecked' | undefined> {
    const found = this.maturityCardAt(projectId, key);
    if (!found) return undefined;
    const stored = copy(found.cards[found.i]!);
    const card = approvedCard(stored, value, by, at);
    if (typeof card !== 'string' && card !== stored) found.cards[found.i] = copy(card);
    return typeof card === 'string' ? card : copy(card);
  }

  async putBaseline(b: Baseline, replace: boolean): Promise<boolean> {
    const samePeriod = (r: (typeof this.baselines)[number]) => r.projectId === b.projectId && r.since === b.since && r.until === b.until;
    if (this.baselines.some(samePeriod)) {
      if (!replace) return false;
      for (let i = this.baselines.length - 1; i >= 0; i--) if (samePeriod(this.baselines[i]!)) this.baselines.splice(i, 1);
    }
    for (const [measure, value] of Object.entries(b.measures)) {
      this.baselines.push({ projectId: b.projectId, since: b.since, until: b.until, measure: measure as BaselineMeasure, computedAt: b.computedAt, value: copy(value) });
    }
    return true;
  }

  async latestBaseline(): Promise<Baseline | null> {
    const last = this.baselines.reduce<(typeof this.baselines)[number] | undefined>((l, r) => (!l || r.computedAt > l.computedAt ? r : l), undefined);
    if (!last) return null;
    const rows = this.baselines.filter((r) => r.projectId === last.projectId && r.since === last.since && r.until === last.until);
    const measures = Object.fromEntries(rows.map((r) => [r.measure, copy(r.value)])) as Baseline['measures'];
    return { projectId: last.projectId, since: last.since, until: last.until, computedAt: last.computedAt, measures };
  }

  async putGhostReplay(r: GhostReplay): Promise<boolean> {
    if (this.ghostReplayRows.has(r.id)) return false;
    this.ghostReplayRows.set(r.id, copy(r));
    return true;
  }

  async ghostReplay(id: string): Promise<GhostReplay | undefined> {
    const r = this.ghostReplayRows.get(id);
    return r && copy(r);
  }

  async ghostReplays(): Promise<GhostReplay[]> {
    return sortBy([...this.ghostReplayRows.values()], (r) => -r.startedAt, (r) => r.id).map(copy);
  }

  async putDryRun(d: DryRun): Promise<void> {
    this.dryRuns.set(d.id, copy(d));
  }

  async lastDryRun(projectId: string, sha?: string): Promise<DryRun | undefined> {
    const rows = [...this.dryRuns.values()].filter((d) => d.projectId === projectId && (sha === undefined ? d.target === 'main' : d.sha === sha)).reverse();
    const last = sortBy(rows, (d) => -d.endedAt)[0];
    return last && copy(last);
  }

  async putGhostTicket(t: GhostTicket): Promise<void> {
    this.ghostTicketRows.set(`${t.replayId}\0${t.ticketId}`, copy(t));
  }

  async ghostTickets(replayId: string): Promise<GhostTicket[]> {
    return sortBy([...this.ghostTicketRows.values()].filter((t) => t.replayId === replayId), (t) => t.ticketId).map(copy);
  }

  async putGhostJudgment(j: GhostJudgment): Promise<boolean> {
    const key = `${j.replayId}\0${j.ticketId}\0${j.side}`;
    if (this.ghostJudgmentRows.has(key)) return false;
    this.ghostJudgmentRows.set(key, copy(j));
    return true;
  }

  async ghostJudgments(replayId: string): Promise<GhostJudgment[]> {
    return sortBy([...this.ghostJudgmentRows.values()].filter((j) => j.replayId === replayId), (j) => j.at, (j) => j.ticketId, (j) => j.side).map(copy);
  }

  async putFindings(r: FindingsRecord): Promise<void> {
    this.findings = this.findings.filter((f) => !(f.projectId === r.projectId && f.ticketId === r.ticketId && f.sha === r.sha && f.lens === r.lens));
    r.findings.forEach((finding, n) => this.findings.push({ ...copy(r), findings: [], n, finding: copy(finding) }));
  }

  async findingsOf(projectId: string, ticketId: string, sha: string): Promise<ReviewFinding[]> {
    const rows = this.findings.filter((f) => f.projectId === projectId && f.ticketId === ticketId && f.sha === sha);
    return sortBy(rows, (f) => f.lens, (f) => f.n).map((f) => ({ ...copy(f.finding), lens: f.lens as ReviewLens, runId: f.runId }));
  }

  async ticketFindings(projectId: string, ticketId: string): Promise<KeptFinding[]> {
    const rows = this.findings.filter((f) => f.projectId === projectId && f.ticketId === ticketId);
    return sortBy(rows, (f) => f.at, (f) => f.lens, (f) => f.n).map((f) => ({
      ...copy(f.finding),
      lens: f.lens as ReviewLens,
      runId: f.runId,
      id: findingRowId(f.runId, f.lens, f.n),
      sha: f.sha,
      at: f.at,
    }));
  }

  async putReviewDefect(d: ReviewDefect): Promise<boolean> {
    if (this.defects.has(d.id)) return false;
    this.defects.set(d.id, copy(d));
    return true;
  }

  async ticketDefects(projectId: string, ticketId: string): Promise<ReviewDefect[]> {
    return sortBy([...this.defects.values()].filter((d) => d.projectId === projectId && d.ticketId === ticketId), (d) => d.at, (d) => d.id).map(copy);
  }

  async reviewDefects(since: number, until: number): Promise<ReviewDefect[]> {
    return sortBy([...this.defects.values()].filter((d) => d.at >= since && d.at < until), (d) => d.at, (d) => d.id).map(copy);
  }

  async securityStats(since: number, until: number): Promise<SecurityStats> {
    const inPeriod = <T extends { at: number }>(xs: T[]) => xs.filter((x) => x.at >= since && x.at < until);
    const hosts = new Map<string, { host: string; requests: number; refused: number }>();
    const rules = new Map<string, { rule: string; refusals: number }>();
    const runs: SecurityStats['runs'] = [];
    for (const log of this.securityLogs.values()) {
      const egress = inPeriod(log.egress);
      const refusals = inPeriod(log.refusals);
      for (const e of egress) {
        const h = hosts.get(e.host) ?? hosts.set(e.host, { host: e.host, requests: 0, refused: 0 }).get(e.host)!;
        h.requests++;
        if (!e.ok) h.refused++;
      }
      for (const r of refusals) (rules.get(r.rule) ?? rules.set(r.rule, { rule: r.rule, refusals: 0 }).get(r.rule)!).refusals++;
      if (egress.length || refusals.length) {
        runs.push({ runId: log.runId, projectId: log.projectId, ticketId: log.ticketId, requests: egress.length, refused: egress.filter((e) => !e.ok).length, refusals: refusals.length });
      }
    }
    return {
      hosts: [...hosts.values()].sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host)),
      rules: [...rules.values()].sort((a, b) => b.refusals - a.refusals || a.rule.localeCompare(b.rule)),
      runs: runs.sort(byMostRefused),
    };
  }

  async blocksEntered(since: number, until: number): Promise<BlockEntry[]> {
    return blockMoves(copy([...this.decisionTrace.values()]), await this.listTickets())
      .filter((b) => b.at >= since && b.at < until)
      .sort((a, b) => a.at - b.at);
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.meta.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  async receiveDelivery(key: string, value: string): Promise<string | undefined> {
    const kept = this.meta.get(`delivery:${key}`);
    if (kept === undefined) this.meta.set(`delivery:${key}`, value);
    return kept;
  }

  async pendingDeliveries(): Promise<{ key: string; value: string }[]> {
    return this.deliveriesUnder('delivery:');
  }

  async asideDeliveries(): Promise<{ key: string; value: string }[]> {
    return this.deliveriesUnder('delivery-aside:');
  }

  private deliveriesUnder(prefix: string): { key: string; value: string }[] {
    return [...this.meta].filter(([k]) => k.startsWith(prefix)).map(([k, value]) => ({ key: k.slice(prefix.length), value }));
  }

  async deleteDelivery(key: string): Promise<void> {
    this.meta.delete(`delivery:${key}`);
  }

  async asideDelivery(key: string): Promise<void> {
    const value = this.meta.get(`delivery:${key}`);
    if (value === undefined) return;
    // Set apart last, as a row written again would be.
    this.meta.delete(`delivery-aside:${key}`);
    this.meta.set(`delivery-aside:${key}`, value);
    this.meta.delete(`delivery:${key}`);
  }

  async close(): Promise<void> {}
}
