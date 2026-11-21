import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import type { BranchProtection, EnvironmentProtection, WorkflowSource } from '../adapters/forge/github-app-api.js';
import { UnreadableAnswerError, type HttpClient, type HttpRequest } from '../adapters/forge/github-app.js';
import type { BranchNaming } from '../core/naming.js';
import { MISSING_TEST_COMMAND } from '../config/repo-config.js';
import { checkHost, runDoctor, runDoctorCommand, type DoctorApi, type HostReport } from './doctor.js';
import { GITHUB_APP_PERMISSIONS } from './init.js';
import { startFactory } from '../app/bootstrap.js';
import { saveInstance, type InstanceConfig } from '../config/instance.js';

interface FakeOptions {
  failWorkflows?: boolean;
  failEnvironments?: boolean;
  failProtection?: boolean;
  protection?: BranchProtection;
  failInstallation?: 'network' | 'unreadable';
  permissions?: Record<string, string>;
}

/** The permissions the manifest asks for (docs/github-app-manifest.json): what a conforming installation holds. */
const MANIFEST_PERMISSIONS: Record<string, string> = GITHUB_APP_PERMISSIONS;

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
    return this.options.protection ?? { branch: 'main', classic: false, rules: ['pull_request'], pullRequestRulesets: [{ id: 1, bypass: 'never' }] };
  }

  async installationPermissions(): Promise<Record<string, string>> {
    if (this.options.failInstallation === 'network') throw new Error('getaddrinfo ENOTFOUND api.github.com');
    if (this.options.failInstallation === 'unreadable') throw new UnreadableAnswerError('GitHub API GET /repos/acme/app/installation: unreadable answer');
    return this.options.permissions ?? MANIFEST_PERMISSIONS;
  }
}

/** `docker info --format '{{json .}}'` of a rootless Docker on cgroup v2 whose user has the three controllers delegated. */
const DOCKER_INFO = {
  CgroupVersion: '2',
  CgroupDriver: 'systemd',
  MemoryLimit: true,
  CpuCfsQuota: true,
  PidsLimit: true,
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'],
};
/** `podman info --format json` of a rootless Podman in a systemd user session, the controllers delegated. */
const PODMAN_INFO = { host: { cgroupVersion: 'v2', cgroupManager: 'systemd', cgroupControllers: ['cpu', 'memory', 'pids'], security: { rootless: true } } };

/** The runner image the start requires with an engine (ORC-449): doctor's host check refuses without it. */
const RUNNER = { FACTORY_RUNNER_IMAGE: 'factory-runner:test' };

/** An engine whose `info` prints `info` as JSON, or fails as `failure` says; it records the calls. */
function engine(info: object, failure?: { code: number; stderr: string }): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return failure ? { stdout: '', ...failure } : { stdout: `${JSON.stringify(info)}\n`, stderr: '', code: 0 };
  };
  return { exec, calls };
}

const docker = (info: object = DOCKER_INFO) => checkHost({ FACTORY_CONTAINER_CLI: 'docker', ...RUNNER }, engine(info).exec);
const podman = (info: object = PODMAN_INFO) => checkHost({ FACTORY_CONTAINER_CLI: 'podman', ...RUNNER }, engine(info).exec);

/** A host as the factory needs it: its engine on cgroup v2, able to limit processes, memory and CPUs. */
const goodHost: HostReport = await docker();

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

  it("still tells the host's and the protection's verdicts when the workflows cannot be read, in text and JSON", async () => {
    const text = await doctor([], [], { fake: { failWorkflows: true } });
    expect(text.text).toMatch(/^Host: accepted/m);
    expect(text.text).toMatch(/^Default branch main: accepted/m);
    const json = await doctor([], [], { json: true, fake: { failWorkflows: true } });
    expect(JSON.parse(json.text)).toMatchObject({ accepted: false, host: { verdict: 'accepted' }, branchProtection: { branch: 'main', verdict: 'accepted' } });
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
      const code = await runDoctor({ repoPath: '/repo', api, host: goodHost, out: (l) => json.push(l), json: true, visualProof });
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
    expect(lines.join('\n')).not.toMatch(/\bgh\b/);
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
      (url) => (url.pathname === '/repos/acme/app/branches/main' ? { body: { name: 'main', protected: true, protection: { enabled: false } } } : undefined),
      (url) => (url.pathname === '/repos/acme/app/rules/branches/main' ? { body: [{ type: 'pull_request', ruleset_id: 9 }] } : undefined),
      (url) => (url.pathname === '/repos/acme/app/rulesets/9' ? { body: { id: 9, current_user_can_bypass: 'never' } } : undefined),
      (url) => (url.pathname === '/repos/acme/app/installation' ? { body: { id: 42, permissions: MANIFEST_PERMISSIONS } } : undefined),
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
      // The host, from the engine of FACTORY_CONTAINER_CLI (ORC-208).
      if (cmd === 'docker') return engine(DOCKER_INFO).exec(cmd, args);
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
      env: { FACTORY_CONTAINER_CLI: 'docker', ...RUNNER },
      out: (line) => lines.push(line),
      http,
      exec,
      now: () => now,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Host: accepted');
    expect(lines.join('\n')).toContain('Default branch main: accepted');
    expect(lines.join('\n')).toContain('GitHub App installation: accepted');
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

  describe("the statuses factory.yml names that the Linear team lacks (ORC-382)", () => {
    const homeWith = (yml = '') => {
      const home = tempHome();
      writeFileSync(join(home, 'config.yaml'), 'projects:\n  - id: app\n    repoPath: /repo\n    linearTeamKey: APP\n');
      if (yml) writeFileSync(join(home, 'factory.yml'), yml);
      return home;
    };
    const ORC_170 = ['Todo', 'In Progress', 'AI Review', 'Human Review', 'Done', 'Canceled'];
    const cli = async (home: string, team: string[] | Error = ORC_170) => {
      const lines: string[] = [];
      await runDoctorCommand({ repoPath: '/repo', home, env: {}, out: (line) => lines.push(line), teamStatuses: async () => (team instanceof Error ? Promise.reject(team) : team) });
      return lines.filter((l) => /status/i.test(l));
    };

    it('criterion 4: warns of a status the team does not have, before it needs the GitHub App', async () => {
      expect(await cli(homeWith('statuses:\n  spec_draft: Spec\n'))).toEqual([
        'Warning: app: the Linear team APP has no status « Spec », which the factory moves tickets to (ORC-170\'s, or as `statuses` in factory.yml names them): a move to it fails. Connect Linear again to create it, or name a status the team has.',
      ]);
    });

    it('refuses statuses the daemon would refuse at load, exit 1', async () => {
      const lines: string[] = [];
      const code = await runDoctorCommand({ repoPath: '/repo', home: homeWith('statuses:\n  build: Todo\n'), env: {}, out: (line) => lines.push(line), teamStatuses: async () => ORC_170 });
      expect(code).toBe(1);
      expect(lines).toContainEqual(expect.stringMatching(/« Todo » would name both todo and dev/));
    });

    it('says nothing when the team has every status, and that it could not read them otherwise', async () => {
      expect(await cli(homeWith())).toEqual([]);
      expect(await cli(homeWith('statuses:\n  spec_draft: Spec\n'), [...ORC_170, 'Spec'])).toEqual([]);
      expect(await cli(homeWith(), new Error('Linear answered 401'))).toEqual(['Linear statuses of app not checked: Linear answered 401']);
    });

    it('without a Linear connection, says the statuses are not checked', async () => {
      const lines: string[] = [];
      await runDoctorCommand({ repoPath: '/repo', home: homeWith(), env: {}, out: (line) => lines.push(line) });
      expect(lines).toContain('Linear statuses not checked: Linear not connected: run `factory up`, then connect Linear.');
    });
  });

  describe('a project whose spec gate no validator can pass (ORC-421)', () => {
    const homeWith = ({ validators, preset }: { validators?: string[]; preset?: string } = {}) => {
      const home = tempHome();
      const authz = validators ? `\n    authz:\n      validators: ${JSON.stringify(validators)}` : '';
      const ghost = preset ? `\n    preset: ${preset}` : '';
      writeFileSync(join(home, 'config.yaml'), `projects:\n  - id: app\n    repoPath: /repo\n    linearTeamKey: APP${authz}${ghost}\n`);
      return home;
    };
    const cli = async (home: string, repoPath = '/repo') => {
      const lines: string[] = [];
      await runDoctorCommand({ repoPath, home, env: {}, out: (line) => lines.push(line) });
      return lines;
    };
    const warned = async (home: string, repoPath?: string) => (await cli(home, repoPath)).filter((l) => l.includes('authz.validators'));

    it('warns, naming authz.validators, of the instance before it needs the GitHub App, without validators', async () => {
      const lines = await cli(homeWith());
      const none = lines.filter((l) => l.includes('authz.validators'));
      expect(none).toHaveLength(1);
      expect(none[0]).toMatch(/^Warning: app: no spec validator \(authz\.validators in config\.yaml\)/);
      expect(lines.indexOf(none[0]!)).toBeLessThan(lines.findIndex((l) => l.includes('GitHub App not configured')));
      expect(await warned(homeWith({ validators: [] }))).toEqual(none);
    });

    it('warns of a lone validator, who cannot approve the tickets they delegate, one id twice counting once', async () => {
      const lone = await warned(homeWith({ validators: ['u-1'] }));
      expect(lone).toHaveLength(1);
      expect(lone[0]).toMatch(/^Warning: app: one spec validator \(authz\.validators in config\.yaml\)/);
      expect(await warned(homeWith({ validators: ['u-1', 'u-1'] }))).toEqual(lone);
    });

    it("says nothing of another repository's project", async () => {
      expect(await warned(homeWith(), '/other')).toEqual([]);
    });

    it('says nothing with two validators, nor of the replay of closed tickets, which approves its own specs', async () => {
      expect(await warned(homeWith({ validators: ['u-1', 'u-2'] }))).toEqual([]);
      expect(await warned(homeWith({ preset: 'factory/fantome' }))).toEqual([]);
    });

    it('lists them in the JSON report, whatever the verdict, and only when there is one', async () => {
      const report = async (api: FakeApi, validatorWarnings?: string[]) => {
        const json: string[] = [];
        await runDoctor({ repoPath: '/repo', api, host: goodHost, json: true, out: (line) => json.push(line), ...(validatorWarnings ? { validatorWarnings } : {}) });
        return JSON.parse(json.join('\n')) as unknown;
      };
      expect(await report(new FakeApi([]), ['Warning: app: x'])).toMatchObject({ accepted: true, validatorWarnings: ['Warning: app: x'] });
      expect(await report(new FakeApi([], [], { failWorkflows: true }), ['Warning: app: x'])).toMatchObject({ accepted: false, validatorWarnings: ['Warning: app: x'] });
      expect(await report(new FakeApi([]), [])).not.toHaveProperty('validatorWarnings');
      expect(await report(new FakeApi([]))).not.toHaveProperty('validatorWarnings');
    });
  });

  // ORC-446: the Smee relay's check of the daemon's start (ORC-444), said by doctor too.
  describe('the Smee relay outside the development mode (ORC-446)', () => {
    const homeWith = (extra: string) => {
      const home = tempHome();
      writeFileSync(join(home, 'config.yaml'), `relay:\n  kind: smee\n  url: https://smee.io/abc\n${extra}projects:\n  - id: app\n    repoPath: /repo\n    linearTeamKey: APP\n`);
      return home;
    };
    const cli = async (home: string, json = false) => {
      const lines: string[] = [];
      const code = await runDoctorCommand({ repoPath: '/repo', home, env: {}, out: (line) => lines.push(line), ...(json ? { json } : {}) });
      return { code, lines, relay: lines.filter((l) => l.includes('kind: smee')) };
    };

    it('criterion 1: warns of a config without the marker, before it needs the GitHub App', async () => {
      const { lines, relay } = await cli(homeWith(''));
      expect(relay).toEqual([expect.stringMatching(/^Warning: relay: \{ kind: smee \}.*dev: true.*factory init --dev/)]);
      expect(lines.indexOf(relay[0]!)).toBeLessThan(lines.findIndex((l) => l.includes('GitHub App not configured')));
    });

    it('criterion 1: fails with dev: false, as factory up does, exit 1', async () => {
      const { code, lines, relay } = await cli(homeWith('dev: false\n'));
      expect(code).toBe(1);
      expect(relay).toEqual([expect.stringMatching(/dev: false.*publicUrl.*factory init --dev/)]);
      expect(lines.join('\n')).not.toContain('GitHub App not configured');
    });

    it('criterion 2: fails with a publicUrl in the development mode, exit 1', async () => {
      const { code, relay } = await cli(homeWith('dev: true\npublicUrl: https://f.example.com\n'));
      expect(code).toBe(1);
      expect(relay).toEqual([expect.stringMatching(/publicUrl: https:\/\/f\.example\.com.*relay: \{ kind: none \}/)]);
    });

    it('says nothing in the development mode', async () => {
      expect((await cli(homeWith('dev: true\n'))).relay).toEqual([]);
    });

    it('lists the warning in the JSON report, and only when there is one', async () => {
      const report = async (relayWarnings?: string[]) => {
        const json: string[] = [];
        await runDoctor({ repoPath: '/repo', api: new FakeApi([]), host: goodHost, json: true, out: (line) => json.push(line), ...(relayWarnings ? { relayWarnings } : {}) });
        return JSON.parse(json.join('\n')) as unknown;
      };
      expect(await report(['Warning: relay: x'])).toMatchObject({ accepted: true, relayWarnings: ['Warning: relay: x'] });
      expect(await report([])).not.toHaveProperty('relayWarnings');
      expect((await cli(homeWith(''), true)).lines.filter((l) => l.startsWith('Warning: relay'))).toEqual([]);
    });
  });
});

// ORC-448: every refusal of the daemon's start that its configuration decides, said by doctor, which fails with the same message.
describe("the daemon's start refusals, each one doctor's", () => {
  const local: InstanceConfig = { port: 4160, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} };
  const exposed: InstanceConfig = { ...local, host: '0.0.0.0', publicUrl: 'https://factory.example' };
  const smee = { kind: 'smee' as const, url: 'https://smee.io/abc' };
  const client = { GH_APP_CLIENT_ID: 'Iv1.client', GH_APP_CLIENT_SECRET: 'client-secret' };
  const signIn = 'dashboard: { logins: [armand] }\n';
  interface Refusal {
    instance?: InstanceConfig;
    configYaml?: string;
    factoryYml?: string;
    env?: NodeJS.ProcessEnv;
    /** What identifies the refusal in the start's message: the start refuses for this reason, not another. */
    reason: RegExp;
  }
  const refusals: Record<string, Refusal> = {
    'an invalid config.yaml': { configYaml: 'port: nope\n', reason: /^invalid config\.yaml: port/ },
    'an invalid factory.yml': { factoryYml: 'github: { app_id: 456, private_key: env:GH_APP_KEY }\n', reason: /github\.private_key: the environment variable GH_APP_KEY/ },
    'a GitHub App secret its source cannot read': {
      factoryYml: 'secret_sources: { creds: { kind: systemd-creds } }\ngithub: { app_id: 456, private_key: creds:github-key }\n',
      reason: /github\.private_key \(creds:github-key\) could not be read/,
    },
    'half the OAuth client': { env: { GH_APP_CLIENT_ID: 'Iv1.client' }, reason: /^Incomplete GitHub sign-in/ },
    'exposed without the OAuth client': { instance: exposed, reason: /^host: 0\.0\.0\.0 exposes .*github\.client_id/ },
    'exposed without who may sign in': { instance: exposed, env: client, reason: /^host: 0\.0\.0\.0 exposes .*dashboard: \{ logins, org, team \}/ },
    'exposed without an HTTPS publicUrl': { instance: { ...exposed, publicUrl: 'http://factory.example' }, factoryYml: signIn, env: client, reason: /^host: 0\.0\.0\.0 exposes .*set publicUrl to its https:\/\/ address/ },
    'exposed without secrets_key': { instance: exposed, factoryYml: signIn, env: client, reason: /^host: 0\.0\.0\.0 exposes .*: set secrets_key in factory\.yml/ },
    'the Smee relay with dev: false': { instance: { ...local, relay: smee, dev: false }, reason: /^relay: \{ kind: smee \}.*\(dev: false\)/ },
    'the Smee relay beside a publicUrl in the development mode': { instance: { ...local, relay: smee, dev: true, publicUrl: 'https://f.example.com' }, reason: /^relay: \{ kind: smee \} in config\.yaml beside publicUrl/ },
    'half the GitHub App': { env: { GH_APP_ID: '456' }, reason: /^Incomplete GitHub App configuration/ },
    'a status no step shows': { factoryYml: 'statuses: { nope: Todo }\n', reason: /^factory\.yml: statuses\.nope: is not a step/ },
    'a step setting of no agent step': { factoryYml: 'budgets: { max_turns: { nope: 3 } }\n', reason: /^factory\.yml: budgets\.max_turns\.nope: not an agent step/ },
    'a Claude token a header cannot carry': { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x\r\nX-Injected: 1' }, reason: /^CLAUDE_CODE_OAUTH_TOKEN: the Claude token holds a character/ },
  };

  it('fails doctor with the message the start refuses with, exit 1, for each refusal', async () => {
    for (const [name, r] of Object.entries(refusals)) {
      const home = tempHome();
      if (r.configYaml !== undefined) writeFileSync(join(home, 'config.yaml'), r.configYaml);
      else saveInstance(home, r.instance ?? local);
      if (r.factoryYml !== undefined) writeFileSync(join(home, 'factory.yml'), r.factoryYml);
      const env = r.env ?? {};
      const started = await startFactory({ home, fakeRunner: true, log: () => {}, env }).then(
        async (app) => {
          await app.stop();
          return undefined;
        },
        (error: Error) => error.message,
      );
      expect(started, name).toMatch(r.reason);
      const lines: string[] = [];
      const code = await runDoctorCommand({ repoPath: '/repo', home, env, out: (line) => lines.push(line) });
      expect({ name, code, refused: lines.includes(started!) }).toEqual({ name, code: 1, refused: true });
    }
  });

  it('takes the secrets it does not read, of a source other than env, as the start takes them read', async () => {
    const home = tempHome();
    saveInstance(home, exposed);
    const claude = 'claude: { runtime: claude-code, default_model: claude-opus-5-5, active: main, accounts: [{ name: main, token: creds:claude }] }\n';
    writeFileSync(join(home, 'factory.yml'), `secret_sources: { creds: { kind: systemd-creds } }\nsecrets_key: creds:secrets-key\n${claude}${signIn}`);
    const lines: string[] = [];
    // The daemon would take the active account's token, never this one.
    await runDoctorCommand({ repoPath: '/repo', home, env: { ...client, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x\r\nX-Injected: 1' }, out: (line) => lines.push(line) });
    expect(lines.filter((l) => l.startsWith('host: 0.0.0.0') || l.startsWith('CLAUDE_CODE_OAUTH_TOKEN'))).toEqual([]);
    expect(lines).toContain('GitHub App not configured: `factory doctor` needs github.appId and github.privateKey (or GH_APP_ID and GH_APP_KEY) to read the workflows and the environments.');
  });
});

// ORC-449: the daemon's environment the start refuses (sandboxRefusals), refused by doctor's host check with the start's message.
describe("the daemon's environment the start refuses, doctor's host refuses", () => {
  const started = async (env: NodeJS.ProcessEnv): Promise<string> => {
    const home = tempHome();
    saveInstance(home, { port: 4160, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    return startFactory({ home, log: () => {}, env }).then(
      async (app) => {
        await app.stop();
        return 'started';
      },
      (error: Error) => error.message,
    );
  };

  it('refuses an engine without FACTORY_RUNNER_IMAGE with the message of the start, the engine asked all the same', async () => {
    const env = { FACTORY_CONTAINER_CLI: 'docker' };
    const message = await started(env);
    expect(message).toBe('FACTORY_RUNNER_IMAGE is required with FACTORY_CONTAINER_CLI.');
    const asked = engine(DOCKER_INFO);
    const host = await checkHost(env, asked.exec);
    expect(host).toMatchObject({ engine: 'docker', cgroupV2: true, verdict: 'refused', reasons: [message] });
    expect(asked.calls).toHaveLength(1);
    const lines: string[] = [];
    expect(await doctor([], [], { host }).then((r) => (lines.push(...r.lines), r.code))).toBe(1);
    expect(lines).toContain(`Host: refused — ${message}`);
  });

  it('refuses an engine neither docker nor podman with the message of the start, without asking it', async () => {
    const env = { FACTORY_CONTAINER_CLI: 'lxc', FACTORY_RUNNER_IMAGE: 'factory-runner:test' };
    const message = await started(env);
    expect(message).toBe('FACTORY_CONTAINER_CLI=lxc: docker or podman expected.');
    const asked = engine(DOCKER_INFO);
    expect(await checkHost(env, asked.exec)).toEqual({ verdict: 'refused', reasons: [message] });
    expect(asked.calls).toEqual([]);
  });
});

describe('doctor --json on a refusal of the instance configuration (ORC-449)', () => {
  it('stays JSON, the refusal under error', async () => {
    const home = tempHome();
    writeFileSync(join(home, 'config.yaml'), 'port: nope\n');
    const lines: string[] = [];
    const code = await runDoctorCommand({ repoPath: '/repo', home, env: {}, json: true, out: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ repoPath: '/repo', accepted: false, error: expect.stringMatching(/^invalid config\.yaml: port/), visualProof: { available: false } });
  });

  it('keeps the warnings said before the refusal, as the text says them', async () => {
    const home = tempHome();
    saveInstance(home, { port: 4160, host: '127.0.0.1', relay: { kind: 'smee', url: 'https://smee.io/abc' }, projects: [], limits: {} });
    const lines: string[] = [];
    expect(await runDoctorCommand({ repoPath: '/repo', home, env: { GH_APP_ID: '456' }, json: true, out: (line) => lines.push(line) })).toBe(1);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ error: expect.stringMatching(/^Incomplete GitHub App configuration/), relayWarnings: [expect.stringContaining('smee')] });
  });

  it('stays JSON without the GitHub App', async () => {
    const lines: string[] = [];
    expect(await runDoctorCommand({ repoPath: '/repo', home: tempHome(), env: {}, json: true, out: (line) => lines.push(line) })).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ accepted: false, error: expect.stringContaining('GitHub App not configured') });
  });
});

describe('the host: the engine on cgroup v2, able to set the limits (ORC-208, criterion 1)', () => {
  it("asks the engine of FACTORY_CONTAINER_CLI, not the cgroups of doctor's own process", async () => {
    const dockerEngine = engine(DOCKER_INFO);
    expect(await checkHost({ FACTORY_CONTAINER_CLI: 'docker', ...RUNNER }, dockerEngine.exec)).toMatchObject({
      engine: 'docker',
      cgroupV2: true,
      controllers: ['cpu', 'memory', 'pids'],
      rootless: true,
      verdict: 'accepted',
    });
    expect(dockerEngine.calls).toEqual([['docker', 'info', '--format', '{{json .}}']]);
    const podmanEngine = engine(PODMAN_INFO);
    expect(await checkHost({ FACTORY_CONTAINER_CLI: 'podman', ...RUNNER }, podmanEngine.exec)).toMatchObject({
      engine: 'podman',
      cgroupV2: true,
      controllers: ['cpu', 'memory', 'pids'],
      rootless: true,
      verdict: 'accepted',
    });
    expect(podmanEngine.calls).toEqual([['podman', 'info', '--format', 'json']]);
  });

  it('refuses an engine on cgroups v1 or the hybrid layout', async () => {
    const host = await docker({ ...DOCKER_INFO, CgroupVersion: '1' });
    expect(host).toMatchObject({ cgroupV2: false, verdict: 'refused' });
    const result = await doctor([], [], { host });
    expect(result.code).toBe(1);
    expect(result.text).toContain('cgroup v2');
    expect(result.text).toContain('Result: refused');
    expect(await podman({ host: { ...PODMAN_INFO.host, cgroupVersion: 'v1' } })).toMatchObject({ cgroupV2: false, verdict: 'refused' });
  });

  it('refuses an engine that cannot set one of the process, memory and CPU limits, and names it', async () => {
    // Rootless Docker without `cpu` delegated to its user: the engine says it cannot apply a CPU quota.
    const noCpu = await docker({ ...DOCKER_INFO, CpuCfsQuota: false });
    expect(noCpu).toMatchObject({ verdict: 'refused', controllers: ['memory', 'pids'] });
    expect(noCpu.reasons.join(' ')).toContain('cpu');
    const noPids = await podman({ host: { ...PODMAN_INFO.host, cgroupControllers: ['cpu', 'memory'] } });
    expect(noPids.verdict).toBe('refused');
    expect(noPids.reasons.join(' ')).toContain('pids');
  });

  it('refuses a rootless Podman on cgroupfs, which ignores the limits, even with every controller listed', async () => {
    const host = await podman({ host: { ...PODMAN_INFO.host, cgroupManager: 'cgroupfs' } });
    expect(host.verdict).toBe('refused');
    expect(host.reasons.join(' ')).toContain('cgroupfs');
    expect(host.reasons.join(' ')).toContain('loginctl enable-linger');
    // Rootful, cgroupfs sets the limits.
    expect((await podman({ host: { ...PODMAN_INFO.host, cgroupManager: 'cgroupfs', security: { rootless: false } } })).verdict).toBe('accepted');
  });

  it('refuses a rootless Docker off the systemd cgroup driver, which ignores the limits, whatever its flags', async () => {
    // No systemd user session: Docker's rootless docs, `Cgroup Driver: none`.
    const none = await docker({ ...DOCKER_INFO, CgroupDriver: 'none' });
    expect(none.verdict).toBe('refused');
    expect(none.reasons.join(' ')).toContain('none');
    expect(none.reasons.join(' ')).toContain('loginctl enable-linger');
    // A rootless Podman behind the Docker-compatible socket (compose's `docker` CLI): its cgroup manager in CgroupDriver.
    expect((await docker({ ...DOCKER_INFO, CgroupDriver: 'cgroupfs' })).verdict).toBe('refused');
    // Rootful, cgroupfs sets the limits.
    expect((await docker({ ...DOCKER_INFO, CgroupDriver: 'cgroupfs', SecurityOptions: ['name=seccomp,profile=builtin'] })).verdict).toBe('accepted');
  });

  it('on cgroups v1, says no cgroup v2 alone: no delegation advice that linger cannot fix', async () => {
    const host = await podman({ host: { ...PODMAN_INFO.host, cgroupVersion: 'v1', cgroupControllers: [], cgroupManager: 'cgroupfs' } });
    expect(host.verdict).toBe('refused');
    expect(host.reasons).toHaveLength(1);
    expect(host.reasons[0]).toContain('no cgroup v2');
  });

  it('refuses without an engine to ask, and names FACTORY_CONTAINER_CLI', async () => {
    const none = engine(DOCKER_INFO);
    const host = await checkHost({}, none.exec);
    expect(host.verdict).toBe('refused');
    expect(host.reasons.join(' ')).toContain('FACTORY_CONTAINER_CLI');
    expect(none.calls).toEqual([]);
    expect((await checkHost({ FACTORY_CONTAINER_CLI: 'lxc' }, none.exec)).reasons.join(' ')).toContain('docker or podman expected');
  });

  it("names an engine it cannot ask or read, and never tells what it did not read (no cgroupV2, no controllers)", async () => {
    const unreachable = await checkHost({ FACTORY_CONTAINER_CLI: 'docker', ...RUNNER }, engine({}, { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }).exec);
    expect(unreachable.verdict).toBe('refused');
    expect(unreachable.reasons.join(' ')).toContain('Cannot connect to the Docker daemon');
    expect(unreachable).not.toHaveProperty('cgroupV2');
    expect(unreachable).not.toHaveProperty('controllers');
    const serverErrors = await docker({ ServerErrors: ['error during connect'] });
    expect(serverErrors.reasons.join(' ')).toContain('error during connect');
    expect(serverErrors).not.toHaveProperty('cgroupV2');
    // An answer without the cgroup version (an engine too old to report it) is unread, never cgroups v1.
    const unknown = await docker({ MemoryLimit: true });
    expect(unknown.verdict).toBe('refused');
    expect(unknown).not.toHaveProperty('cgroupV2');
    expect(unknown.reasons.join(' ')).not.toContain('cgroups v1');
    const garbled = await checkHost({ FACTORY_CONTAINER_CLI: 'podman', ...RUNNER }, async () => ({ stdout: 'not json', stderr: '', code: 0 }));
    expect(garbled.verdict).toBe('refused');
    expect(garbled).not.toHaveProperty('cgroupV2');
  });

  it('puts the host in the JSON report', async () => {
    const result = await doctor([], [], { json: true, host: await docker({ ...DOCKER_INFO, CgroupVersion: '1' }) });
    const report = JSON.parse(result.text) as { accepted: boolean; host: HostReport };
    expect(report.accepted).toBe(false);
    expect(report.host).toMatchObject({ engine: 'docker', cgroupV2: false, verdict: 'refused' });
  });
});

describe("the default branch's protection (ORC-208, criterion 2)", () => {
  const protection = (p: Partial<BranchProtection>): { fake: FakeOptions } => ({ fake: { protection: { branch: 'main', classic: false, rules: [], pullRequestRulesets: [], ...p } } });
  const pullRequest = (...bypass: string[]) => protection({ rules: ['pull_request'], pullRequestRulesets: bypass.map((b, i) => ({ id: i + 1, bypass: b })) });

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
    const ruleset = await doctor([], [], pullRequest('never'));
    expect(ruleset.code).toBe(0);
    const classic = await doctor([], [], protection({ classic: true }));
    expect(classic.code).toBe(0);
    expect(classic.text).toContain('Administration');
  });

  it.each(['always', 'pull_requests_only', 'exempt'])("refuses a pull request ruleset the factory's App can bypass (%s), and names it", async (bypass) => {
    const result = await doctor([], [], pullRequest(bypass));
    expect(result.code).toBe(1);
    expect(result.text).toContain(`ruleset 1 (${bypass})`);
  });

  it('accepts when one pull request ruleset holds the App, though another lets it bypass', async () => {
    expect((await doctor([], [], pullRequest('always', 'never'))).code).toBe(0);
  });

  it('accepts a classic protection beside a pull request ruleset the App bypasses: that ruleset does not count, nor takes from it', async () => {
    const result = await doctor([], [], protection({ classic: true, rules: ['pull_request'], pullRequestRulesets: [{ id: 4, bypass: 'always' }] }));
    expect(result.code).toBe(0);
    expect(result.text).toContain('Administration');
  });

  it('fails closed when the protection cannot be read', async () => {
    const result = await doctor([], [], { fake: { failProtection: true } });
    expect(result.code).toBe(1);
    expect(result.text).toContain('Cannot read the protection of the default branch');
    expect(result.text).toContain("Result: refused — the default branch's protection cannot be read");
    expect(result.text).not.toContain('is not protected');
  });

  // GitHub returns a ruleset's bypass actors only to an account that can edit it (Administration write), which the App lacks.
  it('accepts a protection with a warning naming the manual check of the bypass actors, which it cannot read (ORC-428)', async () => {
    for (const options of [pullRequest('never'), protection({ classic: true })]) {
      const result = await doctor([], [], options);
      expect(result.code).toBe(0);
      const warning = result.lines.find((line) => line.startsWith('  Warning: bypass actors not read'));
      expect(warning).toBeDefined();
      expect(result.text).toContain('Check by hand what the warning under the default branch names.');
      for (const named of ['Administration', 'Repository admin', 'Organization admin', 'Deploy key', 'gh token', 'Do not allow bypassing the above settings', 'FACTORY_ALLOW_HOST_RUNS=1']) {
        expect(warning).toContain(named);
      }
      const json = JSON.parse((await doctor([], [], { json: true, ...options })).text) as { branchProtection: { verdict: string; warnings: string[] } };
      expect(json.branchProtection).toMatchObject({ verdict: 'accepted', warnings: [warning?.trim()] });
    }
  });

  it('adds no bypass warning to a refused protection: the refusal already blocks', async () => {
    const result = await doctor([], [], pullRequest('always'));
    expect(result.code).toBe(1);
    expect(result.text).not.toContain('bypass actors not read');
    expect(result.text).not.toContain('Check by hand what the warning');
  });

  it('puts the protection in the JSON report', async () => {
    const result = await doctor([], [], { json: true, ...protection({ rules: ['deletion'] }) });
    const report = JSON.parse(result.text) as { accepted: boolean; branchProtection: { branch: string; verdict: string } };
    expect(report.accepted).toBe(false);
    expect(report.branchProtection).toMatchObject({ branch: 'main', verdict: 'refused' });
  });
});

describe("the GitHub App's installation permissions (ORC-439, ORC-441, ORC-443)", () => {
  /** How the warning about permissions above the manifest starts (ORC-443). */
  const EXCESS_WARNING = '  Warning: the App is installed with permissions the manifest does not ask for';

  it.each([
    ['administration', 'write', 'Administration'],
    ['administration', 'read', 'Administration'],
    // Organization rulesets: edited with the organization's Administration.
    ['organization_administration', 'write', 'Organization permissions → Administration'],
  ])('refuses an installation holding %s (%s), and says how to remove it', async (permission, level, named) => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, [permission]: level } } });
    expect(result.code).toBe(1);
    const line = result.lines.find((l) => l.startsWith('GitHub App installation: refused'));
    expect(line).toContain(`${permission} (${level})`);
    expect(line).toContain(named);
    for (const named of ['Permissions & events', 'Administration', 'No access', 'Installed GitHub Apps']) expect(line).toContain(named);
    expect(result.text).toContain('Result: refused — the GitHub App is installed with the Administration permission');
    const json = JSON.parse((await doctor([], [], { json: true, fake: { permissions: { [permission]: level } } })).text) as { accepted: boolean; installation: { verdict: string } };
    expect(json).toMatchObject({ accepted: false, installation: { verdict: 'refused', permissions: { [permission]: level } } });
  });

  it('accepts an installation holding what the manifest asks for, and no more, without a warning', async () => {
    const result = await doctor([], []);
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.startsWith('  Warning: the App is installed'))).toBe(false);
    expect(result.text).toContain('GitHub App installation: accepted — installed without the Administration, Workflows or Actions (write) permission');
    const json = JSON.parse((await doctor([], [], { json: true })).text) as { installation: object };
    expect(json.installation).toEqual({ permissions: MANIFEST_PERMISSIONS, verdict: 'accepted', reasons: ['installed without the Administration, Workflows or Actions (write) permission'] });
  });

  it('warns, never refuses, when the installation cannot be read (network, authentication), and tells it unchecked', async () => {
    const result = await doctor([], [], { fake: { failInstallation: 'network' } });
    expect(result.code).toBe(0);
    expect(result.text).toContain('GitHub App installation: unchecked');
    const warning = result.lines.find((l) => l.startsWith("  Warning: the App's installation permissions not read"));
    expect(warning).toContain('getaddrinfo ENOTFOUND api.github.com');
    expect(warning).toContain('Administration');
    expect(result.text).toContain('Result: accepted');
    expect(result.text).not.toContain('installed without the Administration, Workflows or Actions (write) permission');
    const json = JSON.parse((await doctor([], [], { json: true, fake: { failInstallation: 'network' } })).text) as { accepted: boolean; installation: { verdict: string; warnings: string[] } };
    expect(json).toMatchObject({ accepted: true, installation: { verdict: 'unchecked', warnings: [warning?.trim()] } });
  });

  it('refuses an answer it cannot read: never taken for an installation without Administration (ORC-273)', async () => {
    const result = await doctor([], [], { fake: { failInstallation: 'unreadable' } });
    expect(result.code).toBe(1);
    expect(result.text).toContain('GitHub App installation: refused — Cannot read the installation\'s permissions: GitHub API GET /repos/acme/app/installation: unreadable answer');
    expect(result.text).toContain("Result: refused — the GitHub App installation's permissions cannot be read");
  });

  // With Workflows, the App could push a workflow that exposes the secrets after doctor read the workflows (ORC-441).
  it.each(['write', 'read'])('refuses an installation holding workflows (%s), and says how to remove it', async (level) => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, workflows: level } } });
    expect(result.code).toBe(1);
    const line = result.lines.find((l) => l.startsWith('GitHub App installation: refused'));
    expect(line).toContain(`workflows (${level})`);
    for (const named of ['secrets', 'Permissions & events', 'Repository permissions → Workflows', 'No access', 'Installed GitHub Apps']) expect(line).toContain(named);
    expect(line).not.toContain('Administration');
    expect(result.text).toContain('Result: refused — the GitHub App is installed with the Workflows permission');
    const json = JSON.parse((await doctor([], [], { json: true, fake: { permissions: { workflows: level } } })).text) as { accepted: boolean; installation: { verdict: string } };
    expect(json).toMatchObject({ accepted: false, installation: { verdict: 'refused', permissions: { workflows: level } } });
  });

  it('refuses an installation holding both Administration and Workflows, and names both', async () => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, administration: 'write', workflows: 'write' } } });
    expect(result.code).toBe(1);
    const line = result.lines.find((l) => l.startsWith('GitHub App installation: refused'));
    for (const named of ['administration (write)', 'workflows (write)']) expect(line).toContain(named);
    expect(result.text).toContain('Result: refused — the GitHub App is installed with the Administration and Workflows permissions');
  });

  // With Actions at write, the daemon could dispatch a workflow with secrets on a branch it pushed (ORC-443).
  it('refuses an installation holding actions: write, and says to set it back to read-only (ORC-443)', async () => {
    const permissions = { ...MANIFEST_PERMISSIONS, actions: 'write' };
    const result = await doctor([], [], { fake: { permissions } });
    expect(result.code).toBe(1);
    const line = result.lines.find((l) => l.startsWith('GitHub App installation: refused'));
    expect(line).toContain('actions (write)');
    for (const named of ['dispatch', 'secrets', 'Repository permissions → Actions', 'Read-only', 'Installed GitHub Apps']) expect(line).toContain(named);
    expect(line).not.toContain('No access');
    expect(line).toContain('actions is Read-only');
    expect(result.text).toContain('Result: refused — the GitHub App is installed with the Actions (write) permission');
    const json = JSON.parse((await doctor([], [], { json: true, fake: { permissions } })).text) as { accepted: boolean; installation: object };
    expect(json).toMatchObject({ accepted: false, installation: { verdict: 'refused', permissions: { actions: 'write' } } });
    // Refused, not also warned.
    expect(json.installation).not.toHaveProperty('warnings');
  });

  it('warns about Organization Members above read', async () => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, members: 'write' } } });
    expect(result.lines.find((l) => l.startsWith(EXCESS_WARNING))).toContain('members (write, the manifest asks Read-only)');
  });

  it('refuses Actions and Workflows together, and names both', async () => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, actions: 'write', workflows: 'write' } } });
    expect(result.code).toBe(1);
    expect(result.text).toContain('Result: refused — the GitHub App is installed with the Workflows and Actions (write) permissions');
  });

  it.each([
    ['secrets', 'write'],
    ['environments', 'write'],
    ['repository_hooks', 'read'],
    // Above the manifest's level: as much in excess as a permission it leaves out.
    ['statuses', 'write'],
  ])('accepts an installation holding %s (%s), which the manifest does not ask for, with a warning naming it (ORC-443)', async (permission, level) => {
    const permissions = { ...MANIFEST_PERMISSIONS, [permission]: level };
    const result = await doctor([], [], { fake: { permissions } });
    expect(result.code).toBe(0);
    expect(result.text).toContain('GitHub App installation: accepted');
    const warning = result.lines.find((l) => l.startsWith(EXCESS_WARNING));
    expect(warning).toContain(`${permission} (${level}, `);
    for (const named of ['Permissions & events', 'docs/github-app-manifest.json', 'Installed GitHub Apps']) expect(warning).toContain(named);
    expect(result.text).toMatch(/Result: accepted — .*the one under the GitHub App installation/);
    const json = JSON.parse((await doctor([], [], { json: true, fake: { permissions } })).text) as { accepted: boolean };
    expect(json).toMatchObject({ accepted: true, installation: { verdict: 'accepted', warnings: [warning?.trim()] } });
  });

  it('names every permission in excess in one warning', async () => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, secrets: 'write', environments: 'read' } } });
    const warnings = result.lines.filter((l) => l.startsWith(EXCESS_WARNING));
    expect(warnings).toHaveLength(1);
    for (const named of ['secrets (write, ', 'environments (read, ']) expect(warnings[0]).toContain(named);
  });

  it('names the level each permission in excess goes back to', async () => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, statuses: 'write', secrets: 'write' } } });
    const warning = result.lines.find((l) => l.startsWith(EXCESS_WARNING));
    expect(warning).toContain('statuses (write, the manifest asks Read-only)');
    expect(warning).toContain('secrets (write, not in the manifest: No access)');
  });

  // docs/github.md asks for it when the dashboard is gated on an org or a team (ORC-399); above read, it warns.
  it('does not warn about a permission below the manifest, nor about Organization Members at read', async () => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, contents: 'read', members: 'read' } } });
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.startsWith('  Warning: the App is installed'))).toBe(false);
  });

  it('keeps the warning of a permission in excess beside a refusal, without naming the refused one in it', async () => {
    const result = await doctor([], [], { fake: { permissions: { ...MANIFEST_PERMISSIONS, secrets: 'write', workflows: 'write' } } });
    expect(result.code).toBe(1);
    const warning = result.lines.find((l) => l.startsWith(EXCESS_WARNING));
    expect(warning).toContain('secrets (write, ');
    expect(warning).not.toContain('workflows');
  });

  it('tells the installation beside the other verdicts when the workflows cannot be read', async () => {
    const result = await doctor([], [], { fake: { failWorkflows: true, permissions: { administration: 'write' } } });
    expect(result.code).toBe(1);
    expect(result.text).toContain('GitHub App installation: refused');
  });
});
