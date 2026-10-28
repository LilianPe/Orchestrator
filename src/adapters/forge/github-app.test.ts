import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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

type Route = (url: URL, init: HttpRequest, body: unknown) => { status?: number; body?: unknown } | undefined;

function fakeHttp(routes: Route[], calls: Call[] = []): HttpClient {
  return async (url, init) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, headers: init.headers, body });
    for (const route of routes) {
      const res = route(parsed, init, body);
      if (res) {
        const status = res.status ?? 200;
        return { ok: status < 400, status, text: async () => (res.body === undefined ? '' : JSON.stringify(res.body)) };
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

function pullsRoute(pulls: unknown[]): Route {
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
        pullsRoute([openPr({ state: 'closed', merged_at: '2026-10-22T09:00:00Z' })]),
      ],
      { calls },
    );
    expect(await forge.findPr('/repo', 'factory/REL-1')).toMatchObject({ state: 'MERGED', checks: 'none' });
    expect(calls.some((c) => c.url.includes('/check-runs'))).toBe(false);
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
});
