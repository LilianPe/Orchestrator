import { GitHubApiError } from '../adapters/forge/github-app.js';
import { LinearApiError } from '../adapters/tracker/linear/api.js';

/**
 * Transient or permanent (ORC-343): the one place that tells an outage of GitHub, Linear or the database, which passes
 * by itself, from an error that would come back on every try. Read from what each adapter really throws:
 *
 * - **GitHub** (`GitHubApiError`, github-app.ts): a 5xx, a 408, a 429, or a rate limit GitHub answers with a 403.
 * - **Linear** (`LinearApiError`, linear/api.ts): a 5xx, a 408, a 429, or a GraphQL error coded `RATELIMITED` (Linear
 *   answers its rate limit with a 400).
 * - **The network** under `fetch` (undici's `TypeError: fetch failed`, its `cause` a socket error or an undici timeout), `pg`
 *   and its pool: a refused, reset or timed-out connection, a name that does not resolve now. A certificate refused is not.
 * - **Postgres** (`pg`'s `DatabaseError`, wrapped by drizzle's `DrizzleQueryError` as its `cause`): the SQLSTATE classes
 *   `08` (connection), `53` (resources), `57P01`–`57P03` (server shutting down or starting), a serialization failure or
 *   a deadlock (`40001`, `40P01`); and `pg`'s own messages for a connection lost or not obtained in time.
 * - **SQLite** (`node:sqlite`): a busy or locked database (`errcode` 5 or 6).
 * - **git and gh** (`execFailure`, exec.ts, and `fetchOrigin`'s `cause`): stderr naming the network or a 5xx.
 *
 * Everything else is permanent: a 4xx, a refusal, a bug, a closed pool (this process shutting down). The causes are
 * read down the chain (`cause`), so a wrapper (`RetryableStart`, drizzle) keeps what it wraps.
 */
export function isTransient(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && e !== undefined && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (transientHere(e)) return true;
  }
  return false;
}

/** Socket errors: the server is not there now, or the network between. */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN']);
/** undici's own codes for a connection that timed out or broke; its other `UND_ERR_*` are misuses, permanent. */
const UNDICI_TRANSIENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
/** SQLSTATE codes of a database that is down, starting, overloaded or that asked to try again. */
const PG_TRANSIENT = /^(08|53)|^57P0[123]$|^40001$|^40P01$/;
/** `pg` and `pg-pool`: a connection lost, or none obtained in time. "Client was closed" and "Cannot use a pool after calling end" are this process's own shutdown: not transient. */
const PG_MESSAGES = /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect|Client has encountered a connection error and is not queryable)$/;
/** git's and gh's stderr when the forge cannot be reached, or answers a 5xx. */
const EXEC_NETWORK =
  /^(git|gh) .*(Could not resolve host|Failed to connect to|Connection (refused|reset|timed out)|Operation timed out|ssh: connect to host|early EOF|RPC failed|The requested URL returned error: 5\d\d|HTTP 5\d\d|unexpected disconnect|error connecting to)/s;

function transientHere(e: unknown): boolean {
  if (e instanceof GitHubApiError) return e.rateLimited || retryableStatus(e.status);
  if (e instanceof LinearApiError) return (e.status !== undefined && retryableStatus(e.status)) || e.errors.some((g) => g.extensions?.code === 'RATELIMITED');
  if (!(e instanceof Error)) return false;
  // undici's `TypeError: fetch failed` says nothing by itself: its cause tells a socket error from a certificate refused (read on the next turn).
  if (e.name === 'TimeoutError') return true;
  const { code, errcode } = e as { code?: unknown; errcode?: unknown };
  if (typeof code === 'string' && (NETWORK_CODES.has(code) || UNDICI_TRANSIENT.has(code) || PG_TRANSIENT.test(code))) return true;
  if (code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' && [5, 6].includes(errcode & 0xff)) return true;
  return PG_MESSAGES.test(e.message) || EXEC_NETWORK.test(e.message);
}

const retryableStatus = (status: number): boolean => status >= 500 || status === 408 || status === 429;

/** How long a transient outage is waited out before its row or effect is given up (ORC-343): GitHub, Linear or the database back within it, nothing is blocked. */
export const TRANSIENT_WINDOW_MS = 30 * 60_000;

/**
 * A retry with a backoff (ORC-129, ORC-343): the delay after the n-th failure is `baseMs × factor^(n − 1)`, capped at
 * `capMs`. Past `attempts` failures, given up; past `transientAttempts` when the last failure is transient
 * (`isTransient`), so that an outage of `TRANSIENT_WINDOW_MS` is waited out (`retryWindow`).
 */
export interface RetryPolicy {
  /** Attempts in all, the first one included, when the failure is permanent. */
  attempts: number;
  /** Attempts in all when the failure is transient; `attempts` by default. */
  transientAttempts?: number;
  /** Delay after the first failure. */
  baseMs: number;
  /** Ceiling of the delay; none by default. */
  capMs?: number;
  /** Growth of the delay at each failure; 2 by default. */
  factor?: number;
}

/** The delay after the `failure`-th failure (1 for the first one). */
export function backoff(policy: RetryPolicy, failure: number): number {
  return Math.min(policy.capMs ?? Infinity, policy.baseMs * (policy.factor ?? 2) ** (failure - 1));
}

/** The attempts `err` gets in all under `policy`. */
export function attemptsFor(policy: RetryPolicy, err: unknown): number {
  return isTransient(err) ? Math.max(policy.attempts, policy.transientAttempts ?? policy.attempts) : policy.attempts;
}

/** The time from the first failure to the last attempt, when there are `attempts` in all. */
export function retryWindow(policy: RetryPolicy, attempts: number): number {
  let total = 0;
  for (let n = 1; n < attempts; n++) total += backoff(policy, n);
  return total;
}
