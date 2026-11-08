import { createPrivateKey, createSign } from 'node:crypto';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { FeedbackItem } from '../../core/types.js';
import { aggregateChecks, excerpt, toRepoPermission } from './gh-cli.js';
import { unresolvedReviewFeedback, type GraphQl } from './review-threads.js';
import type { RepoPermission, RepoPermissions } from '../roles/types.js';
import { isFactoryCheck, NoCommitsBetween, type CheckRunRequest, type Forge, type ForgeWriter, type GitAccess, type MergeResult, type PrInfo, type PrRequest } from './types.js';

export interface GitHubRepoRef {
  owner: string;
  name: string;
}

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  /** Read for the rate limit headers of a refusal (`retry-after`, `x-ratelimit-remaining`). */
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Injected in tests: no unit test ever reaches the network. */
export type HttpClient = (url: string, init: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, headers: res.headers, text: () => res.text() };
};

/** GitHub rejects installation tokens older than one hour; cache them with a safety margin. */
export const TOKEN_SAFETY_MARGIN_MS = 60_000;
const ONE_HOUR_MS = 60 * 60_000;
/** Pages of 100 read from one list, at most: a bound against a server that ignores `page`, not a GitHub limit. */
const MAX_PAGES = 10;

interface AccessTokenDto {
  token: string;
  expires_at?: string;
}

interface PullRequestDto {
  number: number;
  node_id?: string;
  draft?: boolean;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit_sha?: string | null;
  head: { ref: string; sha: string };
  base?: { ref: string; sha: string };
}

interface CheckRunDto {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  external_id?: string | null;
}

interface WorkflowDto {
  state: string;
  path?: string;
}

interface StatusDto {
  context: string;
  state: string;
}

export interface GitHubAppForgeOptions {
  appId: string | number;
  /** PEM content. */
  privateKey: string;
  /** Known installation; otherwise discovered with GET /repos/{owner}/{repo}/installation. */
  installationId?: string | number;
  apiBase?: string;
  http?: HttpClient;
  exec?: Exec;
  /** Overrides `git remote get-url origin` (tests). */
  resolveRepo?: (repoPath: string) => Promise<GitHubRepoRef>;
  now?: () => number;
  log?: (message: string) => void;
}

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** RS256 app JWT: iss = appId, iat = now - 60 s, exp = now + 9 min. */
export function createAppJwt(appId: string | number, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Parses HTTPS and SSH GitHub remotes into owner/name, without calling gh. */
export function parseGitHubRemote(remote: string): GitHubRepoRef | undefined {
  const value = remote.trim();
  let path: string | undefined;
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/(.+)$/i.exec(value);
  if (url) path = url[1];
  else {
    const scp = /^(?:[^@/]+@)?github\.com:(.+)$/i.exec(value);
    if (scp) path = scp[1];
    else {
      const bare = /^github\.com\/(.+)$/i.exec(value);
      if (bare) path = bare[1];
    }
  }
  if (!path) return undefined;
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return undefined;
  const [owner, rawName] = parts;
  const name = rawName?.replace(/\.git$/, '');
  return owner && name ? { owner, name } : undefined;
}

/** Bucket of a check run, as `aggregateChecks` reads it; also read by the GitHub webhook (ORC-134). */
export function checkRunBucket(run: { status: string; conclusion: string | null }): string {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'pass';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'stale':
    case 'startup_failure':
      return 'fail';
    default:
      return 'pending';
  }
}

function statusBucket(state: string): string {
  if (state === 'success') return 'pass';
  if (state === 'failure' || state === 'error') return 'fail';
  return 'pending';
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the verdict reads of a check run, and all it checks: never its `id`. */
const isCheckRun = (r: unknown): r is Pick<CheckRunDto, 'name' | 'status' | 'conclusion'> =>
  isRecord(r) &&
  typeof r.name === 'string' &&
  typeof r.status === 'string' &&
  (r.conclusion === null || typeof r.conclusion === 'string');

const isPull = (p: unknown): p is PullRequestDto =>
  isRecord(p) &&
  typeof p.number === 'number' &&
  typeof p.html_url === 'string' &&
  typeof p.state === 'string' &&
  isRecord(p.head) &&
  typeof p.head.ref === 'string' &&
  typeof p.head.sha === 'string' &&
  (p.base === undefined || (isRecord(p.base) && typeof p.base.ref === 'string' && typeof p.base.sha === 'string'));

const isWorkflow = (w: unknown): w is WorkflowDto =>
  isRecord(w) && typeof w.state === 'string' && (w.path === undefined || typeof w.path === 'string');

const isStatus = (s: unknown): s is StatusDto => isRecord(s) && typeof s.context === 'string' && typeof s.state === 'string';

const isPulls = (v: unknown): v is PullRequestDto[] => Array.isArray(v) && v.every(isPull);

/** A PR as `markPrReady` reads it: its draft state, and the node id the mutation needs when it is a draft. */
const isDraftState = (p: unknown): p is PullRequestDto & { draft: boolean } =>
  isPull(p) && typeof p.draft === 'boolean' && (!p.draft || typeof p.node_id === 'string');

/** What `upsertCheckRun` reads of a run: its id, and the external id it matches. */
const isCheckRunRef = (r: unknown): r is Pick<CheckRunDto, 'id' | 'external_id'> =>
  isRecord(r) && typeof r.id === 'number' && (r.external_id === undefined || r.external_id === null || typeof r.external_id === 'string');

const isCreated = (r: unknown): r is { id: number } => isRecord(r) && typeof r.id === 'number';

const isAccessToken = (d: unknown): d is AccessTokenDto =>
  isRecord(d) && typeof d.token === 'string' && d.token !== '' && (d.expires_at === undefined || typeof d.expires_at === 'string');

/** A collaborator's permission: one of its two fields at least, a string; an unknown role is still an answer. */
const isPermission = (d: unknown): d is { permission?: string; role_name?: string } =>
  isRecord(d) &&
  (typeof d.permission === 'string' || typeof d.role_name === 'string') &&
  (d.permission === undefined || typeof d.permission === 'string') &&
  (d.role_name === undefined || typeof d.role_name === 'string');

/** GraphQL's `errors`: absent, or a list of messages. */
const isGraphQlErrors = (e: unknown): e is { message: string }[] | undefined =>
  e === undefined || (Array.isArray(e) && e.every((x) => isRecord(x) && typeof x.message === 'string'));

/** GraphQL answered with errors to report: the rest of the answer is not read. */
const hasErrors = (d: Record<string, unknown>): boolean => Array.isArray(d.errors) && d.errors.length > 0;

/** The ready-for-review mutation: its errors, or its result. A `null` result without errors is no proof it ran. */
const isReadyAnswer = (d: unknown): d is { errors?: { message: string }[] } =>
  isRecord(d) && isGraphQlErrors(d.errors) && (hasErrors(d) || (isRecord(d.data) && isRecord(d.data.markPullRequestReadyForReview)));
/** `GitHub API <method> <path>`, without the query: the prefix of every error of a call. */
const apiLabel = (method: string, path: string) => `GitHub API ${method} ${path.split('?')[0]}`;

/**
 * A 2xx answer that is not what the endpoint documents: never read as an empty list (ORC-273). `secret`: the answer
 * may carry a credential, so no part of it goes in the error.
 */
function unreadable(method: string, path: string, what: string, data: unknown, secret = false): Error {
  const shown = secret ? '' : `: ${data === undefined ? 'undefined' : excerpt(JSON.stringify(data))}`;
  return new Error(`${apiLabel(method, path)}: unreadable answer, not ${what}${shown}`);
}

/** `/repos/{owner}/{name}`, encoded. */
function repoApi(repo: GitHubRepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** GitHub's reason under its "Validation Failed": a 422 says it there. */
function validationErrors(data: object): string[] {
  const errors = (data as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors.flatMap((e: { message?: unknown }) => (typeof e?.message === 'string' ? [e.message] : [])) : [];
}

/**
 * A refusal for the rate, not for the permission: GitHub answers both a primary and a secondary rate limit with a 403
 * (or a 429), a `retry-after` header, `x-ratelimit-remaining: 0`, or a message that names it.
 */
function isRateLimit(res: HttpResponse, message: string): boolean {
  return (
    (res.status === 403 || res.status === 429) &&
    (res.headers?.get('retry-after') != null || res.headers?.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message))
  );
}

/** GitHub API failure with its status, so callers can fail closed on 404/403. */
export class GitHubApiError extends Error {
  readonly status: number;
  /** GitHub's own `message`, for an answer worth repeating to a human (a merge refused). */
  readonly apiMessage?: string;
  /** A rate limit, not a permission: never read as an answer about the repository. */
  readonly rateLimited: boolean;

  constructor(status: number, message: string, apiMessage?: string, rateLimited = false) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    if (apiMessage) this.apiMessage = apiMessage;
    this.rateLimited = rateLimited;
  }
}

/**
 * GitHub App authentication shared by the forge and the reads of `factory doctor`:
 * RS256 JWT, repo-scoped installation token cached per repo, JSON REST calls.
 * The token stays in memory: it is never logged and never appears in an error.
 */
export class GitHubAppAuth {
  protected readonly appId: string;
  readonly #privateKey: string;
  protected readonly installationId: string | undefined;
  protected readonly apiBase: string;
  protected readonly http: HttpClient;
  protected readonly exec: Exec;
  private readonly resolveRepoFn: ((repoPath: string) => Promise<GitHubRepoRef>) | undefined;
  protected readonly now: () => number;
  protected readonly log: ((message: string) => void) | undefined;
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(options: GitHubAppForgeOptions) {
    this.appId = String(options.appId);
    this.#privateKey = options.privateKey;
    this.installationId = options.installationId === undefined ? undefined : String(options.installationId);
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.http = options.http ?? fetchHttp;
    this.exec = options.exec ?? execCmd;
    this.resolveRepoFn = options.resolveRepo;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log;
    try {
      createPrivateKey(this.#privateKey);
    } catch {
      throw new Error('GitHub App: invalid private key (RSA PEM expected)');
    }
  }

  protected async repo(repoPath: string): Promise<GitHubRepoRef> {
    if (this.resolveRepoFn) return this.resolveRepoFn(repoPath);
    const remote = await mustExec(this.exec, 'git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    const repo = parseGitHubRemote(remote);
    if (!repo) throw new Error(`the origin remote of ${repoPath} is not a GitHub repository`);
    return repo;
  }

  protected async installationToken(repo: GitHubRepoRef): Promise<string> {
    const key = `${repo.owner}/${repo.name}`;
    const now = this.now();
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAt > now) return cached.token;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = this.fetchInstallationToken(repo, now).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private async fetchInstallationToken(repo: GitHubRepoRef, now: number): Promise<string> {
    const jwt = createAppJwt(this.appId, this.#privateKey, now);
    const installationId = this.installationId ?? (await this.findInstallationId(repo, jwt));
    const data = await this.read(
      'POST',
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      jwt,
      isAccessToken,
      'an installation token',
      { repositories: [repo.name] },
      true,
    );
    const requested = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
    const hardLimit = now + ONE_HOUR_MS;
    const expiresAt = (Number.isFinite(requested) ? Math.min(requested, hardLimit) : hardLimit) - TOKEN_SAFETY_MARGIN_MS;
    this.#tokens.set(`${repo.owner}/${repo.name}`, { token: data.token, expiresAt });
    this.log?.(`GitHub App: installation token for ${repo.owner}/${repo.name} (expires ${new Date(expiresAt).toISOString()})`);
    return data.token;
  }

  private async findInstallationId(repo: GitHubRepoRef, jwt: string): Promise<string> {
    const data = await this.read('GET', `${repoApi(repo)}/installation`, jwt, isCreated, 'an installation');
    return String(data.id);
  }

  /**
   * Every page of a list GitHub returns under `key`, 100 per page. An answer without that list, or with an entry
   * `isEntry` rejects, throws: read as empty, it would drop checks from the verdict, down to `none`, hide a CI, create a
   * second check run, or let `doctor` skip an environment (ORC-273).
   * A list longer than `MAX_PAGES` pages throws too: a server that ignores `page` would loop forever, under a lease
   * renewed all along. After `MAX_PAGES` full pages, one more page is read: empty, the list is complete. `filter`:
   * the endpoint's own query parameters, sent with every page.
   */
  protected async allPages<E>(
    path: string,
    key: string,
    what: string,
    isEntry: (e: unknown) => e is E,
    token: string,
    filter = new URLSearchParams(),
  ): Promise<E[]> {
    const all: E[] = [];
    for (let page = 1; ; page++) {
      const url = `${path}?${new URLSearchParams([...filter, ['per_page', '100'], ['page', String(page)]])}`;
      const isPage = (d: unknown): d is Record<string, E[]> => isRecord(d) && Array.isArray(d[key]) && d[key].every(isEntry);
      const list = (await this.read('GET', url, token, isPage, what))[key]!;
      if (page > MAX_PAGES) {
        if (list.length === 0) return all;
        throw new Error(`${apiLabel('GET', path)}: more than ${MAX_PAGES * 100} entries, never read as complete`);
      }
      all.push(...list);
      if (list.length < 100) return all;
    }
  }

  /**
   * The HTTP exchange: a refusal throws a `GitHubApiError`, a 2xx body that is not JSON throws, an empty one is
   * `undefined`. Callers never read its answer without a guard: `read` checks it, `call` drops it (ORC-273).
   * `secret`: the answer carries a credential (an installation token), so no part of it goes in an error.
   */
  async #send(method: string, path: string, auth: string, body: unknown, secret: boolean): Promise<unknown> {
    const res = await this.http(`${this.apiBase}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${auth}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'factory-orchestrator',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data: unknown;
    let json = true;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
      json = false;
    }
    if (!res.ok) {
      const message =
        typeof data === 'object' && data !== null && 'message' in data
          ? [String((data as { message: unknown }).message), ...validationErrors(data)].join(' : ')
          : text.slice(0, 200);
      throw new GitHubApiError(res.status, `${apiLabel(method, path)}: ${res.status}${message ? ` ${message}` : ''}`, message || undefined, isRateLimit(res, message));
    }
    if (!json) throw new Error(`${apiLabel(method, path)}: unreadable answer, not JSON${secret ? '' : `: ${excerpt(text)}`}`);
    return data;
  }

  /** A call whose answer is not read (a write that only has to succeed): it returns nothing to read. */
  protected async call(method: string, path: string, auth: string, body?: unknown): Promise<void> {
    await this.#send(method, path, auth, body, false);
  }

  /** A call whose answer is read: one `is` rejects throws, saying it is unreadable (ORC-273). */
  protected async read<T>(
    method: string,
    path: string,
    auth: string,
    is: (v: unknown) => v is T,
    what: string,
    body?: unknown,
    secret = false,
  ): Promise<T> {
    const data = await this.#send(method, path, auth, body, secret);
    if (!is(data)) throw unreadable(method, path, what, data, secret);
    return data;
  }

}

export class GitHubAppForge extends GitHubAppAuth implements Forge, ForgeWriter, RepoPermissions {
  /**
   * A user's permission on the repo (ORC-186), with the installation token: the app needs only the
   * `metadata: read` permission. Once the token is in hand, the repo is one the app sees: a 404 then
   * means a login GitHub does not know, which gets `none`. Any other failure throws, a 404 on the
   * repo or the installation included (an app not installed is a configuration error, not a refusal).
   */
  async repoPermission(repoPath: string, login: string): Promise<RepoPermission> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    try {
      return toRepoPermission(
        await this.read('GET', `${repoApi(repo)}/collaborators/${encodeURIComponent(login)}/permission`, token, isPermission, 'a permission'),
      );
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return 'none';
      throw err;
    }
  }

  async findPr(repoPath: string, branch: string): Promise<PrInfo | undefined> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const query = new URLSearchParams({ head: `${repo.owner}:${branch}`, state: 'all', per_page: '1' });
    const [pr] = await this.read('GET', `${repoApi(repo)}/pulls?${query}`, token, isPulls, 'a list of pull requests');
    if (!pr) return undefined;
    const state: PrInfo['state'] = pr.state === 'open' ? 'OPEN' : pr.merged_at ? 'MERGED' : 'CLOSED';
    const checks = state === 'OPEN' ? await this.checksFor(repo, pr.head.sha, token) : { checks: 'none' as const, failedChecks: [] };
    const merged = state === 'MERGED' ? { ...(pr.merge_commit_sha ? { mergeSha: pr.merge_commit_sha } : {}), mergedAt: Date.parse(pr.merged_at!) } : {};
    return { number: pr.number, url: pr.html_url, state, branch: pr.head.ref, headSha: pr.head.sha, ...merged, ...checks };
  }

  async mergePr(repoPath: string, number: number, sha: string, opts: { unchecked?: boolean } = {}): Promise<MergeResult> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const url = `${repoApi(repo)}/pulls/${number}`;
    // A replay: the first call merged it on that head. Merged on another head is not ours to call merged.
    const pr = await this.read('GET', url, token, isPull, 'a pull request');
    if (pr.merged_at && pr.head.sha === sha) return { merged: true, deduplicated: true };
    // A method the repository allows, a merge commit first: a squash-only repository refuses the others (405).
    const settings = await this.read('GET', repoApi(repo), token, isRecord, 'repository settings');
    const method = settings.allow_merge_commit !== false ? 'merge' : settings.allow_squash_merge !== false ? 'squash' : 'rebase';
    if (opts.unchecked) {
      // Read as moved, answered as moved, with no PUT: a stale read must never let an unchecked head merge unverified.
      if (pr.head.sha !== sha) return { merged: false, reason: 'head_moved' };
      if (!(await this.withoutCi(repo, pr, token))) return { merged: false, reason: 'checks_missing' };
    }
    try {
      await this.call('PUT', `${url}/merge`, token, { sha, merge_method: method });
      return { merged: true, deduplicated: false };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 409) return { merged: false, reason: 'head_moved' };
      if (err instanceof GitHubApiError && err.status === 405) return { merged: false, reason: 'not_mergeable', message: err.apiMessage ?? err.message };
      throw err;
    }
  }

  /**
   * Looks for the branch's open PR before creating one (ORC-162). If a PR opened between the two
   * (a concurrent replay), GitHub answers 422: the open PR is read again and returned. A 422 with no
   * open PR behind it (another validation error) is thrown as is.
   */
  async ensurePr(repoPath: string, req: PrRequest): Promise<{ number: number; url: string; deduplicated: boolean }> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const base = `${repoApi(repo)}/pulls`;
    const openPr = async () => {
      const query = new URLSearchParams({ head: `${repo.owner}:${req.branch}`, state: 'open', per_page: '1' });
      const [pr] = await this.read('GET', `${base}?${query}`, token, isPulls, 'a list of pull requests');
      return pr && { number: pr.number, url: pr.html_url, deduplicated: true };
    };
    const found = await openPr();
    if (found) return found;
    try {
      const pr = await this.read('POST', base, token, isPull, 'a pull request', { title: req.title, head: req.branch, base: req.base, body: req.body, ...(req.draft ? { draft: true } : {}) });
      return { number: pr.number, url: pr.html_url, deduplicated: false };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422) {
        // A plan without drafts: the PR is what the ticket needs, and no human is asked to review it before Human Review.
        if (req.draft && /draft pull requests are not supported/i.test(err.message)) {
          const { draft: _, ...plain } = req;
          return this.ensurePr(repoPath, plain);
        }
        const raced = await openPr();
        if (raced) return raced;
        if (/no commits between/i.test(err.message)) throw new NoCommitsBetween(err.message);
      }
      throw err;
    }
  }

  /** The REST API cannot do it: only this GraphQL mutation takes a PR out of draft. Read first: a PR already out writes nothing. */
  async markPrReady(repoPath: string, number: number): Promise<void> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const pr = await this.read('GET', `${repoApi(repo)}/pulls/${number}`, token, isDraftState, 'a pull request with its draft state');
    if (!pr.draft) return;
    const out = await this.read('POST', '/graphql', token, isReadyAnswer, 'a GraphQL answer to markPullRequestReadyForReview', {
      query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }',
      variables: { id: pr.node_id },
    });
    if (out.errors?.length) throw new Error(`GitHub GraphQL: ${out.errors.map((e) => e.message).join('; ')}`);
  }

  /** In the environment: a command line is visible to every process of the host, and git quotes it in its errors. */
  async gitAccess(repoPath: string): Promise<GitAccess> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
      url: `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}.git`,
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` },
    };
  }

  /**
   * Creates the check run, or updates the one of the sha whose `external_id` is the request's
   * (ORC-162). GitHub has no filter on `external_id`: the sha's runs of that name are listed (all of
   * them, `filter=all`, not only the latest, every page) and matched here. An unreadable list rejects: read as
   * empty, it would create a second run for the same external id (ORC-273).
   */
  async upsertCheckRun(repoPath: string, req: CheckRunRequest): Promise<{ id: number; deduplicated: boolean }> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const base = repoApi(repo);
    const query = new URLSearchParams({ check_name: req.name, filter: 'all' });
    const runs = await this.allPages(`${base}/commits/${encodeURIComponent(req.sha)}/check-runs`, 'check_runs', 'a list of check runs', isCheckRunRef, token, query);
    const existing = runs.find((r) => r.external_id === req.externalId);
    const body = {
      name: req.name,
      external_id: req.externalId,
      status: req.status,
      ...(req.conclusion ? { conclusion: req.conclusion } : {}),
      ...(req.title !== undefined || req.summary !== undefined ? { output: { title: req.title ?? req.name, summary: req.summary ?? '' } } : {}),
    };
    if (existing) {
      await this.call('PATCH', `${base}/check-runs/${existing.id}`, token, body);
      return { id: existing.id, deduplicated: true };
    }
    const created = await this.read('POST', `${base}/check-runs`, token, isCreated, 'a check run', { ...body, head_sha: req.sha });
    return { id: created.id, deduplicated: false };
  }

  async unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    // Every page of threads and of their comments (ORC-347), each answer checked before it is read (ORC-273).
    const gql: GraphQl = async <T>(query: string, variables: Record<string, unknown>, isData: (d: unknown) => d is T, what: string) => {
      // With errors, `data` is not read.
      const isAnswer = (d: unknown): d is { data: T; errors?: { message: string }[] } => isRecord(d) && isGraphQlErrors(d.errors) && (hasErrors(d) || isData(d.data));
      const out = await this.read('POST', '/graphql', token, isAnswer, what, { query, variables });
      if (out.errors?.length) throw new Error(`GitHub GraphQL: ${out.errors.map((e) => e.message).join('; ')}`);
      return out.data;
    };
    return unresolvedReviewFeedback(gql, repo.owner, repo.name, prNumber);
  }

  /**
   * Whether an unchecked head is one of a repository with no CI (ORC-148): the head still has no check, the repository
   * no active Actions workflow of its own (a CI on `pull_request` only leaves the base unchecked; GitHub's dynamic
   * workflows, Pages or Dependabot, are no CI), and the PR's base commit no check either (a CI outside Actions that
   * checks the base). Workflows unreadable (Actions permission missing: a 403 or 404) say CI; a rate limit (a 403 too)
   * and a 2xx answer without its list throw, so the effect is replayed.
   */
  private async withoutCi(repo: GitHubRepoRef, pr: PullRequestDto, token: string): Promise<boolean> {
    if (!pr.base) return false;
    const [head, workflows, base] = await Promise.all([
      this.checksFor(repo, pr.head.sha, token),
      this.allPages(`${repoApi(repo)}/actions/workflows`, 'workflows', 'a list of workflows', isWorkflow, token).catch((err: unknown) => {
        if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404) && !err.rateLimited) return undefined;
        throw err;
      }),
      this.checksFor(repo, pr.base.sha, token),
    ]);
    const ci = !workflows || workflows.some((w) => w.state === 'active' && !w.path?.startsWith('dynamic/'));
    return head.checks === 'none' && !ci && base.checks === 'none';
  }

  private async checksFor(
    repo: GitHubRepoRef,
    sha: string,
    token: string,
  ): Promise<{ checks: PrInfo['checks']; failedChecks: string[] }> {
    const base = `${repoApi(repo)}/commits/${encodeURIComponent(sha)}`;
    const [runs, statuses] = await Promise.all([
      this.allPages(`${base}/check-runs`, 'check_runs', 'a list of check runs', isCheckRun, token),
      this.allPages(`${base}/status`, 'statuses', 'a list of commit statuses', isStatus, token),
    ]);
    const buckets: string[] = [];
    const failedChecks: string[] = [];
    for (const run of runs) {
      if (isFactoryCheck(run.name)) continue;
      const bucket = checkRunBucket(run);
      buckets.push(bucket);
      if (bucket === 'fail') failedChecks.push(run.name);
    }
    for (const status of statuses) {
      const bucket = statusBucket(status.state);
      buckets.push(bucket);
      if (bucket === 'fail') failedChecks.push(status.context);
    }
    return { checks: aggregateChecks(buckets), failedChecks };
  }
}
