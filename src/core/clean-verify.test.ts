import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../adapters/exec.js';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import type { SandboxExecOptions, SandboxRequest } from '../adapters/sandbox/types.js';
import { BUNDLE_TARGET } from '../publish/extract.js';
import { runCleanVerify, verifyCommand, type CleanVerifyRequest } from './clean-verify.js';

const BRANCH = 'factory/orc-1-x';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Runs each command on the host, in the dir its sandbox has as `/work`: the fake isolates nothing, the isolation suite proves that part. */
class LocalSandboxes extends FakeSandboxProvider {
  private byId = new Map<string, SandboxRequest>();
  ran: { box: string; command: string; network: string; env: Record<string, string> }[] = [];
  /** A command this test decides the fate of, by its text. */
  answer?: (command: string, box: string) => ExecResult | undefined;
  hang?: (command: string) => boolean;

  override async create(req: SandboxRequest) {
    const s = await super.create(req);
    this.byId.set(s.id, req);
    return s;
  }

  override async exec(id: string, argv: readonly string[], opts?: SandboxExecOptions): Promise<ExecResult> {
    await super.exec(id, argv, opts);
    const req = this.byId.get(id)!;
    const bundle = req.mounts.find((m) => m.target === BUNDLE_TARGET)?.host;
    const args = argv.map((a) => (bundle ? a.replace(BUNDLE_TARGET, bundle) : a));
    // What a test sets as a command comes as the wrapper's last word; what the factory runs itself comes as it is.
    const wrapped = args[0] === 'bash' && args[1] === '-c';
    const shellCommand = wrapped ? args.at(-1)! : args[0] === 'timeout' ? args.at(-1)! : undefined;
    if (shellCommand) {
      if (this.hang?.(shellCommand)) return new Promise(() => {});
      this.ran.push({ box: req.runId, command: shellCommand, network: req.network, env: opts?.env ?? {} });
      const scripted = this.answer?.(shellCommand, req.runId);
      if (scripted) return scripted;
    } else if (args[0] === 'sh') {
      // The Yarn 1 step of the sealed setup: nothing to do here.
      return { stdout: '', stderr: '', code: 0 };
    }
    const p = shellCommand
      ? spawnSync('bash', ['-c', shellCommand], { cwd: req.workspacePath, encoding: 'utf8' })
      : spawnSync(args[0]!, args.slice(1), { cwd: req.workspacePath, encoding: 'utf8' });
    return { stdout: p.stdout, stderr: p.stderr, code: p.status ?? 1 };
  }
}

const identity = (repo: string) => {
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
};

const write = (repo: string, path: string, content: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

const commit = (repo: string, message: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
};

/** The forge's repository, its default branch holding `config`, and the agent's clone of it on its branch, one commit ahead. */
function setup(over: Partial<CleanVerifyRequest> = {}, config?: string) {
  const base = mkdtempSync(join(tmpdir(), 'factory-clean-'));
  const origin = join(base, 'origin');
  git(base, 'init', '-q', '-b', 'main', origin);
  identity(origin);
  write(origin, 'README.md', 'base\n');
  if (config) write(origin, '.factory/config.yml', config);
  commit(origin, 'base');
  const repo = join(base, 'agent');
  git(base, 'clone', '-q', origin, repo);
  identity(repo);
  git(repo, 'checkout', '-q', '-b', BRANCH);
  writeFileSync(join(repo, 'a.txt'), 'committed\n');
  commit(repo, 'work');
  const workDir = join(base, 'work');
  mkdirSync(workDir);
  const sandboxes = new LocalSandboxes();
  const logs: string[] = [];
  const req: CleanVerifyRequest = {
    sandboxes,
    runId: 'r1',
    ticketId: 'ORC-1',
    branch: BRANCH,
    worktree: repo,
    originUrl: origin,
    workDir,
    setup: [],
    commands: ['grep committed a.txt'],
    env: async () => ({}),
    log: (m) => logs.push(m),
    ...over,
  };
  return { base, origin, repo, workDir, sandboxes, req, logs };
}

describe('runCleanVerify', () => {
  it('runs the commands at network none, in a sandbox on a clone of the frozen SHA, not on the worktree', async () => {
    const { repo, sandboxes, req } = setup();
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, failures: [], sha: git(repo, 'rev-parse', BRANCH) });
    expect(res.tree).toBe(git(repo, 'rev-parse', `${BRANCH}^{tree}`));
    const box = sandboxes.created.find((c) => c.runId === 'r1-verify')!;
    expect(box).toMatchObject({ network: 'none', mounts: [] });
    expect(box.workspacePath).not.toBe(repo);
    expect(sandboxes.ran.map((r) => [r.box, r.command])).toEqual([['r1-verify', 'grep committed a.txt']]);
  });

  it('checks commits only: a file the agent left uncommitted is not in the clone', async () => {
    const { repo, sandboxes, req } = setup({ commands: ['test ! -e uncommitted.txt', 'grep committed a.txt'] });
    writeFileSync(join(repo, 'uncommitted.txt'), 'x');
    writeFileSync(join(repo, 'a.txt'), 'changed but not committed\n');
    const res = await runCleanVerify(req);
    expect(res.failures).toEqual([]);
    expect(sandboxes.ran).toHaveLength(2);
  });

  it('extracts in a sandbox of its own, the git dir read-only, at network none', async () => {
    const { sandboxes, req } = setup({ gitDir: '/repo/.git' });
    await runCleanVerify(req).catch(() => {});
    const box = sandboxes.created.find((c) => c.runId === 'r1-bundle')!;
    expect(box).toMatchObject({ network: 'none' });
    expect(box.mounts).toContainEqual({ host: '/repo/.git', target: '/repo/.git', readOnly: true });
    expect(box.mounts).toContainEqual(expect.objectContaining({ target: BUNDLE_TARGET, readOnly: false }));
  });

  it('runs the setup in its own sandbox, destroyed before the one of the commands opens, with no secret', async () => {
    const { sandboxes, req } = setup({ setup: ['touch made-by-setup'], commands: ['test -e made-by-setup'], env: async () => ({ A: '1' }) });
    const res = await runCleanVerify(req);
    expect(res.failures).toEqual([]);
    expect(sandboxes.created.map((c) => [c.runId, c.network])).toEqual([['r1-bundle', 'none'], ['r1-verify-setup', 'limited'], ['r1-verify', 'none']]);
    expect(sandboxes.ran.find((r) => r.box === 'r1-verify')!.env).toEqual({ A: '1' });
  });

  it('reports a failing command with its exit code and output, all commands run', async () => {
    const { req } = setup({ commands: ['echo one; exit 3', 'echo two; exit 4', 'true'] });
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => [f.command, f.exitCode, f.output.trim()])).toEqual([['echo one; exit 3', 3, 'one'], ['echo two; exit 4', 4, 'two']]);
  });

  it("a command over its cap fails with no exit code, as the host's did", async () => {
    const { sandboxes, req } = setup({ commands: ['slow'] });
    sandboxes.answer = () => ({ stdout: 'part', stderr: '', code: 124 });
    const res = await runCleanVerify(req);
    expect(res.failures).toEqual([{ command: 'slow', exitCode: null, output: 'part' }]);
  });

  it('a sandbox that no longer answers rejects: an infrastructure failure, its container destroyed', async () => {
    const { sandboxes, req } = setup({ commands: ['stuck'], deadlineMs: 20 });
    sandboxes.hang = (c) => c === 'stuck';
    await expect(runCleanVerify(req)).rejects.toThrow(/ne répond plus/);
    expect(sandboxes.active()).toEqual([]);
  });

  it('a sandbox that cannot start rejects, and nothing is left', async () => {
    const { workDir, sandboxes, req } = setup();
    sandboxes.create = async () => {
      throw new Error('engine down');
    };
    await expect(runCleanVerify(req)).rejects.toThrow(/engine down/);
    expect(existsSync(join(workDir, 'clone'))).toBe(false);
  });

  it('a setup that fails is an infrastructure failure, never a failure of the commands', async () => {
    const { sandboxes, req } = setup({ setup: ['false'] });
    await expect(runCleanVerify(req)).rejects.toThrow(/setup/);
    expect(sandboxes.ran.some((r) => r.box === 'r1-verify')).toBe(false);
  });

  it('a checkout the sandbox cannot make rejects', async () => {
    const { req } = setup();
    const sandboxes = req.sandboxes as LocalSandboxes;
    const exec = sandboxes.exec.bind(sandboxes);
    sandboxes.exec = async (id, argv, opts) => (argv.includes('checkout') ? { stdout: '', stderr: 'no space', code: 128 } : exec(id, argv, opts));
    await expect(runCleanVerify(req)).rejects.toThrow(/no space/);
  });

  it('a branch that does not exist rejects', async () => {
    const { req } = setup({ branch: 'factory/none' });
    await expect(runCleanVerify(req)).rejects.toThrow();
  });

  it('removes the clone and destroys every sandbox, on a verdict as on a failure', async () => {
    const { workDir, sandboxes, req } = setup({ commands: ['false'] });
    await runCleanVerify(req);
    expect(sandboxes.active()).toEqual([]);
    expect(existsSync(join(workDir, 'clone'))).toBe(false);
    expect(existsSync(join(workDir, 'bundle'))).toBe(false);
  });

  it('with no command, extracts all the same and opens no sandbox for them', async () => {
    const { repo, sandboxes, req } = setup({ commands: [] });
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, sha: git(repo, 'rev-parse', BRANCH) });
    expect(sandboxes.created.map((c) => c.runId)).toEqual(['r1-bundle']);
  });

  describe('.factory/config.yml, on the base branch', () => {
    const CONFIG = 'commands: { lint: "echo base-lint", test: "echo base-test" }\nsetup: "echo base-setup"\nenv: [REPO_VAR]\n';

    it('takes the commands and the setup of the base branch, in their order, over the workflow\'s', async () => {
      const { sandboxes, req } = setup({ commands: ['echo workflow'], setup: ['echo workflow-setup'] }, CONFIG);
      await runCleanVerify(req);
      const commands = sandboxes.ran.map((r) => r.command);
      expect(commands.at(-2)).toBe('echo base-lint');
      expect(commands.at(-1)).toBe('echo base-test');
      expect(commands).toContain('echo base-setup');
      expect(commands).not.toContain('echo workflow');
      expect(commands).not.toContain('echo workflow-setup');
    });

    it('ignores what the agent wrote in its own branch\'s config', async () => {
      const { repo, sandboxes, req } = setup({}, CONFIG);
      write(repo, '.factory/config.yml', 'commands: { test: "echo pwned-by-the-agent" }\n');
      commit(repo, 'the agent rewrites what judges it');
      await runCleanVerify(req);
      expect(sandboxes.ran.map((r) => r.command)).not.toContain('echo pwned-by-the-agent');
      expect(sandboxes.ran.map((r) => r.command)).toContain('echo base-test');
    });

    it('does not believe a ref the agent moved in the repository it can write', async () => {
      const { repo, sandboxes, req } = setup({}, CONFIG);
      write(repo, '.factory/config.yml', 'commands: { test: "echo pwned-by-the-ref" }\n');
      commit(repo, 'forged base');
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      await runCleanVerify(req);
      expect(sandboxes.ran.map((r) => r.command)).not.toContain('echo pwned-by-the-ref');
    });

    it('asks the variables of the repository from the base\'s config', async () => {
      const asked: string[][] = [];
      const { req } = setup({ env: async (config) => (asked.push(config.env), { REPO_VAR: 'v' }) }, CONFIG);
      await runCleanVerify(req);
      expect(asked).toEqual([['REPO_VAR']]);
    });

    it('with no commands in the base\'s config, keeps the workflow\'s', async () => {
      const { sandboxes, req } = setup({ commands: ['echo workflow'] }, 'env: [A]\n');
      await runCleanVerify(req);
      expect(sandboxes.ran.map((r) => r.command)).toEqual(['echo workflow']);
    });

    it('a config the base refuses is a breakdown, not the agent\'s to fix', async () => {
      const { req } = setup({}, 'checks: { disable: [all] }\n');
      await expect(runCleanVerify(req)).rejects.toThrow(/config\.yml refusé/);
    });

    it('an origin that does not answer is a breakdown', async () => {
      const { base, req } = setup({ originUrl: 'nowhere' });
      await expect(runCleanVerify({ ...req, originUrl: join(base, 'gone') })).rejects.toThrow();
    });
  });

  it('caps each command by a kill, and its output by the tail, keeping its exit code', () => {
    const argv = verifyCommand('npm test');
    expect(argv.slice(0, 2)).toEqual(['bash', '-c']);
    expect(argv[2]).toMatch(/timeout -k \d+ \d+ bash -lc "\$1" 2>&1 \| tail -c \d+; exit "\$\{PIPESTATUS\[0\]\}"/);
    expect(argv.at(-1)).toBe('npm test');
  });
});
