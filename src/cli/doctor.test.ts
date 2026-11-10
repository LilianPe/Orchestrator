import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import type { EnvironmentProtection, WorkflowSource } from '../adapters/forge/github-app-api.js';
import type { HttpClient, HttpRequest } from '../adapters/forge/github-app.js';
import type { BranchNaming } from '../core/naming.js';
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

  async appLogin(): Promise<string> {
    return BOT;
  }
}

/** The factory's App as GitHub names the actor of its pushes and PRs. */
const BOT = 'factory-app[bot]';

function workflow(content: string, path = '.github/workflows/ci.yml'): WorkflowSource {
  return { path, content };
}

async function doctor(
  workflows: WorkflowSource[],
  environments: EnvironmentProtection[] = [],
  options: { json?: boolean; fake?: FakeOptions; naming?: BranchNaming } = {},
): Promise<{ code: number; lines: string[]; text: string; api: FakeApi }> {
  const api = new FakeApi(workflows, environments, options.fake);
  const lines: string[] = [];
  const code = await runDoctor({
    repoPath: '/repo',
    api,
    out: (line) => lines.push(line),
    ...(options.json ? { json: true } : {}),
    ...(options.naming ? { naming: options.naming } : {}),
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
    expect(result.text).toContain('protected: yes');
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
      (url) => (url.pathname === '/app' ? { body: { slug: 'factory-app' } } : undefined),
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
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('verdict: accepted');
    expect(gitCalls.some((a) => a.includes('fetch'))).toBe(false);
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

  describe("the factory's App excluded by its actor (ORC-283)", () => {
    const guarded = (condition: string, trigger = 'pull_request'): string => `on: ${trigger}
permissions: read-all
jobs:
  test:
    if: ${JSON.stringify(condition)}
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`;

    it("accepts a job with secrets whose `if:` keeps the factory's App out, as an expression or bare, beside other conditions", async () => {
      for (const condition of [
        `github.actor != '${BOT}'`,
        `\${{ github.actor != '${BOT}' }}`,
        `github.event_name == 'push' && github.actor != '${BOT}'`,
        `(github.actor != 'Factory-App[bot]') && (always() || failure())`,
        `'${BOT}' != github.actor`,
      ]) {
        const result = await doctor([workflow(guarded(condition))]);
        expect(result.code, condition).toBe(0);
        expect(result.text).toContain("exclude the factory's App");
      }
      expect((await doctor([workflow(guarded(`github.actor != '${BOT}'`, 'push'))])).code).toBe(0);
    });

    it('lists the jobs it excludes in the JSON report', async () => {
      const result = await doctor([workflow(guarded(`github.actor != '${BOT}'`))], [], { json: true });
      const report = JSON.parse(result.text) as { workflows: { actorExcluded: string[] }[] };
      expect(report.workflows[0]!.actorExcluded).toEqual(['test']);
    });

    it('refuses a condition that can still let the App in, or names another actor', async () => {
      for (const condition of [
        `github.actor != '${BOT}' || github.event_name == 'push'`,
        `github.actor == '${BOT}'`,
        `github.actor != 'someone-else[bot]'`,
        `github.triggering_actor != '${BOT}'`,
        `!(github.actor == '${BOT}')`,
        `\${{ github.actor != '${BOT}' }} && true`,
      ]) {
        const result = await doctor([workflow(guarded(condition))]);
        expect(result.code, condition).toBe(1);
        expect(result.text).toContain(`if: github.actor != '${BOT}'`);
      }
    });

    it('refuses when one job with secrets has no such condition, or has it on a step only', async () => {
      const two = `on: pull_request
permissions: read-all
jobs:
  test:
    if: github.actor != '${BOT}'
    steps:
      - run: echo "\${{ secrets.NPM_TOKEN }}"
  deploy:
    steps:
      - if: github.actor != '${BOT}'
        run: echo "\${{ secrets.DEPLOY_KEY }}"
`;
      const result = await doctor([workflow(two)]);
      expect(result.code).toBe(1);
      expect(result.text).toContain('job(s) without an environment: deploy');
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
});
