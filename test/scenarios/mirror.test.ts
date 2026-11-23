import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspaces } from '../../src/adapters/workspace/git-workspaces.js';
import { RepoMirrors } from '../../src/adapters/workspace/repo-mirrors.js';
import { makeRepoConfig } from '../../src/app/repo-variables.js';
import { createHarness } from '../helpers/harness.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * ORC-479: the daemon's own mirror is the git source of a ticket, end to end, with no clone of the repository anywhere: GitHub here
 * is a local bare repository, the mirror is made from it at the first fetch, as `RepoMirrors` makes it for the daemon.
 */
describe('a ticket on the daemon\'s mirror, with no local clone (ORC-479)', () => {
  function onMirror() {
    const root = mkdtempSync(join(tmpdir(), 'factory-mirror-e2e-'));
    roots.push(root);
    // GitHub's `acme/app`: its default branch, `trunk`, holds the repository's config. Nothing else of it exists on the machine.
    const github = join(root, 'github', 'acme', 'app.git');
    const seed = join(root, 'seed');
    execFileSync('git', ['init', '--quiet', '-b', 'trunk', seed]);
    writeFileSync(join(seed, 'README.md'), 'hi\n');
    execFileSync('mkdir', ['-p', join(seed, '.factory')]);
    writeFileSync(join(seed, '.factory', 'config.yml'), 'network: { level: custom, allow: [docs.exemple.com] }\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', 'base');
    execFileSync('git', ['clone', '--quiet', '--bare', seed, github]);
    rmSync(seed, { recursive: true, force: true });
    const mirrors = new RepoMirrors({ root: join(root, 'home', 'repos'), url: (repo) => join(root, 'github', `${repo}.git`) });
    const mirror = mirrors.path('acme/app');
    const workspaces = new GitWorkspaces({ root: join(root, 'home', 'workspaces'), fetch: mirrors.fetch, auth: mirrors.auth });
    const read = makeRepoConfig({ fetch: mirrors.fetch });
    const h = createHarness({ sandboxed: true, git: { workspaces, mirror }, repoConfig: (project, o) => read(project, o) });
    // The agent's work: a commit in its own repository, in the worktree its sandbox mounts.
    const start = h.runner.start.bind(h.runner);
    h.runner.start = (req) => {
      const worktree = h.sandboxes.created.at(-1)!.workspacePath;
      writeFileSync(join(worktree, 'export.ts'), 'export const csv = 1;\n');
      git(worktree, 'add', 'export.ts');
      git(worktree, 'commit', '--quiet', '-m', 'export');
      return start(req);
    };
    return { h, root, github, mirror, mirrors };
  }

  it('makes the mirror, works the ticket in a repository of its own copied from it, and publishes the agent\'s commit', async () => {
    const { h, root, mirror } = onMirror();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({});
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });

    const t = await h.ticket();
    expect(t).toMatchObject({ logical: 'human_review', prNumber: 1, blocked: false });
    const worktree = t.worktreePath!;
    expect(relative(join(root, 'home', 'workspaces'), worktree)).toBe(join('p', 'REL-1'));
    // On the forge's default branch, as the mirror has it; the agent's commit is what is published.
    expect(git(worktree, 'log', '--format=%s', '-2').split('\n')).toEqual(['export', 'base']);
    expect(h.publisher.published).toEqual([expect.objectContaining({ github: 'acme/app', sha: git(worktree, 'rev-parse', 'HEAD') })]);
    // The repository's config was read on the mirror's default branch: its network level reached the run.
    expect(h.sandboxes.created[0]).toMatchObject({ network: 'limited', allow: ['docs.exemple.com'] });
    // A bare mirror with the forge's branches alone, which the agent's commit never reached.
    expect(git(mirror, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(git(mirror, 'for-each-ref', '--format=%(refname)')).toBe('refs/remotes/origin/HEAD\nrefs/remotes/origin/trunk');
    expect(() => git(mirror, 'cat-file', '-e', git(worktree, 'rev-parse', 'HEAD'))).toThrow();
  });

  it('never mounts the mirror in a sandbox, and gives the runner no token', async () => {
    const { h, root, mirror } = onMirror();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({});
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.sandboxes.created.length).toBeGreaterThan(0);
    const repos = join(root, 'home', 'repos');
    for (const box of h.sandboxes.created) {
      for (const host of [box.workspacePath, ...box.mounts.map((m) => m.host)]) {
        expect(relative(repos, host).startsWith('..'), `${host} is out of the mirrors`).toBe(true);
        expect(relative(host, mirror).startsWith('..'), `${host} holds no mirror`).toBe(true);
      }
    }
    for (const run of h.runner.requests) expect(Object.keys(run.env).filter((k) => /^GIT_|TOKEN/.test(k) && k !== 'FACTORY_RUN_TOKEN')).toEqual([]);
  });
});
