import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cloneAtStart, knowledgeAt, linkedAsOf } from './history.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ghost-history-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** git in `cwd`, at a fixed committer date when given (seconds since the epoch). */
function git(cwd: string, args: string[], at?: number): string {
  const date = at === undefined ? {} : { GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` };
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...process.env, ...date }, encoding: 'utf8' }).trim();
}
function commit(repo: string, file: string, at?: number): string {
  writeFileSync(join(repo, file), file);
  git(repo, ['add', file]);
  git(repo, ['commit', '-qm', file], at);
  return git(repo, ['rev-parse', 'HEAD']);
}
/** A repository a forge would serve: any commit fetchable by its sha, as GitHub allows. */
function origin(): string {
  const repo = temp();
  git(repo, ['init', '-q']);
  git(repo, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return repo;
}

describe('the historical environment of a replayed ticket (ORC-231)', () => {
  it('criterion 2: the clone holds the parent of the merge commit and no commit after it', async () => {
    const repo = origin();
    commit(repo, 'a.txt');
    const base = commit(repo, 'b.txt');
    git(repo, ['checkout', '-qb', 'feature']);
    const work = commit(repo, 'feature.txt');
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '--no-ff', '-qm', 'merge the PR', 'feature']);
    const merge = git(repo, ['rev-parse', 'HEAD']);
    const later = commit(repo, 'later.txt');

    const dir = join(temp(), 'clone');
    expect(await cloneAtStart({ remote: repo, mergeSha: merge, dir })).toBe(base);
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(base);
    expect(git(dir, ['rev-list', '--all']).split('\n')).toEqual([base]);
    for (const sha of [merge, work, later]) expect(() => git(dir, ['cat-file', '-e', sha])).toThrow();
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);
    expect(existsSync(join(dir, 'feature.txt'))).toBe(false);
    expect(existsSync(join(dir, 'later.txt'))).toBe(false);
    // Nothing points back at the forge: a fetch of the agent's finds no remote.
    expect(git(dir, ['remote'])).toBe('');
  });

  it('a squash merge has one parent: the start is the commit the PR was squashed onto', async () => {
    const repo = origin();
    const base = commit(repo, 'a.txt');
    const squash = commit(repo, 'squashed.txt');
    commit(repo, 'later.txt');
    const dir = join(temp(), 'clone');
    expect(await cloneAtStart({ remote: repo, mergeSha: squash, dir })).toBe(base);
    expect(git(dir, ['rev-list', '--all']).split('\n')).toEqual([base]);
  });

  it("a rebase merge has the PR's commits replayed on the base: the start is before the first of them, none in the clone", async () => {
    const repo = origin();
    const base = commit(repo, 'a.txt');
    const first = commit(repo, 'one.txt');
    const second = commit(repo, 'two.txt');
    const last = commit(repo, 'three.txt');
    commit(repo, 'later.txt');
    const dir = join(temp(), 'clone');
    expect(await cloneAtStart({ remote: repo, mergeSha: last, dir, prCommits: ['one.txt', 'two.txt', 'three.txt'] })).toBe(base);
    expect(git(dir, ['rev-list', '--all']).split('\n')).toEqual([base]);
    for (const sha of [first, second]) expect(() => git(dir, ['cat-file', '-e', sha])).toThrow();
  });

  it("a squash of several commits is no rebase: its single commit does not carry the last commit's message", async () => {
    const repo = origin();
    const base = commit(repo, 'a.txt');
    const squash = commit(repo, 'squashed.txt');
    const dir = join(temp(), 'clone');
    expect(await cloneAtStart({ remote: repo, mergeSha: squash, dir, prCommits: ['wip', 'fix tests'] })).toBe(base);
  });

  it('the knowledge base at transaction time: its last commit before the start, and nothing committed after', async () => {
    const kb = origin();
    const t0 = 1_700_000_000;
    const before = commit(kb, 'note-before.md', t0);
    commit(kb, 'note-learned-from-the-pr.md', t0 + 3600);
    const dir = join(temp(), 'kb');
    expect(await knowledgeAt({ repo: kb, before: (t0 + 60) * 1000, dir })).toBe(before);
    expect(git(dir, ['rev-list', '--all']).split('\n')).toEqual([before]);
    expect(existsSync(join(dir, 'note-before.md'))).toBe(true);
    expect(existsSync(join(dir, 'note-learned-from-the-pr.md'))).toBe(false);
  });

  it('a knowledge base with nothing before the start: none', async () => {
    const kb = origin();
    commit(kb, 'note.md', 1_700_000_000);
    expect(await knowledgeAt({ repo: kb, before: 1_600_000_000_000, dir: join(temp(), 'kb') })).toBeUndefined();
  });

  it('the linked tickets as they were at the start: none created after, no comment written after', () => {
    const start = 1000;
    const linked = linkedAsOf(
      [
        { identifier: 'REL-2', title: 'Before', description: 'd', createdAt: 500, comments: [{ body: 'old', createdAt: 600 }, { body: 'the answer, later', createdAt: 1500 }] },
        { identifier: 'REL-3', title: 'After', description: 'd', createdAt: 1200, comments: [] },
      ],
      start,
    );
    expect(linked).toEqual([{ identifier: 'REL-2', title: 'Before', description: 'd', createdAt: 500, comments: [{ body: 'old', createdAt: 600 }] }]);
  });
});
