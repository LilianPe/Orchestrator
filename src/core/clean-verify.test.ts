import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeShooter } from '../adapters/browser/fake.js';
import type { ShootRequest, VisualShooter } from '../adapters/browser/types.js';
import { execCmd, type Exec, type ExecResult } from '../adapters/exec.js';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import type { SandboxExecOptions, SandboxProvider, SandboxRequest } from '../adapters/sandbox/types.js';
import { VISUAL_PROOF_CHECK } from '../checks/visual-proof.js';
import { BUNDLE_TARGET } from '../publish/extract.js';
import { OutputPolicy, type Capture } from '../publish/output-policy.js';
import { runCleanVerify, verifyCommand, type CleanVerifyRequest } from './clean-verify.js';

const BRANCH = 'factory/orc-1-x';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** A second check of the same run: its work dir emptied as the orchestrator's new one would be. */
const setupAgain = (req: CleanVerifyRequest): CleanVerifyRequest => {
  rmSync(join(req.workDir, 'gitconfig'), { force: true });
  return req;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Runs each command on the host, in the dir its sandbox has as `/work`: the fake isolates nothing, the isolation suite proves that part. */
class LocalSandboxes extends FakeSandboxProvider {
  private byId = new Map<string, SandboxRequest>();
  ran: { box: string; command: string; network: string; env: Record<string, string> }[] = [];
  /** A command this test decides the fate of, by its text. */
  answer?: (command: string, box: string) => ExecResult | undefined;
  hang?: (command: string) => boolean;
  scan?: (argv: readonly string[]) => ExecResult;

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
    if (args.includes('gitleaks')) return this.scan?.(args) ?? { stdout: '[]', stderr: '', code: 0 };
    // What a test sets as a command comes as the wrapper's last word; what the factory runs itself comes as it is.
    const wrapped = args[0] === 'bash' && args[1] === '--norc' && args[2] === '-c';
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
    gitleaks: false,
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

  it('extracts in a sandbox of its own, at network none, with only the place for the bundle beside the worktree', async () => {
    const { sandboxes, req } = setup();
    await runCleanVerify(req).catch(() => {});
    const box = sandboxes.created.find((c) => c.runId === 'r1-bundle')!;
    expect(box).toMatchObject({ network: 'none' });
    expect(box.mounts).toEqual([expect.objectContaining({ target: BUNDLE_TARGET, readOnly: false })]);
  });

  // Read once by process from the repository's config, which no agent writes any more: still, a URL of the agent's runs nothing.
  it('a forge at an ext:: URL runs nothing: the fetch reads no config of the repository that would allow it', async () => {
    const witness = join(mkdtempSync(join(tmpdir(), 'factory-ext-')), 'witness');
    const { req } = setup({ originUrl: `ext::sh -c touch% ${witness.replaceAll('\\', '/')}` });
    await expect(runCleanVerify(req)).rejects.toThrow(/base branch not read/);
    expect(existsSync(witness)).toBe(false);
  });

  it('runs the setup in its own sandbox, destroyed before the one of the commands opens, with no secret', async () => {
    const { sandboxes, req } = setup({ setup: ['touch made-by-setup'], commands: ['test -e made-by-setup'], env: async () => ({ A: '1' }) });
    const res = await runCleanVerify(req);
    expect(res.failures).toEqual([]);
    expect(sandboxes.created.map((c) => [c.runId, c.network])).toEqual([['r1-bundle', 'none'], ['r1-prepare', 'none'], ['r1-verify-setup', 'limited'], ['r1-verify', 'none']]);
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
    await expect(runCleanVerify(req)).rejects.toThrow(/no longer responds/);
    expect(sandboxes.active()).toEqual([]);
  });

  it('gives up on an engine whose destroy hangs too: the deadline does not wait for it', async () => {
    const { sandboxes, req } = setup({ commands: ['stuck'], deadlineMs: 20 });
    sandboxes.hang = (c) => c === 'stuck';
    const destroy = sandboxes.destroy.bind(sandboxes);
    let hanging = false;
    sandboxes.destroy = (id) => (hanging ? new Promise(() => {}) : destroy(id));
    const exec = sandboxes.exec.bind(sandboxes);
    sandboxes.exec = (id, argv, opts) => {
      if (argv.at(-1) === 'stuck') hanging = true;
      return exec(id, argv, opts);
    };
    await expect(runCleanVerify(req)).rejects.toThrow(/no longer responds/);
  });

  it('gives up on a forge that does not answer', async () => {
    const hung: Exec = (cmd, args, opts) => (args.includes('fetch') ? new Promise(() => {}) : execCmd(cmd, args, opts));
    const { req } = setup({ exec: hung, deadlineMs: 500 });
    await expect(runCleanVerify(req)).rejects.toThrow(/forge no longer responds/);
  });

  it('keeps the credentials of the URL out of what reaches the ticket', async () => {
    const url = 'https://x-access-token:s3cr3t-token@github.com/o/r';
    const failing: Exec = async (cmd, args, opts) => (args.includes('fetch') ? { stdout: '', stderr: `fatal: unable to access '${url}/': 503, and https://u:other-token@host/`, code: 128 } : execCmd(cmd, args, opts));
    const { req } = setup({ exec: failing, originUrl: url });
    const message = await runCleanVerify(req).then(() => '', (err: Error) => err.message);
    expect(message).toContain('503');
    expect(message).not.toContain('s3cr3t-token');
    expect(message).not.toContain('other-token');
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

    /** What the config read says, whatever the verdict: its `env`, asked of the caller before any check refuses the commit. */
    const readConfig = (over: Partial<CleanVerifyRequest>, config: string) => {
      const asked: string[][] = [];
      return { asked, ...setup({ ...over, env: async (c) => (asked.push(c.env), {}) }, config) };
    };

    it('ignores what the agent wrote in its own branch\'s config', async () => {
      const { asked, repo, sandboxes, req } = readConfig({}, CONFIG);
      write(repo, '.factory/config.yml', 'commands: { test: "echo pwned-by-the-agent" }\nenv: [PWNED]\n');
      commit(repo, 'the agent rewrites what judges it');
      await runCleanVerify(req);
      expect(asked).toEqual([['REPO_VAR']]);
      expect(sandboxes.ran.map((r) => r.command)).not.toContain('echo pwned-by-the-agent');
    });

    it('does not believe a ref the agent moved in the repository it can write', async () => {
      const { asked, repo, sandboxes, req } = readConfig({}, CONFIG);
      write(repo, '.factory/config.yml', 'commands: { test: "echo pwned-by-the-ref" }\nenv: [PWNED]\n');
      commit(repo, 'forged base');
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      await runCleanVerify(req);
      expect(asked).toEqual([['REPO_VAR']]);
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
      await expect(runCleanVerify(req)).rejects.toThrow(/config\.yml refused/);
    });

    it('an origin that does not answer is a breakdown', async () => {
      const { base, req } = setup({ originUrl: 'nowhere' });
      await expect(runCleanVerify({ ...req, originUrl: join(base, 'gone') })).rejects.toThrow();
    });
  });

  describe('the checks on the commit', () => {
    const CHANGE = 'commands: { test: "echo base-test" }\n';

    it('a change of .factory/config.yml keeps the base\'s commands, and blocks as a forbidden path', async () => {
      const { repo, sandboxes, req } = setup({}, CHANGE);
      write(repo, '.factory/config.yml', 'commands: { test: "echo pwned" }\n');
      commit(repo, 'the agent rewrites what judges it');
      const res = await runCleanVerify(req);
      expect(res.ok).toBe(false);
      expect(res.failures).toEqual([{ command: 'factory/chemins-interdits', exitCode: 1, output: expect.stringContaining('.factory/config.yml') }]);
      // Refused before anything of it runs: neither its commands nor the base's.
      expect(sandboxes.ran).toEqual([]);
      expect(sandboxes.created.map((c) => c.runId)).toEqual(['r1-bundle']);
    });

    it('a file under .github/workflows blocks', async () => {
      const { repo, req } = setup({ commands: [] });
      write(repo, '.github/workflows/ci.yml', 'on: push\n');
      commit(repo, 'x');
      expect((await runCleanVerify(req)).failures[0]).toMatchObject({ command: 'factory/chemins-interdits', output: expect.stringContaining('.github/workflows/ci.yml') });
    });

    it('CODEOWNERS and a setup action under .github block, trusted or not (ORC-338)', async () => {
      const { repo, req } = setup({ commands: [] });
      write(repo, 'CODEOWNERS', '* @someone\n');
      write(repo, '.github/actions/setup/action.yml', 'runs: { using: composite, steps: [] }\n');
      commit(repo, 'tidy CODEOWNERS and the setup action');
      const { output } = (await runCleanVerify(req)).failures[0]!;
      expect(output).toContain('CODEOWNERS');
      expect(output).toContain('.github/actions/setup/action.yml');
    });

    describe("the repository's sensitive_paths (ORC-338)", () => {
      const touchInfra = (over: Partial<CleanVerifyRequest>, config = 'sensitive_paths: ["infra/**"]\n') => {
        const s = setup({ commands: [], ...over }, config);
        write(s.repo, 'infra/main.tf', 'resource "x" "y" {}\n');
        commit(s.repo, 'infra');
        return s;
      };

      it('an untrusted branch that touches one is refused', async () => {
        const res = await runCleanVerify(touchInfra({ untrusted: { since: '', humanPushes: [] } }).req);
        expect(res.failures).toEqual([{ command: 'factory/chemins-interdits', exitCode: 1, output: expect.stringContaining('`infra/main.tf`: sensitive path of the repository (`infra/**`)') }]);
      });

      it('a trusted branch may touch it', async () => {
        expect((await runCleanVerify(touchInfra({}).req)).ok).toBe(true);
      });

      it('only what changed since the branch took untrusted content counts: a trusted commit before it stays the reviewer\'s', async () => {
        const { repo, req } = touchInfra({}, 'sensitive_paths: ["infra"]\n');
        const marked = { ...req, untrusted: { since: git(repo, 'rev-parse', 'HEAD'), humanPushes: [] } };
        write(repo, 'src/a.ts', 'x\n');
        commit(repo, 'untrusted work elsewhere');
        expect((await runCleanVerify(marked)).ok).toBe(true);
        write(repo, 'infra/vpc.tf', 'x\n');
        commit(repo, 'untrusted work on infra');
        const { output } = (await runCleanVerify(setupAgain(marked))).failures[0]!;
        expect(output).toContain('infra/vpc.tf');
        expect(output).not.toContain('infra/main.tf');
      });

      it('a mark that is no ancestor of the head (a rewritten history) reads the whole branch', async () => {
        const { req } = touchInfra({ untrusted: { since: '0123456789012345678901234567890123456789', humanPushes: [] } });
        expect((await runCleanVerify(req)).failures[0]!.output).toContain('infra/main.tf');
      });

      it('a merge of the base brings none of the base\'s own sensitive changes', async () => {
        const { origin, repo, req } = setup({ commands: [] }, 'sensitive_paths: ["infra"]\n');
        const marked = { ...req, untrusted: { since: git(repo, 'rev-parse', 'HEAD'), humanPushes: [] } };
        write(origin, 'infra/main.tf', 'base\n');
        commit(origin, 'a human changes infra on main');
        git(repo, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
        expect((await runCleanVerify(marked)).ok).toBe(true);
      });

      it('read on the base: a branch that drops the entry is refused all the same', async () => {
        const { repo, req } = touchInfra({ untrusted: { since: '', humanPushes: [] } });
        write(repo, '.factory/config.yml', 'sensitive_paths: []\n');
        commit(repo, 'drop it');
        expect((await runCleanVerify(req)).failures[0]!.output).toContain('infra/main.tf');
      });

      it('an entry that names nothing refuses an untrusted branch as a config failure, never a path left open', async () => {
        await expect(runCleanVerify(touchInfra({ untrusted: { since: '', humanPushes: [] } }, 'sensitive_paths: ["../infra/**"]\n').req)).rejects.toThrow(/sensitive_paths\[0\].*refused until it is fixed/);
      });

      it('and leaves a trusted branch alone: an old entry, valid before, blocks no ticket of the repository', async () => {
        expect((await runCleanVerify(touchInfra({}, 'sensitive_paths: ["../infra/**"]\n').req)).ok).toBe(true);
      });
    });

    it('package.json#scripts blocks, its dependencies do not', async () => {
      const { origin, repo, req } = setup({ commands: [] });
      const manifest = (o: object) => write(repo, 'package.json', JSON.stringify(o));
      manifest({ dependencies: { a: '1' } });
      commit(repo, 'deps');
      expect((await runCleanVerify(req)).ok).toBe(true);
      manifest({ dependencies: { a: '1' }, scripts: { test: 'true' } });
      commit(repo, 'scripts');
      void origin;
      const again = setupAgain(req);
      expect((await runCleanVerify(again)).failures[0]!.output).toContain('package.json#scripts');
    });

    it.skipIf(process.platform === 'win32')('an outward symbolic link blocks', async () => {
      const { repo, req } = setup({ commands: [] });
      symlinkSync('/etc/passwd', join(repo, 'link'));
      commit(repo, 'x');
      expect((await runCleanVerify(req)).failures[0]!.output).toContain('symbolic link pointing outside');
    });

    it('only what the branch changed since it left the base counts, not what the base got since', async () => {
      const { origin, req } = setup({ commands: [] });
      write(origin, '.github/workflows/ci.yml', 'on: push\n');
      commit(origin, 'the base moves on');
      expect((await runCleanVerify(req)).ok).toBe(true);
    });

    it('a branch that hides its past (no common commit) has all its files read as changes', async () => {
      const { repo, req } = setup({ commands: [] });
      git(repo, 'checkout', '-q', '--orphan', 'orphan');
      write(repo, '.github/workflows/ci.yml', 'on: push\n');
      commit(repo, 'no past');
      git(repo, 'branch', '-f', BRANCH, 'orphan');
      expect((await runCleanVerify(req)).failures[0]!.output).toContain('.github/workflows/ci.yml');
    });

    it('the freeze is read in the clone, a frozen test changed blocks, whatever the frozen commit became', async () => {
      const { repo, req } = setup({ commands: [], frozen: { sha: 'gone-after-a-rebase', files: { 'a.txt': sha256('committed\n') } } });
      expect((await runCleanVerify(req)).ok).toBe(true);
      write(repo, 'a.txt', 'changed\n');
      commit(repo, 'x');
      const res = await runCleanVerify(setupAgain(req));
      expect(res.failures[0]).toMatchObject({ command: 'factory/tests-gelés', output: expect.stringContaining('a.txt') });
    });

    it('a test disabled or a check bypassed in the diff blocks as factory/anti-triche', async () => {
      const { repo, req } = setup({ commands: [] });
      write(repo, 'src/a.test.ts', "it.skip('works', () => {});\n");
      commit(repo, 'x');
      expect((await runCleanVerify(req)).failures).toEqual([{ command: 'factory/anti-triche', exitCode: 1, output: expect.stringContaining('src/a.test.ts:1') }]);
    });

    it('a test removed from the base, by case or by file, blocks unless a commit of the branch justifies it (ORC-342)', async () => {
      const { origin, repo, req } = setup({ commands: [] });
      write(repo, 'src/a.test.ts', "describe('scores', () => {\n  it('rounds', () => {});\n  it('floors', () => {});\n});\n");
      write(repo, 'tests/test_scores.py', 'def test_rounds():\n    assert score(1.234) == 1.23\n');
      commit(repo, 'tests');
      git(origin, 'pull', '-q', repo, BRANCH);
      write(repo, 'src/a.test.ts', "describe('scores', () => {\n  it('floors', () => {});\n});\n");
      rmSync(join(repo, 'tests/test_scores.py'));
      commit(repo, 'drop');
      const [failure] = (await runCleanVerify(setupAgain(req))).failures;
      expect(failure).toMatchObject({ command: 'factory/anti-triche', output: expect.stringContaining('`src/a.test.ts`: test removed or renamed (`scores > rounds`)') });
      expect(failure!.output).toContain('`tests/test_scores.py`: test removed or renamed (`test_rounds`)');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: drop the rounding\n\nRemoved-test: src/a.test.ts: rounding is gone\nRemoved-test: tests/test_scores.py: same');
      expect((await runCleanVerify(setupAgain(req))).ok).toBe(true);
    });

    it('a text file over the read cap is never read, and blocks: neither scanned nor let through', async () => {
      const { repo, req } = setup({ commands: [] });
      write(repo, 'big.txt', 'x\n'.repeat(9 * 1024 * 1024));
      commit(repo, 'x');
      expect((await runCleanVerify(req)).failures).toEqual([{ command: 'factory/binaires', exitCode: 1, output: expect.stringContaining('big.txt') }]);
    });

    it('a diff too big to read blocks, never throws', async () => {
      const exec: Exec = async (cmd, args, opts) => (args.includes('--patch') ? { stdout: '', stderr: '', code: 1, overflow: true } : execCmd(cmd, args, opts));
      const { req } = setup({ commands: [], exec });
      expect((await runCleanVerify(req)).failures).toEqual([{ command: 'factory/anti-triche', exitCode: 1, output: expect.stringContaining('Diff too large') }]);
    });

    it('a change left uncommitted is no change for the freeze', async () => {
      const { repo, req } = setup({ commands: [], frozen: { sha: 's', files: { 'a.txt': sha256('committed\n') } } });
      write(repo, 'a.txt', 'changed but not committed\n');
      expect((await runCleanVerify(req)).ok).toBe(true);
    });

    describe('factory/secrets', () => {
      const clean = { stdout: '[]', stderr: '', code: 0 };

      it('scans only what the branch adds, in its own sandbox without network, before any code of the agent', async () => {
        const { origin, repo, sandboxes, req } = setup({ gitleaks: true, setup: ['true'] });
        const from = git(origin, 'rev-parse', 'HEAD');
        const scans: (readonly string[])[] = [];
        const setups = () => sandboxes.created.filter((c) => c.runId.endsWith('-setup')).length;
        sandboxes.scan = (argv) => {
          expect(setups()).toBe(0);
          scans.push(argv);
          return clean;
        };
        await runCleanVerify(req);
        expect(scans).toHaveLength(1);
        expect(scans[0]).toContain(`--log-opts=--diff-merges=remerge ${from}..${git(repo, 'rev-parse', BRANCH)}`);
        expect(scans[0]).toEqual(expect.arrayContaining(['--redact', '--ignore-gitleaks-allow']));
        expect(sandboxes.created.find((c) => c.runId === 'r1-prepare')).toMatchObject({ network: 'none', mounts: [] });
      });

      it('a secret blocks, named by its place, never by its value', async () => {
        const { sandboxes, req } = setup({ gitleaks: true, commands: [] });
        sandboxes.scan = () => ({ stdout: JSON.stringify([{ File: 'src/a.ts', StartLine: 3, RuleID: 'github-pat', Secret: 'REDACTED' }]), stderr: '', code: 7 });
        const res = await runCleanVerify(req);
        expect(res.ok).toBe(false);
        expect(res.failures[0]).toMatchObject({ command: 'factory/secrets', output: expect.stringContaining('src/a.ts:3 (github-pat)') });
        expect(res.failures[0]!.output).not.toContain('REDACTED');
      });

      // Each of these is a green if it is read by its exit code alone: 8.30.1 exits 0 on a failing git log.
      it.each([
        ['absent from the image', { stdout: '', stderr: 'gitleaks: not found', code: 127 }],
        ['a git error under an exit 0', { stdout: '[]', stderr: 'ERR stderr is not empty', code: 0 }],
        ['an unreadable report', { stdout: 'not json', stderr: '', code: 0 }],
        ['no report', { stdout: '', stderr: '', code: 0 }],
        ['its cap', { stdout: '', stderr: '', code: 124 }],
      ])('%s is a breakdown, never a green', async (_, answer) => {
        const { sandboxes, req } = setup({ gitleaks: true });
        sandboxes.scan = () => answer;
        await expect(runCleanVerify(req)).rejects.toThrow(/gitleaks/);
        expect(sandboxes.ran).toEqual([]);
      });
    });

    it('a commit the checks refused gets no install, whose breakdown would hide the verdict', async () => {
      const { repo, sandboxes, req } = setup({ setup: ['npm ci'], gitleaks: true });
      write(repo, '.npmrc', 'registry=https://evil.example\n');
      commit(repo, 'x');
      const res = await runCleanVerify(req);
      expect(res.failures[0]).toMatchObject({ command: 'factory/chemins-interdits' });
      expect(sandboxes.ran).toEqual([]);
    });

    it('a blob made huge is not read into the daemon, and reads as changed', async () => {
      const { repo, req } = setup({ commands: [] });
      write(repo, 'package.json', `{"pad":"${'x'.repeat(17 * 1024 * 1024)}"}`);
      commit(repo, 'x');
      const res = await runCleanVerify(req);
      expect(res.failures[0]!.output).toContain('package.json#scripts');
    });

    it('a commit already green is not checked again', async () => {
      const { repo, sandboxes, req } = setup();
      const res = await runCleanVerify({ ...req, green: git(repo, 'rev-parse', BRANCH) });
      expect(res.ok).toBe(true);
      expect(sandboxes.ran).toEqual([]);
    });

  });

  it('caps each command by a kill, and its output by the tail, keeping its exit code', () => {
    const argv = verifyCommand('npm test');
    expect(argv.slice(0, 3)).toEqual(['bash', '--norc', '-c']);
    expect(argv[3]).toMatch(/timeout -k \d+ \d+ bash --norc -c "\$1" 2>&1 \| tail -c \d+; exit "\$\{PIPESTATUS\[0\]\}"/);
    expect(argv.at(-1)).toBe('npm test');
  });

describe('a failure of its own git (ORC-125)', () => {
  it('is no verdict: merge-base failing is not a branch without history, whose every file would be judged a change', async () => {
    const failing: Exec = async (cmd, args, opts) => (args.includes('merge-base') ? { stdout: '', stderr: 'fatal: out of memory', code: 128 } : execCmd(cmd, args, opts));
    const { req } = setup({ exec: failing });
    await expect(runCleanVerify(req)).rejects.toThrow('out of memory');
  });

  it('a branch that shares no commit with the base stays what it was: all its files are changes', async () => {
    const { req, repo } = setup();
    git(repo, 'checkout', '-q', '--orphan', 'other');
    git(repo, 'branch', '-q', '-D', BRANCH);
    git(repo, 'checkout', '-q', '-b', BRANCH);
    git(repo, 'commit', '-q', '-m', 'orphan');
    expect((await runCleanVerify(req)).ok).toBe(true);
  });
});

});

describe('the visual proof, taken by the factory in verify (ORC-176)', () => {
  const VISUAL = 'visual_paths: ["app/**"]\n';
  /** The browser of these tests: what it "shoots" is the page file of the checkout its sandbox has, read in that sandbox. */
  class ReadingShooter extends FakeShooter {
    seen: string[] = [];
    protected override async label(sandboxes: Pick<SandboxProvider, 'exec'>, req: ShootRequest): Promise<string> {
      const page = (await sandboxes.exec(req.sandboxId, ['cat', 'app/page.txt'])).stdout.trim();
      this.seen.push(page);
      return page;
    }
  }

  /** The base has a page; the agent's branch changes it (`page`), or touches only a file outside `visual_paths`. */
  function visual(opts: { page?: string; intake?: boolean; config?: string; shooter?: VisualShooter | null; start?: string | null; commands?: string[] } = {}) {
    const shooter = new ReadingShooter();
    const s = setup({ commands: opts.commands ?? [] }, opts.config ?? VISUAL);
    write(s.origin, 'app/page.txt', 'old page\n');
    commit(s.origin, 'page');
    git(s.repo, 'pull', '-q', '--no-rebase', 'origin', 'main');
    if (opts.page !== undefined) {
      write(s.repo, 'app/page.txt', opts.page);
      commit(s.repo, 'change the page');
    }
    const gate = (c: Capture) => new OutputPolicy().capture(c);
    s.req.visual = {
      intake: opts.intake ?? false,
      ...(opts.shooter === null ? {} : { shooter: opts.shooter ?? shooter }),
      ...(opts.start === null ? {} : { start: opts.start ?? 'npm start' }),
      port: 4201,
      path: '/',
      gate,
    };
    return { ...s, shooter };
  }

  it('criterion 1: a diff in visual_paths: required, its trigger named, six captures, before on the base and after on the commit', async () => {
    const { req, repo, origin, shooter, sandboxes } = visual({ page: 'new page\n' });
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(true);
    expect(res.visual?.proof).toMatchObject({ decision: 'required', triggers: ['app/page.txt'] });
    const base = git(origin, 'rev-parse', 'main');
    const head = git(repo, 'rev-parse', BRANCH);
    expect(res.visual!.proof.captures!.map((c) => [c.side, c.sha, c.width])).toEqual([
      ['before', base, 1280], ['before', base, 768], ['before', base, 375],
      ['after', head, 1280], ['after', head, 768], ['after', head, 375],
    ]);
    expect(res.visual!.files).toHaveLength(6);
    expect(new Set(shooter.seen)).toEqual(new Set(['old page', 'new page']));
    expect(shooter.calls.map((c) => [c.sha, c.start, c.port, c.path])).toEqual(expect.arrayContaining([[head, 'npm start', 4201, '/'], [base, 'npm start', 4201, '/']]));
  });

  it("shoots in sandboxes of their own at network none, with a browser and nothing mounted, never on the agent's worktree", async () => {
    const { req, repo, sandboxes } = visual({ page: 'new page\n' });
    await runCleanVerify(req);
    const boxes = sandboxes.created.filter((c) => c.runId.startsWith('r1-visual-') && c.runId !== 'r1-visual-setup');
    expect(boxes.map((b) => b.runId).sort()).toEqual(['r1-visual-after', 'r1-visual-before']);
    for (const b of boxes) {
      expect(b).toMatchObject({ network: 'none', mounts: [], requirements: { browser: true } });
      expect(b.workspacePath).not.toBe(repo);
    }
    expect(sandboxes.active()).toEqual([]);
  });

  it('criterion 2: a diff outside visual_paths: not applicable, nothing shot', async () => {
    const { req, shooter } = visual();
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, visual: { proof: { decision: 'not_applicable', triggers: [] } } });
    expect(shooter.calls).toEqual([]);
  });

  it('a ticket intake marked visual needs it whatever the diff', async () => {
    const { req, shooter } = visual({ intake: true, config: 'visual_paths: []\n', page: 'new page\n' });
    const res = await runCleanVerify(req);
    expect(res.visual?.proof).toMatchObject({ decision: 'required', triggers: [], intake: true });
    expect(shooter.calls).toHaveLength(2);
  });

  it('criterion 3: before and after identical fail the check, with the commit not green', async () => {
    const { req } = visual({ intake: true, config: 'visual_paths: []\n' });
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([expect.objectContaining({ command: VISUAL_PROOF_CHECK, output: expect.stringContaining('identical') })]);
  });

  it('criterion 3: an application that does not start on the commit fails the check', async () => {
    const { req, repo, shooter } = visual({ page: 'new page\n' });
    const head = git(repo, 'rev-parse', BRANCH);
    shooter.answer = ({ sha }) => (sha === head ? { started: false, detail: 'EADDRINUSE' } : undefined);
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([expect.objectContaining({ command: VISUAL_PROOF_CHECK, output: expect.stringContaining('EADDRINUSE') })]);
  });

  it('a commit whose commands fail is not shot', async () => {
    const { req, shooter } = visual({ page: 'new page\n', commands: ['false'] });
    const res = await runCleanVerify(req);
    expect(res.failures.map((f) => f.command)).toEqual(['false']);
    expect(shooter.calls).toEqual([]);
  });

  it('without a browser or a start command, a required proof is unavailable: indicative, the commit stays green', async () => {
    for (const opts of [{ shooter: null }, { start: null }] as const) {
      const { req } = visual({ page: 'new page\n', ...opts });
      const res = await runCleanVerify(req);
      expect(res.ok).toBe(true);
      expect(res.visual?.proof).toMatchObject({ decision: 'required', unavailable: expect.any(String) });
      expect(res.visual?.proof.captures).toBeUndefined();
    }
  });

  it('the base is read before any code of the agent runs: a command that rewrites the clone changes nothing of the before', async () => {
    const { req, shooter } = visual({ page: 'new page\n', commands: ['git --git-dir=.git update-ref refs/factory/base HEAD; true'] });
    await runCleanVerify(req);
    expect(shooter.seen).toContain('old page');
  });
});
