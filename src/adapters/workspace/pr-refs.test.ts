import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCmd } from '../exec.js';
import { bringPrRefs, fastForward } from './pr-refs.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: ENV }).toString().trim();

let root: string;
let forge: string;
let repo: string;
let human: string;
let agent: string;
let bundleDir: string;

/** A commit on `branch` of `clone`, pushed to the forge. */
function push(clone: string, branch: string, file: string): string {
  git(clone, 'checkout', '--quiet', branch);
  writeFileSync(join(clone, file), file);
  git(clone, 'add', file);
  git(clone, 'commit', '--quiet', '-m', file);
  git(clone, 'push', '--quiet', 'origin', branch);
  return git(clone, 'rev-parse', 'HEAD');
}

/** Git in the agent's repository, as the sandbox runs it. Its `origin` points nowhere: it has no network. */
const inWorktree = (args: readonly string[]) => execCmd('git', ['-C', agent, ...args], { env: ENV });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-refs-'));
  forge = join(root, 'forge.git');
  repo = join(root, 'repo');
  human = join(root, 'human');
  agent = join(root, 'agent');
  bundleDir = join(root, 'bundle');
  mkdirSync(bundleDir);
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', forge]);
  execFileSync('git', ['clone', '--quiet', forge, human], { env: ENV });
  writeFileSync(join(human, 'README.md'), 'base');
  git(human, 'add', '.');
  git(human, 'commit', '--quiet', '-m', 'base');
  git(human, 'push', '--quiet', 'origin', 'main');
  git(human, 'checkout', '--quiet', '-b', 'factory/rel-1');
  push(human, 'factory/rel-1', 'feature.txt');
  execFileSync('git', ['clone', '--quiet', forge, repo], { env: ENV });
  // The agent's own repository (ORC-317): the factory's refs copied, no remote it could reach.
  execFileSync('git', ['init', '--quiet', '-b', 'main', agent]);
  git(agent, 'fetch', '--quiet', repo, '+refs/remotes/origin/*:refs/remotes/origin/*');
  git(agent, 'remote', 'add', 'origin', join(root, 'nowhere'));
  git(agent, 'checkout', '--quiet', '-b', 'factory/rel-1', 'refs/remotes/origin/factory/rel-1');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bringPrRefs (ORC-322)', () => {
  it("brings a human push and a moved base into the agent's repository, from the factory's", async () => {
    const pushed = push(human, 'factory/rel-1', 'human.txt');
    const moved = push(human, 'main', 'trunk.txt');
    const got = await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true });
    expect(got).toEqual({ head: pushed, base: moved });
    expect(git(agent, 'rev-parse', 'refs/remotes/origin/factory/rel-1')).toBe(pushed);
    expect(git(agent, 'rev-parse', 'refs/remotes/origin/main')).toBe(moved);
  });

  it("sends only what the agent's repository lacks", async () => {
    push(human, 'factory/rel-1', 'human.txt');
    await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true });
    const heads = execFileSync('git', ['bundle', 'list-heads', join(bundleDir, 'pr.bundle')]).toString();
    expect(heads).toContain('refs/remotes/origin/factory/rel-1');
    expect(heads).not.toContain('refs/remotes/origin/main');
  });

  it('makes no bundle when nothing moved', async () => {
    const head = git(agent, 'rev-parse', 'HEAD');
    expect(await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true })).toMatchObject({ head });
    expect(readdirSync(bundleDir)).toEqual([]);
  });

  it("takes the factory's refs as they are without a fetch", async () => {
    const before = git(agent, 'rev-parse', 'refs/remotes/origin/factory/rel-1');
    push(human, 'factory/rel-1', 'human.txt');
    expect(await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: false })).toMatchObject({ head: before });
  });

  it('sets a ref the agent already holds the commit of without a bundle: the base fast-forwarded onto the PR head', async () => {
    const pushed = push(human, 'factory/rel-1', 'human.txt');
    await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true });
    // The PR merged into main by a fast-forward: main's new tip is a commit the agent already has.
    git(human, 'checkout', '--quiet', 'main');
    git(human, 'merge', '--quiet', '--ff-only', 'factory/rel-1');
    git(human, 'push', '--quiet', 'origin', 'main');
    rmSync(join(bundleDir, 'pr.bundle'));
    expect(await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true })).toEqual({ head: pushed, base: pushed });
    expect(git(agent, 'rev-parse', 'refs/remotes/origin/main')).toBe(pushed);
    expect(readdirSync(bundleDir)).toEqual([]);
  });

  it('follows a force-pushed branch', async () => {
    git(human, 'checkout', '--quiet', 'factory/rel-1');
    git(human, 'reset', '--quiet', '--hard', 'main');
    writeFileSync(join(human, 'rewritten.txt'), 'x');
    git(human, 'add', 'rewritten.txt');
    git(human, 'commit', '--quiet', '-m', 'rewritten');
    git(human, 'push', '--quiet', '--force', 'origin', 'factory/rel-1');
    const rewritten = git(human, 'rev-parse', 'HEAD');
    expect(await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true })).toMatchObject({ head: rewritten });
    expect(git(agent, 'rev-parse', 'refs/remotes/origin/factory/rel-1')).toBe(rewritten);
  });

  it("brings everything to an agent's repository without origin refs", async () => {
    git(agent, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(agent, 'update-ref', '-d', 'refs/remotes/origin/factory/rel-1');
    const got = await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true });
    expect(git(agent, 'rev-parse', 'refs/remotes/origin/main')).toBe(got.base);
    expect(git(agent, 'rev-parse', 'refs/remotes/origin/factory/rel-1')).toBe(got.head);
  });

  it('takes a branch name git allows, beyond ASCII', async () => {
    git(human, 'checkout', '--quiet', '-b', 'feature/café+1', 'main');
    const tip = push(human, 'feature/café+1', 'cafe.txt');
    expect(await bringPrRefs({ repoPath: repo, branch: 'feature/café+1', base: 'main', bundleDir, inWorktree, fetch: true })).toMatchObject({ head: tip });
  });

  it('refuses a branch name git would read as an option or a range', async () => {
    for (const branch of ['--upload-pack=x', 'a..b', 'a b', '@{-1}', 'main']) {
      await expect(bringPrRefs({ repoPath: repo, branch, base: 'main', bundleDir, inWorktree })).rejects.toThrow(/branch name|is its base/);
    }
  });
});

describe('fastForward (ORC-322)', () => {
  it('moves the branch to the PR head when only the forge has new commits', async () => {
    const pushed = push(human, 'factory/rel-1', 'human.txt');
    await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true });
    expect(await fastForward(inWorktree, 'factory/rel-1')).toBe('fast-forwarded');
    expect(git(agent, 'rev-parse', 'HEAD')).toBe(pushed);
  });

  it('leaves a branch that already holds the PR head alone', async () => {
    writeFileSync(join(agent, 'mine.txt'), 'x');
    git(agent, 'add', 'mine.txt');
    git(agent, 'commit', '--quiet', '-m', 'mine');
    expect(await fastForward(inWorktree, 'factory/rel-1')).toBe('up-to-date');
  });

  it('fails on a git error rather than calling it a divergence', async () => {
    git(agent, 'update-ref', '-d', 'refs/remotes/origin/factory/rel-1');
    await expect(fastForward(inWorktree, 'factory/rel-1')).rejects.toThrow(/merge-base/);
  });

  it('says so when the branch and the forge have diverged, and moves nothing', async () => {
    push(human, 'factory/rel-1', 'human.txt');
    await bringPrRefs({ repoPath: repo, branch: 'factory/rel-1', base: 'main', bundleDir, inWorktree, fetch: true });
    writeFileSync(join(agent, 'mine.txt'), 'x');
    git(agent, 'add', 'mine.txt');
    git(agent, 'commit', '--quiet', '-m', 'mine');
    const head = git(agent, 'rev-parse', 'HEAD');
    expect(await fastForward(inWorktree, 'factory/rel-1')).toBe('diverged');
    expect(git(agent, 'rev-parse', 'HEAD')).toBe(head);
  });
});
