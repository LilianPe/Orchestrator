import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execCmd, type Exec, type ExecResult } from '../adapters/exec.js';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import { BundleInvalid, cloneBundle, extractWork } from './extract.js';

const BRANCH = 'factory/orc-1-x';
// Forward slashes: the trap commands run under sh, Git for Windows' too.
const slash = (p: string) => p.replace(/\\/g, '/');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The agent's worktree, with its commits, and a sandbox whose exec runs git in it (the fake isolates nothing). */
async function setup(onExec?: (argv: readonly string[], r: ExecResult) => ExecResult) {
  const base = mkdtempSync(join(tmpdir(), 'factory-extract-'));
  const repo = join(base, 'agent');
  git(base, 'init', '-q', '-b', BRANCH, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-q', '-am', 'two');
  const bundleDir = join(base, 'bundle');
  mkdirSync(bundleDir);
  // The sandbox's git sees none of the host traps a test sets in the environment.
  const empty = join(base, 'empty.gitconfig');
  writeFileSync(empty, '');
  const sandboxes = new FakeSandboxProvider();
  sandboxes.execResult = (argv) => {
    const p = spawnSync(argv[0]!, argv.slice(1), { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: empty } });
    const r = { stdout: p.stdout, stderr: p.stderr, code: p.status ?? 1 };
    return onExec ? onExec(argv, r) : r;
  };
  const { id } = await sandboxes.create({
    runId: 'r1', ticketId: 'ORC-1', workspacePath: repo, network: 'none', requirements: { minLevel: 'L3', browser: false, services: [] }, mounts: [],
  });
  const args = { sandboxes, sandboxId: id, branch: BRANCH, bundleDir, bundleTarget: bundleDir, cloneDir: join(base, 'clone') };
  return { base, repo, args };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('extractWork', () => {
  it('clones the branch from a bundle, at the SHA the sandbox reported, without a checkout', async () => {
    const { repo, args } = await setup();
    const out = await extractWork(args);
    expect(out).toEqual({ sha: git(repo, 'rev-parse', BRANCH) });
    expect(git(args.cloneDir, 'log', '--format=%s', 'HEAD')).toBe('two\none');
    expect(git(args.cloneDir, 'show', 'HEAD:a.txt')).toBe('two');
    expect(existsSync(join(args.cloneDir, 'a.txt'))).toBe(false);
  });

  it('runs no hook, fsmonitor or filter, neither the agent repo’s nor the host’s', async () => {
    const { base, repo, args } = await setup();
    const witness = join(base, 'witness');
    const trap = (name: string) => {
      const p = join(base, name);
      writeFileSync(p, `#!/bin/sh\necho ${name} >> "${slash(witness)}"\ncat\n`);
      chmodSync(p, 0o755);
      return slash(p);
    };
    const hooks = join(base, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho post-checkout >> "${slash(witness)}"\n`);
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-q', '-m', 'attrs');
    for (const cfg of [join(repo, '.git', 'config'), join(base, 'hostile.gitconfig')]) {
      execFileSync('git', ['config', '-f', cfg, 'core.fsmonitor', trap('fsmonitor')]);
      execFileSync('git', ['config', '-f', cfg, 'core.hooksPath', slash(hooks)]);
      execFileSync('git', ['config', '-f', cfg, 'filter.x.smudge', trap('smudge')]);
      execFileSync('git', ['config', '-f', cfg, 'filter.x.required', 'true']);
    }
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(base, 'hostile.gitconfig'));

    await extractWork(args);
    expect(existsSync(witness)).toBe(false);
    expect(git(args.cloneDir, 'show', 'HEAD:a.txt')).toBe('two');

    // The traps are live: a plain clone of the same bundle springs them.
    git(base, 'clone', '-q', '--branch', BRANCH, join(args.bundleDir, 'work.bundle'), join(base, 'plain'));
    expect(readFileSync(witness, 'utf8')).toMatch(/post-checkout|smudge/);
  });

  it('fails on a corrupted bundle and leaves no clone', async () => {
    const { args } = await setup((argv, r) => {
      if (argv.includes('bundle')) {
        const f = join(args.bundleDir, 'work.bundle');
        const bytes = readFileSync(f);
        writeFileSync(f, bytes.subarray(0, bytes.length - 30));
      }
      return r;
    });
    await expect(extractWork(args)).rejects.toThrow();
    expect(existsSync(args.cloneDir)).toBe(false);
  });

  it('fails when the bundled head is not the SHA the sandbox reported, and leaves no clone', async () => {
    const { args } = await setup((argv, r) => (argv.includes('rev-parse') ? { ...r, stdout: '0'.repeat(40) + '\n' } : r));
    await expect(extractWork(args)).rejects.toThrow(/0{40}/);
    expect(existsSync(args.cloneDir)).toBe(false);
  });
});

describe('cloneBundle: a bundle a human hands back (ORC-234)', () => {
  /** A human's bundle of the branch, made on their own machine: the factory has only the file. */
  async function handed() {
    const { base, repo } = await setup();
    const bundle = join(base, 'human.bundle');
    git(repo, 'bundle', 'create', '-q', bundle, BRANCH);
    return { base, repo, bundle, cloneDir: join(base, 'clone') };
  }

  it('verifies it with `git bundle verify` in a fresh repository of its own, hardened, before any clone', async () => {
    const { base, repo, bundle, cloneDir } = await handed();
    const calls: { args: string[]; cwd?: string }[] = [];
    const exec: Exec = (cmd, args, opts) => (calls.push({ args: [...args], ...(opts?.cwd ? { cwd: opts.cwd } : {}) }), execCmd(cmd, args, opts));
    expect(await cloneBundle({ bundle, branch: BRANCH, cloneDir, exec })).toEqual({ sha: git(repo, 'rev-parse', BRANCH) });
    const verify = calls.findIndex((c) => c.args.includes('verify'));
    const clone = calls.findIndex((c) => c.args.includes('clone'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(clone);
    // No hook and no fsmonitor, in a repository of its own, made empty for it, outside the human's and the agent's.
    for (const c of [calls[verify]!, calls[clone]!]) expect(c.args).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false']));
    expect(calls[verify]!.args.some((a) => a.startsWith('core.hooksPath='))).toBe(true);
    expect(calls[verify]!.cwd).toBeDefined();
    expect(calls[verify]!.cwd!.startsWith(base)).toBe(false);
    // Read as objects only: no checkout, the hardening kept in the clone's own config.
    expect(existsSync(join(cloneDir, 'a.txt'))).toBe(false);
    expect(git(cloneDir, 'config', 'core.fsmonitor')).toBe('false');
  });

  it("runs no hook, fsmonitor or filter of the host's config", async () => {
    const { base, bundle, cloneDir } = await handed();
    const witness = join(base, 'witness');
    const trap = join(base, 'trap');
    writeFileSync(trap, `#!/bin/sh\necho trap >> "${slash(witness)}"\ncat\n`);
    chmodSync(trap, 0o755);
    const hostile = join(base, 'hostile.gitconfig');
    for (const [k, v] of [['core.fsmonitor', slash(trap)], ['filter.x.smudge', slash(trap)], ['filter.x.required', 'true']] as const) execFileSync('git', ['config', '-f', hostile, k, v]);
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostile);
    await cloneBundle({ bundle, branch: BRANCH, cloneDir });
    expect(existsSync(witness)).toBe(false);
  });

  it('refuses a corrupted bundle, a bundle without the branch, a bundle that needs commits it does not carry; no clone left', async () => {
    const { base, repo, bundle, cloneDir } = await handed();
    const bytes = readFileSync(bundle);
    const cut = join(base, 'cut.bundle');
    writeFileSync(cut, bytes.subarray(0, bytes.length - 30));
    git(repo, 'branch', 'other', `${BRANCH}~1`);
    const other = join(base, 'other.bundle');
    git(repo, 'bundle', 'create', '-q', other, 'other');
    const thin = join(base, 'thin.bundle');
    git(repo, 'bundle', 'create', '-q', thin, `${BRANCH}~1..${BRANCH}`);
    for (const b of [cut, other, thin]) {
      await expect(cloneBundle({ bundle: b, branch: BRANCH, cloneDir }), b).rejects.toThrow();
      expect(existsSync(cloneDir)).toBe(false);
    }
  });

  it('refuses what is not a plain file', async () => {
    const { base, cloneDir } = await handed();
    await expect(cloneBundle({ bundle: base, branch: BRANCH, cloneDir })).rejects.toThrow(/not a plain file/);
  });

  it("tells the bundle's fault (`BundleInvalid`) from the host's, which is retried", async () => {
    const { base, bundle, cloneDir } = await handed();
    const cut = join(base, 'cut.bundle');
    writeFileSync(cut, readFileSync(bundle).subarray(0, 40));
    await expect(cloneBundle({ bundle: cut, branch: BRANCH, cloneDir })).rejects.toBeInstanceOf(BundleInvalid);
    const broken: Exec = async () => {
      throw new Error('spawn git ENOENT');
    };
    const err = await cloneBundle({ bundle, branch: BRANCH, cloneDir, exec: broken }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BundleInvalid);
  });
});
