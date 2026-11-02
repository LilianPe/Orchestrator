import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitWorkspaces } from './git-workspaces.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), 'factory-git-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '--bare', '-b', 'main', origin);
  const repo = join(base, 'repo');
  git(base, 'clone', origin, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  return { base, repo, root: join(base, 'ws') };
}

const req = (repo: string, patch: object = {}) => ({
  projectId: 'p', repoPath: repo, ticketId: 'REL-1', title: 'Export CSV', kind: 'worktree' as const, slot: 1, portBase: 4200, runId: 'abcdef123456', ...patch,
});

describe('GitWorkspaces', () => {
  it('creates (fresh), reuses (not fresh) and removes a ticket worktree', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(w).toEqual({ path: join(root, 'p', 'REL-1'), port: 4201, branch: 'factory/rel-1-export-csv', fresh: true });
    expect(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('factory/rel-1-export-csv');
    expect(await ws.prepare(req(repo))).toEqual({ ...w, fresh: undefined });
    await ws.cleanup('p', repo, 'REL-1');
    expect(existsSync(w.path)).toBe(false);
  });

  it('checks out an existing remote branch', async () => {
    const { repo, root } = fixtureRepo();
    git(repo, 'checkout', '-b', 'factory/rel-1-export-csv');
    git(repo, 'commit', '--allow-empty', '-m', 'wip');
    git(repo, 'push', '-u', 'origin', 'factory/rel-1-export-csv');
    git(repo, 'checkout', 'main');
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(git(w.path, 'log', '-1', '--format=%s')).toBe('wip');
    expect(await ws.remoteBranchExists(repo, 'factory/rel-1-')).toBe(true);
    expect(await ws.remoteBranchExists(repo, 'factory/rel-2-')).toBe(false);
  });

  it('reads the HEAD of a worktree, none for a path that is not one (ORC-148)', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(await ws.head(w.path)).toBe(git(w.path, 'rev-parse', 'HEAD'));
    expect(await ws.head(join(root, 'nowhere'))).toBeUndefined();
  });

  it('prepares the read-only trunk and a knowledge worktree', async () => {
    const { repo, root } = fixtureRepo();
    const kb = fixtureRepo();
    const ws = new GitWorkspaces({ root, knowledgeRepo: kb.repo });
    expect(await ws.prepare(req(repo, { kind: 'trunk-readonly' }))).toEqual({ path: join(root, 'p', '_trunk') });
    const k = await ws.prepare(req(repo, { kind: 'knowledge' }));
    expect(k).toEqual({ path: join(root, '_kb', 'abcdef123456'), branch: 'learn/rel-1-abcdef12' });
    expect(existsSync(join(k.path, 'README.md'))).toBe(true);
  });

  it('reads the git common dir of a worktree as an absolute path, the one its .git file points into (ORC-204)', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    const dir = await ws.gitCommonDir(w.path);
    expect(isAbsolute(dir)).toBe(true);
    expect(realpathSync(dir)).toBe(realpathSync(join(repo, '.git')));
  });

  it('keeps unpushed local commits when re-preparing after cleanup', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    git(w.path, 'config', 'user.email', 't@t');
    git(w.path, 'config', 'user.name', 't');
    git(w.path, 'commit', '--allow-empty', '-m', 'local only');
    await ws.cleanup('p', repo, 'REL-1');
    const w2 = await ws.prepare(req(repo));
    expect(git(w2.path, 'log', '-1', '--format=%s')).toBe('local only');
  });

  it('cleanup of one ticket leaves another untouched', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    await ws.prepare(req(repo));
    const w2 = await ws.prepare(req(repo, { ticketId: 'REL-2', title: 'Other' }));
    await ws.cleanup('p', repo, 'REL-1');
    expect(existsSync(w2.path)).toBe(true);
  });

  it('rejects unsafe identifiers', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    await expect(ws.prepare(req(repo, { ticketId: '../x' }))).rejects.toThrow('Identifiant invalide : ../x');
    await expect(ws.prepare(req(repo, { projectId: 'a/b' }))).rejects.toThrow('Identifiant invalide : a/b');
    await expect(ws.cleanup('p', repo, '..')).rejects.toThrow('Identifiant invalide : ..');
    await expect(ws.cleanup('a\\b', repo, 'REL-1')).rejects.toThrow('Identifiant invalide');
  });
});
