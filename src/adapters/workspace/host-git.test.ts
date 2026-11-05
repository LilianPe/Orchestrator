import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeOriginUrl } from '../../app/repo-variables.js';
import { KnowledgeBase } from '../../knowledge/kb.js';
import { GitWorkspaces, originHead } from './git-workspaces.js';
import { execCmd } from '../exec.js';

/**
 * ORC-317: what an agent leaves where it can write, then the factory's own git command on the host, then a witness.
 * Where the agent can write is read from its workspace, as a sandbox's mounts follow it: the git dir its `.git` names.
 * The sandbox itself is `test/isolation/host-git.test.ts`.
 */
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
/** What `sh` reads, on a Windows path too. */
const posix = (p: string) => p.replaceAll('\\', '/');

const bases: string[] = [];
afterEach(() => {
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true, maxRetries: 3 });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'factory-host-git-'));
  bases.push(base);
  const witnesses = join(base, 'witnesses');
  mkdirSync(witnesses);
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(base, 'repo');
  git(base, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const root = join(base, 'ws');
  const ws = new GitWorkspaces({ root });
  return {
    base,
    origin,
    repo,
    root,
    ws,
    /** A shell command that leaves `name`, what follows it on the line (git's own arguments) being a comment. */
    trap: (name: string) => `touch '${posix(join(witnesses, name))}' #`,
    witness: (name: string) => join(witnesses, name),
    fired: () => readdirSync(witnesses),
    /** A commit on the forge, for what only a new ref brings: another clone pushes it. */
    pushed: () => {
      const other = join(base, `other-${readdirSync(base).length}`);
      git(base, 'clone', '-q', origin, other);
      git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'later');
      git(other, 'push', '-q', 'origin', 'HEAD:main');
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

const req = (repo: string, patch: object = {}) => ({
  projectId: 'p', repoPath: repo, ticketId: 'REL-1', title: 'Export CSV', kind: 'worktree' as const, slot: 1, portBase: 4200, runId: 'abcdef123456', ...patch,
});
const other = { ticketId: 'REL-2', title: 'Other' };

/** The git dir the agent's git writes: the agent's sandbox has it, whatever the layout. */
const reach = (work: string) => git(work, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const set = (gitDir: string, key: string, value: string) => execFileSync('git', ['config', '-f', join(gitDir, 'config'), key, value]);
function hook(gitDir: string, name: string, command: string, dir = join(gitDir, 'hooks')): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${command}\n`);
  chmodSync(path, 0o755);
}
/** In its sandbox, not on the host: a stand-in for `SandboxProvider.exec`. */
const inBox = async () => ({ stdout: '', stderr: '', code: 0 });
const reset = (f: Fixture, path: string) => f.ws.resetClaudeDir(path, inBox);
/** The attack may well make the command fail: only the witness says whether it ran. */
const whatever = (work: Promise<unknown>) => work.catch(() => undefined);

describe('what an agent wrote, under the commands the factory runs on the host (ORC-317)', () => {
  describe('hooks', () => {
    it('post-checkout: a worktree added for another ticket', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      hook(reach(path), 'post-checkout', f.trap('post-checkout'));
      await whatever(f.ws.prepare(req(f.repo, other)));
      expect(f.fired()).toEqual([]);
    });

    it('post-checkout, under a hooksPath of the agent: a worktree added for another ticket', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const hooks = join(path, 'my-hooks');
      hook(reach(path), 'post-checkout', f.trap('hooks-path'), hooks);
      set(reach(path), 'core.hooksPath', posix(hooks));
      await whatever(f.ws.prepare(req(f.repo, other)));
      expect(f.fired()).toEqual([]);
    });

    it('reference-transaction: the fetch of a new commit', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      hook(reach(path), 'reference-transaction', f.trap('reference-transaction'));
      f.pushed();
      await whatever(f.ws.prepare(req(f.repo, other)));
      expect(f.fired()).toEqual([]);
    });

    it('post-checkout: the trunk put back on the default branch for the next question', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo, { kind: 'trunk-readonly' }));
      hook(reach(path), 'post-checkout', f.trap('trunk'));
      await whatever(f.ws.prepare(req(f.repo, { kind: 'trunk-readonly', runId: 'fedcba654321' })));
      expect(f.fired()).toEqual([]);
    });

    it('pre-auto-gc: the maintenance a fetch starts', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      set(reach(path), 'gc.auto', '1');
      set(reach(path), 'gc.autoDetach', 'false');
      // Git estimates the loose objects from this one directory: two names of the right shape pass the threshold of 1.
      mkdirSync(join(reach(path), 'objects', '17'), { recursive: true });
      for (const name of ['a'.repeat(38), 'b'.repeat(38)]) writeFileSync(join(reach(path), 'objects', '17', name), '');
      hook(reach(path), 'pre-auto-gc', f.trap('pre-auto-gc'));
      f.pushed();
      await whatever(f.ws.prepare(req(f.repo, other)));
      expect(f.fired()).toEqual([]);
    });

    it('post-merge: the pull of the knowledge base', async () => {
      const f = fixture();
      const kb = new GitWorkspaces({ root: f.root, knowledgeRepo: f.repo });
      const { path } = await kb.prepare(req(f.repo, { kind: 'knowledge' }));
      hook(reach(path), 'post-merge', f.trap('post-merge'));
      f.pushed();
      await whatever(new KnowledgeBase(f.repo).pull());
      expect(f.fired()).toEqual([]);
    });
  });

  describe('config', () => {
    /** What runs when git talks to `origin`: every command that does, on the repository. */
    const remoteAttacks: [string, (f: Fixture, gitDir: string) => void][] = [
      ['core.sshCommand', (f, d) => {
        set(d, 'remote.origin.url', 'ssh://git@example.invalid/x.git');
        set(d, 'core.sshCommand', f.trap('ssh-command'));
      }],
      ['remote.origin.uploadpack', (f, d) => set(d, 'remote.origin.uploadpack', f.trap('uploadpack'))],
      ['ext:: with its protocol allowed', (f, d) => {
        set(d, 'protocol.ext.allow', 'always');
        // Its own syntax, not a shell's: `% ` is a space inside an argument.
        set(d, 'remote.origin.url', `ext::sh -c touch% ${posix(f.witness('ext'))}`);
      }],
      ['core.gitProxy', (f, d) => {
        set(d, 'remote.origin.url', 'git://example.invalid/x.git');
        const proxy = join(f.base, 'proxy.sh');
        writeFileSync(proxy, `#!/bin/sh\n${f.trap('git-proxy')}\n`);
        chmodSync(proxy, 0o755);
        set(d, 'core.gitProxy', posix(proxy));
      }],
      ['include.path, the same setting from a file of the agent', (f, d) => {
        const file = join(f.base, 'included');
        execFileSync('git', ['config', '-f', file, 'core.sshCommand', f.trap('include')]);
        set(d, 'remote.origin.url', 'ssh://git@example.invalid/x.git');
        set(d, 'include.path', posix(file));
      }],
      ['includeIf, the same setting on a condition', (f, d) => {
        const file = join(f.base, 'included-if');
        execFileSync('git', ['config', '-f', file, 'core.sshCommand', f.trap('include-if')]);
        set(d, 'remote.origin.url', 'ssh://git@example.invalid/x.git');
        set(d, 'includeIf.gitdir:**.path', posix(file));
      }],
    ];

    it.each(remoteAttacks)('%s: the fetch of a launch', async (_, plant) => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      plant(f, reach(path));
      await whatever(f.ws.prepare(req(f.repo, other)));
      expect(f.fired()).toEqual([]);
    });

    it.each(remoteAttacks)('%s: the ls-remote of a pickup', async (_, plant) => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      plant(f, reach(path));
      await whatever(f.ws.remoteBranchExists(f.repo, 'factory/rel-2-'));
      expect(f.fired()).toEqual([]);
    });

    it('core.sshCommand: the fetch of the knowledge base', async () => {
      const f = fixture();
      const kb = new GitWorkspaces({ root: f.root, knowledgeRepo: f.repo });
      const { path } = await kb.prepare(req(f.repo, { kind: 'knowledge' }));
      set(reach(path), 'remote.origin.url', 'ssh://git@example.invalid/x.git');
      set(reach(path), 'core.sshCommand', f.trap('kb-ssh'));
      await whatever(new KnowledgeBase(f.repo).pull());
      expect(f.fired()).toEqual([]);
    });

    it('credential.helper: an origin that asks for credentials', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const server = createServer((_, res) => res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end());
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        set(reach(path), 'remote.origin.url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/x.git`);
        set(reach(path), 'http.proxy', '');
        set(reach(path), 'credential.helper', `!${f.trap('credential')}`);
        await whatever(f.ws.remoteBranchExists(f.repo, 'factory/rel-2-'));
      } finally {
        server.close();
      }
      expect(f.fired()).toEqual([]);
    });

    it('a smudge filter, on every file by info/attributes: a worktree added for another ticket', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      set(reach(path), 'filter.x.smudge', f.trap('smudge'));
      mkdirSync(join(reach(path), 'info'), { recursive: true });
      writeFileSync(join(reach(path), 'info', 'attributes'), '* filter=x\n');
      await whatever(f.ws.prepare(req(f.repo, other)));
      expect(f.fired()).toEqual([]);
    });

    it('a smudge filter: the trunk put back for the next question', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo, { kind: 'trunk-readonly' }));
      set(reach(path), 'filter.x.smudge', f.trap('trunk-smudge'));
      mkdirSync(join(reach(path), 'info'), { recursive: true });
      writeFileSync(join(reach(path), 'info', 'attributes'), '* filter=x\n');
      // The file comes back only if the checkout has to write it.
      rmSync(join(path, 'README.md'));
      await whatever(f.ws.prepare(req(f.repo, { kind: 'trunk-readonly', runId: 'fedcba654321' })));
      expect(f.fired()).toEqual([]);
    });
  });

  describe("the worktree's own .git, which the agent also writes", () => {
    /** A git dir of the agent's making, in the worktree, and its `.git` file pointing at it. */
    function pointAway(f: Fixture, work: string, plant: (gitDir: string) => void): void {
      const own = join(work, 'own.git');
      git(f.base, 'init', '-q', '--bare', own);
      plant(own);
      rmSync(join(work, '.git'), { recursive: true, force: true });
      writeFileSync(join(work, '.git'), `gitdir: ${posix(own)}\n`);
    }

    it('core.fsmonitor and a filter of its git dir: the hiding of .claude/ at the next launch', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      pointAway(f, path, (d) => {
        set(d, 'core.bare', 'false');
        set(d, 'core.fsmonitor', f.trap('fsmonitor'));
        set(d, 'filter.x.smudge', f.trap('pointed-smudge'));
      });
      await whatever(reset(f, path));
      expect(f.fired()).toEqual([]);
    });

    it('core.fsmonitor in the git dir it was given: the hiding of .claude/ at the next launch', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      set(reach(path), 'core.fsmonitor', f.trap('fsmonitor-common'));
      await whatever(reset(f, path));
      expect(f.fired()).toEqual([]);
    });

    it('a smudge filter it set, a file .claude/ brings back: the hiding of .claude/ at the next launch', async () => {
      const f = fixture();
      mkdirSync(join(f.repo, '.claude'));
      writeFileSync(join(f.repo, '.claude', 'CLAUDE.md'), 'conventions\n');
      git(f.repo, 'add', '.');
      git(f.repo, 'commit', '-q', '-m', 'claude');
      git(f.repo, 'push', '-q');
      const { path } = await f.ws.prepare(req(f.repo));
      set(reach(path), 'filter.x.smudge', f.trap('reset-smudge'));
      mkdirSync(join(reach(path), 'info'), { recursive: true });
      writeFileSync(join(reach(path), 'info', 'attributes'), '* filter=x\n');
      rmSync(join(path, '.claude', 'CLAUDE.md'));
      git(path, '-c', `core.hooksPath=${posix(join(f.base, 'none'))}`, 'update-index', '--skip-worktree', '.claude/CLAUDE.md');
      await whatever(reset(f, path));
      await whatever(reset(f, path));
      expect(f.fired()).toEqual([]);
    });
  });

  // Nothing runs here, but the factory acts on what it read.
  describe('what the host reads and believes', () => {
    it("origin/HEAD, which the next ticket's branch would start from", async () => {
      const f = fixture();
      const trunk = git(f.repo, 'rev-parse', 'origin/main');
      const { path } = await f.ws.prepare(req(f.repo));
      git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'the agent');
      git(path, 'update-ref', 'refs/remotes/origin/evil', 'HEAD');
      git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/evil');
      const next = await f.ws.prepare(req(f.repo, other));
      expect(git(next.path, 'rev-parse', 'HEAD')).toBe(trunk);
    });

    // Before ORC-317 the daemon mounted, read-write, whatever `git rev-parse --git-common-dir` answered there: another project's git dir, for one.
    it("a .git file naming another project's git dir is neither followed nor taken for a worktree", async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const foreign = join(f.base, 'foreign');
      git(f.base, 'init', '-q', foreign);
      git(foreign, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'theirs');
      rmSync(join(path, '.git'), { recursive: true, force: true });
      writeFileSync(join(path, '.git'), `gitdir: ${posix(join(foreign, '.git'))}\n`);
      expect(await f.ws.head(path)).toBeUndefined();
      expect(await f.ws.stepDiff(f.repo, path, 'HEAD')).toBeUndefined();
      await expect(f.ws.prepare(req(f.repo))).rejects.toThrow("n'est pas celui que l'usine a créé");
    });

    it('a HEAD that names a path out of its git dir, or a commit it could not hold, reads as none', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const secret = join(f.base, 'secret');
      writeFileSync(secret, `${'a'.repeat(40)}\n`);
      for (const head of ['ref: refs/heads/../../../../secret\n', 'ref: refs/heads/-oops\n', 'garbage\n', `ref: ${posix(secret)}\n`]) {
        writeFileSync(join(path, '.git', 'HEAD'), head);
        expect(await f.ws.head(path)).toBeUndefined();
      }
    });

    it.skipIf(process.platform === 'win32')('a HEAD that is a FIFO or a link reads as none: it holds neither the daemon nor another file', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const head = join(path, '.git', 'HEAD');
      const secret = join(f.base, 'secret');
      writeFileSync(secret, `${'a'.repeat(40)}\n`);
      rmSync(head);
      symlinkSync(secret, head);
      expect(await f.ws.head(path)).toBeUndefined();
      rmSync(head);
      execFileSync('mkfifo', [head]);
      expect(await f.ws.head(path)).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')("refs that are a link out of its git dir read as none: another ticket's head stays unread", async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const theirs = join(f.base, 'theirs', 'refs', 'heads');
      mkdirSync(theirs, { recursive: true });
      writeFileSync(join(theirs, 'x'), `${'a'.repeat(40)}\n`);
      rmSync(join(path, '.git', 'refs'), { recursive: true });
      symlinkSync(join(f.base, 'theirs', 'refs'), join(path, '.git', 'refs'));
      writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/x\n');
      expect(await f.ws.head(path)).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('a .claude that is a link: the link goes, not what it names on the host', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const elsewhere = join(f.base, 'elsewhere');
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, 'keep'), 'x');
      symlinkSync(elsewhere, join(path, '.claude'));
      await reset(f, path);
      expect(readdirSync(elsewhere)).toEqual(['keep']);
      expect(existsSync(join(path, '.claude'))).toBe(false);
    });
  });

  // What these commands do not run, whatever is written: proved here too, so that the report's list stands on a test.
  describe('what no command of the factory runs', () => {
    const planted = (f: Fixture, d: string) => {
      for (const name of ['post-checkout', 'post-commit', 'pre-push', 'post-rewrite', 'post-index-change']) hook(d, name, f.trap(name));
      set(d, 'core.pager', f.trap('pager'));
      set(d, 'pager.show', f.trap('pager-show'));
      set(d, 'core.editor', f.trap('editor'));
      set(d, 'core.fsmonitor', f.trap('fsmonitor'));
      set(d, 'diff.external', f.trap('diff-external'));
      set(d, 'diff.x.textconv', f.trap('textconv'));
      set(d, 'gpg.program', f.trap('gpg'));
      set(d, 'alias.fetch', `!${f.trap('alias')}`);
      set(d, 'alias.show', `!${f.trap('alias-show')}`);
      mkdirSync(join(d, 'info'), { recursive: true });
      writeFileSync(join(d, 'info', 'attributes'), '* diff=x\n');
    };

    it('the reads of a head and of a diff', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      const base = git(path, 'rev-parse', 'HEAD');
      git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work');
      planted(f, reach(path));
      await f.ws.head(path);
      const diff = await f.ws.stepDiff(f.repo, path, base);
      await diff?.showAtBase('README.md');
      await diff?.showAtHead('README.md');
      await diff?.filesAtHead();
      await diff?.existsAtBase(['README.md']);
      expect(f.fired()).toEqual([]);
    });

    it("the read of the forge's URL and of the default branch", async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      planted(f, reach(path));
      await makeOriginUrl()({ repoPath: f.repo });
      await originHead(execCmd, f.repo);
      expect(f.fired()).toEqual([]);
    });

    it('the removal of a worktree', async () => {
      const f = fixture();
      const { path } = await f.ws.prepare(req(f.repo));
      planted(f, reach(path));
      await f.ws.cleanup('p', f.repo, 'REL-1');
      expect(f.fired()).toEqual([]);
    });
  });
});
