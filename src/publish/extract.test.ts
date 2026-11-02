import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../adapters/exec.js';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import { extractWork } from './extract.js';

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
