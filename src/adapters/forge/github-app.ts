import { createPrivateKey, createSign } from 'node:crypto';
import { execCmd, mustExec, type Exec } from '../exec.js';
import type { FeedbackItem } from '../../core/types.js';
import { aggregateChecks, toRepoPermission } from './gh-cli.js';
import type { RepoPermission, RepoPermissions } from '../roles/types.js';
import type { CheckRunRequest, Forge, ForgeWriter, PrInfo, PrRequest } from './types.js';

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
  text(): Promise<string>;
}

/** Injected in tests: no unit test ever reaches the network. */
export type HttpClient = (url: string, init: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/** GitHub rejects installation tokens older than one hour; cache them with a safety margin. */
export const TOKEN_SAFETY_MARGIN_MS = 60_000;
const ONE_HOUR_MS = 60 * 60_000;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    isResolved comments(first: 1) { nodes { author { login } body createdAt path line } } } } } } }`;

interface AccessTokenDto {
  token: string;
  expires_at?: string;
}

interface PullRequestDto {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: { ref: string; sha: string };
}

interface CheckRunsDto {
  check_runs?: { id: number; name: string; status: string; conclusion: string | null; external_id?: string | null }[];
}

interface StatusesDto {
  statuses?: { context: string; state: string }[];
}

interface ReviewThreadNode {
  isResolved: boolean;
  comments: {
    nodes: { author: { login: string } | null; body: string; createdAt: string; path: string; line: number | null }[];
  };
}

interface ReviewThreadsDto {
  data?: { repository?: { pullRequest?: { reviewThreads: { nodes: ReviewThreadNode[] } } | null } | null };
  errors?: { message: string }[];
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

/** `/repos/{owner}/{name}`, encoded. */
function repoApi(repo: GitHubRepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** GitHub API failure with its status, so callers can fail closed on 404/403. */
export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
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
      throw new Error('GitHub App : clé privée invalide (PEM RSA attendu)');
    }
  }

  protected async repo(repoPath: string): Promise<GitHubRepoRef> {
    if (this.resolveRepoFn) return this.resolveRepoFn(repoPath);
    const remote = await mustExec(this.exec, 'git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
    const repo = parseGitHubRemote(remote);
    if (!repo) throw new Error(`remote origin de ${repoPath} n'est pas un dépôt GitHub`);
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
    const data = await this.call<AccessTokenDto>(
      'POST',
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      jwt,
      { repositories: [repo.name] },
    );
    if (!data?.token) throw new Error("GitHub App : réponse sans jeton d'installation");
    const requested = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
    const hardLimit = now + ONE_HOUR_MS;
    const expiresAt = (Number.isFinite(requested) ? Math.min(requested, hardLimit) : hardLimit) - TOKEN_SAFETY_MARGIN_MS;
    this.#tokens.set(`${repo.owner}/${repo.name}`, { token: data.token, expiresAt });
    this.log?.(`GitHub App : jeton d'installation pour ${repo.owner}/${repo.name} (expire ${new Date(expiresAt).toISOString()})`);
    return data.token;
  }

  private async findInstallationId(repo: GitHubRepoRef, jwt: string): Promise<string> {
    const data = await this.call<{ id?: number }>(
      'GET',
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`,
      jwt,
    );
    if (!data?.id) throw new Error(`GitHub App : installation introuvable pour ${repo.owner}/${repo.name}`);
    return String(data.id);
  }

  protected async call<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
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
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const message =
        typeof data === 'object' && data !== null && 'message' in data
          ? String((data as { message: unknown }).message)
          : text.slice(0, 200);
      throw new GitHubApiError(res.status, `GitHub API ${method} ${path.split('?')[0]}: ${res.status}${message ? ` ${message}` : ''}`);
    }
    return data as T;
  }

  /** Resolves repo + token, then calls the API on a path built from owner/name. */
  protected async request<T>(
    repoPath: string,
    method: string,
    path: (repo: GitHubRepoRef) => string,
    body?: unknown,
  ): Promise<T> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    return this.call<T>(method, path(repo), token, body);
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
        await this.call<{ permission?: string; role_name?: string }>('GET', `${repoApi(repo)}/collaborators/${encodeURIComponent(login)}/permission`, token),
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
    const pulls = await this.call<PullRequestDto[]>(
      'GET',
      `${repoApi(repo)}/pulls?${query}`,
      token,
    );
    const pr = pulls[0];
    if (!pr) return undefined;
    const state: PrInfo['state'] = pr.state === 'open' ? 'OPEN' : pr.merged_at ? 'MERGED' : 'CLOSED';
    const checks = state === 'OPEN' ? await this.checksFor(repo, pr.head.sha, token) : { checks: 'none' as const, failedChecks: [] };
    return { number: pr.number, url: pr.html_url, state, branch: pr.head.ref, headSha: pr.head.sha, ...checks };
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
      const [pr] = await this.call<PullRequestDto[]>('GET', `${base}?${query}`, token);
      return pr && { number: pr.number, url: pr.html_url, deduplicated: true };
    };
    const found = await openPr();
    if (found) return found;
    try {
      const pr = await this.call<PullRequestDto>('POST', base, token, { title: req.title, head: req.branch, base: req.base, body: req.body });
      return { number: pr.number, url: pr.html_url, deduplicated: false };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422) {
        const raced = await openPr();
        if (raced) return raced;
      }
      throw err;
    }
  }

  /**
   * Creates the check run, or updates the one of the sha whose `external_id` is the request's
   * (ORC-162). GitHub has no filter on `external_id`: the sha's runs of that name are listed (all of
   * them, `filter=all`, not only the latest, page by page) and matched here.
   */
  async upsertCheckRun(repoPath: string, req: CheckRunRequest): Promise<{ id: number; deduplicated: boolean }> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const base = repoApi(repo);
    let existing: { id: number } | undefined;
    for (let page = 1; !existing; page++) {
      const query = new URLSearchParams({ check_name: req.name, filter: 'all', per_page: '100', page: String(page) });
      const runs = (await this.call<CheckRunsDto>('GET', `${base}/commits/${encodeURIComponent(req.sha)}/check-runs?${query}`, token)).check_runs ?? [];
      existing = runs.find((r) => r.external_id === req.externalId);
      if (runs.length < 100) break;
    }
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
    const created = await this.call<{ id: number }>('POST', `${base}/check-runs`, token, { ...body, head_sha: req.sha });
    return { id: created.id, deduplicated: false };
  }

  async unresolvedReviewComments(repoPath: string, prNumber: number): Promise<FeedbackItem[]> {
    const repo = await this.repo(repoPath);
    const token = await this.installationToken(repo);
    const out = await this.call<ReviewThreadsDto>('POST', '/graphql', token, {
      query: THREADS_QUERY,
      variables: { owner: repo.owner, name: repo.name, number: prNumber },
    });
    if (out.errors?.length) throw new Error(`GitHub GraphQL : ${out.errors.map((e) => e.message).join('; ')}`);
    const pr = out.data?.repository?.pullRequest;
    if (!pr) throw new Error(`GitHub GraphQL : PR ${repo.owner}/${repo.name}#${prNumber} introuvable`);
    return pr.reviewThreads.nodes
      .filter((t) => !t.isResolved && t.comments.nodes[0])
      .map((t) => {
        const c = t.comments.nodes[0]!;
        return {
          author: c.author?.login ?? 'inconnu',
          body: `${c.path}${c.line ? `:${c.line}` : ''} — ${c.body}`,
          at: Date.parse(c.createdAt),
          source: 'review' as const,
        };
      });
  }

  private async checksFor(
    repo: GitHubRepoRef,
    sha: string,
    token: string,
  ): Promise<{ checks: PrInfo['checks']; failedChecks: string[] }> {
    const base = `${repoApi(repo)}/commits/${encodeURIComponent(sha)}`;
    const [runs, statuses] = await Promise.all([
      this.call<CheckRunsDto>('GET', `${base}/check-runs?per_page=100`, token),
      this.call<StatusesDto>('GET', `${base}/status`, token),
    ]);
    const buckets: string[] = [];
    const failedChecks: string[] = [];
    for (const run of runs.check_runs ?? []) {
      const bucket = checkRunBucket(run);
      buckets.push(bucket);
      if (bucket === 'fail') failedChecks.push(run.name);
    }
    for (const status of statuses.statuses ?? []) {
      const bucket = statusBucket(status.state);
      buckets.push(bucket);
      if (bucket === 'fail') failedChecks.push(status.context);
    }
    return { checks: aggregateChecks(buckets), failedChecks };
  }
}
