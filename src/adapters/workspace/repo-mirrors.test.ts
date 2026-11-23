import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRepoConfig } from '../../app/repo-variables.js';
import { parseRepoConfig } from '../../config/repo-config.js';
import { execCmd, type Exec } from '../exec.js';
import { GitWorkspaces, ORIGIN_REFSPEC } from './git-workspaces.js';
import { RepoMirrors } from './repo-mirrors.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A local bare repository standing for GitHub's `acme/app`, its `main` with one commit, and a clone that pushes to it. */
function forge() {
  const base = mkdtempSync(join(tmpdir(), 'factory-mirror-'));
  const github = join(base, 'github');
  const bare = join(github, 'acme', 'app.git');
  git(base, 'init', '--quiet', '--bare', '-b', 'main', bare);
  const work = join(base, 'work');
  git(base, 'clone', '--quiet', bare, work);
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'README.md'), 'hi\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'init');
  git(work, 'push', '--quiet', 'origin', 'main');
  const url = (repo: string) => join(github, `${repo.toLowerCase()}.git`);
  return { base, work, url, root: join(base, 'repos') };
}

describe('RepoMirrors (ORC-479)', () => {
  it('makes a bare mirror of the repository: only the forge\'s branches as origin/*, its default branch as origin/HEAD, no branch of its own', async () => {
    const f = forge();
    const mirrors = new RepoMirrors({ root: f.root, url: f.url });
    const mirror = await mirrors.ready('Acme/App');
    expect(mirror).toBe(join(f.root, 'acme', 'app'));
    expect(git(mirror, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(mirror, 'config', 'remote.origin.url')).toBe(f.url('Acme/App'));
    expect(git(mirror, 'config', 'remote.origin.fetch')).toBe(ORIGIN_REFSPEC);
    expect(git(mirror, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
    expect(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('');
    expect(git(mirror, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(f.work, 'rev-parse', 'HEAD'));
    // Nothing left aside by the making.
    expect(readdirSync(join(f.root, 'acme'))).toEqual(['app']);
  });

  it('fetches what the forge got since, a branch pushed after included', async () => {
    const f = forge();
    const mirrors = new RepoMirrors({ root: f.root, url: f.url });
    const mirror = await mirrors.ready('acme/app');
    git(f.work, 'checkout', '--quiet', '-b', 'feat/rel-1');
    git(f.work, 'commit', '--quiet', '--allow-empty', '-m', 'the agent');
    git(f.work, 'push', '--quiet', 'origin', 'feat/rel-1');
    await mirrors.fetch(mirror);
    expect(git(mirror, 'rev-parse', 'refs/remotes/origin/feat/rel-1')).toBe(git(f.work, 'rev-parse', 'HEAD'));
  });

  it('forgets a branch deleted on the forge at the next fetch, and a workspace on it keeps its objects (ORC-486)', async () => {
    const f = forge();
    const mirrors = new RepoMirrors({ root: f.root, url: f.url });
    const mirror = await mirrors.ready('acme/app');
    git(f.work, 'checkout', '--quiet', '-b', 'feat/rel-1');
    git(f.work, 'commit', '--quiet', '--allow-empty', '-m', 'the agent');
    git(f.work, 'push', '--quiet', 'origin', 'feat/rel-1');
    const sha = git(f.work, 'rev-parse', 'HEAD');
    const ws = new GitWorkspaces({ root: join(f.base, 'ws'), fetch: mirrors.fetch, auth: mirrors.auth });
    const w = await ws.prepare({ projectId: 'p', mirror, ticketId: 'REL-1', title: 'Export CSV', kind: 'worktree', runId: 'r1', branch: 'feat/rel-1' });
    git(f.work, 'push', '--quiet', 'origin', '--delete', 'feat/rel-1');
    await mirrors.fetch(mirror);
    expect(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).not.toContain('feat/rel-1');
    expect(git(mirror, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(f.work, 'rev-parse', 'main'));
    // Even once the mirror drops what no ref reaches any more: the workspace's objects are its own.
    git(mirror, 'gc', '--quiet', '--prune=now');
    expect(git(w.path, 'log', '-1', '--format=%H %s')).toBe(`${sha} the agent`);
    expect(await ws.head(w.path)).toBe(sha);
    expect(await ws.ticketDiff(mirror, w.path)).toBeDefined();
  });

  it('makes a missing mirror at its first fetch, whoever asks: a workspace from a mirror the start could not make', async () => {
    const f = forge();
    const mirrors = new RepoMirrors({ root: f.root, url: f.url });
    const mirror = mirrors.path('acme/app');
    expect(existsSync(mirror)).toBe(false);
    const ws = new GitWorkspaces({ root: join(f.base, 'ws'), fetch: mirrors.fetch, auth: mirrors.auth });
    const w = await ws.prepare({ projectId: 'p', mirror, ticketId: 'REL-1', title: 'Export CSV', kind: 'worktree', runId: 'r1' });
    expect(git(w.path, 'log', '-1', '--format=%s')).toBe('init');
    expect(git(w.path, 'config', 'remote.origin.url')).toBe(f.url('acme/app'));
  });

  it('fetches one mirror one git at a time, its making included, and two mirrors side by side', async () => {
    const f = forge();
    git(f.base, 'clone', '--quiet', '--bare', f.url('acme/app'), f.url('acme/tool'));
    let running = 0;
    let most = 0;
    const exec: Exec = async (cmd, args, opts) => {
      const fetching = args.includes('fetch');
      if (fetching) most = Math.max(most, ++running);
      try {
        // Long enough for another fetch to start meanwhile, were it let.
        if (fetching) await new Promise((r) => setTimeout(r, 100));
        return await execCmd(cmd, args, opts);
      } finally {
        if (fetching) running--;
      }
    };
    const mirrors = new RepoMirrors({ root: f.root, url: f.url, exec });
    const app = mirrors.path('acme/app');
    await Promise.all([mirrors.fetch(app), mirrors.fetch(app), mirrors.fetch(app, { refspecs: ['+HEAD:refs/factory/x'] })]);
    expect(most).toBe(1);
    most = 0;
    await Promise.all([mirrors.fetch(app), mirrors.ready('acme/tool')]);
    expect(most).toBe(2);
  });

  it('leaves no mirror when it cannot be made, and makes it at the next fetch', async () => {
    const f = forge();
    let reachable = false;
    const mirrors = new RepoMirrors({ root: f.root, url: (repo) => (reachable ? f.url(repo) : join(f.base, 'nowhere.git')) });
    await expect(mirrors.ready('acme/app')).rejects.toThrow(/the forge could not be read/);
    expect(readdirSync(join(f.root, 'acme'))).toEqual([]);
    reachable = true;
    expect(git(await mirrors.ready('acme/app'), 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/main');
  });

  it('fetches what was asked of a mirror it had to make first: the forge\'s HEAD to a ref of its own', async () => {
    const f = forge();
    const mirrors = new RepoMirrors({ root: f.root, url: f.url });
    const mirror = mirrors.path('acme/app');
    await mirrors.fetch(mirror, { refspecs: ['+HEAD:refs/factory/forge-head/x'] });
    expect(git(mirror, 'rev-parse', 'refs/factory/forge-head/x')).toBe(git(f.work, 'rev-parse', 'HEAD'));
  });

  it('removes what a daemon killed while making a mirror left aside, and takes the mirror another process made meanwhile', async () => {
    const f = forge();
    const mirror = join(f.root, 'acme', 'app');
    // Left by a process killed halfway, no longer alive: a partial copy. One of a process still alive (pid 1) is its own, kept.
    mkdirSync(join(f.root, 'acme'), { recursive: true });
    git(f.base, 'init', '--quiet', '--bare', `${mirror}.new-999999999`);
    writeFileSync(join(`${mirror}.new-999999999`, 'partial'), '');
    mkdirSync(`${mirror}.new-1`);
    // `factory ghost` makes it while this one fetches: the first one renamed wins, the other's copy goes.
    const exec: Exec = async (cmd, args, opts) => {
      const r = await execCmd(cmd, args, opts);
      if (args.includes('set-head') && !existsSync(mirror)) git(f.base, 'clone', '--quiet', '--bare', f.url('acme/app'), mirror);
      return r;
    };
    await new RepoMirrors({ root: f.root, url: f.url, exec }).ready('acme/app');
    expect(readdirSync(join(f.root, 'acme')).sort()).toEqual(['app', 'app.new-1']);
    expect(existsSync(join(mirror, 'partial'))).toBe(false);
  });

  it("makes a missing mirror for a read of the repository's config that does not fetch: an intake that comes before the start made it", async () => {
    const f = forge();
    const mirrors = new RepoMirrors({ root: f.root, url: f.url });
    const config = await makeRepoConfig({ fetch: mirrors.fetch })({ mirror: mirrors.path('acme/app') }, { fetch: false });
    expect(config).toEqual(parseRepoConfig(undefined, { defaultBranch: 'main' }));
    expect(existsSync(mirrors.path('acme/app'))).toBe(true);
  });

  it("sets origin/HEAD once the forge has a default branch, a repository empty when it was made", async () => {
    const f = forge();
    const empty = f.url('acme/empty');
    git(f.base, 'init', '--quiet', '--bare', '-b', 'trunk', empty);
    const logs: string[] = [];
    const mirrors = new RepoMirrors({ root: f.root, url: f.url, log: (m) => logs.push(m) });
    const mirror = await mirrors.ready('acme/empty');
    expect(logs.join('\n')).toMatch(/origin\/HEAD not set/);
    git(f.work, 'push', '--quiet', empty, 'main:trunk');
    await mirrors.fetch(mirror);
    expect(git(mirror, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toBe('refs/remotes/origin/trunk');
  });

  it("gives the App's token of the repository a mirror stands for, and none to any other path (a replayed ticket's clone)", async () => {
    const asked: string[] = [];
    const mirrors = new RepoMirrors({ root: '/home/f/repos', auth: async (github) => (asked.push(github), { GIT_CONFIG_COUNT: '0' }) });
    expect(await mirrors.auth(mirrors.path('Acme/App'))).toEqual({ GIT_CONFIG_COUNT: '0' });
    expect(asked).toEqual(['Acme/App']);
    expect(await mirrors.auth('/home/f/ghost/g1/REL-1/repo')).toEqual({});
    expect(new RepoMirrors({ root: '/r' }).url('acme/app')).toBe('https://github.com/acme/app.git');
  });

  it.each(['acme', 'acme/app/x', '../app', 'acme/..', 'acme/a b', '/acme/app'])('refuses %s, which names no GitHub repository', (github) => {
    expect(() => new RepoMirrors({ root: '/r' }).path(github)).toThrow(/owner\/name/);
  });
});
