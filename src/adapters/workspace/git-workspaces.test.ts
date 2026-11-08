import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BASE, checkBranchPaths, cloneGit, forkPoint, gitReader } from '../../core/clean-verify.js';
import { readConventions } from '../../core/prompt.js';
import { parseRepoConfig } from '../../config/repo-config.js';
import { execCmd } from '../exec.js';
import { GitWorkspaces, withoutUserinfo } from './git-workspaces.js';

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

const TOKEN_URL = 'https://x-access-token:SECRET-341@example.invalid/o/r.git';

/** A remote whose URL names a token: the launch's fetch reaches the fixture's forge by an `insteadOf` that names it too. */
function tokenRemote(base: string, repo: string, url = TOKEN_URL) {
  git(repo, 'remote', 'set-url', 'origin', url);
  git(repo, 'config', `url.${join(base, 'origin.git')}.insteadOf`, url);
}

const agentConfig = (path: string) => readFileSync(join(path, '.git', 'config'), 'utf8');

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

  it('reads a branch for the path rules as the clone does: the same verdict, whatever the mark (ORC-338)', async () => {
    const { base, repo, root } = fixtureRepo();
    const origin = join(base, 'origin.git');
    const put = (dir: string, path: string, content: string) => {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    };
    const commit = (dir: string, message: string) => {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', message);
    };
    const sensitivePaths = ['infra', '*.tf'];
    put(repo, '.factory/config.yml', `sensitive_paths: ${JSON.stringify(sensitivePaths)}\n`);
    commit(repo, 'config');
    git(repo, 'push', '-q', 'origin', 'main');
    const ws = new GitWorkspaces({ root });
    const w = await ws.prepare(req(repo));
    git(w.path, 'config', 'user.email', 't@t');
    git(w.path, 'config', 'user.name', 't');
    put(w.path, 'infra/old.tf', 'trusted\n');
    put(w.path, 'src/a.ts', 'x\n');
    commit(w.path, 'trusted work');
    git(w.path, 'push', '-q', origin, 'HEAD:refs/heads/factory/rel-1-export-csv');
    const mark = git(w.path, 'rev-parse', 'HEAD');
    put(w.path, 'infra/new.tf', 'untrusted\n');
    put(w.path, 'CODEOWNERS', '* @x\n');
    put(w.path, 'claims/.env.example', 'A=\n');
    put(w.path, 'package.json', '{"scripts":{"postinstall":"x"}}');
    commit(w.path, 'untrusted work');
    // Published: the teammate's push below builds on the untrusted commit, which stays the agent's.
    git(w.path, 'push', '-q', origin, 'HEAD:refs/heads/factory/rel-1-export-csv');
    const before = git(w.path, 'rev-parse', 'HEAD');
    // A teammate, from a clone of their own: a commit on the ticket's branch, and one on the default branch, both on infra.
    const mate = join(base, 'mate');
    git(base, 'clone', '-q', origin, mate);
    git(mate, 'config', 'user.email', 'm@m');
    git(mate, 'config', 'user.name', 'm');
    git(mate, 'checkout', '-q', 'factory/rel-1-export-csv');
    put(mate, 'infra/human.tf', 'a human on the branch\n');
    commit(mate, 'human push');
    git(mate, 'push', '-q', 'origin', 'factory/rel-1-export-csv');
    const human = [{ before, after: git(mate, 'rev-parse', 'HEAD') }];
    git(mate, 'checkout', '-q', 'main');
    put(mate, 'infra/main.tf', 'a human on main\n');
    commit(mate, 'main moves on');
    git(mate, 'push', '-q', 'origin', 'main');
    // The branch takes both in, then the agent writes a path that starts with a space: the first a `-z` listing gives.
    git(w.path, 'fetch', '-q', origin, 'factory/rel-1-export-csv');
    git(w.path, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
    git(w.path, 'fetch', '-q', origin, 'main');
    git(w.path, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
    put(w.path, ' space.tf', 'untrusted\n');
    commit(w.path, 'untrusted, spaced');
    const head = git(w.path, 'rev-parse', 'HEAD');

    // The clone `verify` and the publication read: the work's objects, the forge's default branch as `BASE`.
    const cloneDir = join(base, 'clone');
    git(base, 'clone', '-q', '--no-checkout', w.path, cloneDir);
    git(cloneDir, 'fetch', '-q', origin, `+refs/heads/main:${BASE}`);
    const clone = cloneGit({ workDir: base }, cloneDir);
    const from = await forkPoint(clone, head);

    // The host's repository has not fetched main since: its reader fetches the forge, as the clone does.
    const reader = (await ws.branchReader(repo, w.path))!;
    expect(parseRepoConfig(await reader.baseConfig()).sensitivePaths).toEqual(sensitivePaths);
    for (const since of [undefined, '', mark, '0123456789012345678901234567890123456789']) {
      const untrusted = since === undefined ? undefined : { since, humanPushes: human, sensitivePaths };
      const onClone = await checkBranchPaths(gitReader(clone, BASE, from, head), untrusted);
      expect(await checkBranchPaths(reader, untrusted), String(since)).toEqual(onClone);
    }
    const [marked] = await checkBranchPaths(reader, { since: mark, humanPushes: human, sensitivePaths });
    for (const path of ['infra/new.tf', '` space.tf`', 'CODEOWNERS', 'claims/.env.example', 'package.json#scripts']) expect(marked!.output).toContain(path);
    // Neither what came before the mark, nor what a human pushed and the branch took in, nor what the default branch brought.
    for (const path of ['infra/old.tf', 'infra/human.tf', 'infra/main.tf']) expect(marked!.output).not.toContain(path);
    // The whole branch, the `''` mark, still leaves out what a human pushed.
    const whole = (await checkBranchPaths(reader, { since: '', humanPushes: human, sensitivePaths }))[0]!.output;
    expect(whole).toContain('infra/old.tf');
    expect(whole).not.toContain('infra/human.tf');
    // The agent's commits only: not the human's (only theirs, not the agent's they built on), nor the default branch's merged in after the mark.
    const sinceMark = await reader.agentChanges(mark, human);
    expect([...sinceMark].sort()).toEqual([' space.tf', 'CODEOWNERS', 'claims/.env.example', 'infra/new.tf', 'package.json']);
    const sinceFork = await reader.agentChanges('', human);
    expect([...sinceFork].sort()).toEqual([' space.tf', 'CODEOWNERS', 'claims/.env.example', 'infra/new.tf', 'infra/old.tf', 'package.json', 'src/a.ts']);
    // A push recorded without its `before` leaves out nothing: its range cannot be told.
    expect(await reader.agentChanges(mark, [{ after: human[0]!.after }])).toContain('infra/human.tf');
    expect(await ws.branchReader(repo, join(root, 'nowhere'))).toBeUndefined();
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

  it.each(['worktree', 'trunk-readonly', 'knowledge'] as const)('%s: gives up on a forge that does not answer, naming neither the path nor the command', async (kind) => {
    const { base, repo, root } = fixtureRepo();
    // A transport that never answers: the deadline kills it with git.
    const stall = join(base, 'stall.sh');
    writeFileSync(stall, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
    git(repo, 'config', 'protocol.ext.allow', 'always');
    git(repo, 'remote', 'set-url', 'origin', `ext::${stall}`);
    const logged: string[] = [];
    const ws = new GitWorkspaces({ root, knowledgeRepo: repo, fetchDeadlineMs: 300, log: (m) => logged.push(m) });
    const started = Date.now();
    await expect(ws.prepare(req(repo, { kind }))).rejects.toThrow(/^the forge no longer responds after 0.3 s$/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // A forge that answers with an error: its code, and the detail in the daemon's log only.
    git(repo, 'remote', 'set-url', 'origin', join(base, 'gone.git'));
    const err = (await ws.prepare(req(repo, { kind })).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('the forge could not be read (git fetch, code 128)');
    expect(logged.at(-1)).toContain(`git -C ${repo} fetch`);
  });

  it.each(['worktree', 'trunk-readonly', 'knowledge'] as const)('%s: starts from the remote branch, never a tag of its name, when origin/HEAD is missing', async (kind) => {
    const { repo, root } = fixtureRepo();
    const trunk = git(repo, 'rev-parse', 'origin/main');
    // A tag named like the remote branch, on a commit off the default branch: pushed by anyone who can push to the forge.
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'not merged');
    git(repo, 'push', '-q', 'origin', 'elsewhere:refs/tags/origin/main');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'remote', 'set-head', 'origin', '--delete');
    const w = await new GitWorkspaces({ root, knowledgeRepo: repo }).prepare(req(repo, { kind }));
    expect(git(w.path, 'rev-parse', 'HEAD')).toBe(trunk);
  });

  it("checks out the ticket's branch from the forge in full, never a tag of its name", async () => {
    const { repo, root } = fixtureRepo();
    git(repo, 'checkout', '-q', '-b', 'factory/rel-1-export-csv');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'the agent');
    git(repo, 'push', '-q', 'origin', 'factory/rel-1-export-csv');
    const pushed = git(repo, 'rev-parse', 'HEAD');
    // A tag named like the remote branch, on another commit: pushed by anyone who can push to the forge.
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'not the agent');
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/tags/origin/factory/rel-1-export-csv');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'factory/rel-1-export-csv');
    const w = await new GitWorkspaces({ root }).prepare(req(repo));
    expect(git(w.path, 'rev-parse', 'HEAD')).toBe(pushed);
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
    expect(readFileSync(join(w.path, '.git', 'config'), 'utf8')).not.toContain('/host/hooks');
    // Neither the factory's objects by a link, nor another's name for them: the agent rewrites only its own.
    expect(existsSync(join(w.path, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    // Its commits stay out of the factory's repository, read from there all the same.
    git(w.path, 'commit', '--allow-empty', '-m', 'the agent');
    const head = (await ws.head(w.path))!;
    expect(head).toBe(git(w.path, 'rev-parse', 'HEAD'));
    expect(() => execFileSync('git', ['cat-file', '-e', head], { cwd: repo, stdio: 'ignore' })).toThrow();
  });

  // What gives access to the forge or runs a command of the host's: none of it reaches a sandbox (ORC-341, ORC-125).
  it.each([
    ["a token as the remote URL's user", (base: string, repo: string) => tokenRemote(base, repo, 'https://SECRET-341@example.invalid/o/r.git')],
    ["actions/checkout's extraheader", (_: string, repo: string) => git(repo, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic SECRET-341')],
    ['a credential helper', (_: string, repo: string) => {
      git(repo, 'config', 'credential.helper', 'store --file /host/SECRET-341');
      git(repo, 'config', 'credential.https://github.com.username', 'SECRET-341');
    }],
    ['core.sshCommand', (_: string, repo: string) => git(repo, 'config', 'core.sshCommand', 'ssh -i /host/SECRET-341')],
    ['a push URL', (_: string, repo: string) => git(repo, 'config', 'remote.origin.pushurl', 'https://u:SECRET-341@example.invalid/o/r.git')],
  ])("leaves %s out of the agent's repository (ORC-341)", async (_, plant) => {
    const { base, repo, root } = fixtureRepo();
    plant(base, repo);
    const w = await new GitWorkspaces({ root }).prepare(req(repo));
    expect(agentConfig(w.path)).not.toContain('SECRET-341');
  });

  it('gives the agent the remote URL without its credentials, nor the rewrite that names them (ORC-341)', async () => {
    const { base, repo, root } = fixtureRepo();
    tokenRemote(base, repo);
    const w = await new GitWorkspaces({ root }).prepare(req(repo));
    expect(agentConfig(w.path)).not.toContain('SECRET-341');
    expect(git(w.path, 'config', '--get-all', 'remote.origin.url')).toBe('https://example.invalid/o/r.git');
    expect(git(w.path, 'config', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*');
  });

  it.each([
    ['https://x-access-token:t@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://t@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['http://u:p@a@host:8080/r?x=1', 'http://host:8080/r?x=1'],
    ['persistent-https::https://u:p@host/r', 'persistent-https::https://host/r'],
    ['ssh://git:p@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
    ['ssh://git@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ['https://github.com/o/r.git', 'https://github.com/o/r.git'],
    ['/srv/git/r.git', '/srv/git/r.git'],
    ['C:\\git\\r', 'C:\\git\\r'],
  ])('reads %s without its credentials as %s', (url, bare) => {
    expect(withoutUserinfo(url)).toBe(bare);
  });

  it("lets a run commit as the repository's identity, with its line endings and its LFS filter, and nothing else of the host's (ORC-341)", async () => {
    const { base, repo, root } = fixtureRepo();
    git(repo, 'config', 'user.name', 'The Operator');
    git(repo, 'config', 'user.email', 'op@example.com');
    git(repo, 'config', 'core.autocrlf', 'input');
    git(repo, 'config', 'core.eol', 'lf');
    git(repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    git(repo, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    git(repo, 'config', 'filter.lfs.process', 'git-lfs filter-process');
    git(repo, 'config', 'filter.lfs.required', 'true');
    const w = await new GitWorkspaces({ root }).prepare(req(repo));
    // As in a sandbox: neither the host's global nor its system config, only the agent's repository's own.
    const home = join(base, 'agent-home');
    mkdirSync(home);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'none'), GIT_CONFIG_NOSYSTEM: '1' };
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[k];
    const agent = (...args: string[]) => execFileSync('git', args, { cwd: w.path, encoding: 'utf8', env }).trim();
    writeFileSync(join(w.path, 'out.txt'), 'one\r\ntwo\r\n');
    agent('add', 'out.txt');
    agent('commit', '-q', '-m', 'the agent');
    expect(agent('log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('The Operator <op@example.com> / The Operator <op@example.com>');
    expect(agent('cat-file', '-p', 'HEAD:out.txt')).toBe('one\ntwo');
    expect(agent('config', '--get-regexp', '^filter\\.lfs\\.').split('\n')).toEqual([
      'filter.lfs.clean git-lfs clean -- %f',
      'filter.lfs.smudge git-lfs smudge -- %f',
      'filter.lfs.process git-lfs filter-process',
      'filter.lfs.required true',
    ]);
  });

  it("checks the agent's files out through the LFS filter as the repository reaches the forge, its credentials left out of the agent's config (ORC-341)", async () => {
    // Neither the machine's global nor its system config: where git-lfs is installed, its `filter.lfs.process` is there,
    // and git runs it instead of the fake below, at the commit and at the checkout (as on GitHub's runners).
    const none = join(mkdtempSync(join(tmpdir(), 'factory-git-')), 'none');
    vi.stubEnv('GIT_CONFIG_GLOBAL', none);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const { base, repo, root } = fixtureRepo();
    const seen = join(base, 'seen');
    // As git-lfs's smudge: what it reads of the config to reach the forge.
    git(repo, 'config', 'filter.lfs.smudge', `sh -c 'git config remote.origin.url >> "${seen}"; git config http.https://github.com/.extraheader >> "${seen}"; cat'`);
    git(repo, 'config', 'filter.lfs.clean', 'cat');
    writeFileSync(join(repo, '.gitattributes'), '*.bin filter=lfs\n');
    writeFileSync(join(repo, 'big.bin'), 'data\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'lfs');
    git(repo, 'push', '-q', 'origin', 'main');
    tokenRemote(base, repo);
    git(repo, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic SECRET-341');
    const w = await new GitWorkspaces({ root }).prepare(req(repo));
    expect(readFileSync(join(w.path, 'big.bin'), 'utf8')).toBe('data\n');
    expect(existsSync(seen), 'the checkout ran the fake smudge').toBe(true);
    expect(readFileSync(seen, 'utf8').split('\n')).toEqual(expect.arrayContaining([TOKEN_URL, 'AUTHORIZATION: basic SECRET-341']));
    expect(agentConfig(w.path)).not.toContain('SECRET-341');
  });

  it('takes a boolean the repository wrote without a value as true (ORC-341)', async () => {
    const { repo, root } = fixtureRepo();
    writeFileSync(join(repo, '.git', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'utf8')}[core]\n\tautocrlf\n`);
    const w = await new GitWorkspaces({ root }).prepare(req(repo));
    expect(git(w.path, 'config', 'core.autocrlf')).toBe('true');
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
