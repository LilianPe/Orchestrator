import { LEASE_MS, type OutboxRow, type Store } from '../store/types.js';

/** Lease of a claimed outbox row, renewed every third of it while its effect runs (ORC-129: 60 s, renewed every 20 s). */
export const EFFECT_LEASE_MS = LEASE_MS;

/** How an effect that throws is tried again (ORC-150). */
export interface EffectRetry {
  /** Attempts in all, the first one included: past the last one, the effect is dead. */
  attempts: number;
  /** Delay before the second attempt; doubled for each next one. */
  baseMs: number;
  /** Ceiling of the delay. */
  capMs: number;
}

/** ORC-129: backoff `1 s × 2^(attempt − 1)` capped at 5 min, dead after 8 attempts. */
export const EFFECT_RETRY: EffectRetry = { attempts: 8, baseMs: 1_000, capMs: 300_000 };

/** The delay before the attempt after `attempt` (1 for the first one). */
export function effectBackoff(attempt: number, retry: EffectRetry = EFFECT_RETRY): number {
  return Math.min(retry.capMs, retry.baseMs * 2 ** (attempt - 1));
}

export interface OutboxExecutorDeps {
  store: Store;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Carries out one outbox row (the adapters behind it). Throws when the effect failed. */
  execute(row: OutboxRow): Promise<void>;
  /** A row went back to `pending` for its retry in `delayMs`: whoever polls should look again then. */
  retryIn(delayMs: number): void;
  leaseMs?: number;
  retry?: EffectRetry;
  /** The time of the result events (the orchestrator's clock); the store's own by default. */
  now?: () => number;
}

/**
 * The outbox executor of ORC-150. It claims a ticket's outbox rows one at a time, in order, each
 * under a lease renewed while the effect runs, and settles each one under its claim token:
 *
 * - **done**: the row is `done` and its result `effect:<id>` (`effect.done`) enters the inbox in
 *   the same transaction, to be decided by the worker like any event;
 * - **failed, attempts left**: the row goes back to `pending` with its error, claimable again
 *   after the backoff (`effectBackoff`); the ticket's later rows wait behind it;
 * - **failed, last attempt**: the row is `dead`, the later rows of its decision are skipped, the
 *   timers it armed are deleted, and `effect:<id>` (`effect.failed`) enters the inbox: its
 *   decision blocks the ticket. All of it in one transaction: nothing of it is kept in memory.
 *
 * At least once: an effect cut after it acted (a crash, a lost lease) runs again under its next
 * claim. Making each external effect idempotent is ORC-162.
 */
export class OutboxExecutor {
  readonly leaseMs: number;
  readonly retry: EffectRetry;

  constructor(private d: OutboxExecutorDeps) {
    this.leaseMs = d.leaseMs ?? EFFECT_LEASE_MS;
    this.retry = d.retry ?? EFFECT_RETRY;
  }

  /**
   * Runs the ticket's claimable rows, in order, until none is left (`done`) or its head cannot be
   * taken now (`busy`: another executor holds it, or it waits for its retry). `settled` counts the
   * rows settled here: each one wrote a result to the inbox.
   */
  async runTicket(projectId: string, ticketId: string | undefined): Promise<{ status: 'done' | 'busy'; settled: number }> {
    let settled = 0;
    for (;;) {
      const row = await this.d.store.claimEffect(projectId, ticketId, this.leaseMs);
      if (row === undefined) return { status: 'done', settled };
      if (row === 'busy') return { status: 'busy', settled };
      const outcome = await this.run(row);
      if (outcome !== 'lost') settled++;
      if (outcome === 'retry') return { status: 'busy', settled };
    }
  }

  /** Executes one claimed row and settles it: `done`, `retry` (back to pending), `dead`, or `lost` (its lease went to another). */
  async run(row: OutboxRow): Promise<'done' | 'retry' | 'dead' | 'lost'> {
    const { store } = this.d;
    const lease = row.lease ?? '';
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
    if (!failure) {
      if (await store.completeEffect(row.id, lease, this.d.now?.())) return 'done';
      this.d.log('warn', `effect ${row.id} done, but its lease went to another worker: not settled here`);
      return 'lost';
    }
    const what = `effect ${row.id} (${row.effect.kind})`;
    if (row.attempts < this.retry.attempts) {
      const delay = effectBackoff(row.attempts, this.retry);
      if (!(await store.retryEffect(row.id, lease, failure.message, delay))) {
        this.d.log('warn', `${what} failed (${failure.message}), but its lease went to another worker: not settled here`);
        return 'lost';
      }
      this.d.log('warn', `${what}: ${failure.message} (attempt ${row.attempts} of ${this.retry.attempts}, retried in ${delay} ms)`);
      this.d.retryIn(delay);
      return 'retry';
    }
    if (!(await store.failEffect(row.id, lease, failure.message, this.d.now?.()))) {
      this.d.log('warn', `${what} failed (${failure.message}), but its lease went to another worker: not settled here`);
      return 'lost';
    }
    this.d.log('error', `${what}: ${failure.message} (dead after ${row.attempts} attempts: the rest of its decision is skipped)`);
    return 'dead';
  }
}
