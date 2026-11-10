import type { OutboxEffect } from '../core/decision.js';
import { LEASE_MS, type EffectOutcome, type OutboxRow, type Store } from '../store/types.js';
import { attemptsFor, backoff, TRANSIENT_WINDOW_MS, type RetryPolicy } from './transient.js';

/** Lease of a claimed outbox row, renewed every third of it while its effect runs (ORC-129: 60 s, renewed every 20 s). */
export const EFFECT_LEASE_MS = LEASE_MS;

/** How an effect that throws is tried again (ORC-150, ORC-343): doubled from `baseMs` up to `capMs`. */
export type EffectRetry = RetryPolicy;

/**
 * ORC-129: backoff `1 s × 2^(attempt − 1)` capped at 5 min. Dead after 8 attempts (about 2 min) when the failure is
 * permanent; after 15 (about 33 min, `TRANSIENT_WINDOW_MS`) when it is transient (ORC-343): GitHub or Linear back
 * within half an hour, the effect goes through and its ticket is not blocked.
 */
export const EFFECT_RETRY: EffectRetry = { attempts: 8, transientWindowMs: TRANSIENT_WINDOW_MS, baseMs: 1_000, capMs: 300_000 };

/** The delay before the attempt after `attempt` (1 for the first one). */
export function effectBackoff(attempt: number, retry: EffectRetry = EFFECT_RETRY): number {
  return backoff(retry, attempt);
}

/**
 * Where each kind of effect acts (ORC-231): `outside` writes to Linear or GitHub, or reads them into the inbox (`reconcile`);
 * `inside` stays in the factory (its runs, its workspaces, its store). Every kind is listed, so a new one does not compile until
 * someone says where it acts: the no-effect mode never lets one out by default.
 */
export const EFFECT_REACH: Record<OutboxEffect['kind'], 'inside' | 'outside'> = {
  start_run: 'inside',
  stop_run: 'inside',
  run_verify: 'inside',
  publish: 'outside',
  move: 'outside',
  labels: 'outside',
  comment: 'outside',
  block_comment: 'outside',
  ack: 'outside',
  activity: 'outside',
  post_output: 'outside',
  review: 'outside',
  link_pr: 'outside',
  reconcile: 'outside',
  merge: 'outside',
  take_over: 'inside',
  close_take_over: 'inside',
  publish_bundle: 'outside',
  after_merge: 'outside',
  cleanup: 'inside',
  set_paused: 'inside',
  settle: 'inside',
};

export interface OutboxExecutorDeps {
  store: Store;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Carries out one outbox row (the adapters behind it). Throws when the effect failed. May tell
   * that it found the effect already made by an earlier execution (ORC-162): its result says so.
   */
  execute(row: OutboxRow): Promise<EffectOutcome | void>;
  /**
   * The projects without effects (ORC-231: the replay of closed tickets, a prompt tried out): their rows that reach outside
   * (`EFFECT_REACH`) go to `keep`, never to `execute`.
   */
  noEffect?: (projectId: string) => boolean;
  /** Keeps what a row of a project without effects would have done, as an artifact of its run. Absent: such a row fails. */
  keep?(row: OutboxRow): Promise<void>;
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
 *   after the backoff (`effectBackoff`); the ticket's later rows wait behind it. A transient failure
 *   (`isTransient`: GitHub, Linear or the database down) has more attempts, to wait out an outage (ORC-343);
 * - **failed, last attempt**: the row is `dead`, the later rows of its decision are skipped, the
 *   timers it armed are deleted, and `effect:<id>` (`effect.failed`) enters the inbox: its
 *   decision blocks the ticket. All of it in one transaction: nothing of it is kept in memory.
 *
 * At least once: an effect cut after it acted (a crash, a lost lease) runs again under its next
 * claim. Each external effect is idempotent, keyed by the row id (ORC-162, docs/idempotency.md): a
 * replay that finds it already made writes nothing and settles as done, `deduplicated`.
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
      // A result entered the inbox (done or dead): whoever polls should read it.
      if (outcome === 'done' || outcome === 'dead') settled++;
      if (outcome === 'retry') return { status: 'busy', settled };
    }
  }

  /**
   * Here and not in the adapters (ORC-231): a project without effects has its writes kept whatever adapter would make them, so an
   * adapter that forgets the mode cannot push.
   */
  private async carryOut(row: OutboxRow): Promise<EffectOutcome | void> {
    if (!this.d.noEffect?.(row.projectId) || EFFECT_REACH[row.effect.kind] === 'inside') return this.d.execute(row);
    if (!this.d.keep) throw new Error(`project ${row.projectId} has no effects, and nowhere to keep ${row.effect.kind}`);
    await this.d.keep(row);
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
    let outcome: EffectOutcome | undefined;
    try {
      outcome = (await this.carryOut(row)) ?? undefined;
    } catch (err) {
      // A non-Error throw still has a message to store and to report.
      failure = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearInterval(renew);
    }
    // Settled only under this claim: a worker that lost its lease leaves the row to its new holder.
    if (!failure) {
      if (await store.completeEffect(row.id, lease, this.d.now?.(), outcome)) return 'done';
      this.d.log('warn', `effect ${row.id} done, but its lease went to another worker: not settled here`);
      return 'lost';
    }
    const what = `effect ${row.id} (${row.effect.kind})`;
    const attempts = attemptsFor(this.retry, failure);
    if (row.attempts < attempts) {
      const delay = effectBackoff(row.attempts, this.retry);
      if (!(await store.retryEffect(row.id, lease, failure.message, delay))) {
        this.d.log('warn', `${what} failed (${failure.message}), but its lease went to another worker: not settled here`);
        return 'lost';
      }
      this.d.log('warn', `${what}: ${failure.message} (attempt ${row.attempts} of ${attempts}, retried in ${delay} ms)`);
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
