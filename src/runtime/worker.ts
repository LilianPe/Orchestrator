import type { FactoryEvent } from '../core/types.js';
import { upcast, type StoredEvent } from '../core/upcast.js';
import type { DecisionOutcome, DecisionRequest, OutboxRow, Store } from '../store/types.js';

/** Inbox rows read per pass. */
const INBOX_BATCH = 100;
/** Lease of a claimed outbox row, renewed every third of it while its effect runs (ORC-129: 60 s, renewed every 20 s). */
export const EFFECT_LEASE_MS = 60_000;
/**
 * Processings of a row that throws, in this process: the n-th retry after `baseMs * 3^(n-1)`
 * (2 s, 6 s, 18 s, 54 s: about 80 s in all). Past the last one, the row waits for the next start.
 */
export const PROCESS_RETRY = { attempts: 5, baseMs: 2_000 };

export interface WorkerDeps {
  store: Store;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Outside any lock or transaction: what the decision needs from outside (a tracker snapshot). May throw. */
  prepare(event: FactoryEvent): Promise<FactoryEvent>;
  /** The decision request of an event: its `decide` runs inside the store's transaction. */
  request(event: FactoryEvent): DecisionRequest;
  /** After the commit, before the decision's effects: bus, logs, in-memory slots. */
  committed(event: FactoryEvent, outcome: Extract<DecisionOutcome, { status: 'committed' }>): Promise<void>;
  /** Executes one outbox row. Throws when the effect failed. */
  execute(row: OutboxRow): Promise<void>;
  /** An effect threw: the worker skips the decision's later effects (`settle` aside), then calls this. */
  effectFailed(row: OutboxRow, err: Error): Promise<void>;
  leaseMs?: number;
  /** Retries of a row whose processing throws (`PROCESS_RETRY` by default). */
  retry?: { attempts: number; baseMs: number };
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
 * - **Effects after the commit.** Each outbox row is claimed under a lease renewed while it runs:
 *   a worker that dies leaves it to another once the lease expires. At least once: an effect cut
 *   after it acted runs again (idempotency per effect: ORC-162; executors, backoff: ORC-150).
 * - **A failure holds its ticket.** A row whose preparation or transaction throws stays pending
 *   and is retried with a backoff (`PROCESS_RETRY`); the later rows of its ticket (or, for an
 *   event without a ticket, of its project) wait behind it and go once it passes. Past the last
 *   retry, the row and those behind it wait for the next start (dead-letter: ORC-175).
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
  private behind = new Map<string, Set<string>>();
  /** Failed processings of each row in this process. */
  private failures = new Map<string, number>();
  private retryTimers = new Set<NodeJS.Timeout>();
  private readonly retry: { attempts: number; baseMs: number };
  /** Rows that found another worker's row or effect first: retried at the next poll. */
  private waited = new Set<string>();
  /** Events with a failed effect: their later effects are skipped (in this process). */
  private failedEvents = new Set<string>();
  private tasks = new Set<Promise<unknown>>();
  private pass: Promise<number> | undefined;
  private again = false;
  private poller: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly leaseMs: number;

  constructor(private d: WorkerDeps) {
    this.leaseMs = d.leaseMs ?? EFFECT_LEASE_MS;
    this.retry = d.retry ?? PROCESS_RETRY;
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

  /** Polls the store (rows written by another process, leases expired): the daemon's loop. */
  start(intervalMs = 1000): void {
    this.stop();
    this.stopped = false;
    this.poller = setInterval(() => {
      this.waited.clear();
      this.kick().catch((err: unknown) => this.d.log('error', `worker: ${(err as Error).message}`));
    }, intervalMs);
    this.poller.unref();
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
    const exclude = [...this.skipped, ...this.waited, ...this.queuedIds];
    for (const row of await this.d.store.pendingInbox(INBOX_BATCH, exclude)) {
      const key = ticketKey(row);
      if (this.queuedIds.has(row.id)) continue;
      this.queuedIds.add(row.id);
      const rows = this.queued.get(key) ?? [];
      rows.push(row);
      this.queued.set(key, rows);
      this.drain(row);
      n++;
    }
    for (const ref of await this.d.store.effectTickets()) {
      if (this.draining.has(ticketKey(ref))) continue;
      this.drain(ref);
      n++;
    }
    return n;
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
      if ((await this.runEffects(ref)) === 'busy') {
        this.waitAll(key);
        break;
      }
      const row = this.queued.get(key)?.shift();
      if (!row) break;
      if ((await this.process(row, key)) === 'waiting') {
        this.waitAll(key);
        break;
      }
    }
    // Synchronous with the last emptiness check: a row queued from now on starts a new loop.
    this.draining.delete(key);
    this.queued.delete(key);
  }

  /** Another worker holds the ticket: its queued rows wait for the next poll. */
  private waitAll(key: string): void {
    for (const row of this.queued.get(key) ?? []) {
      this.queuedIds.delete(row.id);
      this.waited.add(row.id);
    }
    this.queued.delete(key);
  }

  private async process(row: StoredEvent, key: string): Promise<'done' | 'waiting'> {
    try {
      const holder = this.holders.get(key);
      if (holder !== undefined && holder !== row.id) {
        this.skipped.add(row.id);
        const rows = this.behind.get(key) ?? new Set<string>();
        rows.add(row.id);
        this.behind.set(key, rows);
        this.d.log('error', `event ${row.id} (${row.type}) kept in the inbox behind a failed event of ${whose(row)} (${holder})`);
        return 'done';
      }
      let outcome: DecisionOutcome;
      let event: FactoryEvent;
      try {
        event = await this.d.prepare(upcast(row));
        outcome = await this.d.store.decide(this.d.request(event));
      } catch (err) {
        this.failed(row, key, err as Error);
        return 'done';
      }
      if (outcome.status === 'waiting') {
        this.waited.add(row.id);
        return 'waiting';
      }
      this.passed(row, key);
      if (outcome.status === 'committed') {
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

  /** A row's processing threw: it holds its key, and is retried after a backoff while retries are left. */
  private failed(row: StoredEvent, key: string, err: Error): void {
    const n = (this.failures.get(row.id) ?? 0) + 1;
    this.failures.set(row.id, n);
    this.skipped.add(row.id);
    this.holders.set(key, row.id);
    if (n >= this.retry.attempts || this.stopped) {
      this.d.log('error', `event ${row.id} (${row.type}): ${err.message} (kept in the inbox for the next start, after ${n} attempts)`);
      return;
    }
    const delay = this.retry.baseMs * 3 ** (n - 1);
    this.d.log('error', `event ${row.id} (${row.type}): ${err.message} (attempt ${n} of ${this.retry.attempts}, retried in ${Math.round(delay / 1000)} s)`);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.skipped.delete(row.id);
      this.kick().catch((e: unknown) => this.d.log('error', `worker: ${(e as Error).message}`));
    }, delay);
    timer.unref();
    this.retryTimers.add(timer);
  }

  /** A row went through: if it held its key, the rows behind it are taken up again. */
  private passed(row: StoredEvent, key: string): void {
    this.failures.delete(row.id);
    if (this.holders.get(key) !== row.id) return;
    this.holders.delete(key);
    for (const id of this.behind.get(key) ?? []) this.skipped.delete(id);
    this.behind.delete(key);
    this.kick().catch((e: unknown) => this.d.log('error', `worker: ${(e as Error).message}`));
  }

  private async runEffects(ref: TicketRef): Promise<'done' | 'busy'> {
    const { store } = this.d;
    for (;;) {
      const row = await store.claimEffect(ref.projectId, ref.ticketId, this.leaseMs);
      if (row === undefined) return 'done';
      if (row === 'busy') return 'busy';
      const lease = row.lease ?? '';
      if (this.failedEvents.has(row.eventId) && row.effect.kind !== 'settle') {
        await store.failEffect(row.id, lease);
        continue;
      }
      const renew = setInterval(() => {
        store
          .renewEffect(row.id, lease, this.leaseMs)
          .then((held) => {
            if (!held) this.d.log('warn', `effect ${row.id}: lease lost to another worker while it ran`);
          })
          .catch((err: unknown) => this.d.log('warn', `lease of ${row.id}: ${(err as Error).message}`));
      }, Math.max(1, Math.floor(this.leaseMs / 3)));
      renew.unref();
      let failure: Error | undefined;
      try {
        await this.d.execute(row);
      } catch (err) {
        failure = err as Error;
      } finally {
        clearInterval(renew);
      }
      // Settled only under this claim: a worker that lost its lease leaves the row to its new holder.
      if (failure) {
        if (await store.failEffect(row.id, lease)) {
          this.failedEvents.add(row.eventId);
          await this.d.effectFailed(row, failure);
        } else {
          this.d.log('warn', `effect ${row.id} failed (${failure.message}), but its lease went to another worker: not settled here`);
        }
      } else if (!(await store.completeEffect(row.id, lease))) {
        this.d.log('warn', `effect ${row.id} done, but its lease went to another worker: not settled here`);
      }
    }
  }
}
