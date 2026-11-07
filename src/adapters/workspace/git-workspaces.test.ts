import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConventions } from '../../core/prompt.js';
import { execCmd } from '../exec.js';
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
  it('says when a worktree made again comes on commits beyond the default branch, and only then (ORC-211)', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const first = await ws.prepare(req(repo));
    expect(first.ahead).toBeUndefined();
    // Removed and made again on its branch, with no commit: as a setup that a crash cut.
    await ws.cleanup('p', 'REL-1');
    expect((await ws.prepare(req(repo))).ahead).toBeUndefined();
    await ws.cleanup('p', 'REL-1');
    // Pushed by a previous attempt: what the factory finds on the forge, as it no longer shares the agent's commits.
    git(repo, 'checkout', '-q', '-b', 'factory/rel-1-export-csv');
    git(repo, 'commit', '--allow-empty', '-m', 'the agent');
    git(repo, 'push', '-q', 'origin', 'factory/rel-1-export-csv');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'factory/rel-1-export-csv');
    expect(await ws.prepare(req(repo))).toMatchObject({ fresh: true, ahead: true });
  });

  it('creates (fresh), reuses (not fresh) and removes a ticket worktree', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(w).toEqual({ path: join(root, 'p', 'REL-1'), port: 4201, branch: 'factory/rel-1-export-csv', fresh: true });
    expect(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('factory/rel-1-export-csv');
    expect(await ws.prepare(req(repo))).toEqual({ ...w, fresh: undefined });
    await ws.cleanup('p', 'REL-1');
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

  it('lists what the commits since a base changed, reads paths at the base and the head, and the uncommitted files (ORC-123)', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    git(w.path, 'config', 'user.email', 't@t');
    git(w.path, 'config', 'user.name', 't');
    mkdirSync(join(w.path, 'src'));
    writeFileSync(join(w.path, 'src', 'export.ts'), 'export const other = 1;\n');
    git(w.path, 'add', '.');
    git(w.path, 'commit', '-m', 'earlier dev work');
    // The step starts here: only its own commits count.
    const base = git(w.path, 'rev-parse', 'HEAD');
    writeFileSync(join(w.path, 'export.test.ts'), 'x\n');
    git(w.path, 'rm', '-q', 'README.md');
    git(w.path, 'add', '.');
    git(w.path, 'commit', '-m', 'tests');
    writeFileSync(join(w.path, 'draft.ts'), 'x\n');
    writeFileSync(join(w.path, 'src', 'export.ts'), 'changed\n');
    const diff = (await ws.stepDiff(repo, w.path, base))!;
    expect(diff.changed).toEqual([{ path: 'README.md', deleted: true }, { path: 'export.test.ts', deleted: false }]);
    expect(await diff.existsAtBase(['README.md', 'src', 'src/export.ts', 'export.test.ts', 'src/nope.ts'])).toEqual(new Set(['README.md', 'src', 'src/export.ts']));
    expect(await diff.showAtBase('src/export.ts')).toBe('export const other = 1;\n');
    expect(await diff.showAtHead('export.test.ts')).toBe('x\n');
    expect(await diff.showAtBase('export.test.ts')).toBeUndefined();
    expect(diff.head).toBe(await ws.head(w.path));
    expect(await diff.filesAtHead()).toContain('export.test.ts');
    expect((await ws.uncommitted(w.path)).sort()).toEqual(['draft.ts', 'src/export.ts']);
    expect(await ws.stepDiff(repo, join(root, 'nowhere'), base)).toBeUndefined();
  });

  it('prepares the read-only trunk and a knowledge worktree', async () => {
    const { repo, root } = fixtureRepo();
    const kb = fixtureRepo();
    const ws = new GitWorkspaces({ root, knowledgeRepo: kb.repo });
    const trunk = await ws.prepare(req(repo, { kind: 'trunk-readonly' }));
    expect(trunk).toEqual({ path: join(root, 'p', '_trunk', 'abcdef123456') });
    expect(git(trunk.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'origin/main'));
    await ws.release('p', 'abcdef123456');
    expect(existsSync(trunk.path)).toBe(false);
    const k = await ws.prepare(req(repo, { kind: 'knowledge' }));
    expect(k).toEqual({ path: join(root, '_kb', 'abcdef123456'), branch: 'learn/rel-1-abcdef12' });
    expect(existsSync(join(k.path, 'README.md'))).toBe(true);
  });

  it('gives each question its own trunk: what one left is not there for the next', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const one = await ws.prepare(req(repo, { kind: 'trunk-readonly', runId: 'run-one' }));
    writeFileSync(join(one.path, 'left-by-one'), 'x');
    const two = await ws.prepare(req(repo, { kind: 'trunk-readonly', runId: 'run-two' }));
    expect(two.path).not.toBe(one.path);
    expect(existsSync(join(two.path, 'left-by-one'))).toBe(false);
    expect(existsSync(join(one.path, 'left-by-one'))).toBe(true);
  });

  it('releases a trunk and nothing else: a worktree holds its unpushed commits, a project named as the trunk included', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo, { projectId: '_trunk' }));
    await ws.release('_trunk', 'REL-1');
    await ws.release('_trunk', 'abcdef123456');
    expect(existsSync(w.path)).toBe(true);
  });

  it('prefers the forge to a branch of the repository, which an agent no longer moves and can only lag behind', async () => {
    const { repo, root } = fixtureRepo();
    git(repo, 'checkout', '-q', '-b', 'factory/rel-1-export-csv');
    git(repo, 'commit', '--allow-empty', '-m', 'old, local');
    git(repo, 'push', '-q', 'origin', 'factory/rel-1-export-csv');
    git(repo, 'commit', '--allow-empty', '-m', 'on the forge');
    git(repo, 'push', '-q', 'origin', 'factory/rel-1-export-csv');
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    git(repo, 'checkout', '-q', 'main');
    const w = await new GitWorkspaces({ root }).prepare(req(repo));
    expect(git(w.path, 'log', '-1', '--format=%s')).toBe('on the forge');
  });

  it('takes a relative repoPath and a relative root, as the config allows both', async () => {
    const { base, repo } = fixtureRepo();
    const here = process.cwd();
    process.chdir(base);
    try {
      const ws = new GitWorkspaces({ root: 'rel-root' });
      const w = await ws.prepare(req('repo'));
      const start = git(w.path, 'rev-parse', 'HEAD');
      git(w.path, 'commit', '--allow-empty', '-m', 'the agent');
      expect((await ws.stepDiff('repo', w.path, start))?.changed).toEqual([]);
      expect(git(repo, 'rev-parse', 'origin/main')).toBe(start);
    } finally {
      process.chdir(here);
    }
  });

  it("makes the agent a repository of its own (ORC-317): its git dir in its worktree, the repository's settings without its hooks or its layout, on the forge's refs", async () => {
    const { repo, root } = fixtureRepo();
    git(repo, 'tag', 'v1');
    git(repo, 'push', '-q', 'origin', 'v1');
    git(repo, 'config', 'core.sshCommand', 'a-deploy-key');
    git(repo, 'config', 'core.hooksPath', '/host/hooks');
    git(repo, 'branch', 'someone-elses');
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\nexit 1\n');
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    expect(realpathSync(git(w.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'))).toBe(realpathSync(join(w.path, '.git')));
    expect(git(w.path, 'config', 'remote.origin.url')).toBe(git(repo, 'config', 'remote.origin.url'));
    expect(git(w.path, 'config', 'remote.origin.fetch')).toBe(git(repo, 'config', 'remote.origin.fetch'));
    expect(git(w.path, 'config', 'user.name')).toBe('t');
    expect(git(w.path, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
    expect(git(w.path, 'tag')).toBe('v1');
    expect(git(w.path, 'branch', '--format=%(refname:short)')).toBe('factory/rel-1-export-csv');
    expect(existsSync(join(w.path, '.git', 'hooks'))).toBe(false);
    expect(git(w.path, 'config', 'core.sshCommand')).toBe('a-deploy-key');
    expect(readFileSync(join(w.path, '.git', 'config'), 'utf8')).not.toContain('/host/hooks');
    // Neither the factory's objects by a link, nor another's name for them: the agent rewrites only its own.
    expect(existsSync(join(w.path, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    // Its commits stay out of the factory's repository, read from there all the same.
    git(w.path, 'commit', '--allow-empty', '-m', 'the agent');
    const head = (await ws.head(w.path))!;
    expect(head).toBe(git(w.path, 'rev-parse', 'HEAD'));
    expect(() => execFileSync('git', ['cat-file', '-e', head], { cwd: repo, stdio: 'ignore' })).toThrow();
  });

  it('reads the head of a repository whose refs git packed, on a branch or detached', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    const head = git(w.path, 'rev-parse', 'HEAD');
    git(w.path, 'pack-refs', '--all');
    expect(await ws.head(w.path)).toBe(head);
    expect(await ws.prepare(req(repo))).toMatchObject({ branch: 'factory/rel-1-export-csv' });
    git(w.path, 'checkout', '-q', '--detach');
    expect(await ws.head(w.path)).toBe(head);
    expect(await ws.prepare(req(repo))).toMatchObject({ branch: 'HEAD' });
    // A name git allows, however unusual, is no attack.
    for (const name of ['feat/été', 'fix/#12', 'a+b@c']) {
      git(w.path, 'checkout', '-q', '-b', name);
      expect(await ws.head(w.path)).toBe(head);
      expect(await ws.prepare(req(repo))).toMatchObject({ branch: name });
    }
  });

  it('leaves nothing a next launch would take for a worktree when the repository cannot be made', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    const fails = new GitWorkspaces({ root, exec: async (cmd, args, opts) => (args.includes('checkout') ? { stdout: '', stderr: 'boom', code: 1 } : execCmd(cmd, args, opts)) });
    await expect(fails.prepare(req(repo))).rejects.toThrow('boom');
    expect(readdirSync(join(root, 'p'))).toEqual([]);
    expect((await ws.prepare(req(repo))).fresh).toBe(true);
  });

  it("starts from a branch only the repository has, and the agent's unpushed commits go with its worktree", async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    git(repo, 'branch', 'factory/rel-1-export-csv');
    git(repo, 'checkout', '-q', 'factory/rel-1-export-csv');
    git(repo, 'commit', '--allow-empty', '-m', 'human, local only');
    git(repo, 'checkout', '-q', 'main');
    const w = await ws.prepare(req(repo));
    expect(git(w.path, 'log', '-1', '--format=%s')).toBe('human, local only');
    expect(w.ahead).toBe(true);
    git(w.path, 'commit', '--allow-empty', '-m', 'the agent, unpushed');
    await ws.cleanup('p', 'REL-1');
    const w2 = await ws.prepare(req(repo));
    expect(git(w2.path, 'log', '-1', '--format=%s')).toBe('human, local only');
  });

  it('cleanup of one ticket leaves another untouched', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    await ws.prepare(req(repo));
    const w2 = await ws.prepare(req(repo, { ticketId: 'REL-2', title: 'Other' }));
    await ws.cleanup('p', 'REL-1');
    expect(existsSync(w2.path)).toBe(true);
  });

  it("hides the repository's .claude/ from a worktree, its tracked files neither deleted nor committed (ORC-284)", async () => {
    const { repo, root } = fixtureRepo();
    mkdirSync(join(repo, '.claude', 'skills', 'piege'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(repo, '.claude', 'skills', 'piege', 'SKILL.md'), 'piege\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'claude');
    git(repo, 'push');
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    // Hidden from its creation: what a setup or an agent writes there goes at the next launch.
    expect(existsSync(join(w.path, '.claude'))).toBe(false);
    mkdirSync(join(w.path, '.claude'));
    writeFileSync(join(w.path, '.claude', 'settings.local.json'), '{}\n');
    await ws.resetClaudeDir(w.path);
    await ws.resetClaudeDir(w.path);
    expect(existsSync(join(w.path, '.claude'))).toBe(false);
    expect(git(w.path, 'status', '--porcelain')).toBe('');
    git(w.path, 'config', 'user.email', 't@t');
    git(w.path, 'config', 'user.name', 't');
    writeFileSync(join(w.path, 'README.md'), 'changed\n');
    git(w.path, 'add', '-A');
    git(w.path, 'commit', '-am', 'work');
    expect(git(w.path, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('.claude/settings.json');
    // A merge that changes it brings it back neither: the worktree's checkout leaves .claude/ out.
    git(repo, 'checkout', '-b', 'side');
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"x":1}\n');
    git(repo, 'commit', '-am', 'side');
    git(repo, 'push', '-q', 'origin', 'side');
    git(repo, 'checkout', 'main');
    git(w.path, 'fetch', '-q', 'origin');
    git(w.path, 'merge', '--no-edit', 'origin/side');
    expect(existsSync(join(w.path, '.claude'))).toBe(false);
    expect(git(w.path, 'status', '--porcelain')).toBe('');
    expect(git(w.path, 'show', 'HEAD:.claude/settings.json')).toContain('"x":1');
    // Only that worktree: the repository's own checkout keeps its .claude/.
    expect(existsSync(join(repo, '.claude', 'settings.json'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // A repository without one: nothing to do.
    const plain = fixtureRepo();
    const ws2 = new GitWorkspaces({ root: plain.root });
    await expect(ws2.resetClaudeDir((await ws2.prepare(req(plain.repo))).path)).resolves.toBeUndefined();
  });

  it('keeps .claude/CLAUDE.md on disk for readConventions, across resets and merges (ORC-205)', async () => {
    const { repo, root } = fixtureRepo();
    mkdirSync(join(repo, '.claude', 'skills', 'piege'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'CLAUDE.md'), 'run npm test\n');
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(repo, '.claude', 'skills', 'piege', 'SKILL.md'), 'piege\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'claude');
    git(repo, 'push');
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    writeFileSync(join(w.path, '.claude', 'settings.local.json'), '{}\n');
    await ws.resetClaudeDir(w.path);
    await ws.resetClaudeDir(w.path);
    expect(readdirSync(join(w.path, '.claude'))).toEqual(['CLAUDE.md']);
    expect(readConventions(w.path)).toContain('### .claude/CLAUDE.md\nrun npm test');
    expect(git(w.path, 'status', '--porcelain')).toBe('');
    // A merge that changes settings.json does not write it back.
    git(repo, 'checkout', '-b', 'side');
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"x":1}\n');
    git(repo, 'commit', '-am', 'side');
    git(repo, 'push', '-q', 'origin', 'side');
    git(repo, 'checkout', 'main');
    git(w.path, 'fetch', '-q', 'origin');
    git(w.path, 'merge', '--no-edit', 'origin/side');
    expect(readdirSync(join(w.path, '.claude'))).toEqual(['CLAUDE.md']);
    expect(git(w.path, 'status', '--porcelain')).toBe('');
  });

  it('rejects unsafe identifiers', async () => {
    const { repo, root } = fixtureRepo();
    const ws = new GitWorkspaces({ root });
    await expect(ws.prepare(req(repo, { ticketId: '../x' }))).rejects.toThrow('Invalid identifier: ../x');
    await expect(ws.prepare(req(repo, { projectId: 'a/b' }))).rejects.toThrow('Invalid identifier: a/b');
    await expect(ws.cleanup('p', '..')).rejects.toThrow('Invalid identifier: ..');
    await expect(ws.cleanup('a\\b', 'REL-1')).rejects.toThrow('Invalid identifier');
  });
});
