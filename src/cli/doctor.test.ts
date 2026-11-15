import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import type { BranchProtection, EnvironmentProtection, WorkflowSource } from '../adapters/forge/github-app-api.js';
import type { HttpClient, HttpRequest } from '../adapters/forge/github-app.js';
import type { BranchNaming } from '../core/naming.js';
import { MISSING_TEST_COMMAND } from '../config/repo-config.js';
import { checkHost, runDoctor, runDoctorCommand, type DoctorApi, type HostReport } from './doctor.js';

interface FakeOptions {
  failWorkflows?: boolean;
  failEnvironments?: boolean;
  failProtection?: boolean;
  protection?: BranchProtection;
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

  async branchProtection(): Promise<BranchProtection> {
    if (this.options.failProtection) throw new Error('403 Resource not accessible');
    return this.options.protection ?? { branch: 'main', classic: false, rules: ['pull_request'] };
  }
}

/** A host as the factory needs it: cgroup v2, its controllers delegated to the daemon's user. */
const goodHost: HostReport = checkHost(() => 'cpuset cpu io memory pids', 1000);

function workflow(content: string, path = '.github/workflows/ci.yml'): WorkflowSource {
  return { path, content };
}

async function doctor(
  workflows: WorkflowSource[],
  environments: EnvironmentProtection[] = [],
  options: { json?: boolean; fake?: FakeOptions; naming?: BranchNaming; repoPath?: string; commands?: Record<string, string>; host?: HostReport } = {},
): Promise<{ code: number; lines: string[]; text: string; api: FakeApi }> {
  const api = new FakeApi(workflows, environments, options.fake);
  const lines: string[] = [];
  const code = await runDoctor({
    repoPath: options.repoPath ?? '/repo',
    api,
    host: options.host ?? goodHost,
    out: (line) => lines.push(line),
    ...(options.json ? { json: true } : {}),
    ...(options.naming ? { naming: options.naming } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
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
permissions:
  contents: read
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
    expect(result.text).toContain('limited to jobs under a protected environment');
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

  it('accepts a push limited to branches the factory never names', async () => {
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

  it("refuses a push whose branch filter can reach the factory's branches: feat/, fix/, and the legacy factory/ (ORC-283)", async () => {
    for (const filter of ['feat/*', 'fix/**', 'factory/*']) {
      const ci = `on:
  push:
    branches: ["${filter}"]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
      const result = await doctor([workflow(ci)]);
      expect(result.code, filter).toBe(1);
      expect(result.text).toContain("can run the CI on the factory's branches");
    }
  });

  it('accepts a push that ignores every branch the factory names, and only then (ORC-283)', async () => {
    const ignoring = (patterns: string) => `on:
  push:
    branches-ignore: [${patterns}]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    expect((await doctor([workflow(ignoring('"feat/**", "fix/**", "factory/**"'))])).code).toBe(0);
    // A ticket whose PR is open on a factory/ branch keeps it: the factory still pushes there.
    expect((await doctor([workflow(ignoring('"feat/**", "fix/**"'))])).code).toBe(1);
  });

  it("accepts branches filtered to everything except the factory's", async () => {
    const ci = `on:
  push:
    branches: ["**", "!feat/**", "!fix/**", "!factory/**"]
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
    branches: ["**", "!feat/**", "!fix/**", "!factory/**", "feat/keep"]
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
    branches-ignore: ["feat/**", "fix/**", "factory/**", "!fix/keep"]
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
    expect(result.text).toContain('secrets: yes');
    expect(result.text).toContain("exposed on the factory's branches");
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

  it('puts whether the visual proof can be taken on this instance in the JSON report, whatever the verdict, a failure included (ORC-404)', async () => {
    const report = async (api: FakeApi, visualProof: { image?: string; detail: string }) => {
      const json: string[] = [];
      const code = await runDoctor({ repoPath: '/repo', api, out: (l) => json.push(l), json: true, visualProof });
      return { code, report: JSON.parse(json.join('\n')) as unknown };
    };
    expect(await report(new FakeApi([]), { image: 'b:1', detail: 'the captures run in b:1' })).toEqual({
      code: 0, report: expect.objectContaining({ accepted: true, visualProof: { available: true, detail: 'the captures run in b:1' } }),
    });
    expect(await report(new FakeApi([], [], { failWorkflows: true }), { detail: 'FACTORY_BROWSER_IMAGE is not set' })).toEqual({
      code: 1, report: expect.objectContaining({ accepted: false, error: expect.any(String), visualProof: { available: false, detail: 'FACTORY_BROWSER_IMAGE is not set' } }),
    });
  });

  it('says it first in text, from the CLI, once, before it needs the GitHub App (ORC-404)', async () => {
    const lines: string[] = [];
    await runDoctorCommand({ repoPath: '/repo', home: tempHome(), env: {}, out: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/^Visual proof on this instance: unavailable — .*FACTORY_CONTAINER_CLI/);
    expect(lines.filter((l) => l.startsWith('Visual proof'))).toHaveLength(1);
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
    const ci = 'on: pull_request\npermissions: read-all\njobs:\n  test:\n    steps:\n      - run: npm test\n';
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
      (url) => (url.pathname === '/repos/acme/app' ? { body: { default_branch: 'main' } } : undefined),
      (url) => (url.pathname === '/repos/acme/app/branches/main' ? { body: { name: 'main', protected: false } } : undefined),
      (url) => (url.pathname === '/repos/acme/app/rules/branches/main' ? { body: [{ type: 'pull_request' }] } : undefined),
    ];
    const http: HttpClient = async (url, init) => {
      const parsed = new URL(url);
      for (const route of routes) {
        const result = route(parsed, init);
        if (result) return { ok: true, status: 200, text: async () => JSON.stringify(result.body) };
      }
      throw new Error(`unexpected ${init.method} ${parsed.pathname}`);
    };
    const gitCalls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      expect(cmd).toBe('git');
      gitCalls.push(args);
      if (args[0] === 'remote') return { stdout: 'git@github.com:acme/app.git\n', stderr: '', code: 0 };
      // The repository's branch naming, on its default branch as the clone last fetched it: no `.factory`, the convention.
      if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '', code: 0 };
      if (args.includes('ls-tree')) return { stdout: '', stderr: '', code: 0 };
      throw new Error(`unexpected git ${args.join(' ')}`);
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
      readHostFile: () => 'cpu memory pids',
      uid: 1000,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Host: accepted');
    expect(lines.join('\n')).toContain('Default branch main: accepted');
    expect(lines.join('\n')).toContain('verdict: accepted');
    // No `.factory/config.yml` on the default branch: no `commands.test` either (ORC-412).
    expect(lines).toContain(MISSING_TEST_COMMAND);
    expect(gitCalls.some((a) => a.includes('fetch'))).toBe(false);
    // The App's key in a file config.yaml names (ORC-398): said after the visual proof, never part of the verdict.
    expect(lines.slice(1, 3)).toEqual([
      'Server secrets:',
      '  github.privateKey (config.yaml): in clear — warning: in clear on disk: write github.private_key in factory.yml with a sealed source (systemd-creds)',
    ]);
  });

  describe("the factory's real branch names (ORC-353)", () => {
    const pushOn = (filter: string): string => `on:
  push:
${filter}
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;

    it('refuses a filter that reaches the branches the factory names, though no made-up name matches it', async () => {
      // <type>/<id>-<slug>: at least two dashes after the type, as branchName writes them.
      const result = await doctor([workflow(pushOn('    branches: ["*/*-*-*"]'))]);
      expect(result.code).toBe(1);
      expect(result.text).toContain('factory branches: reached');
    });

    it("says so when a filter excludes the factory's real branches, and accepts the workflow", async () => {
      const ignored = await doctor([workflow(pushOn('    branches-ignore: ["feat/*-*", "fix/*-*", "factory/*-*"]'))]);
      expect(ignored.code).toBe(0);
      expect(ignored.text).toContain('factory branches: not reached');

      const negated = await doctor([workflow(pushOn('    branches: ["**", "!f[aei]*/[a-z]*-*"]'))], [], { json: true });
      expect(negated.code).toBe(0);
      const report = JSON.parse(negated.text) as { workflows: { factoryBranches: boolean }[] };
      expect(report.workflows[0]!.factoryBranches).toBe(false);
    });

    it('keeps refusing a negation that leaves some of the real branches in', async () => {
      for (const negation of ['!f*/[a-m]*', '!f*/[amoz]*', '!**[a-z]']) {
        expect((await doctor([workflow(pushOn(`    branches: ["**", "${negation}"]`))])).code, negation).toBe(1);
      }
    });

    it('refuses a filter that reaches only the branches whose title ends in a digit', async () => {
      expect((await doctor([workflow(pushOn('    branches: ["**[0-9]"]'))])).code).toBe(1);
    });
  });

  describe("a repository's own branch naming (ORC-283)", () => {
    const pushOn = (branches: string): string => `on:
  push:
    branches: [${branches}]
jobs:
  test:
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const naming: BranchNaming = { pattern: 'agent/{type}-{id}', types: [['Bug', 'fix']], fallback: 'feat' };

    it('tries the filters on the names that naming makes, and the legacy factory/ ones', async () => {
      expect((await doctor([workflow(pushOn('"feat/**", "fix/**"'))], [], { naming })).code).toBe(0);
      expect((await doctor([workflow(pushOn('"agent/fix-*"'))], [], { naming })).code).toBe(1);
      expect((await doctor([workflow(pushOn('"agent/**"'))], [], { naming })).code).toBe(1);
      expect((await doctor([workflow(pushOn('"factory/**"'))], [], { naming })).code).toBe(1);
    });
  });

  describe('a protected environment, the only approval doctor credits (ORC-283)', () => {
    const BOT = 'factory-app[bot]';
    const guarded = (trigger: string, environment?: string): string => `on: ${trigger}
permissions: read-all
jobs:
  test:
    if: github.actor != '${BOT}'
${environment ? `    environment: ${environment}\n` : ''}    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;
    const TRIGGERS = ['pull_request', 'pull_request_target', 'push', 'workflow_run'];

    it("refuses a job with secrets that keeps the factory's App out by its actor, on every trigger that reaches the agent's branches", async () => {
      for (const trigger of TRIGGERS) {
        const result = await doctor([workflow(guarded(trigger))], [], { json: true });
        expect(result.code, trigger).toBe(1);
        const report = JSON.parse(result.text) as { workflows: Record<string, unknown>[] };
        expect(report.workflows[0]!['verdict'], trigger).toBe('refused');
        expect(report.workflows[0]!, trigger).not.toHaveProperty('actorExcluded');
      }
    });

    it('names the job without an environment, and does not offer the actor exclusion', async () => {
      const result = await doctor([workflow(guarded('pull_request'))]);
      expect(result.text).toContain('job(s) without an environment: test');
      expect(result.text).not.toContain('github.actor');
      expect(result.text).not.toContain("App excluded");
    });

    it('accepts the same job under an environment with required reviewers, on every trigger', async () => {
      for (const trigger of TRIGGERS) {
        const result = await doctor([workflow(guarded(trigger, 'ci'))], [{ name: 'ci', requiredReviewers: true }]);
        expect(result.code, trigger).toBe(0);
      }
    });

    it('accepts secrets on a push limited to the default branch, which the agent never pushes to', async () => {
      expect((await doctor([workflow(guarded('{ push: { branches: [main] } }'))])).code).toBe(0);
    });
  });

  describe('the workflow read as YAML: secrets.* and the GITHUB_TOKEN (ORC-353)', () => {
    it('reads secrets in expressions only: a shell text that names them references none', async () => {
      const ci = `on: pull_request
permissions: read-all
jobs:
  test:
    steps:
      - run: echo "see secrets.NPM_TOKEN in the docs"
`;
      const result = await doctor([workflow(ci)]);
      expect(result.code).toBe(0);
      expect(result.text).toContain('secrets: no');
    });

    it('reads an `if:` as the expression it is', async () => {
      const ci = `on: pull_request
permissions: read-all
jobs:
  test:
    if: secrets.NPM_TOKEN != ''
    steps:
      - run: npm test
`;
      const result = await doctor([workflow(ci)]);
      expect(result.code).toBe(1);
      expect(result.text).toContain('secrets: yes');
    });

    it('counts secrets.GITHUB_TOKEN as the token, by its rights, not as a repository secret', async () => {
      const ci = `on: pull_request
permissions:
  contents: read
jobs:
  test:
    steps:
      - run: gh pr view
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
      const result = await doctor([workflow(ci)]);
      expect(result.code).toBe(0);
      expect(result.text).toContain('secrets: no');
      expect(result.text).toContain('GITHUB_TOKEN: read only');
    });

    it('refuses an exposed job whose GITHUB_TOKEN keeps the repository default rights, which the App cannot read', async () => {
      const ci = `on: pull_request
jobs:
  test:
    steps:
      - run: npm test
`;
      const result = await doctor([workflow(ci)]);
      expect(result.code).toBe(1);
      expect(result.text).toContain('GITHUB_TOKEN: test (repository default)');
      expect(result.text).toContain('declare `permissions:`');
    });

    it('refuses a GITHUB_TOKEN with write rights, workflow-wide or raised by one job', async () => {
      const all = await doctor([workflow('on: pull_request\npermissions: write-all\njobs:\n  test:\n    steps:\n      - run: npm test\n')]);
      expect(all.code).toBe(1);
      expect(all.text).toContain('GITHUB_TOKEN: test (write-all)');

      const raised = `on: pull_request
permissions: read-all
jobs:
  lint:
    steps:
      - run: npm run lint
  release:
    permissions:
      contents: write
      packages: write
    steps:
      - run: npm publish
`;
      const result = await doctor([workflow(raised)], [], { json: true });
      expect(result.code).toBe(1);
      const report = JSON.parse(result.text) as { workflows: { githubToken: { job: string; rights: string }[]; reasons: string[] }[] };
      expect(report.workflows[0]!.githubToken).toEqual([{ job: 'release', rights: 'write: contents, packages' }]);
      expect(report.workflows[0]!.reasons.join(' ')).toContain('job(s) without an environment: release');
    });

    it('accepts a writable GITHUB_TOKEN under a protected environment, or on triggers that do not reach the factory', async () => {
      const guarded = `on: pull_request
permissions: write-all
jobs:
  deploy:
    environment: ci-protected
    steps:
      - run: ./deploy
`;
      expect((await doctor([workflow(guarded)], [protectedEnvironment])).code).toBe(0);
      expect((await doctor([workflow('on:\n  push:\n    branches: [main]\njobs:\n  test:\n    steps:\n      - run: npm test\n')])).code).toBe(0);
    });

    it('refuses permissions it cannot read', async () => {
      const result = await doctor([workflow('on: pull_request\npermissions:\n  contents: maybe\njobs:\n  test:\n    steps:\n      - run: npm test\n')]);
      expect(result.code).toBe(1);
      expect(result.text).toContain('ambiguous `permissions`');
    });
  });

  describe('a workflow file of the repository, ignored since the workflow is the preset (ORC-388)', () => {
    /** A repository holding `files`, none of them readable: doctor names them, it never opens them. */
    function repoWith(files: string[]): string {
      const repo = tempHome();
      for (const file of files) {
        mkdirSync(join(repo, file, '..'), { recursive: true });
        writeFileSync(join(repo, file), 'not: [a workflow');
        chmodSync(join(repo, file), 0o000);
      }
      return repo;
    }

    it('warns about .factory/workflow.yml and .relais/workflow.yml, ignored, to delete, without reading them or changing the verdict', async () => { // transition, à retirer
      const result = await doctor([], [], { repoPath: repoWith(['.factory/workflow.yml', '.relais/workflow.yml']) }); // transition, à retirer
      expect(result.code).toBe(0);
      expect(result.lines).toContain('Warning: .factory/workflow.yml is ignored: the workflow is the factory/default preset. Delete it; its setup and checks go in .factory/config.yml.');
      expect(result.lines).toContain('Warning: .relais/workflow.yml is ignored: the workflow is the factory/default preset. Delete it; its setup and checks go in .factory/config.yml.'); // transition, à retirer
    });

    it('lists them in the JSON report', async () => {
      const result = await doctor([], [], { repoPath: repoWith(['.factory/workflow.yml']), json: true });
      expect(JSON.parse(result.text)).toMatchObject({ accepted: true, ignored: ['.factory/workflow.yml'] });
      const failed = await doctor([], [], { repoPath: repoWith(['.relais/workflow.yml']), json: true, fake: { failWorkflows: true } }); // transition, à retirer
      expect(JSON.parse(failed.text)).toMatchObject({ accepted: false, ignored: ['.relais/workflow.yml'] }); // transition, à retirer
    });

    it('says nothing of a repository without one', async () => {
      const result = await doctor([], [], { repoPath: repoWith([]) });
      expect(result.text).not.toContain('workflow.yml');
    });
  });

  describe("a repository without `commands.test`, the red check's command (ORC-412)", () => {
    it('warns, naming the key, without changing the verdict', async () => {
      const result = await doctor([], [], { commands: { lint: 'npm run lint' } });
      expect(result.code).toBe(0);
      expect(result.lines).toContain(MISSING_TEST_COMMAND);
      expect(MISSING_TEST_COMMAND).toContain('commands.test');
    });

    it('lists it in the JSON report', async () => {
      const result = await doctor([], [], { commands: {}, json: true });
      expect(JSON.parse(result.text)).toMatchObject({ accepted: true, warnings: [MISSING_TEST_COMMAND] });
    });

    it('says nothing when the repository has one', async () => {
      expect((await doctor([], [], { commands: { test: 'npm test' } })).text).not.toContain('commands.test');
      expect(JSON.parse((await doctor([], [], { commands: { test: 'npm test' }, json: true })).text)).not.toHaveProperty('warnings');
    });
  });
});

describe('the host: cgroup v2 and its controllers (ORC-208, criterion 1)', () => {
  const ROOT = '/sys/fs/cgroup/cgroup.controllers';
  const USER = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers';
  const files = (entries: Record<string, string>) => (path: string) => entries[path];

  it('refuses a host without cgroup v2: no cgroup.controllers at the root (cgroups v1 or hybrid)', async () => {
    const host = checkHost(files({}), 1000);
    expect(host.verdict).toBe('refused');
    const result = await doctor([], [], { host });
    expect(result.code).toBe(1);
    expect(result.text).toContain('cgroup v2');
    expect(result.text).toContain('Result: refused');
  });

  it('refuses a cgroup v2 host that lacks one of pids, memory and cpu, and names it', () => {
    const host = checkHost(files({ [ROOT]: 'cpuset cpu io memory', [USER]: 'cpu memory' }), 1000);
    expect(host.verdict).toBe('refused');
    expect(host.reasons.join(' ')).toContain('pids');
  });

  it("refuses a rootless daemon whose user has no delegated cgroup, or not every controller in it", () => {
    const none = checkHost(files({ [ROOT]: 'cpu memory pids' }), 1000);
    expect(none.verdict).toBe('refused');
    expect(none.reasons.join(' ')).toContain('loginctl enable-linger');
    const partial = checkHost(files({ [ROOT]: 'cpu memory pids', [USER]: 'memory pids' }), 1000);
    expect(partial.verdict).toBe('refused');
    expect(partial.reasons.join(' ')).toMatch(/delegated.*cpu/);
  });

  it('accepts cgroup v2 with the three controllers, delegated to the user; a root daemon reads the root only', () => {
    expect(checkHost(files({ [ROOT]: 'cpuset cpu io memory hugetlb pids', [USER]: 'cpu memory pids' }), 1000)).toMatchObject({ verdict: 'accepted', cgroupV2: true });
    expect(checkHost(files({ [ROOT]: 'cpu memory pids' }), 0).verdict).toBe('accepted');
  });

  it('puts the host in the JSON report', async () => {
    const result = await doctor([], [], { json: true, host: checkHost(files({}), 1000) });
    const report = JSON.parse(result.text) as { accepted: boolean; host: HostReport };
    expect(report.accepted).toBe(false);
    expect(report.host).toMatchObject({ cgroupV2: false, verdict: 'refused' });
  });
});

describe("the default branch's protection (ORC-208, criterion 2)", () => {
  const protection = (p: Partial<BranchProtection>): { fake: FakeOptions } => ({ fake: { protection: { branch: 'main', classic: false, rules: [], ...p } } });

  it('refuses a repository whose default branch has neither branch protection nor a ruleset that requires a pull request', async () => {
    const result = await doctor([], [], protection({}));
    expect(result.code).toBe(1);
    expect(result.text).toContain('main');
    expect(result.text).toContain('not protected');
    expect(result.text).toContain('Result: refused');
  });

  it('refuses rulesets that do not require a pull request: a direct push still lands', async () => {
    const result = await doctor([], [], protection({ rules: ['deletion', 'non_fast_forward'] }));
    expect(result.code).toBe(1);
    expect(result.text).toContain('pull_request');
  });

  it('accepts a ruleset that requires a pull request, and a classic protection, whose rules the App cannot read, saying so', async () => {
    const ruleset = await doctor([], [], protection({ rules: ['pull_request'] }));
    expect(ruleset.code).toBe(0);
    const classic = await doctor([], [], protection({ classic: true }));
    expect(classic.code).toBe(0);
    expect(classic.text).toContain('Administration');
  });

  it('fails closed when the protection cannot be read', async () => {
    const result = await doctor([], [], { fake: { failProtection: true } });
    expect(result.code).toBe(1);
    expect(result.text).toContain('Cannot read the protection of the default branch');
  });

  it('puts the protection in the JSON report', async () => {
    const result = await doctor([], [], { json: true, ...protection({ rules: ['deletion'] }) });
    const report = JSON.parse(result.text) as { accepted: boolean; branchProtection: { branch: string; verdict: string } };
    expect(report.accepted).toBe(false);
    expect(report.branchProtection).toMatchObject({ branch: 'main', verdict: 'refused' });
  });
});
