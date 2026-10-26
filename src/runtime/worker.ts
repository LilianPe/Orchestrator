import type { FactoryEvent } from '../core/types.js';
import { upcast, type StoredEvent } from '../core/upcast.js';
import type { DecisionOutcome, DecisionRequest, OutboxRow, Store } from '../store/types.js';

/** Inbox rows read per pass. */
const INBOX_BATCH = 100;
/** Lease of a claimed outbox row, renewed every third of it while its effect runs (ORC-129: 60 s, renewed every 20 s). */
export const EFFECT_LEASE_MS = 60_000;

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
}

interface TicketRef {
  projectId: string;
  ticketId?: string;
}

/** `projectId:ticketId`, `projectId:*` for an event without a ticket. */
export const ticketKey = (r: TicketRef): string => `${r.projectId}:${r.ticketId ?? '*'}`;

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
 * - **A failure holds its ticket.** A row whose preparation or transaction throws stays pending,
 *   untouched by this process until the next start, and so do the later rows of its ticket
 *   (dead-letter: ORC-175).
 */
export class Worker {
  /** Tail of each ticket's task chain: everything of a ticket runs after what was queued before. */
  private tails = new Map<string, Promise<unknown>>();
  /** Tickets whose row-and-effect loop is queued or running. */
  private draining = new Set<string>();
  private queued = new Map<string, StoredEvent[]>();
  private queuedIds = new Set<string>();
  /** Rows whose processing threw in this process: pending until the next start. */
  private skipped = new Set<string>();
  /** Tickets with a skipped row: their later rows stay pending behind it. */
  private held = new Set<string>();
  /** Rows that found another worker's row or effect first: retried at the next poll. */
  private waited = new Set<string>();
  /** Events with a failed effect: their later effects are skipped (in this process). */
  private failedEvents = new Set<string>();
  private tasks = new Set<Promise<unknown>>();
  private pass: Promise<number> | undefined;
  private again = false;
  private poller: NodeJS.Timeout | undefined;
  private readonly leaseMs: number;

  constructor(private d: WorkerDeps) {
    this.leaseMs = d.leaseMs ?? EFFECT_LEASE_MS;
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
    this.poller = setInterval(() => {
      this.waited.clear();
      this.kick().catch((err: unknown) => this.d.log('error', `worker: ${(err as Error).message}`));
    }, intervalMs);
    this.poller.unref();
  }

  stop(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
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
    const hasTicket = row.ticketId !== undefined;
    try {
      if (hasTicket && this.held.has(key)) {
        this.skipped.add(row.id);
        this.d.log('error', `event ${row.id} (${row.type}) kept in the inbox behind a failed event of ${row.ticketId}, for the next start`);
        return 'done';
      }
      let outcome: DecisionOutcome;
      let event: FactoryEvent;
      try {
        event = await this.d.prepare(upcast(row));
        outcome = await this.d.store.decide(this.d.request(event));
      } catch (err) {
        this.skipped.add(row.id);
        if (hasTicket) this.held.add(key);
        this.d.log('error', `event ${row.id} (${row.type}): ${(err as Error).message} (kept in the inbox for the next start)`);
        return 'done';
      }
      if (outcome.status === 'waiting') {
        this.waited.add(row.id);
        return 'waiting';
      }
      if (outcome.status === 'committed') await this.d.committed(event, outcome);
      return 'done';
    } finally {
      this.queuedIds.delete(row.id);
    }
  }

  private async runEffects(ref: TicketRef): Promise<'done' | 'busy'> {
    const { store } = this.d;
    for (;;) {
      const row = await store.claimEffect(ref.projectId, ref.ticketId, this.leaseMs);
      if (row === undefined) return 'done';
      if (row === 'busy') return 'busy';
      if (this.failedEvents.has(row.eventId) && row.effect.kind !== 'settle') {
        await store.failEffect(row.id);
        continue;
      }
      const renew = setInterval(() => {
        store.renewEffect(row.id, this.leaseMs).catch((err: unknown) => this.d.log('warn', `lease of ${row.id}: ${(err as Error).message}`));
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
      if (failure) {
        await store.failEffect(row.id);
        this.failedEvents.add(row.eventId);
        await this.d.effectFailed(row, failure);
      } else {
        await store.completeEffect(row.id);
      }
    }
  }
}
