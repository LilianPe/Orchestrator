import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../adapters/exec.js';
import type { HttpClient, HttpRequest } from '../forge/github-app.js';
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
                    { name: 'protected', protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] },
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
