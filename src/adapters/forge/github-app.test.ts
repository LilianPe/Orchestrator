import { NoCommitsBetween } from './types.js';
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeForgeContract } from '../../../test/contracts/forge.contract.js';
import type { Exec } from '../exec.js';
import {
  createAppJwt,
  GitHubAppForge,
  parseGitHubRemote,
  type HttpClient,
  type HttpRequest,
} from './github-app.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = Date.parse('2026-10-22T10:00:00Z');

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** `raw` is sent as is, for an answer that is not JSON; `body` is sent as JSON. */
type Route = (url: URL, init: HttpRequest, body: unknown) => { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> } | undefined;

function fakeHttp(routes: Route[], calls: Call[] = []): HttpClient {
  return async (url, init) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, headers: init.headers, body });
    for (const route of routes) {
      const res = route(parsed, init, body);
      if (res) {
        const status = res.status ?? 200;
        const text = res.raw ?? (res.body === undefined ? '' : JSON.stringify(res.body));
        const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        return { ok: status < 400, status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => text };
      }
    }
    throw new Error(`unexpected ${init.method} ${parsed.pathname}`);
  };
}

function tokenRoute(id: string | number, token = 'ghs_test_token', expiresAt = new Date(NOW + 2 * 60 * 60_000).toISOString()): Route {
  return (url) =>
    url.pathname === `/app/installations/${id}/access_tokens`
      ? { body: { token, expires_at: expiresAt } }
      : undefined;
}

function installationRoute(id = 42): Route {
  return (url) => (url.pathname === '/repos/acme/app/installation' ? { body: { id } } : undefined);
}

function pullsRoute(pulls: unknown): Route {
  return (url) => (url.pathname === '/repos/acme/app/pulls' ? { body: pulls } : undefined);
}

function checksRoutes(runs: unknown[], statuses: unknown[]): Route[] {
  return [
    (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: { check_runs: runs } } : undefined),
    (url) => (url.pathname === '/repos/acme/app/commits/abc123/status' ? { body: { statuses } } : undefined),
  ];
}

function makeForge(
  routes: Route[],
  opts: { now?: () => number; calls?: Call[]; log?: (m: string) => void; exec?: Exec; installationId?: string | number } = {},
) {
  const calls = opts.calls ?? [];
  const forge = new GitHubAppForge({
    appId: '123',
    privateKey: privatePem,
    installationId: opts.installationId,
    http: fakeHttp(routes, calls),
    resolveRepo: async () => ({ owner: 'acme', name: 'app' }),
    now: opts.now ?? (() => NOW),
    log: opts.log,
    exec: opts.exec,
  });
  return { forge, calls };
}

const openPr = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  html_url: 'https://github.com/acme/app/pull/7',
  state: 'open',
  merged_at: null,
  head: { ref: 'factory/REL-1', sha: 'abc123' },
  ...overrides,
});

/** A GitHub API scripted per branch: each PR has its own head sha, whose checks answer as given. */
function scriptedGitHub(prs: Record<string, { number: number; runs: Route; statuses?: unknown[] }>): Route[] {
  const sha = (branch: string) => `sha-${branch.replace(/\W/g, '-')}`;
  return [
    tokenRoute(42),
    (url) => {
      if (url.pathname !== '/repos/acme/app/pulls') return undefined;
      const branch = url.searchParams.get('head')!.replace(/^acme:/, '');
      const pr = prs[branch];
      return { body: pr ? [openPr({ number: pr.number, html_url: `https://github.com/acme/app/pull/${pr.number}`, head: { ref: branch, sha: sha(branch) } })] : [] };
    },
    ...Object.entries(prs).flatMap(([branch, pr]): Route[] => [
      (url, init, body) => (url.pathname === `/repos/acme/app/commits/${sha(branch)}/check-runs` ? pr.runs(url, init, body) : undefined),
      (url) => (url.pathname === `/repos/acme/app/commits/${sha(branch)}/status` ? { body: { statuses: pr.statuses ?? [] } } : undefined),
    ]),
    (url) =>
      url.pathname === '/graphql'
        ? { body: { data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { isResolved: false, comments: { nodes: [{ author: { login: 'alice' }, body: 'renommer', createdAt: '2026-10-10T10:00:00Z', path: 'src/a.ts', line: 3 }] } },
          { isResolved: true, comments: { nodes: [{ author: { login: 'bob' }, body: 'fait', createdAt: '2026-10-10T11:00:00Z', path: 'src/b.ts', line: null }] } },
        ] } } } } } }
        : undefined,
  ];
}

const runs = (list: unknown[]): Route => () => ({ body: { total_count: list.length, check_runs: list } });

describeForgeContract('GitHubAppForge (scripted fetch)', () => ({
  forge: makeForge(
    scriptedGitHub({
      'factory/rel-1-x': {
        number: 7,
        runs: runs([{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }, { id: 2, name: 'lint', status: 'completed', conclusion: 'success' }]),
      },
      // A 200 without its list of check runs: read as no check, it would open the unchecked merge.
      'factory/rel-2-y': { number: 8, runs: () => ({ body: { total_count: 0 } }) },
      'factory/rel-3-z': { number: 9, runs: runs([]) },
      'factory/rel-4-w': { number: 10, runs: () => ({ status: 502, body: { message: 'Bad gateway' } }) },
      'factory/rel-5-v': {
        number: 11,
        runs: runs([{ id: 3, name: 'lint', status: 'completed', conclusion: 'success' }, { id: 4, name: 'deploy', status: 'completed', conclusion: 'mystery' }]),
        statuses: [{ context: 'docs', state: 'mystery' }],
      },
    }),
    { installationId: 42 },
  ).forge,
  repoPath: '/repo',
  missingBranch: 'factory/rel-404',
  pr: { branch: 'factory/rel-1-x', number: 7 },
  unresolved: [{ author: 'alice', body: 'src/a.ts:3 — renommer', at: Date.parse('2026-10-10T10:00:00Z'), source: 'review' }],
  unreachable: new GitHubAppForge({
    appId: '123',
    privateKey: privatePem,
    installationId: 42,
    http: async () => {
      throw new TypeError('fetch failed');
    },
    resolveRepo: async () => ({ owner: 'acme', name: 'app' }),
    now: () => NOW,
  }),
  unreadableChecks: 'factory/rel-2-y',
  noChecks: 'factory/rel-3-z',
  checksDown: 'factory/rel-4-w',
  unknownBucket: 'factory/rel-5-v',
}));

describe('createAppJwt', () => {
  it('builds a signed RS256 JWT with the GitHub App claims', () => {
    const jwt = createAppJwt('123', privatePem, NOW);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      iat: Math.floor(NOW / 1000) - 60,
      exp: Math.floor(NOW / 1000) + 9 * 60,
      iss: '123',
    });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });
});

describe('parseGitHubRemote', () => {
  it.each([
    ['git@github.com:acme/app.git', { owner: 'acme', name: 'app' }],
    ['https://github.com/acme/app.git', { owner: 'acme', name: 'app' }],
    ['https://github.com/acme/app/', { owner: 'acme', name: 'app' }],
    ['ssh://git@github.com/acme/app.git', { owner: 'acme', name: 'app' }],
    ['github.com/acme/app', { owner: 'acme', name: 'app' }],
    ['git@gitlab.com:acme/app.git', undefined],
    ['https://github.com/acme', undefined],
  ])('%s', (remote, expected) => {
    expect(parseGitHubRemote(remote)).toEqual(expected);
  });
});

describe('GitHubAppForge installation tokens', () => {
  it('discovers the installation, requests a repo-scoped token and caches it for at most one hour', async () => {
    let now = NOW;
    const calls: Call[] = [];
    const { forge } = makeForge(
      [installationRoute(42), tokenRoute(42), pullsRoute([])],
      { now: () => now, calls },
    );

    await forge.findPr('/repo', 'factory/REL-1');
    const tokenCall = calls.find((c) => c.url.endsWith('/access_tokens'))!;
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.body).toEqual({ repositories: ['app'] });
    const appJwt = tokenCall.headers.authorization!.replace(/^Bearer /, '');
    expect(JSON.parse(Buffer.from(appJwt.split('.')[1]!, 'base64url').toString())).toMatchObject({ iss: '123' });

    await forge.findPr('/repo', 'factory/REL-1');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(1);

    now = NOW + 30 * 60_000;
    await forge.findPr('/repo', 'factory/REL-1');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(1);

    // GitHub answered with a 2 h expiry: the forge caps it at 1 h, so the cache is already expired here.
    now = NOW + 61 * 60_000;
    await forge.findPr('/repo', 'factory/REL-1');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(2);
  });

  it('skips installation discovery when installationId is configured', async () => {
    const calls: Call[] = [];
    const { forge } = makeForge([tokenRoute('99'), pullsRoute([])], { calls, installationId: 99 });
    await forge.findPr('/repo', 'factory/REL-1');
    expect(calls.some((c) => c.url.endsWith('/installation'))).toBe(false);
    expect(calls.find((c) => c.url.endsWith('/access_tokens'))!.body).toEqual({ repositories: ['app'] });
  });

  it('resolves owner/name with git, never gh', async () => {
    const calls: Call[] = [];
    const exec: Exec = async (cmd) => {
      expect(cmd).toBe('git');
      return { stdout: 'git@github.com:acme/app.git\n', stderr: '', code: 0 };
    };
    const forge = new GitHubAppForge({
      appId: '123',
      privateKey: privatePem,
      http: fakeHttp([installationRoute(), tokenRoute(42), pullsRoute([])], calls),
      exec,
      now: () => NOW,
    });
    await forge.findPr('/repo', 'factory/REL-1');
    expect(calls.some((c) => c.url.startsWith('https://api.github.com/repos/acme/app/pulls'))).toBe(true);
  });

  it('rejects an invalid private key without echoing it', () => {
    expect(() => new GitHubAppForge({ appId: '1', privateKey: 'not-a-pem', http: fakeHttp([]) })).toThrow(
      /clé privée invalide/,
    );
  });

  it('does not expose the private key when the forge is serialized', () => {
    const { forge } = makeForge([pullsRoute([])]);
    expect(JSON.stringify(forge)).not.toContain('PRIVATE KEY');
  });
});

describe('GitHubAppForge.findPr', () => {
  it.each([
    {
      name: 'passing checks',
      runs: [
        { name: 'test', status: 'completed', conclusion: 'success' },
        { name: 'lint', status: 'completed', conclusion: 'skipped' },
      ],
      statuses: [],
      checks: 'pass',
      failedChecks: [],
    },
    {
      name: 'failing checks and commit statuses',
      runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      statuses: [{ context: 'legacy-ci', state: 'failure' }],
      checks: 'fail',
      failedChecks: ['test', 'legacy-ci'],
    },
    {
      name: 'pending checks',
      runs: [{ name: 'test', status: 'in_progress', conclusion: null }],
      statuses: [],
      checks: 'pending',
      failedChecks: [],
    },
    { name: 'no checks', runs: [], statuses: [], checks: 'none', failedChecks: [] },
    {
      name: "the factory's own checks alone: no CI (ORC-151)",
      runs: [
        { name: 'factory/verify', status: 'completed', conclusion: 'success' },
        { name: 'factory/anti-triche', status: 'completed', conclusion: 'success' },
      ],
      statuses: [],
      checks: 'none',
      failedChecks: [],
    },
  ])('maps $name', async ({ runs, statuses, checks, failedChecks }) => {
    const { forge } = makeForge([
      installationRoute(),
      tokenRoute(42),
      pullsRoute([openPr()]),
      ...checksRoutes(runs, statuses),
    ]);
    expect(await forge.findPr('/repo', 'factory/REL-1')).toEqual({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      state: 'OPEN',
      branch: 'factory/REL-1',
      headSha: 'abc123',
      checks,
      failedChecks,
    });
  });

  it('returns undefined without a PR', async () => {
    const { forge } = makeForge([installationRoute(), tokenRoute(42), pullsRoute([])]);
    expect(await forge.findPr('/repo', 'factory/REL-1')).toBeUndefined();
  });

  it('reports merged PRs without fetching checks', async () => {
    const calls: Call[] = [];
    const { forge } = makeForge(
      [
        installationRoute(),
        tokenRoute(42),
        pullsRoute([openPr({ state: 'closed', merged_at: '2026-10-22T09:00:00Z', merge_commit_sha: 'm1' })]),
      ],
      { calls },
    );
    expect(await forge.findPr('/repo', 'factory/REL-1')).toMatchObject({ state: 'MERGED', checks: 'none', mergeSha: 'm1', mergedAt: Date.parse('2026-10-22T09:00:00Z') });
    expect(calls.some((c) => c.url.includes('/check-runs'))).toBe(false);
  });

  const answeringRuns = (runsAnswer: { body?: unknown; raw?: string }, statusAnswer: { body?: unknown; raw?: string } = { body: { statuses: [] } }) =>
    makeForge([
      tokenRoute(42),
      pullsRoute([openPr()]),
      (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? runsAnswer : undefined),
      (url) => (url.pathname === '/repos/acme/app/commits/abc123/status' ? statusAnswer : undefined),
    ], { installationId: 42 }).forge;

  it.each([
    ['an answer that is not JSON', { raw: '<html>Bad gateway</html>' }, /check-runs: unreadable answer, not JSON: "<html>Bad gateway<\/html>"$/],
    ['an empty answer', { raw: '' }, /check-runs: unreadable answer, not a list of check runs: undefined$/],
    ['an answer without its list', { body: { total_count: 0 } }, /check-runs: unreadable answer, not a list of check runs: "\{\\"total_count\\":0\}"$/],
    ['a list that is not one', { body: { check_runs: { name: 'ci' } } }, /not a list of check runs/],
    ['an entry that is not an object', { body: { check_runs: [null] } }, /not a list of check runs/],
    ['an entry without a status', { body: { check_runs: [{ id: 1, name: 'ci', conclusion: 'success' }] } }, /not a list of check runs/],
  ])('rejects, saying it is unreadable, check runs answered as %s: never none, never a raw TypeError', async (_case, answer, message) => {
    const err = await answeringRuns(answer).findPr('/repo', 'factory/REL-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(message);
  });

  it.each([
    ['an answer without its list', { body: { state: 'pending' } }],
    ['an entry without a state', { body: { statuses: [{ context: 'legacy-ci' }] } }],
  ])('rejects, saying it is unreadable, commit statuses answered as %s', async (_case, answer) => {
    await expect(answeringRuns({ body: { check_runs: [] } }, answer).findPr('/repo', 'factory/REL-1')).rejects.toThrow(
      /\/status: unreadable answer, not a list of commit statuses: /,
    );
  });

  it('cuts a long unreadable answer in its error', async () => {
    await expect(answeringRuns({ raw: `<html>${'x'.repeat(1000)}` }).findPr('/repo', 'factory/REL-1')).rejects.toThrow(/: "<html>x{194}"…$/);
  });

  it('rejects, saying it is unreadable, a list of PRs that is not one: never read as no PR', async () => {
    const { forge } = makeForge([tokenRoute(42), pullsRoute({ message: 'ok' })], { installationId: 42 });
    await expect(forge.findPr('/repo', 'factory/REL-1')).rejects.toThrow(/pulls: unreadable answer, not a list of pull requests: "\{\\"message\\":\\"ok\\"\}"$/);
  });

  it.each([
    ['an entry that is not an object', [null]],
    ['an entry without its head', [{ number: 7, state: 'open', html_url: 'https://github.com/acme/app/pull/7' }]],
    ['an entry without a number', [openPr({ number: undefined })]],
  ])('rejects, saying it is unreadable, a list of PRs with %s: never a raw TypeError', async (_case, body) => {
    const { forge } = makeForge([tokenRoute(42), pullsRoute(body)], { installationId: 42 });
    const err = await forge.findPr('/repo', 'factory/REL-1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/pulls: unreadable answer, not a list of pull requests: /);
  });

  it('reads every page of check runs and commit statuses: a failure past the first hundred is in the verdict', async () => {
    const green = (i: number) => ({ id: i, name: `job-${i}`, status: 'completed', conclusion: 'success' });
    const ok = (i: number) => ({ context: `ctx-${i}`, state: 'success' });
    const page = (url: URL) => Number(url.searchParams.get('page'));
    const { forge, calls } = makeForge([
      tokenRoute(42),
      pullsRoute([openPr()]),
      (url) =>
        url.pathname === '/repos/acme/app/commits/abc123/check-runs'
          ? { body: { total_count: 101, check_runs: page(url) === 1 ? Array.from({ length: 100 }, (_, i) => green(i)) : [{ id: 100, name: 'late', status: 'completed', conclusion: 'failure' }] } }
          : undefined,
      (url) =>
        url.pathname === '/repos/acme/app/commits/abc123/status'
          ? { body: { total_count: 101, statuses: page(url) === 1 ? Array.from({ length: 100 }, (_, i) => ok(i)) : [{ context: 'late-ci', state: 'error' }] } }
          : undefined,
    ], { installationId: 42 });
    expect(await forge.findPr('/repo', 'factory/REL-1')).toMatchObject({ checks: 'fail', failedChecks: ['late', 'late-ci'] });
    for (const endpoint of ['check-runs', 'status']) {
      expect(calls.filter((c) => new URL(c.url).pathname.endsWith(`/${endpoint}`)).map((c) => new URL(c.url).searchParams.get('per_page') + ':' + page(new URL(c.url)))).toEqual(['100:1', '100:2']);
    }
  });

  it('rejects, past ten pages, check runs a server answers the same whatever the page: never loops', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `job-${i}`, status: 'completed', conclusion: 'success' }));
    const { forge, calls } = makeForge([
      tokenRoute(42),
      pullsRoute([openPr()]),
      (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: { total_count: 100, check_runs: full } } : undefined),
      (url) => (url.pathname === '/repos/acme/app/commits/abc123/status' ? { body: { statuses: [] } } : undefined),
    ], { installationId: 42 });
    await expect(forge.findPr('/repo', 'factory/REL-1')).rejects.toThrow(/check-runs: more than 1000 entries, never read as complete$/);
    expect(calls.filter((c) => c.url.includes('/check-runs'))).toHaveLength(11);
  });

  it('reads a list of exactly ten full pages as complete, once the eleventh comes back empty', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `job-${i}`, status: 'completed', conclusion: 'success' }));
    const { forge, calls } = makeForge([
      tokenRoute(42),
      pullsRoute([openPr()]),
      (url) =>
        url.pathname === '/repos/acme/app/commits/abc123/check-runs'
          ? { body: { total_count: 1000, check_runs: Number(url.searchParams.get('page')) <= 10 ? full : [] } }
          : undefined,
      (url) => (url.pathname === '/repos/acme/app/commits/abc123/status' ? { body: { statuses: [] } } : undefined),
    ], { installationId: 42 });
    expect(await forge.findPr('/repo', 'factory/REL-1')).toMatchObject({ checks: 'pass' });
    expect(calls.filter((c) => c.url.includes('/check-runs'))).toHaveLength(11);
  });

  it('reports closed PRs', async () => {
    const { forge } = makeForge([installationRoute(), tokenRoute(42), pullsRoute([openPr({ state: 'closed' })])]);
    expect(await forge.findPr('/repo', 'factory/REL-1')).toMatchObject({ state: 'CLOSED', checks: 'none' });
  });
});

describe('GitHubAppForge.unresolvedReviewComments', () => {
  it('maps unresolved threads to feedback', async () => {
    const calls: Call[] = [];
    const { forge } = makeForge(
      [
        installationRoute(),
        tokenRoute(42),
        (url) =>
          url.pathname === '/graphql'
            ? {
                body: {
                  data: {
                    repository: {
                      pullRequest: {
                        reviewThreads: {
                          nodes: [
                            {
                              isResolved: false,
                              comments: {
                                nodes: [
                                  {
                                    author: { login: 'lilian' },
                                    body: 'Renomme ça',
                                    createdAt: '2026-10-10T10:00:00Z',
                                    path: 'src/a.ts',
                                    line: 12,
                                  },
                                ],
                              },
                            },
                            {
                              isResolved: true,
                              comments: { nodes: [{ author: { login: 'x' }, body: 'ok', createdAt: '2026-10-10T10:00:00Z', path: 'b', line: 1 }] },
                            },
                            { isResolved: false, comments: { nodes: [] } },
                          ],
                        },
                      },
                    },
                  },
                },
              }
            : undefined,
      ],
      { calls },
    );
    expect(await forge.unresolvedReviewComments('/repo', 7)).toEqual([
      { author: 'lilian', body: 'src/a.ts:12 — Renomme ça', at: Date.parse('2026-10-10T10:00:00Z'), source: 'review' },
    ]);
    const gql = calls.find((c) => c.url.endsWith('/graphql'))!;
    expect(gql.method).toBe('POST');
    expect(gql.body).toMatchObject({ variables: { owner: 'acme', name: 'app', number: 7 } });
    expect(JSON.stringify(gql.body)).toContain('reviewThreads');
  });

  it.each([['not JSON', '<html>oops</html>'], ['empty', '']])('rejects, saying it is unreadable, a GraphQL answer %s', async (_case, raw) => {
    const { forge } = makeForge([tokenRoute(42), (url) => (url.pathname === '/graphql' ? { raw } : undefined)], { installationId: 42 });
    await expect(forge.unresolvedReviewComments('/repo', 7)).rejects.toThrow(/graphql: unreadable answer/);
  });

  it.each([
    ['errors that are no list', { errors: 'boom' }],
    ['an error that is null', { errors: [null] }],
    ['threads that are no list', { data: { repository: { pullRequest: { reviewThreads: { nodes: {} } } } } }],
    ['a thread without its comments', { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }] } } } } }],
  ])('rejects, saying it is unreadable, never a raw TypeError, review threads answered with %s', async (_case, answer) => {
    const { forge } = makeForge([tokenRoute(42), (url) => (url.pathname === '/graphql' ? { body: answer } : undefined)], { installationId: 42 });
    const err = await forge.unresolvedReviewComments('/repo', 7).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error)?.message).toMatch(/POST \/graphql: unreadable answer, not a GraphQL answer with review threads: /);
  });

  it('surfaces GraphQL errors without leaking the installation token', async () => {
    const { forge } = makeForge([
      installationRoute(),
      tokenRoute(42),
      (url) => (url.pathname === '/graphql' ? { body: { errors: [{ message: 'Resource not accessible' }] } } : undefined),
    ]);
    await expect(forge.unresolvedReviewComments('/repo', 7)).rejects.toThrow(/Resource not accessible/);
  });
});

describe('GitHubAppForge secrets', () => {
  it('never logs the installation token', async () => {
    const logs: string[] = [];
    const { forge } = makeForge([installationRoute(), tokenRoute(42, 'ghs_very_secret'), pullsRoute([])], {
      log: (m) => logs.push(m),
    });
    await forge.findPr('/repo', 'factory/REL-1');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('ghs_very_secret');
  });

  it('never puts the installation token in API errors', async () => {
    const { forge } = makeForge([
      installationRoute(),
      tokenRoute(42, 'ghs_very_secret'),
      (url) => (url.pathname === '/repos/acme/app/pulls' ? { status: 500, body: { message: 'boom' } } : undefined),
    ]);
    const error = await forge.findPr('/repo', 'factory/REL-1').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('boom');
    expect((error as Error).message).not.toContain('ghs_very_secret');
  });

  it('never puts the installation token in the error of a cut token answer', async () => {
    const cut: Route = (url) =>
      url.pathname === '/app/installations/42/access_tokens' ? { status: 201, raw: '{"token":"ghs_very_secret","expires_at":"2026-' } : undefined;
    const error = await makeForge([installationRoute(), cut]).forge.findPr('/repo', 'factory/REL-1').catch((e: Error) => e);
    expect((error as Error).message).toMatch(/access_tokens: unreadable answer, not JSON$/);
    expect((error as Error).message).not.toContain('ghs_very_secret');
  });

  it('rejects a token answer without its token, saying it is unreadable, with no part of the answer in the error', async () => {
    const odd: Route = (url) => (url.pathname === '/app/installations/42/access_tokens' ? { status: 201, body: { tokn: 'ghs_very_secret' } } : undefined);
    const error = await makeForge([installationRoute(), odd]).forge.findPr('/repo', 'factory/REL-1').catch((e: Error) => e);
    expect((error as Error).message).toMatch(/access_tokens: unreadable answer, not an installation token$/);
    expect((error as Error).message).not.toContain('ghs_very_secret');
  });

  it('rejects an installation answer without its id, saying it is unreadable', async () => {
    const odd: Route = (url) => (url.pathname === '/repos/acme/app/installation' ? { body: { id: '42' } } : undefined);
    await expect(makeForge([odd]).forge.findPr('/repo', 'factory/REL-1')).rejects.toThrow(/installation: unreadable answer, not an installation: /);
  });
});

describe('GitHubAppForge.mergePr (ORC-148)', () => {
  const pullRoute = (pr: Record<string, unknown>): Route => (url, init) => (url.pathname === '/repos/acme/app/pulls/7' && init.method === 'GET' ? { body: pr } : undefined);
  const repoRoute = (allowed: Record<string, boolean> = {}): Route => (url, init) =>
    url.pathname === '/repos/acme/app' && init.method === 'GET' ? { body: { allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true, ...allowed } } : undefined;
  const mergeRoute = (status: number, body: unknown): Route => (url, init) => (url.pathname === '/repos/acme/app/pulls/7/merge' && init.method === 'PUT' ? { status, body } : undefined);

  it('merges with the expected head sha, so GitHub refuses a head that moved', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(openPr()), repoRoute(), mergeRoute(200, { merged: true, sha: 'm1' })], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123')).toEqual({ merged: true, deduplicated: false });
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ sha: 'abc123', merge_method: 'merge' });
  });

  it('merges with a method the repository allows: squash when merge commits are off', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(openPr()), repoRoute({ allow_merge_commit: false }), mergeRoute(200, { merged: true })], { installationId: 42 });
    await forge.mergePr('/repo', 7, 'abc123');
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ sha: 'abc123', merge_method: 'squash' });
  });

  it('answers a head moved since the review as a refusal, not an error', async () => {
    const { forge } = makeForge([tokenRoute(42), pullRoute(openPr({ head: { ref: 'factory/REL-1', sha: 'new999' } })), repoRoute(), mergeRoute(409, { message: 'Head branch was modified.' })], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123')).toEqual({ merged: false, reason: 'head_moved' });
  });

  it('answers a PR GitHub will not merge (conflict, required checks) as a refusal with its message', async () => {
    const { forge } = makeForge([tokenRoute(42), pullRoute(openPr()), repoRoute(), mergeRoute(405, { message: 'Pull Request is not mergeable' })], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123')).toEqual({ merged: false, reason: 'not_mergeable', message: 'Pull Request is not mergeable' });
  });

  it('a replay finds the PR already merged on that head and writes nothing', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(openPr({ state: 'closed', merged_at: '2026-10-30T10:00:00Z' }))], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123')).toEqual({ merged: true, deduplicated: true });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  // A head with no check (ORC-148): merged only in a repository with no CI, its base commit unchecked too.
  const baseChecks = (runs: unknown[]): Route[] => [
    (url) => (url.pathname === '/repos/acme/app/commits/base999/check-runs' ? { body: { check_runs: runs } } : undefined),
    (url) => (url.pathname === '/repos/acme/app/commits/base999/status' ? { body: { statuses: [] } } : undefined),
  ];
  const withBase = openPr({ base: { ref: 'main', sha: 'base999' } });
  const headChecks = (runs: unknown[]): Route[] => [
    (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: { check_runs: runs } } : undefined),
    (url) => (url.pathname === '/repos/acme/app/commits/abc123/status' ? { body: { statuses: [] } } : undefined),
  ];
  const workflows = (list: { state: string; path?: string }[]): Route => (url) => (url.pathname === '/repos/acme/app/actions/workflows' ? { body: { total_count: list.length, workflows: list } } : undefined);
  const noCi = (): Route[] => [...headChecks([]), workflows([]), ...baseChecks([])];

  it('merges an unchecked head when the base has no check either: a repository with no CI', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...noCi(), mergeRoute(200, { merged: true })], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: true, deduplicated: false });
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('refuses an unchecked head when the base has checks: its CI has not run on it yet', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), workflows([]), ...baseChecks([{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }])], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: false, reason: 'checks_missing' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses an unchecked head in a repository with an active Actions workflow: a CI on pull_request leaves main unchecked', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), workflows([{ state: 'active', path: '.github/workflows/ci.yml' }]), ...baseChecks([])], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: false, reason: 'checks_missing' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses an unchecked head whose checks appeared since the factory read it', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([{ id: 2, name: 'test', status: 'in_progress', conclusion: null }]), workflows([]), ...baseChecks([])], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: false, reason: 'checks_missing' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('an unchecked head read as moved is a head moved, answered without a merge: never an unchecked merge on a stale read', async () => {
    // GitHub's read may lag (or the head came back to abc123): a PUT with abc123 would merge it unchecked.
    const moved = openPr({ head: { ref: 'factory/REL-1', sha: 'new999' }, base: { ref: 'main', sha: 'base999' } });
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(moved), repoRoute(), mergeRoute(200, { merged: true })], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: false, reason: 'head_moved' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('GitHub\'s own dynamic workflows (Pages, Dependabot) are no CI', async () => {
    const dynamic = [{ state: 'active', path: 'dynamic/pages/pages-build-deployment' }, { state: 'active', path: 'dynamic/dependabot/dependabot-updates' }];
    const { forge } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), workflows(dynamic), ...baseChecks([]), mergeRoute(200, { merged: true })], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: true, deduplicated: false });
  });

  it('workflows unreadable (Actions permission missing, 403): an answer, taken as a CI, not an error', async () => {
    const denied: Route = (url) => (url.pathname === '/repos/acme/app/actions/workflows' ? { status: 403, body: { message: 'Resource not accessible by integration' } } : undefined);
    const { forge } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), denied, ...baseChecks([])], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: false, reason: 'checks_missing' });
  });

  it.each([
    ['a retry-after header', { 'retry-after': '60' }, 'Forbidden'],
    ['no request left (x-ratelimit-remaining: 0)', { 'x-ratelimit-remaining': '0' }, 'Forbidden'],
    ['a rate limit message, without its headers', {}, 'API rate limit exceeded for installation ID 42.'],
  ])('a 403 on the workflows with %s is a rate limit, not a CI: it rejects, never merges, so the effect is replayed', async (_case, headers, message) => {
    const limited: Route = (url) => (url.pathname === '/repos/acme/app/actions/workflows' ? { status: 403, headers, body: { message } } : undefined);
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), limited, ...baseChecks([]), mergeRoute(200, { merged: true })], { installationId: 42 });
    await expect(forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).rejects.toMatchObject({ status: 403, rateLimited: true });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a 404 on the workflows (Actions not visible to the app) is still taken as a CI', async () => {
    const hidden: Route = (url) => (url.pathname === '/repos/acme/app/actions/workflows' ? { status: 404, body: { message: 'Not Found' } } : undefined);
    const { forge } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), hidden, ...baseChecks([])], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: false, reason: 'checks_missing' });
  });

  it('rejects, never merges, when GitHub answers the checks of the head and the base without their list: an unread CI is no proof of none', async () => {
    const unlisted: Route[] = ['abc123', 'base999'].flatMap((sha): Route[] => [
      (url) => (url.pathname === `/repos/acme/app/commits/${sha}/check-runs` ? { body: { total_count: 3 } } : undefined),
      (url) => (url.pathname === `/repos/acme/app/commits/${sha}/status` ? { body: { state: 'success' } } : undefined),
    ]);
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), workflows([]), ...unlisted, mergeRoute(200, { merged: true })], { installationId: 42 });
    await expect(forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).rejects.toThrow(/unreadable answer/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it.each([
    ['without its list', { body: { total_count: 1 } }],
    ['with an entry without a state', { body: { total_count: 1, workflows: [{ path: '.github/workflows/ci.yml' }] } }],
  ])('rejects, never merges, when GitHub answers the workflows %s: no proof of a repository without CI', async (_case, answer) => {
    const unlisted: Route = (url) => (url.pathname === '/repos/acme/app/actions/workflows' ? answer : undefined);
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), unlisted, ...baseChecks([]), mergeRoute(200, { merged: true })], { installationId: 42 });
    await expect(forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).rejects.toThrow(/actions\/workflows: unreadable answer, not a list of workflows: /);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('reads every page of workflows: an active one past the first hundred is a CI', async () => {
    const paged: Route = (url) =>
      url.pathname === '/repos/acme/app/actions/workflows'
        ? { body: { total_count: 101, workflows: url.searchParams.get('page') === '2' ? [{ state: 'active', path: '.github/workflows/ci.yml' }] : Array.from({ length: 100 }, (_, i) => ({ state: 'disabled_manually', path: `.github/workflows/w${i}.yml` })) } }
        : undefined;
    const { forge, calls } = makeForge([tokenRoute(42), pullRoute(withBase), repoRoute(), ...headChecks([]), paged, ...baseChecks([]), mergeRoute(200, { merged: true })], { installationId: 42 });
    expect(await forge.mergePr('/repo', 7, 'abc123', { unchecked: true })).toEqual({ merged: false, reason: 'checks_missing' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it.each([
    ['a PR without its head', [pullRoute({ number: 7, state: 'open', merged_at: null }), repoRoute()], /pulls\/7: unreadable answer, not a pull request: /],
    ['a PR whose base has no sha', [pullRoute(openPr({ base: { ref: 'main' } })), repoRoute()], /pulls\/7: unreadable answer, not a pull request: /],
    ['repository settings that are not an object', [pullRoute(openPr()), (url: URL, init: HttpRequest) => (url.pathname === '/repos/acme/app' && init.method === 'GET' ? { raw: '' } : undefined)], /GET \/repos\/acme\/app: unreadable answer, not repository settings: undefined$/],
  ])('rejects, saying it is unreadable, never merges, on %s: never a raw TypeError', async (_case, routes, message) => {
    const { forge, calls } = makeForge([tokenRoute(42), ...(routes as Route[]), mergeRoute(200, { merged: true })], { installationId: 42 });
    const err = await forge.mergePr('/repo', 7, 'abc123', { unchecked: true }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(message);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('throws on another error, so the effect is retried', async () => {
    const { forge } = makeForge([tokenRoute(42), pullRoute(openPr()), repoRoute(), mergeRoute(502, { message: 'Bad gateway' })], { installationId: 42 });
    await expect(forge.mergePr('/repo', 7, 'abc123')).rejects.toMatchObject({ status: 502 });
  });
});

describe('GitHubAppForge writes, idempotent (ORC-162)', () => {
  const req = { branch: 'factory/REL-1', base: 'main', title: 'REL-1 : export', body: 'Ferme REL-1' };
  const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/access_tokens'));

  it('returns the open PR of the branch without creating one, and asks for open PRs only', async () => {
    const { forge, calls } = makeForge([tokenRoute(42), pullsRoute([openPr()])], { installationId: 42 });
    expect(await forge.ensurePr('/repo', req)).toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7', deduplicated: true });
    const list = new URL(calls.find((c) => c.url.includes('/pulls'))!.url);
    expect(Object.fromEntries(list.searchParams)).toEqual({ head: 'acme:factory/REL-1', state: 'open', per_page: '1' });
    expect(writes(calls)).toEqual([]);
  });

  it('creates the PR when the branch has no open one', async () => {
    const { forge, calls } = makeForge(
      [
        tokenRoute(42),
        (url, init) => (url.pathname === '/repos/acme/app/pulls' && init.method === 'POST' ? { status: 201, body: openPr({ number: 8, html_url: 'u8' }) } : undefined),
        pullsRoute([]),
      ],
      { installationId: 42 },
    );
    expect(await forge.ensurePr('/repo', req)).toEqual({ number: 8, url: 'u8', deduplicated: false });
    expect(writes(calls).map((c) => c.body)).toEqual([{ title: req.title, head: req.branch, base: 'main', body: req.body }]);
  });

  it('opens a draft when asked (ORC-125)', async () => {
    const { forge, calls } = makeForge(
      [
        tokenRoute(42),
        (url, init) => (url.pathname === '/repos/acme/app/pulls' && init.method === 'POST' ? { status: 201, body: openPr({ number: 8, html_url: 'u8' }) } : undefined),
        pullsRoute([]),
      ],
      { installationId: 42 },
    );
    await forge.ensurePr('/repo', { ...req, draft: true });
    expect(writes(calls).map((c) => c.body)).toEqual([{ title: req.title, head: req.branch, base: 'main', body: req.body, draft: true }]);
  });

  it('opens a plain PR where the repository has no drafts: its plan decides, and a human then reviews it all the same', async () => {
    const posted: unknown[] = [];
    const { forge } = makeForge(
      [
        tokenRoute(42),
        (url, init, body) => {
          if (url.pathname !== '/repos/acme/app/pulls' || init.method !== 'POST') return undefined;
          posted.push(body);
          return (body as { draft?: boolean }).draft
            ? { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'Draft pull requests are not supported in this repository.' }] } }
            : { status: 201, body: openPr({ number: 8, html_url: 'u8' }) };
        },
        pullsRoute([]),
      ],
      { installationId: 42 },
    );
    expect(await forge.ensurePr('/repo', { ...req, draft: true })).toEqual({ number: 8, url: 'u8', deduplicated: false });
    expect(posted).toHaveLength(2);
  });

  it('says what GitHub said under its "Validation Failed": the reason is in its errors', async () => {
    const { forge } = makeForge(
      [
        tokenRoute(42),
        (url, init) => (url.pathname === '/repos/acme/app/pulls' && init.method === 'POST' ? { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'No commits between main and factory/REL-1' }] } } : undefined),
        pullsRoute([]),
      ],
      { installationId: 42 },
    );
    await expect(forge.ensurePr('/repo', req)).rejects.toBeInstanceOf(NoCommitsBetween);
    await expect(forge.ensurePr('/repo', req)).rejects.toThrow('No commits between main and factory/REL-1');
  });

  it('takes a draft out of draft by the only call that can, and writes nothing for a PR already out (ORC-125)', async () => {
    const pull = (draft: boolean): Route => (url, init) => (url.pathname === '/repos/acme/app/pulls/7' && init.method === 'GET' ? { body: openPr({ draft, node_id: 'PR_node' }) } : undefined);
    const mutation: Route = (url, init) => (url.pathname === '/graphql' && init.method === 'POST' ? { body: { data: { markPullRequestReadyForReview: { clientMutationId: null } } } } : undefined);
    const drafted = makeForge([tokenRoute(42), pull(true), mutation], { installationId: 42 });
    await drafted.forge.markPrReady('/repo', 7);
    const posted = drafted.calls.filter((c) => c.url.endsWith('/graphql'));
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted[0]!.body)).toContain('markPullRequestReadyForReview');
    expect(JSON.stringify(posted[0]!.body)).toContain('PR_node');
    const ready = makeForge([tokenRoute(42), pull(false), mutation], { installationId: 42 });
    await ready.forge.markPrReady('/repo', 7);
    expect(ready.calls.filter((c) => c.url.endsWith('/graphql'))).toEqual([]);
  });

  it("a GraphQL refusal of it rejects: GitHub answers 200 with its errors", async () => {
    const { forge } = makeForge(
      [
        tokenRoute(42),
        (url, init) => (url.pathname === '/repos/acme/app/pulls/7' && init.method === 'GET' ? { body: openPr({ draft: true, node_id: 'PR_node' }) } : undefined),
        (url) => (url.pathname === '/graphql' ? { body: { errors: [{ message: 'not allowed' }] } } : undefined),
      ],
      { installationId: 42 },
    );
    await expect(forge.markPrReady('/repo', 7)).rejects.toThrow('not allowed');
  });

  it.each([
    ['a PR without its draft flag', openPr({ node_id: 'PR_node' }), /pulls\/7: unreadable answer, not a pull request with its draft state: /],
    ['a draft without its node id', openPr({ draft: true }), /pulls\/7: unreadable answer, not a pull request with its draft state: /],
    ['a PR that is no PR', { message: 'ok' }, /pulls\/7: unreadable answer, not a pull request with its draft state: /],
  ])('rejects, saying it is unreadable, never reads it as out of draft, on %s', async (_case, pr, message) => {
    const { forge, calls } = makeForge(
      [tokenRoute(42), (url, init) => (url.pathname === '/repos/acme/app/pulls/7' && init.method === 'GET' ? { body: pr } : undefined), (url) => (url.pathname === '/graphql' ? { body: { data: {} } } : undefined)],
      { installationId: 42 },
    );
    const err = await forge.markPrReady('/repo', 7).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(message);
    expect(calls.some((c) => c.url.endsWith('/graphql'))).toBe(false);
  });

  it.each([
    ['an empty object', {}],
    ['a null mutation result', { data: { markPullRequestReadyForReview: null } }],
    ['errors that are no list', { errors: 'boom' }],
    ['an error that is null', { errors: [null] }],
  ])('rejects, saying it is unreadable, never reads it as done, a ready-for-review mutation answered with %s', async (_case, answer) => {
    const { forge } = makeForge(
      [
        tokenRoute(42),
        (url, init) => (url.pathname === '/repos/acme/app/pulls/7' && init.method === 'GET' ? { body: openPr({ draft: true, node_id: 'PR_node' }) } : undefined),
        (url) => (url.pathname === '/graphql' ? { body: answer } : undefined),
      ],
      { installationId: 42 },
    );
    const err = await forge.markPrReady('/repo', 7).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error)?.message).toMatch(/POST \/graphql: unreadable answer, not a GraphQL answer to markPullRequestReadyForReview: /);
  });

  it('rejects, saying it is unreadable, a ready-for-review mutation answered with no GraphQL object', async () => {
    const { forge } = makeForge(
      [
        tokenRoute(42),
        (url, init) => (url.pathname === '/repos/acme/app/pulls/7' && init.method === 'GET' ? { body: openPr({ draft: true, node_id: 'PR_node' }) } : undefined),
        (url) => (url.pathname === '/graphql' ? { raw: '' } : undefined),
      ],
      { installationId: 42 },
    );
    await expect(forge.markPrReady('/repo', 7)).rejects.toThrow(/POST \/graphql: unreadable answer, not a GraphQL answer to markPullRequestReadyForReview: undefined$/);
  });

  it.each([
    ['a list that is no list', { message: 'ok' }],
    ['a PR without its number', [openPr({ number: undefined })]],
  ])('rejects, never creates a PR, when the open PRs of the branch come back as %s', async (_case, answer) => {
    const { forge, calls } = makeForge(
      [tokenRoute(42), (url, init) => (url.pathname === '/repos/acme/app/pulls' && init.method === 'GET' ? { body: answer } : undefined), (url, init) => (url.pathname === '/repos/acme/app/pulls' && init.method === 'POST' ? { status: 201, body: openPr({ number: 8 }) } : undefined)],
      { installationId: 42 },
    );
    const err = await forge.ensurePr('/repo', req).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/pulls: unreadable answer, not a list of pull requests: /);
    expect(writes(calls)).toEqual([]);
  });

  it('rejects, saying it is unreadable, a created PR answered without its URL', async () => {
    const { forge } = makeForge(
      [tokenRoute(42), (url, init) => (url.pathname === '/repos/acme/app/pulls' && init.method === 'POST' ? { status: 201, body: { number: 8 } } : undefined), pullsRoute([])],
      { installationId: 42 },
    );
    await expect(forge.ensurePr('/repo', req)).rejects.toThrow(/POST \/repos\/acme\/app\/pulls: unreadable answer, not a pull request: /);
  });

  it("gives the factory's git the repository's URL and the token, the token in the environment alone (ORC-125)", async () => {
    const { forge } = makeForge([tokenRoute(42, 'ghs_push_token')], { installationId: 42 });
    const access = await forge.gitAccess('/repo');
    expect(access.url).toBe('https://github.com/acme/app.git');
    expect(access.url).not.toContain('ghs_push_token');
    expect(access.env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
    expect(access.env['GIT_CONFIG_VALUE_0']).toBe(`Authorization: Basic ${Buffer.from('x-access-token:ghs_push_token').toString('base64')}`);
  });

  it('reads the open PR again when a concurrent replay opened it first (422), and rethrows a 422 with none behind it', async () => {
    const pulls = (afterPost: unknown[]): Route => {
      let posted = false;
      return (url, init) => {
        if (url.pathname !== '/repos/acme/app/pulls') return undefined;
        if (init.method === 'GET') return { body: posted ? afterPost : [] };
        posted = true;
        return { status: 422, body: { message: 'Validation Failed' } };
      };
    };
    const raced = makeForge([tokenRoute(42), pulls([openPr()])], { installationId: 42 });
    expect(await raced.forge.ensurePr('/repo', req)).toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7', deduplicated: true });
    const invalid = makeForge([tokenRoute(42), pulls([])], { installationId: 42 });
    await expect(invalid.forge.ensurePr('/repo', req)).rejects.toMatchObject({ status: 422 });
  });

  it('updates the check run of the sha that carries the external id instead of creating one', async () => {
    const runs = [
      { id: 11, name: 'factory/verify', status: 'completed', conclusion: 'failure', external_id: 'REL-1:2:1' },
      { id: 12, name: 'factory/verify', status: 'in_progress', conclusion: null, external_id: 'REL-1:4:1' },
    ];
    const { forge, calls } = makeForge(
      [
        tokenRoute(42),
        (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: { check_runs: runs } } : undefined),
        (url, init) => (url.pathname === '/repos/acme/app/check-runs/12' && init.method === 'PATCH' ? { body: { id: 12 } } : undefined),
      ],
      { installationId: 42 },
    );
    const out = await forge.upsertCheckRun('/repo', {
      sha: 'abc123', name: 'factory/verify', externalId: 'REL-1:4:1', status: 'completed', conclusion: 'success', title: 'Vert', summary: '3 vérifications',
    });
    expect(out).toEqual({ id: 12, deduplicated: true });
    const list = new URL(calls.find((c) => c.url.includes('/check-runs?'))!.url);
    expect(Object.fromEntries(list.searchParams)).toEqual({ check_name: 'factory/verify', filter: 'all', per_page: '100', page: '1' });
    expect(writes(calls)).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        body: { name: 'factory/verify', external_id: 'REL-1:4:1', status: 'completed', conclusion: 'success', output: { title: 'Vert', summary: '3 vérifications' } },
      }),
    ]);
  });

  it('looks for the external id past the first page of check runs', async () => {
    const page = (n: number) =>
      Array.from({ length: n === 1 ? 100 : 1 }, (_, i) => ({ id: n * 1000 + i, name: 'factory/verify', status: 'completed', conclusion: 'failure', external_id: n === 2 ? 'REL-1:9:1' : `old-${i}` }));
    const { forge, calls } = makeForge(
      [
        tokenRoute(42),
        (url) =>
          url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: { check_runs: page(Number(url.searchParams.get('page'))) } } : undefined,
        (url, init) => (url.pathname === '/repos/acme/app/check-runs/2000' && init.method === 'PATCH' ? { body: { id: 2000 } } : undefined),
      ],
      { installationId: 42 },
    );
    const out = await forge.upsertCheckRun('/repo', { sha: 'abc123', name: 'factory/verify', externalId: 'REL-1:9:1', status: 'completed', conclusion: 'success', summary: 'Vert' });
    expect(out).toEqual({ id: 2000, deduplicated: true });
    // A summary alone still gets its output, titled by the check's name.
    expect(writes(calls).map((c) => c.body)).toEqual([
      { name: 'factory/verify', external_id: 'REL-1:9:1', status: 'completed', conclusion: 'success', output: { title: 'factory/verify', summary: 'Vert' } },
    ]);
  });

  it('creates the check run on the sha, with the external id, when none carries it', async () => {
    const { forge, calls } = makeForge(
      [
        tokenRoute(42),
        (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: { check_runs: [] } } : undefined),
        (url, init) => (url.pathname === '/repos/acme/app/check-runs' && init.method === 'POST' ? { status: 201, body: { id: 21 } } : undefined),
      ],
      { installationId: 42 },
    );
    expect(await forge.upsertCheckRun('/repo', { sha: 'abc123', name: 'factory/verify', externalId: 'REL-1:4:1', status: 'in_progress' })).toEqual({
      id: 21,
      deduplicated: false,
    });
    expect(writes(calls).map((c) => c.body)).toEqual([{ name: 'factory/verify', external_id: 'REL-1:4:1', status: 'in_progress', head_sha: 'abc123' }]);
  });

  it.each([
    ['without its list', { total_count: 1 }],
    ['with a run without its id', { check_runs: [{ name: 'factory/verify', external_id: 'REL-1:4:1' }] }],
  ])('rejects, never creates a second run, when the check runs of the sha come back %s', async (_case, answer) => {
    const { forge, calls } = makeForge(
      [
        tokenRoute(42),
        (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: answer } : undefined),
        (url, init) => (url.pathname === '/repos/acme/app/check-runs' && init.method === 'POST' ? { status: 201, body: { id: 21 } } : undefined),
      ],
      { installationId: 42 },
    );
    const err = await forge.upsertCheckRun('/repo', { sha: 'abc123', name: 'factory/verify', externalId: 'REL-1:4:1', status: 'in_progress' }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/check-runs: unreadable answer, not a list of check runs: /);
    expect(writes(calls)).toEqual([]);
  });

  it('rejects, saying it is unreadable, a created check run answered without its id', async () => {
    const { forge } = makeForge(
      [
        tokenRoute(42),
        (url) => (url.pathname === '/repos/acme/app/commits/abc123/check-runs' ? { body: { check_runs: [] } } : undefined),
        (url, init) => (url.pathname === '/repos/acme/app/check-runs' && init.method === 'POST' ? { status: 201, body: {} } : undefined),
      ],
      { installationId: 42 },
    );
    await expect(forge.upsertCheckRun('/repo', { sha: 'abc123', name: 'factory/verify', externalId: 'REL-1:4:1', status: 'in_progress' })).rejects.toThrow(
      /POST \/repos\/acme\/app\/check-runs: unreadable answer, not a check run: "\{\}"$/,
    );
  });
});

describe('GitHubAppForge.repoPermission (ORC-186)', () => {
  const permissionRoute = (login: string, status: number, body: unknown): Route => (url) =>
    url.pathname === `/repos/acme/app/collaborators/${login}/permission` ? { status, body } : undefined;

  it("reads a user's role on the repo with the installation token", async () => {
    const calls: Call[] = [];
    const { forge } = makeForge(
      [
        installationRoute(42),
        tokenRoute(42),
        permissionRoute('dev', 200, { permission: 'write', role_name: 'maintain' }),
        permissionRoute('reader', 200, { permission: 'read', role_name: 'read' }),
        permissionRoute('custom', 200, { permission: 'write', role_name: 'release-manager' }),
      ],
      { calls },
    );
    expect(await forge.repoPermission('/repo', 'dev')).toBe('maintain');
    expect(await forge.repoPermission('/repo', 'reader')).toBe('read');
    expect(await forge.repoPermission('/repo', 'custom')).toBe('write');
    expect(calls.find((c) => c.url.includes('/collaborators/'))!.headers.authorization).toBe('Bearer ghs_test_token');
  });

  it('gives none to a login GitHub does not know, and throws on any other failure', async () => {
    const { forge } = makeForge([
      installationRoute(42),
      tokenRoute(42),
      permissionRoute('ghost', 404, { message: 'Not Found' }),
      permissionRoute('down', 502, { message: 'Bad Gateway' }),
    ]);
    expect(await forge.repoPermission('/repo', 'ghost')).toBe('none');
    await expect(forge.repoPermission('/repo', 'down')).rejects.toThrow(/502/);
  });

  it.each([
    ['an empty object', {}],
    ['a permission that is no string', { permission: 3 }],
  ])('rejects, never answers none, on a permission answer that is %s', async (_case, body) => {
    const { forge } = makeForge([installationRoute(42), tokenRoute(42), permissionRoute('odd', 200, body)]);
    await expect(forge.repoPermission('/repo', 'odd')).rejects.toThrow(/permission: unreadable answer, not a permission: /);
  });

  it('throws, never answers none, when the app is not installed on the repo', async () => {
    const { forge } = makeForge([(url) => (url.pathname === '/repos/acme/app/installation' ? { status: 404, body: { message: 'Not Found' } } : undefined)]);
    await expect(forge.repoPermission('/repo', 'dev')).rejects.toThrow(/installation.*404/);
  });
});
