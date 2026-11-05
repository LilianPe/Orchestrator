import { deadLetteredEvent } from '../core/dead-letter.js';
import type { FactoryEvent } from '../core/types.js';
import { upcast, type StoredEvent } from '../core/upcast.js';
import { TicketHeldError, type DecisionOutcome, type DecisionRequest, type EffectOutcome, type OutboxRow, type Store } from '../store/types.js';
import { OutboxExecutor, type EffectRetry } from './outbox.js';

/** Inbox rows read per pass. */
const INBOX_BATCH = 100;
/**
 * Processings of a row whose preparation or store transaction throws (the tracker or the database
 * down), in this process: the n-th retry after `baseMs * 3^(n-1)` (2 s, 6 s, 18 s, 54 s: about 80 s
 * in all). Past the last one, the row waits for the next start. A decision that throws is not
 * retried: it is dead-lettered (ORC-175).
 */
export const PROCESS_RETRY = { attempts: 5, baseMs: 2_000 };

/**
 * What the event itself makes throw, whatever the infrastructure: its upcast, or its decision
 * (`decide`, `reduce`). Pure functions of the event and the stored state, they would throw again.
 */
class PoisonEvent extends Error {}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function poisonOn<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    throw new PoisonEvent(toError(err).message, { cause: err });
  }
}

export interface WorkerDeps {
  store: Store;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Outside any lock or transaction: what the decision needs from outside (a tracker snapshot). May throw. */
  prepare(event: FactoryEvent): Promise<FactoryEvent>;
  /** The decision request of an event: its `decide` runs inside the store's transaction. */
  request(event: FactoryEvent): DecisionRequest;
  /** After the commit, before the decision's effects: bus, logs, in-memory slots. */
  committed(event: FactoryEvent, outcome: Extract<DecisionOutcome, { status: 'committed' }>): Promise<void>;
  /** Executes one outbox row. Throws when the effect failed: the executor retries it, then lets it die (ORC-150). */
  execute(row: OutboxRow): Promise<EffectOutcome | void>;
  leaseMs?: number;
  /** Retries of a row whose processing throws (`PROCESS_RETRY` by default). */
  retry?: { attempts: number; baseMs: number };
  /** Retries of an effect that throws (`EFFECT_RETRY` by default). */
  effectRetry?: EffectRetry;
  /** The time of the effect results it writes to the inbox; the store's clock by default. */
  now?: () => number;
  /** A row left for the next start: past its last retry, or behind such a row. Must not throw. */
  left?(row: StoredEvent): void;
  /** A row set aside in `dead_letter`, its decision having thrown (ORC-175). Must not throw. */
  deadLettered?(row: StoredEvent): void;
}

interface TicketRef {
  projectId: string;
  ticketId?: string;
}

/** `projectId:ticketId`, `projectId:*` for an event without a ticket. */
export const ticketKey = (r: TicketRef): string => `${r.projectId}:${r.ticketId ?? '*'}`;

const whose = (r: TicketRef): string => r.ticketId ?? `the events without a ticket of ${r.projectId}`;

/**
 * The worker of ORC-149: it takes the inbox rows and runs each one's decision transaction
 * (`Store.decide`), then executes the outbox rows that decision wrote, after the commit.
 *
 * - **One task per ticket.** A ticket's rows and effects run one after the other, in arrival
 *   order; tickets run side by side, so a long effect (`workspaces.prepare`, an `npm ci`) holds
 *   only its own ticket. Across processes, the store's ticket lock and its `waiting` outcome
 *   (an older row, or an unfinished effect, of the same ticket) keep the same order.
 * - **Effects after the commit.** The ticket's outbox rows go through the `OutboxExecutor`
 *   (ORC-150): claimed under a lease renewed while they run, retried with a backoff, dead past
 *   their last attempt, and each result written back to the inbox as `effect:<id>`, decided here
 *   like any event. A worker that dies leaves its row to another once the lease expires. At least
 *   once: an effect cut after it acted runs again (idempotency per effect: ORC-162).
 * - **A failure holds its ticket.** A row whose preparation or store transaction throws (the
 *   tracker, the database) stays pending and is retried with a backoff (`PROCESS_RETRY`); the later
 *   rows of its ticket (or, for an event without a ticket, of its project) wait behind it and go
 *   once it passes. Past the last retry, the row and those behind it wait for the next start.
 * - **A poison event is dead-lettered (ORC-175).** A row whose upcast or decision (`decide`,
 *   `reduce`) throws would throw again: it is not retried. It goes to `dead_letter`, marked
 *   processed, with the event that blocks its ticket written to the inbox, in one transaction; the
 *   rows behind it go on. `factory run repair` replays, skips or forces it.
 */
export class Worker {
  /** Tail of each ticket's task chain: everything of a ticket runs after what was queued before. */
  private tails = new Map<string, Promise<unknown>>();
  /** Tickets whose row-and-effect loop is queued or running. */
  private draining = new Set<string>();
  private queued = new Map<string, StoredEvent[]>();
  private queuedIds = new Set<string>();
  /** Rows left out of the passes: a failed row until its retry (or the next start), the rows behind it. */
  private skipped = new Set<string>();
  /** Keys held by a failed row (its id): their later rows wait behind it. */
  private holders = new Map<string, string>();
  /** The rows waiting behind each held key, released once its failed row passes. */
  private behind = new Map<string, Map<string, StoredEvent>>();
  /** Failed processings of each row in this process. */
  private failures = new Map<string, number>();
  private retryTimers = new Set<NodeJS.Timeout>();
  private readonly retry: { attempts: number; baseMs: number };
  /** Rows that found a row or an effect of their ticket first: retried at the next poll, or by `unwait`. */
  private waited = new Map<string, StoredEvent>();
  private tasks = new Set<Promise<unknown>>();
  private pass: Promise<number> | undefined;
  private again = false;
  private poller: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly executor: OutboxExecutor;

  constructor(private d: WorkerDeps) {
    this.retry = d.retry ?? PROCESS_RETRY;
    this.executor = new OutboxExecutor({
      store: d.store,
      log: d.log,
      execute: (row) => d.execute(row),
      retryIn: (delayMs) => this.wakeIn(delayMs),
      leaseMs: d.leaseMs,
      retry: d.effectRetry,
      now: d.now,
    });
  }

  /** Looks at the store again in `delayMs` (an effect's retry is due), as the poll would. */
  private wakeIn(delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.pollInBackground();
    }, delayMs + 1);
    timer.unref();
    this.retryTimers.add(timer);
  }

  /**
   * Runs `f` in the ticket's task chain, after what is queued for that ticket (its rows, its
   * effects): the in-process lock of a ticket, for work outside a decision.
   */
  exclusive<T>(ref: TicketRef, f: () => Promise<T>): Promise<T> {
    const key = ticketKey(ref);
    const run = (this.tails.get(key) ?? Promise.resolve()).then(f, f);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    this.tasks.add(tail);
    void tail.finally(() => {
      this.tasks.delete(tail);
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }

  /**
   * One pass: reads the pending inbox rows and the tickets with effects to claim, and starts a
   * task for each ticket that has work. A kick during a pass makes the pass read again before it
   * resolves. Resolves with the number of rows and tickets it handed out.
   */
  kick(): Promise<number> {
    if (this.pass) {
      this.again = true;
      return this.pass;
    }
    const pass = (async () => {
      let n = 0;
      do {
        this.again = false;
        n += await this.scan();
      } while (this.again);
      return n;
    })().finally(() => {
      this.pass = undefined;
    });
    this.pass = pass;
    return pass;
  }

  /** `kick` without waiting for it: a failed pass is logged, and the next one reads again. */
  kickInBackground(): void {
    this.kick().catch((err: unknown) => this.d.log('error', `worker: ${(err as Error).message}`));
  }

  /** Polls the store (rows written by another process, leases expired): the daemon's loop. */
  start(intervalMs = 1000): void {
    this.stop();
    this.stopped = false;
    this.poller = setInterval(() => this.pollInBackground(), intervalMs);
    this.poller.unref();
  }

  /**
   * One poll of `start`'s loop, awaited: the rows that found their ticket held (another worker's
   * effect, a backoff) are tried again, with what another process wrote and the expired leases.
   */
  poll(): Promise<number> {
    this.waited.clear();
    return this.kick();
  }

  private pollInBackground(): void {
    this.poll().catch((err: unknown) => this.d.log('error', `worker: ${(err as Error).message}`));
  }

  /** Stops polling and the pending retries: a stopped worker takes nothing up by itself. */
  stop(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.stopped = true;
  }

  /** Resolves once the tasks running now, and those they start, are done. */
  async settle(): Promise<void> {
    while (this.tasks.size > 0 || this.pass) {
      await Promise.all([...this.tasks, this.pass?.catch(() => 0)]);
    }
  }

  private async scan(): Promise<number> {
    let n = 0;
    const exclude = [...this.skipped, ...this.waited.keys(), ...this.queuedIds];
    for (const row of await this.d.store.pendingInbox(INBOX_BATCH, exclude)) {
      this.queue(row);
      n++;
    }
    for (const ref of await this.d.store.effectTickets()) {
      if (this.draining.has(ticketKey(ref))) continue;
      this.drain(ref);
      n++;
    }
    return n;
  }

  /** Queues a row on its ticket's task, once. */
  private queue(row: StoredEvent): void {
    if (this.queuedIds.has(row.id)) return;
    const key = ticketKey(row);
    this.queuedIds.add(row.id);
    const rows = this.queued.get(key) ?? [];
    rows.push(row);
    this.queued.set(key, rows);
    this.drain(row);
  }

  private drain(ref: TicketRef): void {
    const key = ticketKey(ref);
    if (this.draining.has(key)) return;
    this.draining.add(key);
    void this.exclusive(ref, () => this.drainTicket(ref, key)).catch((err: unknown) => {
      // The store failed (database down): the ticket's rows are read again at the next pass.
      this.draining.delete(key);
      for (const row of this.queued.get(key) ?? []) this.queuedIds.delete(row.id);
      this.queued.delete(key);
      this.d.log('error', `worker ${key}: ${(err as Error).message}`);
    });
  }

  /** The ticket's loop: its unfinished effects first, then its next row, until both are empty. */
  private async drainTicket(ref: TicketRef, key: string): Promise<void> {
    for (;;) {
      const effects = await this.executor.runTicket(ref.projectId, ref.ticketId);
      // Their results are in the inbox now: the next pass reads them. With no effect left open, the
      // rows that found them unfinished go first, without waiting for a poll (ORC-290).
      if (effects.settled > 0) {
        if (effects.status === 'done' && !this.stopped) this.unwait(key);
        this.kickInBackground();
      }
      // Effects held (another worker's lease, a backoff): the next row still goes to the store, which
      // lets a stop of the ticket's work pass a backoff (ORC-150) and answers `waiting` otherwise.
      const row = this.queued.get(key)?.shift();
      if (!row) break;
      // `held`: only a backoff holds it, so the ticket's next row is tried (a stop passes them both).
      if ((await this.process(row, key)) === 'waiting') {
        this.waitAll(key);
        break;
      }
    }
    // Synchronous with the last emptiness check: a row queued from now on starts a new loop.
    this.draining.delete(key);
    this.queued.delete(key);
  }

  /** Something holds the ticket (another worker, an older row, an effect): its queued rows wait for the next poll, or for `unwait`. */
  private waitAll(key: string): void {
    for (const row of this.queued.get(key) ?? []) {
      this.queuedIds.delete(row.id);
      this.waited.set(row.id, row);
    }
    this.queued.delete(key);
  }

  private async process(row: StoredEvent, key: string): Promise<'done' | 'held' | 'waiting'> {
    try {
      const holder = this.holders.get(key);
      if (holder !== undefined && holder !== row.id) {
        this.skipped.add(row.id);
        const rows = this.behind.get(key) ?? new Map<string, StoredEvent>();
        rows.set(row.id, row);
        this.behind.set(key, rows);
        this.d.log('error', `event ${row.id} (${row.type}) kept in the inbox behind a failed event of ${whose(row)} (${holder})`);
        if (this.givenUp(holder)) this.d.left?.(row);
        return 'done';
      }
      let outcome: DecisionOutcome;
      let event: FactoryEvent | undefined;
      try {
        event = await this.d.prepare(poisonOn(() => upcast(row)));
        const req = this.d.request(event);
        outcome = await this.d.store.decide({ ...req, decide: (ticket, workflow) => poisonOn(() => req.decide(ticket, workflow)) });
      } catch (err) {
        // Set aside as prepared (its snapshot filled), so that a replay decides what was decided.
        if (err instanceof PoisonEvent || err instanceof TicketHeldError) await this.deadLetter(event ?? row, key, err);
        else this.failed(row, key, toError(err));
        return 'done';
      }
      if (outcome.status === 'waiting') {
        this.waited.set(row.id, row);
        return outcome.backoff ? 'held' : 'waiting';
      }
      this.passed(row, key);
      if (outcome.status === 'committed') {
        this.unwait(key);
        try {
          await this.d.committed(event, outcome);
        } catch (err) {
          // The decision is committed: its effects run all the same, right after.
          this.d.log('error', `event ${row.id} (${row.type}) decided, but its follow-up failed: ${(err as Error).message}`);
        }
      }
      return 'done';
    } finally {
      this.queuedIds.delete(row.id);
    }
  }

  /**
   * The row's decision threw (ORC-175), or the store refused it (`TicketHeldError`, ORC-291): retried, it
   * would do so again. It is set aside in
   * `dead_letter` and marked processed, and the event that blocks its ticket is written to the inbox,
   * in one transaction; the rows behind it go on. A store that cannot write the dead letter (down)
   * leaves the row to the retries of `failed`: nothing is lost.
   */
  private async deadLetter(row: StoredEvent, key: string, err: Error): Promise<void> {
    let written: boolean;
    try {
      written = await this.d.store.deadLetter(row, err.message, this.d.now?.() ?? Date.now());
    } catch (writeErr) {
      this.failed(row, key, new Error(`${err.message}; not dead-lettered: ${toError(writeErr).message}`));
      return;
    }
    // Not written: another worker processed the row meanwhile. Either way, the rows behind it go on.
    this.passed(row, key);
    if (!written) return;
    const set = deadLetteredEvent(row);
    this.d.log('error', `event ${set.id} (${set.type}) dead-lettered, its decision threw: ${err.message} (repair: factory run repair ${set.ticketId ?? set.id})`);
    this.d.deadLettered?.(row);
    // The event that blocks the ticket is in the inbox now.
    this.kickInBackground();
  }

  /** A row's processing threw: it holds its key, and is retried after a backoff while retries are left. */
  private failed(row: StoredEvent, key: string, err: Error): void {
    const n = (this.failures.get(row.id) ?? 0) + 1;
    this.failures.set(row.id, n);
    this.skipped.add(row.id);
    this.holders.set(key, row.id);
    if (this.givenUp(row.id)) {
      this.d.log('error', `event ${row.id} (${row.type}): ${err.message} (kept in the inbox for the next start, after ${n} attempts)`);
      for (const r of [row, ...(this.behind.get(key)?.values() ?? [])]) this.d.left?.(r);
      return;
    }
    const delay = this.retry.baseMs * 3 ** (n - 1);
    this.d.log('error', `event ${row.id} (${row.type}): ${err.message} (attempt ${n} of ${this.retry.attempts}, retried in ${Math.round(delay / 1000)} s)`);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.skipped.delete(row.id);
      // Queued as read, not left to the next scan: a transaction that committed after all (the
      // answer to its COMMIT lost) left the row processed, out of the scans, and only its own
      // processing (`processed`) lets the rows behind it go (ORC-163).
      this.queue(row);
      this.kickInBackground();
    }, delay);
    timer.unref();
    this.retryTimers.add(timer);
  }

  /**
   * A row of the ticket went through (a stop that cancelled a backoff, say), or its last open effect
   * settled here: its rows that found it held are tried again now rather than at the next poll. They
   * go at the head of its queue, ahead of the younger rows read while they were parked (ORC-290). Only
   * from the ticket's own task: none of its rows is at the store now.
   */
  private unwait(key: string): void {
    const rows = [...this.waited.values()].filter((row) => ticketKey(row) === key);
    if (rows.length === 0) return;
    for (const row of rows) {
      this.waited.delete(row.id);
      this.queuedIds.add(row.id);
    }
    this.queued.set(key, [...rows, ...(this.queued.get(key) ?? [])]);
  }

  /** No retry left for this row in this process: it waits for the next start. */
  private givenUp(id: string): boolean {
    return (this.failures.get(id) ?? 0) >= this.retry.attempts || this.stopped;
  }

  /** A row went through: if it held its key, the rows behind it are taken up again. */
  private passed(row: StoredEvent, key: string): void {
    this.failures.delete(row.id);
    if (this.holders.get(key) !== row.id) return;
    this.holders.delete(key);
    for (const id of this.behind.get(key)?.keys() ?? []) this.skipped.delete(id);
    this.behind.delete(key);
    this.kickInBackground();
  }
}
