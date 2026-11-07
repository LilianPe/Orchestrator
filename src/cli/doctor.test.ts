import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import type { EnvironmentProtection, WorkflowSource } from '../adapters/forge/github-app-api.js';
import type { HttpClient, HttpRequest } from '../adapters/forge/github-app.js';
import { runDoctor, runDoctorCommand, type DoctorApi } from './doctor.js';

interface FakeOptions {
  failWorkflows?: boolean;
  failEnvironments?: boolean;
}

class FakeApi implements DoctorApi {
  workflowCalls = 0;
  environmentCalls = 0;

  constructor(
    private readonly workflows: WorkflowSource[],
    private readonly environments: EnvironmentProtection[] = [],
    private readonly options: FakeOptions = {},
  ) {}

  async listWorkflows(): Promise<WorkflowSource[]> {
    this.workflowCalls++;
    if (this.options.failWorkflows) throw new Error('403 Resource not accessible');
    return this.workflows;
  }

  async listEnvironments(): Promise<EnvironmentProtection[]> {
    this.environmentCalls++;
    if (this.options.failEnvironments) throw new Error('403 Resource not accessible');
    return this.environments;
  }
}

function workflow(content: string, path = '.github/workflows/ci.yml'): WorkflowSource {
  return { path, content };
}

async function doctor(
  workflows: WorkflowSource[],
  environments: EnvironmentProtection[] = [],
  options: { json?: boolean; fake?: FakeOptions } = {},
): Promise<{ code: number; lines: string[]; text: string; api: FakeApi }> {
  const api = new FakeApi(workflows, environments, options.fake);
  const lines: string[] = [];
  const code = await runDoctor({
    repoPath: '/repo',
    api,
    out: (line) => lines.push(line),
    ...(options.json ? { json: true } : {}),
  });
  return { code, lines, text: lines.join('\n'), api };
}

const secretsWorkflow = (trigger: string): string => `name: ci
on:
${trigger}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          TOKEN: \${{ secrets.NPM_TOKEN }}
`;

const protectedEnvironment: EnvironmentProtection = { name: 'ci-protected', requiredReviewers: true };

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'factory-doctor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('factory doctor', () => {
  it('refuses a CI with secrets on pull_request without human approval (isolation 12)', async () => {
    const result = await doctor([workflow(secretsWorkflow('  pull_request:')), workflow('name: other\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n', '.github/workflows/other.yml')]);

    expect(result.code).toBe(1);
    expect(result.text).toContain('secrets: yes');
    expect(result.text).toContain('pull_request');
    expect(result.text).toContain('refused');
    // The report never contains a secret value nor a secret name.
    expect(result.text).not.toContain('NPM_TOKEN');
  });

  it('accepts a dedicated CI without secrets', async () => {
    const ci = `name: ci
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('secrets: no');
    expect(result.text).toContain('verdict: accepted');
    expect(result.text).toContain('Result: accepted');
  });

  it('accepts a workflow with secrets attached to an environment with required reviewers', async () => {
    const ci = `name: ci
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    environment: ci-protected
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)], [protectedEnvironment]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('protected environment: yes');
    expect(result.text).toContain('secrets limited to jobs under a protected environment');
  });

  it('accepts an environment object with a name', async () => {
    const ci = `on: pull_request
jobs:
  test:
    environment:
      name: ci-protected
      url: https://example.test
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)], [protectedEnvironment]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('ci-protected');
  });

  it('refuses pull_request_target with secrets without protection', async () => {
    const result = await doctor([workflow(secretsWorkflow('  pull_request_target:'))]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('pull_request_target');
    expect(result.text).toContain('refused');
  });

  it('refuses an environment that exists without required reviewers', async () => {
    const ci = `on: pull_request
jobs:
  test:
    environment: staging
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)], [{ name: 'staging', requiredReviewers: false }]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('without required reviewers');
  });

  it('accepts a push limited to branches outside factory/*', async () => {
    const ci = `on:
  push:
    branches: [main, "release/*"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('push (branches: main, release/*)');
    expect(result.text).toContain("triggers that do not reach the factory's branches");
  });

  it('refuses a push on all branches with secrets', async () => {
    const result = await doctor([workflow(secretsWorkflow('  push:'))]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('push (all branches)');
    expect(result.text).toContain('refused');
  });

  it('refuses a push whose branch filter can reach factory/*', async () => {
    const ci = `on:
  push:
    branches: ["factory/*"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('factory/*');
  });

  it('accepts a push that explicitly ignores factory/*', async () => {
    const ci = `on:
  push:
    branches-ignore: ["factory/**"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(0);
  });

  it('accepts branches filtered to everything except factory/*', async () => {
    const ci = `on:
  push:
    branches: ["**", "!factory/**"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(0);
  });

  it('refuses a filter that re-includes a factory branch after excluding it', async () => {
    const ci = `on:
  push:
    branches: ["**", "!factory/**", "factory/keep"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(1);
  });

  it('refuses branches-ignore that re-includes a factory branch', async () => {
    const ci = `on:
  push:
    branches-ignore: ["factory/**", "!factory/keep"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(1);
  });

  it('accepts a tags-only push, which does not run on branches', async () => {
    const ci = `on:
  push:
    tags: ["v*"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(0);
  });

  it('refuses an ambiguous or unreadable YAML', async () => {
    const broken = await doctor([workflow('on: [pull_request\njobs: {}\n')]);
    expect(broken.code).toBe(1);
    expect(broken.text).toContain('invalid YAML');

    const dynamic = await doctor([workflow('on: "${{ github.event_name }}"\njobs: {}\n')]);
    expect(dynamic.code).toBe(1);
    expect(dynamic.text).toContain('dynamic');
  });

  it('refuses a workflow with indirect secrets (secrets: inherit)', async () => {
    const ci = `on: pull_request
jobs:
  call:
    uses: acme/ci/.github/workflows/test.yml@main
    secrets: inherit
`;
    const result = await doctor([workflow(ci)]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('secrets exposed');
  });

  it('refuses when only one of several secret-exposing jobs is protected', async () => {
    const ci = `on: pull_request
jobs:
  protected:
    environment: ci-protected
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
  unprotected:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const result = await doctor([workflow(ci)], [protectedEnvironment]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('job(s) without an environment: unprotected');
  });

  it('accepts a repository without workflows without calling the environments API', async () => {
    const result = await doctor([]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('No GitHub Actions workflow found');
    expect(result.api.environmentCalls).toBe(0);
  });

  it('fails closed when the GitHub API cannot be read', async () => {
    const result = await doctor([], [], { fake: { failWorkflows: true } });
    expect(result.code).toBe(1);
    expect(result.text).toContain('Cannot read the workflows');

    const envFailure = await doctor([workflow(secretsWorkflow('  pull_request:'))], [], { fake: { failEnvironments: true } });
    expect(envFailure.code).toBe(1);
    expect(envFailure.text).toContain('Cannot read the environments');
  });

  it('emits a JSON report with the verdict and no secret value', async () => {
    const ci = `on: pull_request
jobs:
  test:
    steps:
      - run: echo ghp_SENTINEL_VALUE
        env:
          TOKEN: \${{ secrets.GHP_SENTINEL_VALUE }}
`;
    const result = await doctor([workflow(ci)], [], { json: true });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.text) as {
      accepted: boolean;
      workflows: { path: string; secrets: boolean; verdict: string; triggers: string[] }[];
    };
    expect(report.accepted).toBe(false);
    expect(report.workflows[0]).toMatchObject({
      path: '.github/workflows/ci.yml',
      secrets: true,
      verdict: 'refused',
      triggers: ['pull_request'],
    });
    expect(result.text).not.toContain('ghp_SENTINEL_VALUE');
  });

  it('fails with a clear message when the GitHub App is not configured', async () => {
    const home = tempHome();
    const lines: string[] = [];
    const code = await runDoctorCommand({ repoPath: '/repo', home, env: {}, out: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('GitHub App not configured');
    expect(lines.join('\n')).toContain('No `gh` fallback');
  });

  it('runs the CLI adapter with the configured App and the git remote', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const home = tempHome();
    const pemPath = join(home, 'github-app.pem');
    writeFileSync(pemPath, privatePem);
    writeFileSync(
      join(home, 'config.yaml'),
      `github:\n  appId: "123"\n  privateKey: ${JSON.stringify(pemPath)}\n  installationId: "42"\n`,
    );

    const now = Date.parse('2026-10-22T10:00:00Z');
    const ci = 'on: pull_request\njobs:\n  test:\n    steps:\n      - run: npm test\n';
    const routes: ((url: URL, init: HttpRequest) => { body?: unknown } | undefined)[] = [
      (url) =>
        url.pathname === '/app/installations/42/access_tokens'
          ? { body: { token: 'ghs_cli_secret', expires_at: new Date(now + 60 * 60_000).toISOString() } }
          : undefined,
      (url) =>
        url.pathname === '/repos/acme/app/contents/.github/workflows'
          ? { body: [{ type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml' }] }
          : undefined,
      (url) =>
        url.pathname === '/repos/acme/app/contents/.github/workflows/ci.yml'
          ? { body: { type: 'file', encoding: 'base64', content: Buffer.from(ci).toString('base64') } }
          : undefined,
      (url) => (url.pathname === '/repos/acme/app/environments' ? { body: { total_count: 0, environments: [] } } : undefined),
    ];
    const http: HttpClient = async (url, init) => {
      const parsed = new URL(url);
      for (const route of routes) {
        const result = route(parsed, init);
        if (result) return { ok: true, status: 200, text: async () => JSON.stringify(result.body) };
      }
      throw new Error(`unexpected ${init.method} ${parsed.pathname}`);
    };
    const exec: Exec = async (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return { stdout: 'git@github.com:acme/app.git\n', stderr: '', code: 0 };
    };

    const lines: string[] = [];
    const code = await runDoctorCommand({
      repoPath: '/repo',
      home,
      env: {},
      out: (line) => lines.push(line),
      http,
      exec,
      now: () => now,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('verdict: accepted');
  });
});
