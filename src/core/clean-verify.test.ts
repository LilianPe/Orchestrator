import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPythonRepo, pythonRepoFiles } from '../../test/helpers/python-repo.js';
import { FakeShooter } from '../adapters/browser/fake.js';
import type { ShootRequest, VisualShooter } from '../adapters/browser/types.js';
import { execCmd, type Exec, type ExecResult } from '../adapters/exec.js';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import type { SandboxExecOptions, SandboxProvider, SandboxRequest } from '../adapters/sandbox/types.js';
import { FakePackageRegistry } from '../checks/fake-registry.js';
import type { RegistryOpener } from '../checks/registry.js';
import { freezeTests } from '../checks/freeze.js';
import { VISUAL_PROOF_CHECK } from '../checks/visual-proof.js';
import { QUALITY_SCRIPT } from '../checks/diff-quality.js';
import type { PreviewRecipe } from '../knowledge/preview-recipe.js';
import { RepoConfigRefusal } from '../config/repo-config.js';
import { BUNDLE_TARGET } from '../publish/extract.js';
import { OutputPolicy, type Capture } from '../publish/output-policy.js';
import { runCleanVerify, verifyCommand, type CleanVerifyRequest } from './clean-verify.js';
import { VERIFY_TIMEOUT_MS } from './verify.js';

const BRANCH = 'factory/orc-1-x';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** A second check of the same run: its work dir emptied as the daemon's new one would be. */
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
  /** Semgrep's answer, with the request of the sandbox it runs in: no report by default. */
  semgrep?: (argv: readonly string[], req: SandboxRequest) => ExecResult;
  /** crapper's and dryer's (ORC-280), with the request of the sandbox they run in: an empty report by default. */
  quality?: (argv: readonly string[], req: SandboxRequest) => ExecResult;

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
    if (args.includes('semgrep')) return this.semgrep?.(args, req) ?? { stdout: '{"results":[],"errors":[]}', stderr: '', code: 0 };
    if (args.includes(QUALITY_SCRIPT)) return this.quality?.(args, req) ?? { stdout: '{"functions":[],"pairs":[]}', stderr: '', code: 0 };
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

/** The registries `factory/dependances` reaches (ORC-371): each opening and closing recorded. */
function registries(registry: FakePackageRegistry) {
  const opened: string[] = [];
  const closed: string[] = [];
  const open: RegistryOpener = async (id) => {
    opened.push(id);
    return { registry, close: async () => void closed.push(id) };
  };
  return { opened, closed, open };
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
function setup(over: Partial<CleanVerifyRequest> = {}, config?: string, baseFiles: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'factory-clean-'));
  const origin = join(base, 'origin');
  git(base, 'init', '-q', '-b', 'main', origin);
  identity(origin);
  write(origin, 'README.md', 'base\n');
  if (config) write(origin, '.factory/config.yml', config);
  for (const [path, content] of Object.entries(baseFiles)) write(origin, path, content);
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
    semgrep: false,
    setup: [],
    commands: ['grep committed a.txt'],
    env: async () => ({}),
    log: (m) => logs.push(m),
    ...over,
  };
  return { base, origin, repo, workDir, sandboxes, req, logs };
}

// A test that moves the clock past the cap (ORC-348) leaves it as it found it.
afterEach(() => {
  vi.useRealTimers();
});

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
    // The factory's clock past the cap while the command runs: an expiry, as the factory sees one (ORC-348).
    sandboxes.answer = () => {
      vi.setSystemTime(Date.now() + VERIFY_TIMEOUT_MS);
      return { stdout: 'part', stderr: '', code: 124 };
    };
    const res = await runCleanVerify(req);
    expect(res.failures).toEqual([{ command: 'slow', exitCode: null, output: 'part' }]);
  });

  it("a command that outlived its cap's TERM, killed after it (137), fails with no exit code too (ORC-348)", async () => {
    const { sandboxes, req } = setup({ commands: ['stubborn'] });
    sandboxes.answer = () => {
      vi.setSystemTime(Date.now() + VERIFY_TIMEOUT_MS);
      return { stdout: 'part', stderr: '', code: 137 };
    };
    expect((await runCleanVerify(req)).failures).toEqual([{ command: 'stubborn', exitCode: null, output: 'part' }]);
  });

  it('a command that exits 124 itself, before its cap, keeps its exit code (ORC-348)', async () => {
    const { sandboxes, req } = setup({ commands: ['exit 124'] });
    sandboxes.answer = () => ({ stdout: 'part', stderr: '', code: 124 });
    const res = await runCleanVerify(req);
    expect(res.failures).toEqual([{ command: 'exit 124', exitCode: 124, output: 'part' }]);
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

    describe('a setup that declares setup_secrets (ORC-461)', () => {
      const SECRET = `${CONFIG}setup_secrets: [NPM_TOKEN, REGISTRY_TOKEN]\n`;

      it('is refused before it runs, naming the secrets withheld and why: the commit verify checks, nobody reviewed', async () => {
        const { sandboxes, req } = setup({ commands: ['true'] }, SECRET);
        const refused = runCleanVerify(req);
        await expect(refused).rejects.toThrow(/setup_secrets \(NPM_TOKEN, REGISTRY_TOKEN\)/);
        await expect(refused).rejects.toThrow(/nobody reviewed/);
        // The repository's to fix (ORC-493): the ticket is blocked as such, never as a breakdown of the factory.
        await expect(refused).rejects.toBeInstanceOf(RepoConfigRefusal);
        expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-verify-setup');
        expect(sandboxes.ran.map((r) => r.command)).not.toContain('echo base-setup');
      });

      it("on a human's push too: its commit is beyond the default branch, as the launch's rule reads it", async () => {
        const { sandboxes, req, repo } = setup({ commands: ['true'] }, SECRET);
        git(repo, 'push', '-q', 'origin', BRANCH);
        req.head = git(repo, 'rev-parse', 'HEAD');
        await expect(runCleanVerify(req)).rejects.toThrow(/setup_secrets \(NPM_TOKEN, REGISTRY_TOKEN\)/);
        expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-verify-setup');
      });

      it("with the workflow's setup, none of the config's own, it is refused all the same", async () => {
        const { sandboxes, req } = setup({ commands: ['true'], setup: ['echo workflow-setup'] }, 'setup_secrets: [NPM_TOKEN]\n');
        await expect(runCleanVerify(req)).rejects.toThrow(/setup_secrets \(NPM_TOKEN\).*if it needs it, the repository cannot be verified/);
        expect(sandboxes.ran.map((r) => r.command)).not.toContain('echo workflow-setup');
      });

      it('with no setup to run, nothing is withheld: the commands run', async () => {
        const { req } = setup({ commands: ['true'], setup: [] }, 'setup_secrets: [NPM_TOKEN]\n');
        expect((await runCleanVerify(req)).ok).toBe(true);
      });

      it('a commit the checks refuse keeps their verdict: it goes out before the refusal', async () => {
        const { repo, req } = setup({ commands: ['true'] }, SECRET);
        write(repo, '.factory/config.yml', CONFIG);
        commit(repo, 'the agent drops setup_secrets');
        const res = await runCleanVerify(req);
        expect(res).toMatchObject({ ok: false, failures: [{ command: 'factory/chemins-interdits' }] });
      });
    });

    it("gives verify's setup and commands services of their own, new, gone with the commands' sandbox (ORC-309)", async () => {
      const { sandboxes, req } = setup({}, `${CONFIG}services: [postgres]\n`);
      await runCleanVerify(req);
      const asked = sandboxes.created.map((c) => [c.runId, c.servicesOf, c.requirements.services]);
      expect(asked).toEqual([
        ['r1-bundle', undefined, []],
        ['r1-prepare', undefined, []],
        ['r1-verify-setup', 'r1-verify', ['postgres']],
        ['r1-verify', undefined, ['postgres']],
      ]);
      expect(sandboxes.activeServices()).toEqual([]);
      expect(sandboxes.destroyed).toContain('svc-1');
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

      it("the verdict carries the class of the diff against the default branch, under the base's sensitive_paths (ORC-198)", async () => {
        expect((await runCleanVerify(touchInfra({}).req)).diffClass).toEqual({ class: 'sensitive', paths: ['infra/main.tf'] });
        const { repo, req } = setup({ commands: [] });
        write(repo, 'vitest.config.ts', 'export default {};\n');
        commit(repo, 'harness');
        expect((await runCleanVerify(req)).diffClass).toEqual({ class: 'verification-config', paths: ['vitest.config.ts'] });
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
      const { origin, repo, req } = setup({ commands: [], registries: registries(new FakePackageRegistry({ npm: ['a'] })).open }, 'dependencies: { allow: { npm: [a] } }\n');
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

    describe('factory/taille-du-diff (ORC-333)', () => {
      const files = (repo: string, n: number, dir = 'src') => {
        for (let i = 0; i < n; i++) write(repo, `${dir}/f${i}.ts`, `export const f${i} = ${i};\n`);
        commit(repo, `${n} files under ${dir}`);
      };

      it('criterion 1: a diff past max_diff blocks with its cause, before anything of it runs', async () => {
        const { repo, sandboxes, req } = setup();
        files(repo, 15);
        const res = await runCleanVerify(req);
        expect(res.ok).toBe(false);
        expect(res.failures).toEqual([{ command: 'factory/taille-du-diff', exitCode: 1, output: expect.stringContaining('16 files outside tests, over 15') }]);
        expect(res.failures[0]!.output).toContain('split the ticket');
        expect(sandboxes.ran).toEqual([]);
      });

      it("criterion ORC-381: under factory.yml's `max_diff: off`, a diff of 30 files is not blocked for its size", async () => {
        const { repo, req } = setup({ commands: [], maxDiff: 'off' });
        files(repo, 30);
        expect((await runCleanVerify(req)).failures).toEqual([]);
      });

      it("under `max_diff: off`, the base's own max_diff still bounds the diff (ORC-381)", async () => {
        const { repo, req } = setup({ commands: [], maxDiff: 'off' }, 'max_diff: { files: 10 }\n');
        files(repo, 30);
        expect((await runCleanVerify(req)).failures).toEqual([expect.objectContaining({ command: 'factory/taille-du-diff', output: expect.stringContaining('31 files outside tests, over 10') })]);
      });

      it("tightened by the base's max_diff; tests do not count", async () => {
        const { repo, req } = setup({ commands: [] }, 'max_diff: { files: 3 }\n');
        files(repo, 20, 'test');
        expect((await runCleanVerify(req)).ok).toBe(true);
        files(repo, 3);
        expect((await runCleanVerify(setupAgain(req))).failures).toEqual([expect.objectContaining({ command: 'factory/taille-du-diff', output: expect.stringContaining('4 files outside tests, over 3') })]);
      });

      it('a rename counts as one file without lines, a deletion with its lines', async () => {
        // The branch's a.txt is its one line before these.
        const { origin, repo, req } = setup({ commands: [] }, 'max_diff: { lines: 4 }\n');
        write(origin, 'old.ts', 'a\nb\nc\n');
        write(origin, 'gone.ts', 'a\nb\nc\nd\n');
        commit(origin, 'base files');
        git(repo, 'pull', '-q', '--no-rebase', 'origin', 'main');
        git(repo, 'mv', 'old.ts', 'new.ts');
        commit(repo, 'rename');
        expect((await runCleanVerify(req)).ok).toBe(true);
        rmSync(join(repo, 'gone.ts'));
        commit(repo, 'delete');
        expect((await runCleanVerify(setupAgain(req))).failures[0]!.output).toContain('5 lines outside tests, over 4');
      });
    });

    describe('factory/dependances (ORC-371)', () => {
      const ALLOW = 'dependencies: { allow: { npm: [left-pad, zod], pypi: [requests] } }\n';
      const npm = (repo: string, deps: Record<string, string>) => write(repo, 'package.json', JSON.stringify({ dependencies: deps }));

      it('criterion 1: an added package missing from its registry blocks with its cause, before anything of it runs', async () => {
        const regs = registries(new FakePackageRegistry({ npm: ['left-pad'] }));
        const { repo, sandboxes, req } = setup({ registries: regs.open }, ALLOW);
        npm(repo, { 'left-pad': '1', zod: '3' });
        commit(repo, 'deps');
        const res = await runCleanVerify(req);
        expect(res.ok).toBe(false);
        expect(res.failures).toEqual([{ command: 'factory/dependances', exitCode: 1, output: expect.stringContaining('npm "zod" (package.json): package missing from the npm registry') }]);
        expect(sandboxes.ran).toEqual([]);
      });

      it("criterion 2: an added package off the base's allowlist blocks", async () => {
        const regs = registries(new FakePackageRegistry({ npm: ['left-pad', 'evil'], pypi: ['requests'] }));
        const { repo, req } = setup({ commands: [], registries: regs.open }, ALLOW);
        npm(repo, { 'left-pad': '1', evil: '1' });
        write(repo, 'requirements.txt', 'requests==2\n');
        commit(repo, 'deps');
        const res = await runCleanVerify(req);
        expect(res.failures.map((f) => f.command)).toEqual(['factory/dependances']);
        expect(res.failures[0]!.output).toContain(`npm "evil" (package.json): not on the repository's allowlist.`);
        expect(res.failures[0]!.output).not.toContain('left-pad');
      });

      it('without an allowlist on the base, no added package passes', async () => {
        const { repo, req } = setup({ commands: [], registries: registries(new FakePackageRegistry({ npm: ['left-pad'] })).open });
        npm(repo, { 'left-pad': '1' });
        commit(repo, 'deps');
        expect((await runCleanVerify(req)).failures[0]!.output).toContain('no npm allowlist for this repository');
      });

      it('criterion 3: added packages that exist and are allowed pass, npm and PyPI, and the commands run', async () => {
        const registry = new FakePackageRegistry({ npm: ['left-pad'], pypi: ['requests'] });
        const { repo, sandboxes, req } = setup({ registries: registries(registry).open }, ALLOW);
        npm(repo, { 'left-pad': '1' });
        write(repo, 'requirements.txt', 'Requests>=2\n');
        commit(repo, 'deps');
        expect(await runCleanVerify(req)).toMatchObject({ ok: true, failures: [] });
        expect(registry.lookups).toEqual([{ ecosystem: 'npm', name: 'left-pad' }, { ecosystem: 'pypi', name: 'requests' }]);
        expect(sandboxes.ran.map((r) => r.box)).toEqual(['r1-verify']);
      });

      it('criterion 4: read from the clone by the daemon, the registries reached outside every sandbox, which stay at network none', async () => {
        const regs = registries(new FakePackageRegistry({ npm: ['left-pad'] }));
        const { repo, sandboxes, req } = setup({ setup: ['true'], registries: regs.open }, ALLOW);
        npm(repo, { 'left-pad': '1' });
        commit(repo, 'deps');
        expect((await runCleanVerify(req)).ok).toBe(true);
        // A name of this check's own: another check of the same run closes nothing of it.
        expect(regs.opened).toEqual([expect.stringMatching(/^r1-dependencies-[0-9a-f]{8}$/)]);
        expect(regs.closed).toEqual(regs.opened);
        // The sealed setup alone installs, at `limited`, as before; nothing of the check runs in a sandbox.
        expect(sandboxes.created.filter((c) => c.runId !== 'r1-verify-setup').map((c) => [c.runId, c.network])).toEqual([
          ['r1-bundle', 'none'],
          ['r1-prepare', 'none'],
          ['r1-verify', 'none'],
        ]);
      });

      it('a branch that adds no dependency reaches no registry', async () => {
        const regs = registries(new FakePackageRegistry());
        const { repo, req } = setup({ commands: [], registries: regs.open });
        write(repo, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0' }));
        commit(repo, 'a manifest, no dependency');
        expect((await runCleanVerify(req)).ok).toBe(true);
        expect(regs.opened).toEqual([]);
      });

      it('a version bump adds nothing: only what the base did not declare is checked', async () => {
        const regs = registries(new FakePackageRegistry());
        const { origin, repo, req } = setup({ commands: [], registries: regs.open });
        npm(origin, { zod: '3' });
        commit(origin, 'zod on the base');
        git(repo, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
        npm(repo, { zod: '4' });
        commit(repo, 'bump');
        expect((await runCleanVerify(req)).ok).toBe(true);
        expect(regs.opened).toEqual([]);
      });

      it('a registry that does not answer is a breakdown, never sent to the agent, and its way out is closed', async () => {
        const registry = new FakePackageRegistry();
        registry.fail('npm', 'left-pad', 'connect ETIMEDOUT');
        const regs = registries(registry);
        const { repo, req } = setup({ registries: regs.open }, ALLOW);
        npm(repo, { 'left-pad': '1' });
        commit(repo, 'deps');
        await expect(runCleanVerify(req)).rejects.toThrow(/registry did not answer \(connect ETIMEDOUT\)/);
        expect(regs.closed).toEqual(regs.opened);
        expect(regs.closed).toHaveLength(1);
      });

      it('a registry down hides no verdict that needs no answer: the package off the allowlist blocks all the same', async () => {
        const registry = new FakePackageRegistry({ npm: ['left-pad'] });
        registry.fail('npm', 'evil', 'connect ETIMEDOUT');
        const { repo, req } = setup({ registries: registries(registry).open }, ALLOW);
        npm(repo, { 'left-pad': '1', evil: '1' });
        commit(repo, 'deps');
        const res = await runCleanVerify(req);
        expect(res.failures).toEqual([{ command: 'factory/dependances', exitCode: 1, output: expect.stringContaining(`npm "evil" (package.json): not on the repository's allowlist.`) }]);
        expect(res.failures[0]!.output).not.toContain('did not answer');
      });

      it('asked after gitleaks: a registry down hides no secret the branch committed', async () => {
        const registry = new FakePackageRegistry();
        registry.fail('npm', 'left-pad', 'connect ETIMEDOUT');
        const { repo, sandboxes, req } = setup({ gitleaks: true, registries: registries(registry).open }, ALLOW);
        sandboxes.scan = () => ({ stdout: JSON.stringify([{ File: 'a.txt', StartLine: 1, RuleID: 'github-pat', Secret: 'REDACTED' }]), stderr: '', code: 7 });
        npm(repo, { 'left-pad': '1' });
        commit(repo, 'deps and a secret');
        expect((await runCleanVerify(req)).failures.map((f) => f.command)).toEqual(['factory/secrets']);
        expect(registry.lookups).toEqual([]);
      });

      it('an instance with no way to the registries is a breakdown too, as is a proxy that does not open', async () => {
        const { repo, req } = setup({}, ALLOW);
        npm(repo, { 'left-pad': '1' });
        commit(repo, 'deps');
        await expect(runCleanVerify(req)).rejects.toThrow(/registry did not answer \(no package registry on this instance\)/);
        const down = { ...setupAgain(req), registries: () => Promise.reject(new Error('egress: proxy unreachable')) };
        await expect(runCleanVerify(down)).rejects.toThrow(/registry did not answer \(egress: proxy unreachable\)/);
      });

      it('a branch refused already reaches no registry: a breakdown there would hide its verdict', async () => {
        const regs = registries(new FakePackageRegistry());
        const { repo, req } = setup({ registries: regs.open }, ALLOW);
        npm(repo, { 'left-pad': '1' });
        write(repo, '.github/workflows/x.yml', 'on: push\n');
        commit(repo, 'deps and a workflow');
        expect((await runCleanVerify(req)).failures.map((f) => f.command)).toEqual(['factory/chemins-interdits']);
        expect(regs.opened).toEqual([]);
      });
    });

    describe('factory/semgrep (ORC-333)', () => {
      const report = (results: { path: string; line: number; end?: number; rule?: string }[]) => ({
        stdout: JSON.stringify({ results: results.map((r) => ({ check_id: r.rule ?? 'js-eval', path: r.path, start: { line: r.line }, end: { line: r.end ?? r.line }, extra: { message: 'eval of a dynamic value' } })), errors: [] }),
        stderr: '',
        code: 0,
      });
      /** The base holds `src/a.js`, two lines; the branch adds a third. */
      const appended = (over: Partial<CleanVerifyRequest> = {}, config?: string) => {
        const s = setup({ semgrep: true, commands: [], ...over }, config);
        write(s.origin, 'src/a.js', 'one();\ntwo();\n');
        commit(s.origin, 'a.js');
        git(s.repo, 'pull', '-q', '--no-rebase', 'origin', 'main');
        write(s.repo, 'src/a.js', 'one();\ntwo();\neval(input);\n');
        commit(s.repo, 'eval');
        return s;
      };

      it("scans the files the branch adds lines to, without network, before any setup, with the factory's rules", async () => {
        const { origin, repo, sandboxes, req } = setup({ semgrep: true, setup: ['true'] });
        write(origin, 'gone.ts', 'x\n');
        commit(origin, 'a file the branch deletes');
        git(repo, 'pull', '-q', '--no-rebase', 'origin', 'main');
        rmSync(join(repo, 'gone.ts'));
        write(repo, '-dash.js', 'dash();\n');
        commit(repo, 'delete one, add one');
        const scans: (readonly string[])[] = [];
        sandboxes.semgrep = (argv) => {
          expect(sandboxes.created.filter((c) => c.runId.endsWith('-setup'))).toEqual([]);
          scans.push(argv);
          return report([]);
        };
        expect((await runCleanVerify(req)).ok).toBe(true);
        expect(scans).toHaveLength(1);
        const argv = scans[0]!;
        expect(argv.filter((_, i) => argv[i - 1] === '--config')).toEqual(['/usr/local/share/factory/semgrep']);
        expect(argv.slice(argv.indexOf('--')).sort()).toEqual(['--', '-dash.js', 'a.txt']);
        expect(sandboxes.created.find((c) => c.runId === 'r1-prepare')).toMatchObject({ network: 'none', mounts: [] });
      });

      it('criterion 2: a finding on a line the branch adds blocks, named by its place and rule', async () => {
        const { sandboxes, req } = appended();
        sandboxes.semgrep = () => report([{ path: 'src/a.js', line: 3 }]);
        const res = await runCleanVerify(req);
        expect(res.ok).toBe(false);
        expect(res.failures).toEqual([{ command: 'factory/semgrep', exitCode: 1, output: expect.stringContaining('`src/a.js`:3 (js-eval): eval of a dynamic value') }]);
        expect(res.failures[0]!.output).toContain('`nosemgrep` comment is not read');
      });

      it('a finding on a line the branch did not write is the base\'s: it does not block', async () => {
        const { sandboxes, req } = appended();
        sandboxes.semgrep = () => report([{ path: 'src/a.js', line: 1 }, { path: 'README.md', line: 1 }]);
        expect(await runCleanVerify(req)).toMatchObject({ ok: true, failures: [] });
      });

      it('a finding over several lines blocks when one of them is added', async () => {
        const { sandboxes, req } = appended();
        sandboxes.semgrep = () => report([{ path: 'src/a.js', line: 2, end: 3 }]);
        expect((await runCleanVerify(req)).failures[0]!.output).toContain('`src/a.js`:3');
      });

      it("adds the repository's rules as its default branch holds them, mounted read-only", async () => {
        const base = setup({ semgrep: true, commands: [] });
        write(base.origin, '.factory/semgrep/house.yml', 'rules: base\n');
        write(base.origin, '.factory/semgrep/notes.md', 'not a rule\n');
        commit(base.origin, 'house rules');
        git(base.repo, 'pull', '-q', '--no-rebase', 'origin', 'main');
        write(base.repo, 'b.js', 'x\n');
        commit(base.repo, 'work');
        let seen: { argv: readonly string[]; mounts: SandboxRequest['mounts']; content: string } | undefined;
        base.sandboxes.semgrep = (argv, box) => {
          const mount = box.mounts[0]!;
          seen = { argv, mounts: box.mounts, content: readFileSync(join(mount.host, 'house.yml'), 'utf8') };
          return report([]);
        };
        const res = await runCleanVerify(base.req);
        expect(seen!.mounts).toEqual([expect.objectContaining({ target: '/factory/semgrep', readOnly: true })]);
        expect(seen!.content).toBe('rules: base\n');
        const configs = seen!.argv.flatMap((a, i) => (seen!.argv[i - 1] === '--config' ? [a] : []));
        expect(configs).toEqual(['/usr/local/share/factory/semgrep', '/factory/semgrep/house.yml']);
        expect(res.ok).toBe(true);
      });

      it('a commit the other checks refused is not scanned: a breakdown of the scan would hide the verdict', async () => {
        const { repo, sandboxes, req } = appended();
        write(repo, '.factory/semgrep/house.yml', 'rules: []\n');
        commit(repo, 'the agent empties the rules');
        sandboxes.semgrep = () => ({ stdout: '', stderr: 'boom', code: 2 });
        expect((await runCleanVerify(req)).failures.map((f) => f.command)).toEqual(['factory/chemins-interdits']);
      });

      it.skipIf(process.platform === 'win32')('a symbolic link is not scanned: its target is no code of the branch', async () => {
        const { repo, sandboxes, req } = setup({ semgrep: true, commands: [] });
        symlinkSync('a.txt', join(repo, 'link.js'));
        commit(repo, 'link');
        const scans: (readonly string[])[] = [];
        sandboxes.semgrep = (argv) => (scans.push(argv), report([]));
        await runCleanVerify(req);
        expect(scans[0]!.slice(scans[0]!.indexOf('--'))).toEqual(['--', 'a.txt']);
      });

      it('an added line Semgrep could not parse blocks: what it does not read, it cannot judge', async () => {
        const { sandboxes, req } = appended();
        const errors = [
          { level: 'warn', type: 'PartialParsing', message: 'Syntax error at line src/a.js:3:\n `x` was unexpected', path: 'src/a.js', spans: [{ file: 'src/a.js', start: { line: 3 }, end: { line: 3 } }] },
          { level: 'warn', type: 'PartialParsing', message: 'Syntax error at line src/a.js:1', path: 'src/a.js', spans: [{ file: 'src/a.js', start: { line: 1 }, end: { line: 1 } }] },
        ];
        sandboxes.semgrep = () => ({ stdout: JSON.stringify({ results: [], errors }), stderr: '', code: 0 });
        const { output } = (await runCleanVerify(req)).failures[0]!;
        expect(output).toContain('- `src/a.js`: Syntax error at line src/a.js:3:');
        expect(output).not.toContain('src/a.js:1');
      });

      it('a branch that adds no line runs no scan', async () => {
        const { origin, repo, sandboxes, req } = setup({ semgrep: true, commands: [] });
        write(origin, 'gone.ts', 'x\n');
        commit(origin, 'base');
        git(repo, 'pull', '-q', '--no-rebase', 'origin', 'main');
        git(repo, 'rm', '-q', 'a.txt', 'gone.ts');
        commit(repo, 'only deletions');
        sandboxes.semgrep = () => {
          throw new Error('scanned');
        };
        expect((await runCleanVerify(req)).ok).toBe(true);
      });

      it.each([
        ['absent from the image', { stdout: '', stderr: 'semgrep: not found', code: 127 }],
        ['its cap', { stdout: '', stderr: '', code: 124 }],
      ])('%s is a breakdown, never a green', async (_, answer) => {
        const { sandboxes, req } = appended({ commands: ['true'] });
        sandboxes.semgrep = () => answer;
        await expect(runCleanVerify(req)).rejects.toThrow(/semgrep/);
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

  describe('a Python repository (ORC-172)', () => {
    const COMMANDS = ['uv run --frozen ruff check', 'uv run --frozen mypy .', 'uv run --frozen pytest'];

    /** The fixture on the base branch, the agent's branch on it, frozen at its tests and harness; uv answers green. */
    async function python() {
      const s = setup({ commands: COMMANDS, setup: ['uv sync --frozen'] });
      copyPythonRepo(s.origin);
      commit(s.origin, 'the fixture');
      git(s.repo, 'pull', '-q', '--no-rebase', 'origin', 'main');
      const files = pythonRepoFiles();
      const frozen = await freezeTests(['tests/test_export.py'], { head: 'freeze', changed: [], filesAtHead: async () => Object.keys(files), showAtHead: async (p) => files[p] });
      // pytest's line comes after the path of its report (ORC-164).
      s.sandboxes.answer = (command) => (/^(?:f=.*\n)?uv /.test(command) ? { stdout: '', stderr: '', code: 0 } : undefined);
      return { ...s, req: { ...s.req, frozen } };
    }

    it('freezes conftest.py and the pytest section of pyproject.toml with the tests', async () => {
      const { req } = await python();
      expect(Object.keys(req.frozen.files).sort()).toEqual(['pyproject.toml', 'tests/conftest.py', 'tests/test_export.py']);
    });

    it('runs its setup, then the commands init proposes for it: green', async () => {
      const { sandboxes, req } = await python();
      expect(await runCleanVerify(req)).toMatchObject({ ok: true, failures: [] });
      // Without the reads of pytest's report (ORC-164).
      const ran = sandboxes.ran.map((r) => r.command).filter((c) => !c.startsWith('[ -f '));
      expect(ran).toContain('uv sync --frozen');
      expect(ran.slice(-3)).toEqual([COMMANDS[0], COMMANDS[1], expect.stringMatching(/\nuv run --frozen pytest --junitxml="\$f" -o junit_family=xunit1$/)]);
    });

    it('criterion 3: a conftest.py the agent changed after the freeze blocks as factory/tests-gelés', async () => {
      const { repo, req, sandboxes } = await python();
      write(repo, 'tests/conftest.py', `${pythonRepoFiles()['tests/conftest.py']}\ncollect_ignore = ["test_export.py"]\n`);
      commit(repo, 'skip the slow tests');
      const res = await runCleanVerify(req);
      expect(res.failures).toEqual([{ command: 'factory/tests-gelés', exitCode: 1, output: expect.stringContaining('tests/conftest.py') }]);
      expect(sandboxes.ran).toEqual([]);
    });

    it('criterion 4: a # noqa the agent added blocks as factory/anti-triche', async () => {
      const { repo, req, sandboxes } = await python();
      write(repo, 'src/app/export.py', pythonRepoFiles()['src/app/export.py']!.replace('import io\n', 'import io\nimport os  # noqa: F401\n'));
      commit(repo, 'export');
      const res = await runCleanVerify(req);
      expect(res.failures).toEqual([{ command: 'factory/anti-triche', exitCode: 1, output: expect.stringContaining('src/app/export.py:5') }]);
      expect(sandboxes.ran).toEqual([]);
    });
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
  /** `preview`: the base's in `.factory/config.yml`, `npm start` by default, none with `null`. */
  function visual(opts: { page?: string; intake?: boolean; config?: string; shooter?: VisualShooter | null; preview?: string | null; commands?: string[]; learned?: PreviewRecipe; found?: PreviewRecipe } = {}) {
    const shooter = new ReadingShooter();
    const preview = opts.preview === null ? '' : `preview: ${opts.preview ?? 'npm start'}\n`;
    const s = setup({ commands: opts.commands ?? [] }, (opts.config ?? VISUAL) + preview);
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
      port: 4201,
      path: '/',
      gate,
      ...(opts.learned ? { learned: opts.learned } : {}),
      ...(opts.found ? { found: opts.found } : {}),
    };
    return { ...s, shooter };
  }

  it('criterion 1: a diff in visual_paths: required, its trigger named, six captures, before on the base and after on the commit', async () => {
    const { req, repo, origin, shooter } = visual({ page: 'new page\n' });
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

  it('without a browser or a start command, a required proof is unavailable: indicative, the commit stays green (ORC-397 criterion 2)', async () => {
    for (const [opts, why] of [[{ shooter: null }, 'browser'], [{ preview: null }, '`preview` in .factory/config.yml']] as const) {
      const { req } = visual({ page: 'new page\n', ...opts });
      const res = await runCleanVerify(req);
      expect(res.ok).toBe(true);
      expect(res.visual?.proof).toMatchObject({ decision: 'required', unavailable: expect.stringContaining(why) });
      expect(res.visual?.proof.captures).toBeUndefined();
    }
  });

  it("ORC-397 criterion 1: the base's `preview` in .factory/config.yml starts the application, the only place it is declared (ORC-388)", async () => {
    const { req, shooter } = visual({ page: 'new page\n', preview: 'npm run dev' });
    const res = await runCleanVerify(req);
    expect(res.visual?.proof.captures).toHaveLength(6);
    expect(shooter.calls.map((c) => c.start)).toEqual(['npm run dev', 'npm run dev']);
  });

  describe('the start recipe learned in the knowledge base, or found by the agent (ORC-386)', () => {
    const LEARNED = { command: 'npm run dev', setup: ['npm run build'] };
    const FOUND = { command: 'npx vite --port "$PORT"', setup: [] };
    const answers = (sandboxes: { answer?: (command: string, box: string) => ExecResult | undefined }, code: number, stdout: string) => {
      sandboxes.answer = (command, box) => (box.endsWith('-preview') && command === FOUND.command ? { code, stdout, stderr: '' } : undefined);
    };

    it('a learned recipe starts the application when none is declared, and the proof says so', async () => {
      const { req, shooter } = visual({ page: 'new page\n', preview: null, learned: LEARNED });
      const res = await runCleanVerify(req);
      expect(res.visual?.proof).toMatchObject({ decision: 'required', start: 'learned' });
      expect(res.visual?.proof.captures).toHaveLength(6);
      expect(shooter.calls.map((c) => c.start)).toEqual(['npm run build && npm run dev', 'npm run build && npm run dev']);
      expect(res.preview).toBeUndefined();
    });

    it('criterion 3: a declared start wins over the learned recipe and the found one, which is not even probed', async () => {
      const { req, shooter, sandboxes } = visual({ page: 'new page\n', learned: LEARNED, found: FOUND });
      const res = await runCleanVerify(req);
      expect(res.visual?.proof).toMatchObject({ start: 'declared' });
      expect(shooter.calls.map((c) => c.start)).toEqual(['npm start', 'npm start']);
      expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-preview');
      expect(res.preview).toBeUndefined();
    });

    it('criterion 1: a found recipe the proof needs is tried by the captures themselves: started on the commit, it answered', async () => {
      const { req, shooter, sandboxes } = visual({ page: 'new page\n', preview: null, found: FOUND });
      const res = await runCleanVerify(req);
      expect(res.preview).toEqual({ of: 'found', answered: true });
      expect(res.visual?.proof).toMatchObject({ start: 'found' });
      expect(res.visual?.proof.captures).toHaveLength(6);
      expect(shooter.calls.map((c) => c.start)).toEqual([FOUND.command, FOUND.command]);
      // No second start of it: the shot after was its probe.
      expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-preview');
    });

    it('a found recipe is probed even when this diff needs no proof, so the next ticket has it', async () => {
      const { req, shooter, sandboxes } = visual({ preview: null, found: FOUND });
      answers(sandboxes, 0, 'answered\n');
      const res = await runCleanVerify(req);
      expect(res.preview).toEqual({ of: 'found', answered: true });
      expect(res.visual?.proof).toEqual({ decision: 'not_applicable', triggers: [] });
      expect(shooter.calls).toEqual([]);
      // Probed by the factory at network none with nothing mounted, in the image the captures run in.
      expect(sandboxes.created.find((c) => c.runId === 'r1-preview')).toMatchObject({ network: 'none', mounts: [], requirements: { browser: true } });
      expect(sandboxes.ran.find((r) => r.box === 'r1-preview')).toMatchObject({ command: FOUND.command });
    });

    it('a found recipe probed with no proof to take that does not answer: said, with what it printed', async () => {
      const { req, sandboxes } = visual({ preview: null, found: FOUND });
      answers(sandboxes, 1, 'nothing answers on port 4201 after 60 s\nError: Cannot find module vite\n');
      const res = await runCleanVerify(req);
      expect(res.ok).toBe(true);
      expect(res.preview).toEqual({ of: 'found', answered: false, detail: expect.stringContaining('Cannot find module vite') });
    });

    it('criterion 5: a found recipe that starts the application neither on the commit nor on the base: unavailable with why, the commit green', async () => {
      const { req, shooter } = visual({ page: 'new page\n', preview: null, found: FOUND });
      shooter.answer = () => ({ started: false, detail: 'Error: Cannot find module vite' });
      const res = await runCleanVerify(req);
      expect(res.ok).toBe(true);
      expect(res.preview).toEqual({ of: 'found', answered: false, detail: 'Error: Cannot find module vite' });
      expect(res.visual?.proof).toMatchObject({ start: 'found', unavailable: expect.stringContaining('the start command the agent found started the application neither on') });
      expect(shooter.calls).toHaveLength(2);
    });

    it('criterion 4: a learned recipe that starts the application neither on the commit nor on the base is stale, no failure of the branch', async () => {
      const { req, shooter } = visual({ page: 'new page\n', preview: null, learned: LEARNED });
      shooter.answer = () => ({ started: false, detail: 'nothing answers on port 4201' });
      const res = await runCleanVerify(req);
      expect(res.ok).toBe(true);
      expect(res.failures).toEqual([]);
      expect(res.preview).toEqual({ of: 'learned', answered: false, detail: 'nothing answers on port 4201' });
      expect(res.visual?.proof).toMatchObject({ start: 'learned', unavailable: expect.stringContaining('neither on') });
      expect(shooter.calls).toHaveLength(2);
    });

    it('a learned recipe the base still starts with, which the commit does not: the branch broke the application, the check fails', async () => {
      const { req, repo, shooter } = visual({ page: 'new page\n', preview: null, learned: LEARNED });
      const head = git(repo, 'rev-parse', BRANCH);
      shooter.answer = ({ sha }) => (sha === head ? { started: false, detail: 'TypeError at boot' } : undefined);
      const res = await runCleanVerify(req);
      expect(res.ok).toBe(false);
      expect(res.failures).toEqual([expect.objectContaining({ command: VISUAL_PROOF_CHECK, output: expect.stringContaining('TypeError at boot') })]);
      expect(res.preview).toBeUndefined();
      // The base shot once, to tell, and not again.
      expect(shooter.calls).toHaveLength(2);
    });

    it('a repository with services: the found recipe is not probed, as the captures could not run it either', async () => {
      const { req, sandboxes } = visual({ page: 'new page\n', preview: null, found: FOUND, config: `${VISUAL}services: [postgres]\n` });
      const res = await runCleanVerify(req);
      expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-preview');
      expect(res.preview).toBeUndefined();
    });

    it('a commit whose commands fail probes nothing', async () => {
      const { req, sandboxes } = visual({ page: 'new page\n', preview: null, found: FOUND, commands: ['false'] });
      const res = await runCleanVerify(req);
      expect(res.failures.map((f) => f.command)).toEqual(['false']);
      expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-preview');
      expect(res.preview).toBeUndefined();
    });

    it('none declared, learned nor found: unavailable, saying where to declare one', async () => {
      const { req } = visual({ page: 'new page\n', preview: null });
      const res = await runCleanVerify(req);
      expect(res.visual?.proof).toMatchObject({ start: 'none', unavailable: expect.stringContaining('`preview` in .factory/config.yml') });
    });

    it('none, and no search asked any more (ORC-406): unavailable, saying why', async () => {
      const { req } = visual({ page: 'new page\n', preview: null });
      req.visual!.noSearch = 'the build agent searched 3 times without finding how to start it';
      const res = await runCleanVerify(req);
      expect(res.visual?.proof).toMatchObject({ start: 'none', unavailable: expect.stringMatching(/learned none: the build agent searched 3 times/) });
    });
  });

  it('a commit that declares a service no sandbox provides is refused before any of its code runs, naming it (ORC-282)', async () => {
    const { req, sandboxes } = setup({ commands: ['true'] }, 'services: [redis]\n');
    const refused = runCleanVerify(req);
    await expect(refused).rejects.toThrow('The service redis is not available');
    await expect(refused).rejects.toBeInstanceOf(RepoConfigRefusal);
    expect(sandboxes.ran).toEqual([]);
    expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-verify');
  });

  it("a repository with services: a required proof is unavailable, naming them, as the shots get none of them (ORC-282)", async () => {
    const { req, shooter, sandboxes } = visual({ page: 'new page\n', config: `${VISUAL}services: [postgres]
` });
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(true);
    expect(res.visual?.proof).toMatchObject({ decision: 'required', unavailable: expect.stringContaining('postgres') });
    expect(shooter.calls).toEqual([]);
    expect(sandboxes.created.map((c) => c.runId)).not.toContain(`${req.runId}-visual-after`);
  });

  it('the base is read before any code of the agent runs: a command that rewrites the clone changes nothing of the before', async () => {
    const { req, shooter } = visual({ page: 'new page\n', commands: ['git --git-dir=.git update-ref refs/factory/base HEAD; true'] });
    await runCleanVerify(req);
    expect(shooter.seen).toContain('old page');
  });
});

describe("a human's push on the agent's branch (ORC-159)", () => {
  /** The agent's branch published on the forge, then a human's commit pushed on top of it from another clone. */
  function pushedByHuman(over: Partial<CleanVerifyRequest> = {}, files: Record<string, string> = { 'h.txt': 'human\n' }) {
    const s = setup(over);
    git(s.repo, 'push', '-q', 'origin', BRANCH);
    const human = join(s.base, 'human');
    git(s.base, 'clone', '-q', '--branch', BRANCH, s.origin, human);
    identity(human);
    for (const [path, content] of Object.entries(files)) write(human, path, content);
    commit(human, 'a human fixes it');
    git(human, 'push', '-q', 'origin', BRANCH);
    return { ...s, human, pushed: git(human, 'rev-parse', 'HEAD') };
  }

  it('criterion 1: checks the pushed commit as the forge holds it, in a fresh clone, without reading the worktree', async () => {
    const { repo, sandboxes, req, pushed } = pushedByHuman({ commands: ['grep human h.txt'] });
    const res = await runCleanVerify({ ...req, head: pushed });
    expect(res).toMatchObject({ ok: true, failures: [], sha: pushed });
    // The worktree is still on the agent's commit, and no sandbox made a bundle of it.
    expect(git(repo, 'rev-parse', BRANCH)).not.toBe(pushed);
    expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-bundle');
    const box = sandboxes.created.find((c) => c.runId === 'r1-verify')!;
    expect(box).toMatchObject({ network: 'none', mounts: [] });
    expect(box.workspacePath).not.toBe(repo);
    expect(sandboxes.ran.map((r) => r.command)).toEqual(['grep human h.txt']);
  });

  it('the clone the commands run in records no remote: the forge URL and its credentials stay out of it', async () => {
    const { req, pushed } = pushedByHuman({ commands: ['test -z "$(git config --get-regexp ^remote[.])"'] });
    expect(await runCleanVerify({ ...req, head: pushed })).toMatchObject({ ok: true, failures: [] });
  });

  it('a pushed commit no longer on the branch (a history rewritten since) gives no verdict', async () => {
    const { req } = pushedByHuman({ commands: [] });
    await expect(runCleanVerify({ ...req, head: 'b'.repeat(40) })).rejects.toThrow('is no longer on the forge');
  });

  it('criterion 3: a human commit that changes a frozen test fails factory/tests-gelés', async () => {
    const { req, pushed } = pushedByHuman({ commands: [], frozen: { sha: 's', files: { 'a.txt': sha256('committed\n') } } }, { 'a.txt': 'changed by a human\n' });
    const res = await runCleanVerify({ ...req, head: pushed });
    expect(res.failures).toEqual([expect.objectContaining({ command: 'factory/tests-gelés', output: expect.stringContaining('a.txt') })]);
  });

  describe('criterion 2: the work published after a push carries it', () => {
    it('a commit of the agent that does not carry the push fails factory/commits-humains before anything runs', async () => {
      const { sandboxes, req, pushed } = pushedByHuman();
      const res = await runCleanVerify({ ...req, humanHead: pushed });
      expect(res.ok).toBe(false);
      expect(res.failures).toEqual([{ command: 'factory/commits-humains', exitCode: 1, output: expect.stringContaining(`git rebase origin/${BRANCH}`) }]);
      expect(sandboxes.ran).toEqual([]);
    });

    it('nor is a commit found green before the push taken as it is', async () => {
      const { repo, req, pushed } = pushedByHuman();
      const res = await runCleanVerify({ ...req, humanHead: pushed, green: git(repo, 'rev-parse', BRANCH) });
      expect(res.failures.map((f) => f.command)).toEqual(['factory/commits-humains']);
    });

    it('the agent rebased on top of the push: checked as any commit', async () => {
      const { repo, req, pushed } = pushedByHuman({ commands: ['grep human h.txt', 'grep agent b.txt'] });
      git(repo, 'fetch', '-q', 'origin');
      git(repo, 'rebase', '-q', `origin/${BRANCH}`);
      write(repo, 'b.txt', 'agent\n');
      commit(repo, 'the agent goes on');
      expect(await runCleanVerify({ ...req, humanHead: pushed })).toMatchObject({ ok: true, failures: [] });
    });
  });
});

/**
 * A vitest of the test's making, on the base and the commit: it writes its JSON report where `--outputFile.json` says, each
 * test of `plan` (by side: the commit holds `a.txt`, the base does not) with its next outcome, or its last; `-t` runs one.
 */
const fakeVitest = (state: string, plan: Record<'head' | 'base', Record<string, ('passed' | 'failed')[]>>) => `
const fs = require('fs');
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
const t = args.indexOf('-t');
const side = fs.existsSync('a.txt') ? 'head' : 'base';
const results = [];
for (const [name, seq] of Object.entries(${JSON.stringify(plan)}[side])) {
  if (t >= 0 && !new RegExp(args[t + 1]).test(name)) continue;
  const count = ${JSON.stringify(state)} + '/' + side + '-' + name.replace(/[^A-Za-z0-9]/g, '_');
  const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0;
  fs.writeFileSync(count, String(n + 1));
  const status = seq[Math.min(n, seq.length - 1)];
  results.push({ fullName: name, title: name, status, duration: 5, failureMessages: status === 'failed' ? ['AssertionError: ' + name + ' broke'] : [] });
}
fs.writeFileSync(out, JSON.stringify({ testResults: [{ name: '/work/src/a.test.ts', assertionResults: results }] }));
process.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
`;

describe('flaky tests in verify (ORC-164)', () => {
  const withVitest = (plan: Parameters<typeof fakeVitest>[1], over: Partial<CleanVerifyRequest> = {}) => {
    const state = mkdtempSync(join(tmpdir(), 'factory-flaky-'));
    return setup({ commands: ['node bin/vitest run'], ...over }, undefined, { 'bin/vitest': fakeVitest(state, plan) });
  };

  it('criteria 1 and 2: reruns a failing test once on the commit and once on the base, each in its sandbox, the cause of each attempt recorded', async () => {
    const { sandboxes, req } = withVitest({ head: { 'cart total': ['failed'], 'cart ok': ['passed'] }, base: { 'cart total': ['failed'] } });
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(res.flaky).toEqual([
      {
        command: 'node bin/vitest run', test: 'src/a.test.ts > cart total', file: 'src/a.test.ts', name: 'cart total',
        attempts: [
          { on: 'head', attempt: 1, outcome: 'failed', durationMs: 5, output: 'AssertionError: cart total broke' },
          { on: 'head', attempt: 2, outcome: 'failed', durationMs: expect.any(Number), output: 'AssertionError: cart total broke' },
          { on: 'base', attempt: 1, outcome: 'failed', durationMs: expect.any(Number), output: 'AssertionError: cart total broke' },
        ],
      },
    ]);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.output).toContain('`src/a.test.ts > cart total`: failed again on its rerun; fails on the base commit too: not caused by this ticket');
    // Each run, then the read of its report.
    expect(sandboxes.ran.map((r) => r.box)).toEqual(['r1-verify', 'r1-verify', 'r1-verify', 'r1-verify', 'r1-verify-base', 'r1-verify-base']);
    const baseBox = sandboxes.created.find((c) => c.runId === 'r1-verify-base')!;
    expect(baseBox).toMatchObject({ network: 'none', mounts: [] });
    expect(baseBox.workspacePath).toBe(join(req.workDir, 'before'));
  });

  it('a test that passes on its rerun is said flaky to the agent, still counted: only a known flaky test is indicative', async () => {
    const { req } = withVitest({ head: { 'cart total': ['failed', 'passed'] }, base: { 'cart total': ['passed'] } });
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(res.failures[0]!.output).toContain('`src/a.test.ts > cart total`: failed, then passed on its rerun: flaky on this commit; passes on the base commit');
  });

  it('criterion 3: a known flaky test is marked indicative before the agent sees the verdict: alone failing, the commit passes', async () => {
    const { req } = withVitest(
      { head: { 'cart total': ['failed'], 'cart ok': ['passed'] }, base: { 'cart total': ['passed'] } },
      { knownFlaky: [{ test: 'src/a.test.ts > cart total', coversFrozen: false }] },
    );
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(res.flaky).toEqual([expect.objectContaining({ test: 'src/a.test.ts > cart total', indicative: true })]);
  });

  it('through `npm test`, asks the script for its report and reruns its failing test past the `--` (ORC-420)', async () => {
    const state = mkdtempSync(join(tmpdir(), 'factory-flaky-'));
    const plan = { head: { 'cart total': ['failed' as const, 'passed' as const] }, base: { 'cart total': ['passed' as const] } };
    const files = { 'bin/vitest': fakeVitest(state, plan), 'package.json': JSON.stringify({ scripts: { test: 'node bin/vitest run' } }) };
    const { sandboxes, req } = setup({ commands: ['npm test'] }, undefined, files);
    const res = await runCleanVerify(req);
    expect(res.flaky).toEqual([
      expect.objectContaining({
        command: 'npm test', test: 'src/a.test.ts > cart total',
        attempts: [expect.objectContaining({ on: 'head', outcome: 'failed' }), expect.objectContaining({ on: 'head', outcome: 'passed' }), expect.objectContaining({ on: 'base', outcome: 'passed' })],
      }),
    ]);
    expect(res.failures.map((f) => f.command)).toEqual(['npm test']);
    const lines = sandboxes.ran.filter((r) => r.command.includes('npm test')).map((r) => r.command);
    expect(lines.some((l) => l.includes("npm test -- 'src/a.test.ts' -t 'cart total' --reporter=default"))).toBe(true);
  });

  it('a passing run reruns nothing', async () => {
    const { sandboxes, req } = withVitest({ head: { 'cart ok': ['passed'] }, base: {} });
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(res.flaky).toBeUndefined();
    expect(sandboxes.created.map((c) => c.runId)).not.toContain('r1-verify-base');
  });
});

describe('factory/qualité-diff (ORC-280)', () => {
  const report = (functions: unknown[] = [], pairs: unknown[] = []) => ({ stdout: JSON.stringify({ functions, pairs }), stderr: '', code: 0 });
  const grade = { path: 'src/a.ts', name: 'grade', start: 1, end: 3, cc: 9, coverage: 0, crap: 90 };

  it('runs crapper and dryer after the commands, in their sandbox, on the files the diff adds lines to, and keeps what they list', async () => {
    const { repo, sandboxes, req } = setup({ quality: true });
    write(repo, 'src/a.ts', 'export function grade() {\n  return 1;\n}\n');
    commit(repo, 'grade');
    let seen: { argv: readonly string[]; box: SandboxRequest } | undefined;
    sandboxes.quality = (argv, box) => ((seen = { argv, box }), report([grade]));
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(res.quality).toEqual({ functions: [grade], pairs: [] });
    expect(seen!.box).toMatchObject({ runId: 'r1-verify', network: 'none' });
    expect(seen!.argv.slice(seen!.argv.indexOf('--') + 1).sort()).toEqual(['a.txt', 'src/a.ts']);
  });

  it('measures nothing when the request does not ask for it', async () => {
    const { sandboxes, req } = setup();
    let ran = false;
    sandboxes.quality = () => ((ran = true), report());
    const res = await runCleanVerify(req);
    expect(ran).toBe(false);
    expect(res.quality).toBeUndefined();
  });

  it('keeps the verdict green when the tools break down, and says why', async () => {
    const { sandboxes, req } = setup({ quality: true });
    sandboxes.quality = () => ({ stdout: '', stderr: 'python: not found', code: 127 });
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, failures: [], quality: { unavailable: expect.stringContaining('python: not found') } });
  });

  it('asks vitest for an LCOV on its first run when the commit installs a coverage package, and reads it there', async () => {
    const pkg = JSON.stringify({ devDependencies: { '@vitest/coverage-v8': '^5', vitest: '^5' } });
    const { sandboxes, req } = setup({ quality: true, commands: ['npx vitest run'] }, undefined, { 'package.json': pkg });
    sandboxes.answer = (command) => (command.includes('vitest run') ? { stdout: '', stderr: '', code: 0 } : undefined);
    let argv: readonly string[] = [];
    sandboxes.quality = (a) => ((argv = a), report());
    await runCleanVerify(req);
    const line = sandboxes.ran.find((r) => r.command.includes('vitest run'))!.command;
    expect(line).toContain('--coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov');
    expect(line).toContain(`--coverage.reportsDirectory=${argv[5]}/0`);
    expect(argv[6]).toBe('typescript');
  });

  it('a first run the coverage made fail is run again without it, whose exit is the verdict: the measure never fails the tests', async () => {
    const pkg = JSON.stringify({ devDependencies: { '@vitest/coverage-v8': '^5' } });
    const { sandboxes, req } = setup({ quality: true, commands: ['npx vitest run'] }, undefined, { 'package.json': pkg });
    sandboxes.answer = (command) => (command.includes('vitest run') ? { stdout: '', stderr: 'MISSING DEPENDENCY', code: command.includes('--coverage') ? 1 : 0 } : undefined);
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(sandboxes.ran.filter((r) => r.command.includes('vitest run')).map((r) => r.command.includes('--coverage'))).toEqual([true, false]);
  });

  /** The runner's JSON report where the command asks for it (`reportRun`): its tests, with their outcome. */
  const reportTests = (command: string, tests: Record<string, 'passed' | 'failed'>) => {
    const f = /factory-report-[\w-]+/.exec(command)?.[0];
    const assertionResults = Object.entries(tests).map(([name, status]) => ({ fullName: name, title: name, status, duration: 5, failureMessages: status === 'failed' ? [`AssertionError: ${name}`] : [] }));
    if (f) writeFileSync(join(process.env['TMPDIR'] || '/tmp', f), JSON.stringify({ testResults: [{ name: '/work/src/a.test.ts', assertionResults }] }));
  };
  /** The whole suite's runs, not the reruns of a test (`-t`): whether each asked for the coverage. */
  const suiteRuns = (sandboxes: LocalSandboxes) => sandboxes.ran.filter((r) => r.command.includes('vitest run') && !r.command.includes(' -t ')).map((r) => r.command.includes('--coverage'));

  it('a red first run whose report names a failing test is the verdict: a failing suite is not run twice', async () => {
    const pkg = JSON.stringify({ devDependencies: { '@vitest/coverage-v8': '^5' } });
    const { sandboxes, req } = setup({ quality: true, commands: ['npx vitest run'] }, undefined, { 'package.json': pkg });
    sandboxes.answer = (command) => {
      if (!command.includes('vitest run')) return undefined;
      reportTests(command, { 'cart total': 'failed' });
      return { stdout: '', stderr: 'AssertionError', code: 1 };
    };
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(suiteRuns(sandboxes)).toEqual([true]);
  });

  it.each([
    'ERROR: Coverage for lines (80%) does not meet "src/**" threshold (95%)',
    'ERROR: Uncovered lines (42) exceed "src/**" threshold (10)',
  ])('a red first run whose report names no failing test failed for the coverage (a threshold the flags leave: %s), and is run again without it', async (missed) => {
    const pkg = JSON.stringify({ devDependencies: { '@vitest/coverage-v8': '^5' } });
    const { sandboxes, req } = setup({ quality: true, commands: ['npx vitest run'] }, undefined, { 'package.json': pkg });
    sandboxes.answer = (command) => {
      if (!command.includes('vitest run')) return undefined;
      reportTests(command, { 'cart total': 'passed' });
      // vitest writes its LCOV, then exits 1 on a glob's threshold: a percentage (`{ 'src/**': { lines: 95 } }`) or a count of uncovered lines (`lines: -10`).
      const dir = /--coverage\.reportsDirectory=(\S+)/.exec(command)?.[1];
      if (dir) write(dir, 'lcov.info', 'SF:src/a.ts\nend_of_record\n');
      return { stdout: '', stderr: dir ? missed : '', code: dir ? 1 : 0 };
    };
    const res = await runCleanVerify(req);
    rmSync(/factory-coverage-[^/]+/.exec(sandboxes.ran.find((r) => r.command.includes('reportsDirectory'))!.command)![0].replace(/^/, '/tmp/'), { recursive: true, force: true });
    expect(res).toMatchObject({ ok: true, failures: [] });
    expect(suiteRuns(sandboxes)).toEqual([true, false]);
  });

  it('a red first run with no test to name (a hook, an unhandled error) is the verdict once it wrote its LCOV: an intermittent failure does not vanish into a second run', async () => {
    const pkg = JSON.stringify({ devDependencies: { '@vitest/coverage-v8': '^5' } });
    for (const report of [undefined, { 'cart total': 'passed' as const }]) {
      const { sandboxes, req } = setup({ quality: true, commands: ['npx vitest run'] }, undefined, { 'package.json': pkg });
      sandboxes.answer = (command) => {
        if (!command.includes('vitest run')) return undefined;
        // A beforeAll that times out: no test failed, the report names none (or none at all), and the next run passes.
        if (report) reportTests(command, report);
        const dir = /--coverage\.reportsDirectory=(\S+)/.exec(command)?.[1];
        if (dir) write(dir, 'lcov.info', 'SF:src/a.ts\nend_of_record\n');
        return { stdout: '', stderr: dir ? 'Error: Hook timed out in 10000ms' : '', code: dir ? 1 : 0 };
      };
      const res = await runCleanVerify(req);
      rmSync(/factory-coverage-[^/]+/.exec(sandboxes.ran.find((r) => r.command.includes('reportsDirectory'))!.command)![0].replace(/^/, '/tmp/'), { recursive: true, force: true });
      expect(res.ok).toBe(false);
      expect(suiteRuns(sandboxes)).toEqual([true]);
    }
  });

  it('asks for the coverage once: a failing command and its reruns go without it', async () => {
    const pkg = JSON.stringify({ devDependencies: { '@vitest/coverage-v8': '^5' } });
    const { sandboxes, req } = setup({ quality: true, commands: ['npx vitest run'] }, undefined, { 'package.json': pkg });
    sandboxes.answer = (command) => (command.includes('vitest run') ? { stdout: '', stderr: 'AssertionError', code: 1 } : undefined);
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(sandboxes.ran.filter((r) => r.command.includes('--coverage'))).toHaveLength(1);
  });

  it('runs under a cap of its own, and a sandbox that rejects it leaves the verdict as it was', async () => {
    const { sandboxes, req } = setup({ quality: true });
    let argv: readonly string[] = [];
    sandboxes.quality = (a) => {
      argv = a;
      throw new Error('the sandbox no longer responds');
    };
    const res = await runCleanVerify(req);
    expect(argv.slice(0, 2)).toEqual(['timeout', '120']);
    expect(res).toMatchObject({ ok: true, failures: [], quality: { unavailable: expect.stringContaining('no longer responds') } });
  });

  it('says a diff over 500 files is not measured', async () => {
    // `max_diff` off: past its bounds the size check refuses the branch before anything runs.
    const { repo, sandboxes, req } = setup({ quality: true, maxDiff: 'off' });
    for (let i = 0; i < 501; i++) write(repo, `src/f${i}.ts`, `export const v${i} = ${i};\n`);
    commit(repo, 'wide');
    let ran = false;
    sandboxes.quality = () => ((ran = true), report());
    const res = await runCleanVerify(req);
    expect(ran).toBe(false);
    expect(res.quality).toMatchObject({ unavailable: expect.stringContaining('502 files') });
  });

  it('adds nothing to the tests when the commit has no coverage package, and reads no coverage', async () => {
    const { sandboxes, req } = setup({ quality: true, commands: ['npx vitest run'] }, undefined, { 'package.json': JSON.stringify({ devDependencies: { vitest: '^5' } }) });
    sandboxes.answer = (command) => (command.includes('vitest run') ? { stdout: '', stderr: '', code: 0 } : undefined);
    let argv: readonly string[] = [];
    sandboxes.quality = (a) => ((argv = a), report());
    await runCleanVerify(req);
    expect(sandboxes.ran.find((r) => r.command.includes('vitest run'))!.command).not.toContain('--coverage');
    expect(argv[6]).toBe('');
  });
});

describe('the property tests run again with the factory settings (ORC-261)', () => {
  const PROPERTY = 'src/orc-1.property-1.test.ts';
  const withProperty = (over: Partial<CleanVerifyRequest> = { properties: 1 }) => {
    const s = setup({ commands: ['npx vitest run'], ...over });
    write(s.repo, PROPERTY, "import fc from 'fast-check';\nfc.assert(fc.property(fc.integer(), () => true), { numRuns: 5 });\n");
    commit(s.repo, 'property');
    return s;
  };
  const rerunLine = `npx vitest run '${PROPERTY}'`;
  const written = (ran: { command: string }[]) =>
    ran.flatMap((r) => {
      const b64 = /printf %s (\S+) \| base64 -d > '([^']+)'/.exec(r.command);
      return b64 ? [{ path: b64[2], content: Buffer.from(b64[1]!, 'base64').toString() }] : [];
    });

  it('reruns them once the commands pass, their settings over the file, and says the runs and the seed', async () => {
    const { sandboxes, req } = withProperty();
    sandboxes.answer = (command) => (command.includes('npx vitest run') ? { stdout: '', stderr: '', code: 0 } : undefined);
    const res = await runCleanVerify(req);
    expect(res).toMatchObject({ ok: true, failures: [], properties: { runs: 1000, files: [PROPERTY], unsettled: [], notRun: [], found: false } });
    const commands = sandboxes.ran.filter((r) => r.box === 'r1-verify').map((r) => r.command);
    expect(commands.at(-1)).toBe(rerunLine);
    expect(written(sandboxes.ran)).toEqual([{ path: PROPERTY, content: expect.stringContaining(`numRuns: 1000, seed: ${res.properties!.seed}, path: undefined`) }]);
  });

  it('a red rerun fails verify, with the runs and the seed, and counts as a defect the properties found', async () => {
    const { sandboxes, req } = withProperty();
    sandboxes.answer = (command) => (command.includes('npx vitest run') ? { stdout: 'Property failed after 412 tests', stderr: '', code: command === rerunLine ? 1 : 0 } : undefined);
    const res = await runCleanVerify(req);
    expect(res.ok).toBe(false);
    expect(res.properties!.found).toBe(true);
    expect(res.failures).toEqual([{ command: rerunLine, exitCode: 1, output: expect.stringMatching(new RegExp(`^Property tests rerun by the factory: 1000 runs, seed ${res.properties!.seed},[\\s\\S]*412 tests`)) }]);
  });

  it('reruns nothing when a command failed, nor without approved properties', async () => {
    const red = withProperty();
    red.sandboxes.answer = (command) => (command.includes('npx vitest run') ? { stdout: '', stderr: '', code: 1 } : undefined);
    const failed = await runCleanVerify(red.req);
    expect(failed.properties).toBeUndefined();
    expect(red.sandboxes.ran.map((r) => r.command)).not.toContain(rerunLine);
    const none = withProperty({});
    none.sandboxes.answer = (command) => (command.includes('npx vitest run') ? { stdout: '', stderr: '', code: 0 } : undefined);
    expect((await runCleanVerify(none.req)).properties).toBeUndefined();
    expect(none.sandboxes.ran.map((r) => r.command)).not.toContain(rerunLine);
  });
});
