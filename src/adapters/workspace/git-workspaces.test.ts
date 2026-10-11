import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitWorkspaces } from './git-workspaces.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), 'relais-git-'));
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
  projectId: 'p', repoPath: repo, ticketId: 'REL-1', title: 'Export CSV', kind: 'worktree' as const, slot: 1, portBase: 4200, setup: [], runId: 'abcdef123456', ...patch,
});

describe('GitWorkspaces', () => {
  it('creates, reuses and removes a ticket worktree', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(w).toEqual({ path: join(root, 'p', 'REL-1'), port: 4201, branch: 'relais/rel-1-export-csv' });
    expect(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('relais/rel-1-export-csv');
    expect(await ws.prepare(req(repo))).toEqual(w);
    await ws.cleanup('p', repo, 'REL-1');
    expect(existsSync(w.path)).toBe(false);
  });

  it('checks out an existing remote branch', async () => {
    const { repo, root } = fixtureRepo();
    git(repo, 'checkout', '-b', 'relais/rel-1-export-csv');
    git(repo, 'commit', '--allow-empty', '-m', 'wip');
    git(repo, 'push', '-u', 'origin', 'relais/rel-1-export-csv');
    git(repo, 'checkout', 'main');
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(git(w.path, 'log', '-1', '--format=%s')).toBe('wip');
    expect(await ws.remoteBranchExists(repo, 'relais/rel-1-')).toBe(true);
    expect(await ws.remoteBranchExists(repo, 'relais/rel-2-')).toBe(false);
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

  it('fails clearly when setup fails', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    await expect(ws.prepare(req(repo, { setup: ['exit 2'] }))).rejects.toThrow('Le setup du worktree a échoué : exit 2');
  });
});
