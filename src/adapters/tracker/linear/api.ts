export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> }>;

export interface LinearGqlError {
  message: string;
  /** `code`: `RATELIMITED` for Linear's rate limit, which it answers with a 400 (ORC-343). */
  extensions?: { userPresentableMessage?: string; code?: string };
}

/** A refusal of Linear's API: its GraphQL errors, and the HTTP status it came with (`isTransient` reads both, ORC-343). */
export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly errors: LinearGqlError[] = [],
    readonly status?: number,
    /** The wait the answer asked for before a retry, in ms: its `Retry-After`, or the reset of its requests (ORC-350). */
    readonly retryInMs?: number,
  ) {
    super(message);
  }
}

export interface LinearApiOptions {
  /** The longest a call may take, its answer read (ORC-350): past it, aborted, a `TimeoutError` (transient, ORC-343). */
  timeoutMs?: number;
  /** Tries again after a rate limit, for a critical call; a background one is never tried again. */
  rateLimitRetries?: number;
  /** The longest wait before a retry, whatever Linear's reset says. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GqlOptions {
  /**
   * A call nothing waits for (the live feed of a run, ORC-350): skipped, never retried, while a rate limit is waited out
   * or once less than a tenth of the hour's requests is left, so that the critical calls keep the quota.
   */
  background?: boolean;
}

const TIMEOUT_MS = 30_000;
const RATE_LIMIT_RETRIES = 3;
const MAX_WAIT_MS = 60_000;
/** The first wait after a rate limit without a reset in its answer, doubled at each retry. */
const BASE_WAIT_MS = 1_000;
/** The share of the hour's requests kept for the critical calls. */
const RESERVE = 0.1;

const isRateLimited = (status: number, errors: LinearGqlError[] | undefined) => status === 429 || !!errors?.some((e) => e.extensions?.code === 'RATELIMITED');

/** An hour without an answer that says when its requests reset: the quota read is no longer known past it. */
const QUOTA_WINDOW_MS = 3_600_000;

export class LinearApi {
  private readonly opts: Required<LinearApiOptions>;
  /** Until when Linear refuses for its rate limit: a critical call waits, a background one is skipped. */
  private limitedUntil = 0;
  /** The hour's requests, as Linear's last answer counted them, until their reset. */
  private quota: { limit: number; remaining: number; until: number } | undefined;

  constructor(
    private getToken: () => Promise<string>,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private endpoint = 'https://api.linear.app/graphql',
    opts: LinearApiOptions = {},
  ) {
    this.opts = {
      timeoutMs: TIMEOUT_MS,
      rateLimitRetries: RATE_LIMIT_RETRIES,
      maxWaitMs: MAX_WAIT_MS,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      ...opts,
    };
  }

  /**
   * One GraphQL call, bounded in time (ORC-350). A rate limit (a 429, or Linear's `RATELIMITED` 400) is waited out, until
   * Linear's reset when it gives one, with a growing delay otherwise, then tried again; a critical call made meanwhile
   * waits for it too. Past the retries, its error is the outbox's to retry (ORC-343).
   */
  async gql<T>(query: string, variables: Record<string, unknown> = {}, o: GqlOptions = {}): Promise<T> {
    for (let failure = 1; ; failure++) {
      if (o.background && this.keptForCritical()) throw new LinearApiError('Linear quota kept for the critical calls: background call skipped');
      const hold = this.limitedUntil - this.opts.now();
      if (hold > 0) await this.opts.sleep(Math.min(hold, this.opts.maxWaitMs));
      try {
        const data = await this.once<T>(query, variables);
        this.limitedUntil = 0;
        return data;
      } catch (err) {
        if (!(err instanceof LinearApiError && err.status !== undefined && isRateLimited(err.status, err.errors))) throw err;
        // A reset already past by this clock (a skew) or a `Retry-After: 0` still backs off.
        const wait = Math.min(this.opts.maxWaitMs, err.retryInMs || BASE_WAIT_MS * 2 ** (failure - 1));
        this.limitedUntil = this.opts.now() + wait;
        if (o.background || failure > this.opts.rateLimitRetries) throw err;
      }
    }
  }

  private keptForCritical(): boolean {
    const now = this.opts.now();
    if (now < this.limitedUntil) return true;
    return this.quota !== undefined && now < this.quota.until && this.quota.remaining < this.quota.limit * RESERVE;
  }

  private async once<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.getToken()}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    const retryInMs = this.readLimits(res.headers);
    // A 502 from a proxy in front of Linear has an HTML body: its status still tells what failed.
    const json = (await res.json().catch((err: unknown) => {
      if (res.ok) throw err;
      return {};
    })) as { data?: T; errors?: LinearGqlError[] };
    if (json.errors?.length) throw new LinearApiError(json.errors.map((e) => e.message).join('; '), json.errors, res.status, retryInMs);
    if (!res.ok) throw new LinearApiError(`HTTP ${res.status}`, [], res.status, retryInMs);
    return json.data as T;
  }

  /**
   * Linear's rate-limit headers: the hour's requests and their reset (epoch ms) kept as the quota; returns the wait before
   * a retry they ask for, its `Retry-After` in seconds first.
   */
  private readLimits(headers: { get(name: string): string | null } | undefined): number | undefined {
    const num = (name: string) => {
      const v = headers?.get(name);
      return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
    };
    const now = this.opts.now();
    const limit = num('x-ratelimit-requests-limit');
    const remaining = num('x-ratelimit-requests-remaining');
    const reset = num('x-ratelimit-requests-reset');
    if (limit !== undefined && remaining !== undefined) this.quota = { limit, remaining, until: reset ?? now + QUOTA_WINDOW_MS };
    const retryAfter = num('retry-after');
    return retryAfter !== undefined ? retryAfter * 1000 : reset !== undefined ? Math.max(0, reset - now) : undefined;
  }
}
