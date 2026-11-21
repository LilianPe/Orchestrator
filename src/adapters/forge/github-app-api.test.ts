import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../adapters/exec.js';
import type { HttpClient, HttpRequest } from '../forge/github-app.js';
import { UnreadableAnswerError } from './github-app.js';
import { GitHubAppApi } from './github-app-api.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = Date.parse('2026-10-22T10:00:00Z');
const YAML = 'on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

type Route = (url: URL, init: HttpRequest) => { status?: number; body?: unknown } | undefined;

function fakeHttp(routes: Route[], calls: Call[] = []): HttpClient {
  return async (url, init) => {
    const parsed = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers });
    for (const route of routes) {
      const result = route(parsed, init);
      if (result) {
        const status = result.status ?? 200;
        return { ok: status < 400, status, text: async () => (result.body === undefined ? '' : JSON.stringify(result.body)) };
      }
    }
    throw new Error(`unexpected ${init.method} ${parsed.pathname}`);
  };
}

function tokenRoute(): Route {
  return (url) =>
    url.pathname === '/app/installations/42/access_tokens'
      ? { body: { token: 'ghs_api_secret', expires_at: new Date(NOW + 60 * 60_000).toISOString() } }
      : undefined;
}

const exec: Exec = async (cmd) => {
  expect(cmd).toBe('git');
  return { stdout: 'git@github.com:acme/app.git\n', stderr: '', code: 0 };
};

function makeApi(routes: Route[], calls: Call[] = []): GitHubAppApi {
  return new GitHubAppApi({
    appId: '123',
    privateKey: privatePem,
    installationId: 42,
    http: fakeHttp(routes, calls),
    exec,
    now: () => NOW,
  });
}

describe('GitHubAppApi', () => {
  it('resolves owner/name with git, lists workflow files and decodes them', async () => {
    const calls: Call[] = [];
    const api = makeApi(
      [
        tokenRoute(),
        (url) =>
          url.pathname === '/repos/acme/app/contents/.github/workflows'
            ? {
                body: [
                  { type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml' },
                  { type: 'file', name: 'notes.txt', path: '.github/workflows/notes.txt' },
                  { type: 'dir', name: 'nested', path: '.github/workflows/nested' },
                ],
              }
            : undefined,
        (url) =>
          url.pathname === '/repos/acme/app/contents/.github/workflows/ci.yml'
            ? { body: { type: 'file', encoding: 'base64', content: Buffer.from(YAML).toString('base64') } }
            : undefined,
      ],
      calls,
    );

    expect(await api.listWorkflows('/repo')).toEqual([{ path: '.github/workflows/ci.yml', content: YAML }]);
    expect(calls.some((call) => call.url === 'https://api.github.com/repos/acme/app/contents/.github/workflows')).toBe(true);
  });

  it('treats a missing .github/workflows directory as no CI', async () => {
    const api = makeApi([
      tokenRoute(),
      (url) => (url.pathname === '/repos/acme/app/contents/.github/workflows' ? { status: 404, body: { message: 'Not Found' } } : undefined),
    ]);
    expect(await api.listWorkflows('/repo')).toEqual([]);
  });

  it('reads environments and only accepts required reviewers with at least one reviewer', async () => {
    const calls: Call[] = [];
    const api = makeApi(
      [
        tokenRoute(),
        (url) =>
          url.pathname === '/repos/acme/app/environments'
            ? {
                body: {
                  total_count: 3,
                  environments: [
                    { name: 'protected', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'alice' } }] }] },
                    { name: 'empty-reviewers', protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
                    { name: 'wait-timer', protection_rules: [{ type: 'wait_timer', wait_timer: 30 }] },
                  ],
                },
              }
            : undefined,
      ],
      calls,
    );

    expect(await api.listEnvironments('/repo')).toEqual([
      { name: 'protected', requiredReviewers: true },
      { name: 'empty-reviewers', requiredReviewers: false },
      { name: 'wait-timer', requiredReviewers: false },
    ]);
    expect(calls.find((call) => call.url.includes('/environments'))!.url).toContain('per_page=100');
  });

  const workflowsDir = (body: unknown): Route => (url) => (url.pathname === '/repos/acme/app/contents/.github/workflows' ? { body } : undefined);
  const environmentsRoute = (answer: (page: number) => unknown): Route => (url) =>
    url.pathname === '/repos/acme/app/environments' ? { body: answer(Number(url.searchParams.get('page'))) } : undefined;

  it.each([
    ['an object, not a listing', { message: 'ok' }],
    ['an entry without its path', [{ type: 'file', name: 'ci.yml' }]],
  ])('rejects, never reads "no workflow", a 2xx listing of .github/workflows that is %s', async (_case, body) => {
    const error = await makeApi([tokenRoute(), workflowsDir(body)]).listWorkflows('/repo').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/contents\/\.github\/workflows: unreadable answer, not a directory listing: /);
  });

  it('rejects a workflow file answered with no object, saying it is unreadable', async () => {
    const api = makeApi([
      tokenRoute(),
      (url) => (url.pathname === '/repos/acme/app/contents/.github/workflows/ci.yml' ? { body: ['ci.yml'] } : undefined),
      workflowsDir([{ type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml' }]),
    ]);
    await expect(api.listWorkflows('/repo')).rejects.toThrow(/workflows\/ci\.yml: unreadable answer, not a file: /);
  });

  it.each([
    ['without its list', { total_count: 2 }],
    ['with an environment without its name', { total_count: 1, environments: [{ protection_rules: [] }] }],
    ['with protection rules that are no list', { total_count: 1, environments: [{ name: 'prod', protection_rules: { type: 'required_reviewers' } }] }],
    ['with a reviewer rule without its reviewers', { total_count: 1, environments: [{ name: 'prod', protection_rules: [{ type: 'required_reviewers' }] }] }],
  ])('rejects, never reads "no environment" or "no reviewer", environments answered %s', async (_case, body) => {
    const error = await makeApi([tokenRoute(), environmentsRoute(() => body)]).listEnvironments('/repo').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/environments: unreadable answer, not a list of environments: /);
  });

  it('reads every page of environments, and rejects past ten full pages instead of stopping there', async () => {
    const page = (n: number) => Array.from({ length: n === 2 ? 1 : 100 }, (_, i) => ({ name: `env-${n}-${i}`, protection_rules: [] }));
    const two = await makeApi([tokenRoute(), environmentsRoute((n) => ({ total_count: 101, environments: n <= 2 ? page(n) : [] }))]).listEnvironments('/repo');
    expect(two).toHaveLength(101);
    const endless = makeApi([tokenRoute(), environmentsRoute(() => ({ total_count: 5000, environments: page(1) }))]);
    await expect(endless.listEnvironments('/repo')).rejects.toThrow(/environments: more than 1000 entries, never read as complete/);
  });

  it.each([
    ['the app is not installed on the repo', [(url: URL) => (url.pathname === '/repos/acme/app/installation' ? { status: 404, body: { message: 'Not Found' } } : undefined)], undefined],
    ['the configured installation does not exist', [(url: URL) => (url.pathname === '/app/installations/42/access_tokens' ? { status: 404, body: { message: 'Not Found' } } : undefined)], 42],
  ])('rejects, never reads "no CI", a 404 while resolving the installation: %s', async (_case, routes, installationId) => {
    const listing: Route = workflowsDir([{ type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml' }]);
    const api = new GitHubAppApi({ appId: '123', privateKey: privatePem, installationId, http: fakeHttp([...(routes as Route[]), listing]), exec, now: () => NOW });
    await expect(api.listWorkflows('/repo')).rejects.toMatchObject({ status: 404 });
  });

  it('resolves the repository and its token once for every workflow file', async () => {
    let gits = 0;
    const counting: Exec = async (cmd, args, opts) => {
      gits++;
      return exec(cmd, args, opts);
    };
    const file = (name: string): Route => (url) =>
      url.pathname === `/repos/acme/app/contents/.github/workflows/${name}` ? { body: { type: 'file', encoding: 'base64', content: Buffer.from(YAML).toString('base64') } } : undefined;
    const routes = [tokenRoute(), workflowsDir([1, 2, 3].map((i) => ({ type: 'file', name: `w${i}.yml`, path: `.github/workflows/w${i}.yml` }))), file('w1.yml'), file('w2.yml'), file('w3.yml')];
    const api = new GitHubAppApi({ appId: '123', privateKey: privatePem, installationId: 42, http: fakeHttp(routes), exec: counting, now: () => NOW });
    expect(await api.listWorkflows('/repo')).toHaveLength(3);
    expect(gits).toBe(1);
  });

  it('rejects a workflow file answered without its content, saying it is unreadable', async () => {
    const api = makeApi([
      tokenRoute(),
      (url) => (url.pathname === '/repos/acme/app/contents/.github/workflows/ci.yml' ? { body: { message: 'ok' } } : undefined),
      workflowsDir([{ type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml' }]),
    ]);
    await expect(api.listWorkflows('/repo')).rejects.toThrow(/workflows\/ci\.yml: unreadable answer, not a file: /);
  });

  it.each([
    ['a reviewer that is null', [null]],
    ['a reviewer without its type', [{}]],
    ['a reviewer without the user or team behind it', [{ type: 'User', reviewer: null }]],
  ])('rejects, never reads "protected", required reviewers listing %s', async (_case, reviewers) => {
    const body = { total_count: 1, environments: [{ name: 'prod', protection_rules: [{ type: 'required_reviewers', reviewers }] }] };
    await expect(makeApi([tokenRoute(), environmentsRoute(() => body)]).listEnvironments('/repo')).rejects.toThrow(
      /environments: unreadable answer, not a list of environments: /,
    );
  });

  it('surfaces API errors without leaking the installation token', async () => {
    const api = makeApi([
      tokenRoute(),
      (url) => (url.pathname === '/repos/acme/app/environments' ? { status: 403, body: { message: 'Resource not accessible' } } : undefined),
    ]);
    const error = await api.listEnvironments('/repo').catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).toContain('Resource not accessible');
    expect((error as Error).message).not.toContain('ghs_api_secret');
  });
});

describe('GitHubAppApi.branchProtection (ORC-208)', () => {
  const protectionRoutes = (branch: unknown, rules: unknown, repo: unknown = { default_branch: 'main' }, rulesets: Record<string, unknown> = {}): Route[] => [
    tokenRoute(),
    (url) => {
      const id = /^\/repos\/acme\/app\/rulesets\/(\d+)$/.exec(url.pathname)?.[1];
      return id ? { body: rulesets[id] ?? { id: Number(id), current_user_can_bypass: 'never' } } : undefined;
    },
    (url) => (url.pathname === '/repos/acme/app' ? { body: repo } : undefined),
    (url) => (url.pathname === '/repos/acme/app/branches/main' ? { body: branch } : undefined),
    (url) => (url.pathname === '/repos/acme/app/rules/branches/main' ? { body: rules } : undefined),
  ];

  it('reads the default branch, its classic protection flag and the rule types its active rulesets apply, once each', async () => {
    const calls: Call[] = [];
    const rules = [{ type: 'pull_request', ruleset_id: 1 }, { type: 'deletion', ruleset_id: 1 }, { type: 'pull_request', ruleset_id: 2 }];
    const rulesets = { '2': { id: 2, current_user_can_bypass: 'always' } };
    // GitHub's answer for a branch its rulesets cover and no classic protection does: `protected` true, `protection.enabled` false.
    const branch = { name: 'main', protected: true, protection: { enabled: false } };
    const protection = await makeApi(protectionRoutes(branch, rules, undefined, rulesets), calls).branchProtection('/repo');
    expect(protection).toEqual({ branch: 'main', classic: false, rules: ['deletion', 'pull_request'], pullRequestRulesets: [{ id: 1, bypass: 'never' }, { id: 2, bypass: 'always' }] });
    expect(calls.every((call) => !call.url.includes('/protection'))).toBe(true);
    expect(calls.filter((call) => call.url.includes('/rulesets/'))).toHaveLength(2);
  });

  it("does not read a ruleset that only blocks deletion as a classic protection: GitHub's `protected` counts rulesets too", async () => {
    const branch = { name: 'main', protected: true, protection: { enabled: false } };
    const protection = await makeApi(protectionRoutes(branch, [{ type: 'deletion', ruleset_id: 3 }])).branchProtection('/repo');
    expect(protection).toEqual({ branch: 'main', classic: false, rules: ['deletion'], pullRequestRulesets: [] });
  });

  it('reads a classic protection on its `protection.enabled`, with no ruleset', async () => {
    const branch = { name: 'main', protected: true, protection: { enabled: true } };
    expect((await makeApi(protectionRoutes(branch, [])).branchProtection('/repo')).classic).toBe(true);
  });

  it('reads every page of the branch rules: a pull request rule past the first 100 still counts', async () => {
    const first = Array.from({ length: 100 }, () => ({ type: 'required_status_checks', ruleset_id: 5 }));
    const branch = { name: 'main', protected: true, protection: { enabled: false } };
    const routes = protectionRoutes(branch, []);
    routes.splice(1, 0, (url) =>
      url.pathname === '/repos/acme/app/rules/branches/main'
        ? { body: url.searchParams.get('page') === '2' ? [{ type: 'pull_request', ruleset_id: 6 }] : first }
        : undefined,
    );
    const protection = await makeApi(routes).branchProtection('/repo');
    expect(protection.pullRequestRulesets).toEqual([{ id: 6, bypass: 'never' }]);
  });

  it('reads a named branch instead of the default one, without asking the repository for it (ORC-427)', async () => {
    const calls: Call[] = [];
    const routes: Route[] = [
      tokenRoute(),
      (url) => (url.pathname === '/repos/acme/app/rulesets/4' ? { body: { id: 4, current_user_can_bypass: 'always' } } : undefined),
      (url) => (url.pathname === '/repos/acme/app/branches/iso%2Fguarded' ? { body: { protection: { enabled: false } } } : undefined),
      (url) => (url.pathname === '/repos/acme/app/rules/branches/iso%2Fguarded' ? { body: [{ type: 'pull_request', ruleset_id: 4 }] } : undefined),
    ];
    const protection = await makeApi(routes, calls).branchProtection('/repo', 'iso/guarded');
    expect(protection).toEqual({ branch: 'iso/guarded', classic: false, rules: ['pull_request'], pullRequestRulesets: [{ id: 4, bypass: 'always' }] });
    expect(calls.some((call) => new URL(call.url).pathname === '/repos/acme/app')).toBe(false);
  });

  it("rejects a ruleset that does not say whether the App can bypass it", async () => {
    const routes = protectionRoutes({ protected: true, protection: { enabled: false } }, [{ type: 'pull_request', ruleset_id: 7 }], undefined, { '7': { id: 7 } });
    await expect(makeApi(routes).branchProtection('/repo')).rejects.toThrow(/unreadable answer, not a ruleset/);
  });

  it.each([
    ['a repository without its default branch', { name: 'app' }, { protected: true, protection: { enabled: true } }, []],
    ['a branch without its classic protection flag', { default_branch: 'main' }, { name: 'main', protected: true }, []],
    ['rules that are not a list of typed rules', { default_branch: 'main' }, { protected: true, protection: { enabled: true } }, [{ ruleset_id: 1 }]],
    ['a rule without its ruleset', { default_branch: 'main' }, { protected: true, protection: { enabled: true } }, [{ type: 'pull_request' }]],
  ])('rejects, never reads "protected", %s', async (_case, repo, branch, rules) => {
    await expect(makeApi(protectionRoutes(branch, rules, repo)).branchProtection('/repo')).rejects.toThrow(/unreadable answer/);
  });
});

describe('GitHubAppApi.installationPermissions (ORC-439)', () => {
  it("reads the repository's installation with the App's JWT, never an installation token", async () => {
    const calls: Call[] = [];
    const api = makeApi([tokenRoute(), (url) => (url.pathname === '/repos/acme/app/installation' ? { body: { id: 42, permissions: { contents: 'write', administration: 'write' } } } : undefined)], calls);
    expect(await api.installationPermissions('/repo')).toEqual({ contents: 'write', administration: 'write' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/repos/acme/app/installation']);
    const [scheme, jwt] = (calls[0]!.headers.authorization ?? calls[0]!.headers.Authorization ?? '').split(' ');
    expect(scheme).toBe('Bearer');
    expect(jwt?.split('.')).toHaveLength(3);
  });

  it.each([{ id: 42 }, { id: 42, permissions: { administration: 'write', contents: null } }, '<html>Bad gateway</html>'])(
    'rejects an installation answered without readable permissions as unreadable, apart from a failed call: %j',
    async (body) => {
      const http: HttpClient = async () => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
      const api = new GitHubAppApi({ appId: '123', privateKey: privatePem, http, exec, now: () => NOW });
      await expect(api.installationPermissions('/repo')).rejects.toThrow(UnreadableAnswerError);
      await expect(api.installationPermissions('/repo')).rejects.toThrow(/unreadable answer/);
    },
  );

  it('rejects a refused call as a GitHub error, not as an unreadable answer', async () => {
    const api = makeApi([(url) => (url.pathname === '/repos/acme/app/installation' ? { status: 401, body: { message: 'Bad credentials' } } : undefined)]);
    await expect(api.installationPermissions('/repo')).rejects.toThrow(/401 Bad credentials/);
    await expect(api.installationPermissions('/repo')).rejects.not.toThrow(UnreadableAnswerError);
  });
});
