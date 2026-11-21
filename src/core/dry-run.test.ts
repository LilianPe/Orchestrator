import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execCmd, type Exec, type ExecResult } from '../adapters/exec.js';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import type { SandboxExecOptions, SandboxRequest } from '../adapters/sandbox/types.js';
import type { CommandRun } from '../checks/flaky.js';
import { VERIFY_TIMEOUT_MS } from './verify.js';
import { breaksOfRuns, classifyBreak, dryRunFingerprint, dryRunHolds, dryRunRefusal, runDryRun, unreachable, type DryRun, type DryRunRequest } from './dry-run.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Runs each command on the host, in the dir its sandbox has as `/work`: the fake isolates nothing, the isolation suite proves that part. */
class LocalSandboxes extends FakeSandboxProvider {
  private byId = new Map<string, SandboxRequest>();
  ran: { box: string; command: string; network: string; env: Record<string, string> }[] = [];
  answer?: (command: string, box: string) => ExecResult | undefined;

  override async create(req: SandboxRequest) {
    const s = await super.create(req);
    this.byId.set(s.id, req);
    return s;
  }

  override async exec(id: string, argv: readonly string[], opts?: SandboxExecOptions): Promise<ExecResult> {
    await super.exec(id, argv, opts);
    const req = this.byId.get(id)!;
    const wrapped = argv[0] === 'bash' && argv[1] === '--norc' && argv[2] === '-c';
    const shellCommand = wrapped ? argv.at(-1)! : undefined;
    if (shellCommand) {
      this.ran.push({ box: req.runId, command: shellCommand, network: req.network, env: opts?.env ?? {} });
      const scripted = this.answer?.(shellCommand, req.runId);
      if (scripted) return scripted;
    } else if (argv[0] === 'sh') {
      return { stdout: '', stderr: '', code: 0 };
    }
    const p = shellCommand ? spawnSync('bash', ['-c', shellCommand], { cwd: req.workspacePath, encoding: 'utf8', env: { ...process.env, ...opts?.env } }) : spawnSync(argv[0]!, argv.slice(1), { cwd: req.workspacePath, encoding: 'utf8' });
    return { stdout: p.stdout, stderr: p.stderr, code: p.status ?? 1 };
  }
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (repo: string, path: string, content: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

const commit = (repo: string, files: Record<string, string>, message: string): string => {
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

const CONFIG = 'setup: npm ci\ncommands:\n  test: grep green state.txt\n';

/** The forge's repository, its default branch green; a work dir of the daemon's, empty. */
function forge(over: Partial<DryRunRequest> = {}, files: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'factory-dry-'));
  dirs.push(base);
  const origin = join(base, 'origin');
  git(base, 'init', '-q', '-b', 'main', origin);
  git(origin, 'config', 'user.email', 't@t');
  git(origin, 'config', 'user.name', 't');
  const head = commit(origin, { '.factory/config.yml': CONFIG, 'state.txt': 'green\n', 'package-lock.json': '{"lockfileVersion":3}\n', ...files }, 'base');
  const workDir = join(base, 'work');
  mkdirSync(workDir);
  const sandboxes = new LocalSandboxes();
  // `npm ci` is the repository's setup: the host has none to run here.
  sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: 'added 0 packages\n', stderr: '', code: 0 } : undefined);
  const logs: string[] = [];
  const req: DryRunRequest = {
    sandboxes,
    runId: 'dry-1',
    projectId: 'p1',
    originUrl: origin,
    workDir,
    setup: [],
    commands: [],
    image: 'ghcr.io/factory/runner@sha256:aaa',
    env: async () => ({}),
    now: () => 1_000,
    log: (m) => logs.push(m),
    ...over,
  };
  return { base, origin, head, sandboxes, req, logs };
}

describe('runDryRun (ORC-408)', () => {
  it('criterion 1: a green default branch is recorded green, with the fingerprint of its setup, image and lockfile', async () => {
    const { req, head, origin, sandboxes } = forge();
    const run = await runDryRun(req);
    expect(run).toMatchObject({ id: 'dry-1', projectId: 'p1', sha: head, target: 'main', ok: true, breaks: [], commands: ['grep green state.txt'], startedAt: 1_000, endedAt: 1_000 });
    expect(run.fingerprint).toEqual({
      setup: expect.stringMatching(/^[0-9a-f]{64}$/),
      image: 'ghcr.io/factory/runner@sha256:aaa',
      lockfiles: { 'package-lock.json': git(origin, 'rev-parse', `${head}:package-lock.json`) },
      config: git(origin, 'rev-parse', `${head}:.factory/config.yml`),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The setup at N2 (`limited`: the registries the proxy allows), sealed; the commands at `none`.
    expect(sandboxes.ran.map((r) => [r.command, r.network])).toEqual([['npm ci', 'limited'], ['grep green state.txt', 'none']]);
    expect(sandboxes.ran[0]!.env).toMatchObject({ npm_config_ignore_scripts: 'true' });
    expect(sandboxes.active()).toEqual([]);
  });

  it('criterion 2: a setup that fails on a missing dependency is recorded red, and the report names it', async () => {
    const { req, sandboxes } = forge();
    sandboxes.answer = (command) =>
      command === 'npm ci' ? { stdout: '', stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for left-pad@9.9.9.\n', code: 1 } : undefined;
    const run = await runDryRun(req);
    expect(run.ok).toBe(false);
    expect(run.breaks).toEqual([{ kind: 'dependency', step: 'setup', command: 'npm ci', detail: expect.stringContaining('left-pad@9.9.9'), output: expect.stringContaining('ETARGET') }]);
    // Nothing runs on a commit that could not be set up, and none is recorded as run.
    expect(sandboxes.ran.map((r) => r.command)).toEqual(['npm ci']);
    expect(run.commands).toEqual([]);
    expect(sandboxes.active()).toEqual([]);
  });

  it('criterion 3: on a given commit, it runs that commit instead of the default branch', async () => {
    const { req, head, origin } = forge();
    commit(origin, { 'state.txt': 'red\n' }, 'main moved on');
    const run = await runDryRun({ ...req, sha: head });
    expect(run).toMatchObject({ sha: head, target: 'commit', ok: true });
    const workDir = mkdtempSync(join(tmpdir(), 'factory-dry-w-'));
    dirs.push(workDir);
    const onMain = await runDryRun({ ...req, runId: 'dry-2', workDir });
    expect(onMain).toMatchObject({ sha: git(origin, 'rev-parse', 'HEAD'), target: 'main', ok: false });
    expect(onMain.breaks).toEqual([expect.objectContaining({ kind: 'failure', step: 'command', command: 'grep green state.txt' })]);
  });

  it('criterion 3: a commit off the default branch is fetched by its sha', async () => {
    const { req, origin } = forge();
    git(origin, 'checkout', '-q', '-b', 'side');
    const side = commit(origin, { 'state.txt': 'green, on a side branch\n' }, 'side');
    git(origin, 'checkout', '-q', 'main');
    // Off every branch the forge has: only a fetch by its id brings it.
    git(origin, 'branch', '-q', '-D', 'side');
    const run = await runDryRun({ ...req, sha: side });
    expect(run).toMatchObject({ sha: side, target: 'commit', ok: true });
  });

  it('the host git\'s config stays out of the commit\'s working tree: a repository that tracks a `gitconfig` at its root is set up as any other', async () => {
    const { req } = forge({}, { gitconfig: '[core]\n', '.factory/config.yml': 'setup: npm ci\ncommands:\n  test: grep green state.txt && s=$(git status --porcelain) && test -z "$s"\n' });
    expect(await runDryRun(req)).toMatchObject({ ok: true, breaks: [] });
  });

  it('a sha that is not a full commit id is refused before anything is fetched', async () => {
    const { req, sandboxes } = forge();
    for (const sha of ['main', 'abc1234', 'a:b']) await expect(runDryRun({ ...req, sha })).rejects.toThrow('a full commit sha expected');
    expect(sandboxes.created).toEqual([]);
  });

  it('a setup that cannot reach a registry or the egress proxy rejects: a breakdown is not the repository\'s state', async () => {
    const { req, sandboxes } = forge();
    sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: '', stderr: 'npm error code ECONNREFUSED\nnpm error FetchError: request to https://registry.npmjs.org/zod failed, reason: connect ECONNREFUSED 127.0.0.1:3128\n', code: 1 } : undefined);
    await expect(runDryRun(req)).rejects.toThrow('no dry run recorded');
    expect(sandboxes.active()).toEqual([]);
  });

  it('a registry pip cannot reach, before it finds no version, rejects: the dependency it names is not missing', async () => {
    const { req, sandboxes } = forge();
    sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: '', stderr: "WARNING: Retrying after connection broken by 'NewConnectionError: Failed to establish a new connection: [Errno 111] Connection refused'\nERROR: Could not find a version that satisfies the requirement httpx\n", code: 1 } : undefined);
    await expect(runDryRun(req)).rejects.toThrow('no dry run recorded');
  });

  it('a setup cut by its cap while a registry did not answer rejects, as any registry breakdown', async () => {
    const { req, sandboxes } = forge();
    const now = Date.now();
    sandboxes.answer = (command) => {
      if (command !== 'npm ci') return undefined;
      // Past the cap on the factory's clock: the exit is the cap's (`cappedExit`).
      vi.spyOn(Date, 'now').mockReturnValue(now + 2 * VERIFY_TIMEOUT_MS);
      return { stdout: '', stderr: 'npm error code ESOCKETTIMEDOUT\n', code: 124 };
    };
    await expect(runDryRun(req)).rejects.toThrow('no dry run recorded');
  });

  it.each([
    ['pip, past its ProxyError', "WARNING: Retrying (Retry(total=4)) after connection broken by 'ProxyError('Cannot connect to proxy.', NewConnectionError('Failed to establish a new connection: [Errno 111] Connection refused'))'\nERROR: No matching distribution found for requests\n"],
    ['the proxy\'s 502 on a host it could not resolve', 'curl: (22) The requested URL returned error: 502\negress proxy: getaddrinfo ENOTFOUND get.pnpm.io\n'],
    ['the proxy\'s 502 on a request it could not send', 'egress proxy: not sent on: Invalid character in header content\n'],
    ['the proxy down, as npm and git say it', 'npm error connect ECONNREFUSED 127.0.0.1:3128\nfatal: unable to access \'https://github.com/acme/sub.git/\': Failed to connect to 127.0.0.1 port 3128 after 0 ms: Could not connect to server\n'],
  ])('a breakdown the installer reports as something else still rejects: %s', async (_, stderr) => {
    const { req, sandboxes } = forge();
    sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: '', stderr, code: 1 } : undefined);
    await expect(runDryRun(req)).rejects.toThrow('no dry run recorded');
  });

  it('a variable the setup asks for is the repository\'s, past a retry an installer warned of: recorded red, as a variable', async () => {
    const { req, sandboxes } = forge();
    const stderr = "WARNING: Retrying (Retry(total=4)) after connection broken by 'ProxyError('Cannot connect to proxy.')'\nError: STRIPE_KEY is not set\n";
    sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: '', stderr, code: 1 } : undefined);
    expect((await runDryRun(req)).breaks).toEqual([expect.objectContaining({ kind: 'variable', step: 'setup' })]);
  });

  it.each([
    ['a host the proxy refuses a CONNECT to, as curl says it', 'curl: (56) CONNECT tunnel failed, response 403\n'],
    ['a host the proxy refuses a CONNECT to, as git says it', 'fatal: unable to access \'https://get.example.com/\': Received HTTP code 403 from proxy after CONNECT\n'],
    ['the relay\'s address printed by a setup that then fails', 'HTTPS_PROXY=http://127.0.0.1:3128\nnpm error 404 Not Found - GET https://registry.npmjs.org/left-pad\n'],
  ])('what names the proxy without a breakdown is the repository\'s: recorded red, %s', async (_, stderr) => {
    const { req, sandboxes } = forge();
    sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: '', stderr, code: 1 } : undefined);
    expect((await runDryRun(req)).ok).toBe(false);
  });

  it('a setup over its cap on a registry that no longer answers rejects too', async () => {
    const { req, sandboxes } = forge();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sandboxes.answer = (command) => {
      if (command !== 'npm ci') return undefined;
      now += VERIFY_TIMEOUT_MS;
      return { stdout: '', stderr: 'npm error code ETIMEDOUT\n', code: 124 };
    };
    await expect(runDryRun(req)).rejects.toThrow('no dry run recorded');
  });

  it('a service of its own refusing on the loopback in the setup is the repository\'s: recorded red, as a service', async () => {
    const { req, sandboxes } = forge();
    // As Node prints it: the address on the first line only.
    sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: '', stderr: "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16) {\n  errno: -111,\n  code: 'ECONNREFUSED',\n  syscall: 'connect',\n  address: '127.0.0.1',\n  port: 5432\n}\n", code: 1 } : undefined);
    expect((await runDryRun(req)).breaks).toEqual([expect.objectContaining({ kind: 'service', step: 'setup' })]);
  });

  it('a registry the egress proxy refuses is the repository\'s: recorded red, as a dependency', async () => {
    const { req, sandboxes } = forge();
    sandboxes.answer = (command) => (command === 'npm ci' ? { stdout: '', stderr: 'npm error 403 Forbidden - GET https://npm.acme.internal/left-pad\n', code: 1 } : undefined);
    const run = await runDryRun(req);
    expect(run.breaks).toEqual([expect.objectContaining({ kind: 'dependency', step: 'setup', detail: expect.stringContaining('egress proxy does not allow') })]);
  });

  it('a forge that no longer answers rejects at the dry run\'s deadline, not at git\'s', async () => {
    const { req } = forge();
    const exec: Exec = (cmd, args, opts) => (args.includes('fetch') ? new Promise(() => {}) : execCmd(cmd, args, opts));
    await expect(runDryRun({ ...req, exec, deadlineMs: 200 })).rejects.toThrow('the forge no longer responds');
  });

  it('a commit the forge does not hold rejects: no dry run is recorded on it', async () => {
    const { req } = forge();
    await expect(runDryRun({ ...req, sha: 'f'.repeat(40) })).rejects.toThrow(/f{12}/);
  });

  it('a service the commit declares that no sandbox provides is recorded red, before any setup', async () => {
    const { req, sandboxes } = forge({}, { '.factory/config.yml': `${CONFIG}services: [postgres]\n` });
    sandboxes.provides = [];
    const run = await runDryRun(req);
    expect(run.ok).toBe(false);
    expect(run.breaks).toEqual([expect.objectContaining({ kind: 'service', step: 'config', detail: expect.stringContaining('postgres') })]);
    expect(run.commands).toEqual([]);
    expect(sandboxes.ran).toEqual([]);
  });

  it('a .factory/config.yml refused at the commit is recorded red, as a failure of its config', async () => {
    const { req, sandboxes } = forge({}, { '.factory/config.yml': 'nope: 1\n' });
    const run = await runDryRun(req);
    expect(run).toMatchObject({ ok: false, breaks: [expect.objectContaining({ kind: 'failure', step: 'config', detail: expect.stringContaining('nope') })] });
    expect(sandboxes.ran).toEqual([]);
  });

  it('a variable the repository declares that factory.yml gives no value is recorded red as a variable, its cause named', async () => {
    const { req } = forge({}, { '.factory/config.yml': 'env: [API_URL]\ncommands:\n  test: test -n "$API_URL" || { echo API_URL is not set; exit 1; }\n' });
    const run = await runDryRun(req);
    expect(run.breaks).toEqual([expect.objectContaining({ kind: 'variable', step: 'command', detail: expect.stringContaining('gives no value (API_URL)') })]);
  });

  it('without a setup or commands of its own, it takes the workflow\'s, and the variables the repository declares', async () => {
    const { req, sandboxes } = forge({ setup: ['true'], commands: ['test -n "$API_URL"'], env: async () => ({ API_URL: 'http://x' }) }, { '.factory/config.yml': 'env: [API_URL]\n' });
    const run = await runDryRun(req);
    expect(run.ok).toBe(true);
    expect(sandboxes.ran.map((r) => r.command)).toEqual(['true', 'test -n "$API_URL"']);
    expect(sandboxes.ran[1]!.env).toMatchObject({ API_URL: 'http://x' });
  });
});

describe('dryRunFingerprint', () => {
  const base = { setup: ['npm ci'], image: 'img@sha256:1', lockfiles: { 'package-lock.json': 'b1' }, config: 'c1' as string | null };
  it('changes with the setup, the image, a lockfile or .factory/config.yml, and only with them', () => {
    const fp = dryRunFingerprint(base);
    expect(dryRunFingerprint({ ...base })).toEqual(fp);
    expect(dryRunFingerprint({ ...base, setup: ['npm ci --legacy-peer-deps'] }).hash).not.toBe(fp.hash);
    expect(dryRunFingerprint({ ...base, image: 'img@sha256:2' }).hash).not.toBe(fp.hash);
    expect(dryRunFingerprint({ ...base, lockfiles: { 'package-lock.json': 'b2' } }).hash).not.toBe(fp.hash);
    expect(dryRunFingerprint({ ...base, lockfiles: { ...base.lockfiles, 'uv.lock': 'u1' } }).hash).not.toBe(fp.hash);
    // ORC-409: a red dry run fixed in the config runs again.
    expect(dryRunFingerprint({ ...base, config: 'c2' }).hash).not.toBe(fp.hash);
    expect(dryRunFingerprint({ ...base, config: null }).hash).not.toBe(fp.hash);
  });
});

describe('the fingerprint of a dry run (ORC-409)', () => {
  it('reads every lockfile at the root as max_diff knows them, deno.lock and pylock.<name>.toml included, and the blob of .factory/config.yml', async () => {
    const { req, head, origin } = forge({}, { 'deno.lock': '{}\n', 'pylock.dev.toml': 'lock-version = "1.0"\n', 'web/yarn.lock': '# not at the root\n' });
    const run = await runDryRun(req);
    const blob = (path: string) => git(origin, 'rev-parse', `${head}:${path}`);
    expect(run.fingerprint.lockfiles).toEqual({ 'deno.lock': blob('deno.lock'), 'package-lock.json': blob('package-lock.json'), 'pylock.dev.toml': blob('pylock.dev.toml') });
    expect(run.fingerprint.config).toBe(blob('.factory/config.yml'));
  });

  it('a .factory/config.yml refused still has its blob in the fingerprint: fixing it runs the dry run again', async () => {
    const { req, head, origin } = forge({}, { '.factory/config.yml': 'setup: [\n' });
    const run = await runDryRun(req);
    expect(run.breaks).toMatchObject([{ step: 'config' }]);
    expect(run.fingerprint.config).toBe(git(origin, 'rev-parse', `${head}:.factory/config.yml`));
  });

  it('without .factory/config.yml, its part is null', async () => {
    const { req, origin } = forge();
    git(origin, 'rm', '-q', '.factory/config.yml');
    git(origin, 'commit', '-q', '-m', 'no config');
    expect((await runDryRun(req)).fingerprint.config).toBeNull();
  });
});

describe('dryRunHolds (ORC-409)', () => {
  const fingerprint = dryRunFingerprint({ setup: [], image: 'img', lockfiles: {}, config: null });
  const other = dryRunFingerprint({ setup: [], image: 'img', lockfiles: { 'uv.lock': 'u' }, config: null });
  const run = (ok: boolean, sha = 'a'.repeat(40)): DryRun => ({ id: 'd', projectId: 'p', sha, target: 'main', ok, fingerprint, breaks: [], commands: [], startedAt: 0, endedAt: 0 });
  it('a green one holds on the same inputs, wherever the branch went; a red one on the same commit only', () => {
    expect(dryRunHolds(run(true), { sha: 'b'.repeat(40), fingerprint })).toBe(true);
    expect(dryRunHolds(run(false), { sha: 'a'.repeat(40), fingerprint })).toBe(true);
    expect(dryRunHolds(run(false), { sha: 'b'.repeat(40), fingerprint })).toBe(false);
  });
  it('none holds once an input changed', () => {
    expect(dryRunHolds(run(true), { sha: 'a'.repeat(40), fingerprint: other })).toBe(false);
    expect(dryRunHolds(run(false), { sha: 'a'.repeat(40), fingerprint: other })).toBe(false);
  });
});

describe('dryRunRefusal (ORC-409)', () => {
  it('says what breaks, each break with its step, command and cause, and how the dry run runs again', () => {
    const run: DryRun = {
      id: 'd', projectId: 'app', sha: 'c'.repeat(40), target: 'main', ok: false, fingerprint: dryRunFingerprint({ setup: [], image: 'img', lockfiles: {}, config: null }), commands: [], startedAt: 0, endedAt: 0,
      breaks: [
        { kind: 'variable', step: 'command', command: 'npm test', detail: 'a variable the repository does not declare under `env`: Missing environment variable: STRIPE_KEY', output: '' },
        { kind: 'flaky', step: 'command', command: 'npm test', detail: 'a.test.ts > races failed, then passed on its rerun', output: '' },
      ],
    };
    const r = dryRunRefusal(run);
    expect(r.reason).toBe(`The dry run of the repository is red on its default branch (${'c'.repeat(12)}): variable in \`npm test\`, flaky in \`npm test\`. No ticket of the repository starts until it is green.`);
    expect(r.tried).toEqual([
      "The dry run's command, `npm test`: variable, a variable the repository does not declare under `env`: Missing environment variable: STRIPE_KEY",
      "The dry run's command, `npm test`: flaky, a.test.ts > races failed, then passed on its rerun",
    ]);
    expect(r.question).toContain('`factory dry-run app`');
  });
});

describe('classifyBreak', () => {
  const declared = { env: ['DATABASE_URL', 'SENTRY_ENV'], provided: ['DATABASE_URL'], secrets: ['NPM_TOKEN'] };
  it.each([
    ['npm error code ETARGET\nnpm error notarget No matching version found for left-pad@9.9.9.', 'left-pad@9.9.9'],
    ['npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fnope - Not found', '404'],
    ['ERR_PNPM_NO_MATCHING_VERSION  No matching version found for zod@99.0.0', 'zod@99.0.0'],
    ['ERR_PNPM_NO_MATURE_MATCHING_VERSION  Version 4.1.0 of vite does not meet the minimumReleaseAge constraint', 'vite'],
    ['  × No solution found when resolving dependencies:\n  ╰─▶ Because there is no version of httpx==9.0 and you require httpx==9.0', 'httpx==9.0'],
    ['ERROR: No matching distribution found for requests==99.1', 'requests==99.1'],
    ["Error: Cannot find module 'lodash'\nRequire stack:", 'lodash'],
    ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@acme/ui' imported from /work/src/a.ts", '@acme/ui'],
    ["Error: Cannot find module '/work/node_modules/zod/index.js'", 'node_modules/zod'],
    ["ModuleNotFoundError: No module named 'yaml'", 'yaml'],
    ['npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.', 'in sync'],
  ])('a missing or too recent dependency: %s', (output, named) => {
    const b = classifyBreak(output, 'setup', declared);
    expect(b.kind).toBe('dependency');
    expect(b.detail).toContain(named);
  });

  it('a service that does not answer on the loopback', () => {
    expect(classifyBreak('Error: connect ECONNREFUSED 127.0.0.1:5432', 'command', declared)).toMatchObject({ kind: 'service', detail: expect.stringContaining('127.0.0.1:5432') });
    expect(classifyBreak('psql: error: could not connect to server: Connection refused\n\tIs the server running on host "localhost"', 'command', declared).kind).toBe('service');
  });

  it('a variable the code reads that the repository does not declare; a declared one is not that', () => {
    expect(classifyBreak('Error: Missing environment variable: STRIPE_KEY', 'command', declared)).toMatchObject({ kind: 'variable', detail: expect.stringContaining('STRIPE_KEY') });
    expect(classifyBreak("KeyError: 'SENTRY_DSN'", 'command', declared)).toMatchObject({ kind: 'variable', detail: expect.stringContaining('SENTRY_DSN') });
    expect(classifyBreak('Error: STRIPE_KEY is not set', 'command', declared).kind).toBe('variable');
    expect(classifyBreak('Error: DATABASE_URL is not set', 'command', declared).kind).toBe('failure');
  });

  it('each name of a line is read: one undeclared past a declared one is that line\'s cause', () => {
    expect(classifyBreak('Error: Missing environment variables: DATABASE_URL, STRIPE_KEY', 'command', declared)).toMatchObject({ kind: 'variable', detail: expect.stringContaining('does not declare under `env` (STRIPE_KEY)') });
    expect(classifyBreak('DATABASE_URL is not set, STRIPE_KEY is not set', 'command', declared)).toMatchObject({ kind: 'variable', detail: expect.stringContaining('(STRIPE_KEY)') });
    expect(classifyBreak('Error: Missing environment variables: DATABASE_URL', 'command', declared).kind).toBe('failure');
  });

  it('a secret the repository declares under setup_secrets is never said undeclared: no variable is read of it, in the setup or a command', () => {
    for (const step of ['setup', 'command'] as const) expect(classifyBreak('Error: NPM_TOKEN is not set', step, declared).kind).toBe('failure');
  });

  it('a variable the repository declares and factory.yml gives no value is said as such: the factory\'s config, not the code', () => {
    expect(classifyBreak('Error: Missing environment variable: SENTRY_ENV', 'command', declared)).toMatchObject({ kind: 'variable', detail: expect.stringContaining('`factory.yml` gives no value (SENTRY_ENV)') });
  });

  it('in a command\'s output, what only an installer means is not a dependency: the application\'s 404, a module of its own', () => {
    expect(classifyBreak('expected 200 "OK", got 404 "Not Found"', 'command', declared).kind).toBe('failure');
    expect(classifyBreak("Error: Cannot find module './dist/index.js'", 'command', declared).kind).toBe('failure');
    expect(classifyBreak("Error: Cannot find module '/work/build/app.js'", 'command', declared).kind).toBe('failure');
    expect(classifyBreak("Error: Cannot find module '@/lib/db'", 'command', declared).kind).toBe('failure');
    expect(classifyBreak("Error: Cannot find module '~/utils'", 'command', declared).kind).toBe('failure');
    expect(classifyBreak('npm error code ETARGET', 'command', declared).kind).toBe('failure');
    expect(classifyBreak('npm error 403 Forbidden - GET https://npm.acme.internal/x', 'command', declared).kind).toBe('failure');
  });

  it('a global that is not defined is no variable of the environment', () => {
    expect(classifyBreak('ReferenceError: URL is not defined', 'command', declared).kind).toBe('failure');
    expect(classifyBreak("error  'JSX' is not defined  no-undef", 'command', declared).kind).toBe('failure');
  });

  it('the egress proxy\'s relay on the loopback is no service; a registry that does not answer is said apart', () => {
    expect(classifyBreak('connect ECONNREFUSED 127.0.0.1:3128', 'setup', declared).kind).toBe('failure');
    expect(unreachable('connect ECONNREFUSED 127.0.0.1:3128')).toContain('3128');
    // The relay by its address: a 3128 that is no port (a pid, a duration) leaves a service a service.
    expect(classifyBreak('Error: connect ECONNREFUSED 127.0.0.1:5432 (after 3128 ms)', 'command', declared).kind).toBe('service');
    expect(unreachable('npm error code ETIMEDOUT')).toContain('ETIMEDOUT');
    expect(unreachable('npm error 502 Bad Gateway - GET https://registry.npmjs.org/zod')).toContain('502');
    expect(unreachable("Failed to establish a new connection: [Errno 111] Connection refused")).toContain('Errno 111');
    expect(unreachable('error: Request failed after 3 retries\n  Caused by: dns error: failed to lookup address information')).toContain('dns error');
    expect(unreachable('AssertionError: expected 1 to be 2')).toBeUndefined();
    expect(unreachable("Error: connect ECONNREFUSED 127.0.0.1:5432\n  code: 'ECONNREFUSED',")).toBeUndefined();
  });

  it('anything else is a failure, its first error line said', () => {
    expect(classifyBreak('ran 3 tests\nAssertionError: expected 1 to be 2\n', 'command', declared)).toMatchObject({ kind: 'failure', detail: expect.stringContaining('AssertionError') });
  });
});

describe('breaksOfRuns', () => {
  const run = (over: Partial<CommandRun>): CommandRun => ({ command: 'npm test', line: 'npm test', runner: 'vitest', exitCode: 1, output: 'FAIL a.test.ts', tests: [], notRerun: 0, ...over });
  const test = (name: string, rerun: 'passed' | 'failed') => ({
    command: 'npm test', test: `a.test.ts > ${name}`, file: 'a.test.ts', name,
    attempts: [{ on: 'head' as const, attempt: 1, outcome: 'failed' as const, output: '' }, { on: 'head' as const, attempt: 2, outcome: rerun, output: '' }],
  });

  it('a test that failed then passed on its rerun is flaky; a command that failed on it alone has no other break', () => {
    expect(breaksOfRuns([run({ tests: [test('races', 'passed')] })], { known: [] }, { env: [], provided: [], secrets: [] })).toEqual([
      { kind: 'flaky', step: 'command', command: 'npm test', detail: expect.stringContaining('a.test.ts > races'), output: 'FAIL a.test.ts' },
    ]);
  });

  it('a test that failed again is the command\'s failure, the flaky ones beside it', () => {
    const breaks = breaksOfRuns([run({ tests: [test('races', 'passed'), test('broken', 'failed')] })], { known: [] }, { env: [], provided: [], secrets: [] });
    expect(breaks.map((b) => b.kind)).toEqual(['flaky', 'failure']);
  });

  it('known flaky tests alone, but the command without them still not passing (cut by its cap), is the command\'s failure', () => {
    const known = { known: [{ test: 'a.test.ts > races', coversFrozen: false }] };
    expect(breaksOfRuns([run({ tests: [test('races', 'failed')], withoutIndicative: null })], known, { env: [], provided: [], secrets: [] }).map((b) => b.kind)).toEqual(['failure']);
    expect(breaksOfRuns([run({ tests: [test('races', 'failed')], withoutIndicative: 1 })], known, { env: [], provided: [], secrets: [] }).map((b) => b.kind)).toEqual(['failure']);
  });

  it('a known flaky test of the repository that alone failed the command is no break: it does not count', () => {
    expect(breaksOfRuns([run({ tests: [test('races', 'failed')], withoutIndicative: 0 })], { known: [{ test: 'a.test.ts > races', coversFrozen: false }] }, { env: [], provided: [], secrets: [] })).toEqual([]);
  });
});
