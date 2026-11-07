import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TIMED_OUT, type Exec, type ExecOpts } from '../adapters/exec.js';
import { parseRepoConfig, RepoConfigError } from '../config/repo-config.js';
import { NO_REPO_VARIABLES } from '../config/repo-variables.js';
import { makeOriginUrl, makeRepoConfig, makeRepoVariables } from './repo-variables.js';

const YML = { repos: [{ linearTeam: 'REL', github: 'Org/App', env: { NODE_ENV: 'test' }, secrets: { REGISTRY_TOKEN: 'registry-secret' } }] };
const CONFIG = 'env: [NODE_ENV]\nsetup_secrets: [REGISTRY_TOKEN]\n';

/** A repository: its origin, its default branch, the config committed on it. */
function git(o: { origin?: string; head?: string; config?: string; mode?: string; dir?: string } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  const ko = { stdout: '', stderr: 'fatal', code: 128 };
  const exec: Exec = async (_, args) => {
    calls.push(args);
    if (args.includes('get-url')) return ok(`${o.origin ?? 'https://github.com/org/app.git'}\n`);
    if (args.includes('symbolic-ref')) return o.head === undefined ? ko : ok(`${o.head}\n`);
    if (args.includes('fetch')) return ok('');
    if (args.at(-1) === '.factory') return ok(o.config === undefined ? '' : `${o.dir ?? '040000 tree'} def456\t.factory\0`);
    if (args.includes('ls-tree')) return ok(o.config === undefined ? '' : `${o.mode ?? '100644 blob'} abc123\t.factory/config.yml\0`);
    if (args.includes('cat-file')) return o.config === undefined ? ko : ok(o.config);
    return ko;
  };
  return { exec, calls };
}

const PROJECT = { id: 'p', repoPath: '/repo', teamKey: 'REL' };

/** A real forge (bare) and the factory's clone of it, in `root`, the clone's default branch holding `config`. */
function forgeAndClone(root: string, config: string) {
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const forge = join(root, 'forge');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', forge]);
  execFileSync('git', ['clone', '--quiet', forge, repo]);
  mkdirSync(join(repo, '.factory'));
  writeFileSync(join(repo, '.factory', 'config.yml'), config);
  run(repo, 'add', '.');
  run(repo, 'commit', '--quiet', '-m', 'base');
  run(repo, 'push', '--quiet', 'origin', 'main');
  run(repo, 'remote', 'set-head', 'origin', 'main');
  return { run, forge, repo };
}
const DECLARED = parseRepoConfig(CONFIG);

describe('makeRepoConfig (ORC-209 C)', () => {
  it('reads the file on the default branch as the forge has it now, never in a worktree the agent writes', async () => {
    const { exec, calls } = git({ head: 'origin/trunk', config: CONFIG });
    expect(await makeRepoConfig({ exec })(PROJECT)).toEqual(DECLARED);
    expect(calls[0]).toEqual(['-C', '/repo', 'fetch', '--quiet', 'origin']);
    expect(calls.slice(-3)).toEqual([
      ['-C', '/repo', 'ls-tree', '-z', 'refs/remotes/origin/trunk', '--', '.factory'],
      ['-C', '/repo', 'ls-tree', '-z', 'refs/remotes/origin/trunk', '--', '.factory/config.yml'],
      ['-C', '/repo', 'cat-file', 'blob', 'abc123'],
    ]);
  });

  it('reads without a fetch when the caller just fetched, or reads after the run what the launch fetched', async () => {
    const { exec, calls } = git({ head: 'origin/main', config: CONFIG });
    expect(await makeRepoConfig({ exec })(PROJECT, { fetch: false })).toEqual(DECLARED);
    expect(calls.some((c) => c.includes('fetch'))).toBe(false);
  });

  it('gives up on a forge that does not answer, refusing the launch rather than holding it forever', async () => {
    const calls: { args: string[]; opts?: ExecOpts }[] = [];
    // `execCmd` kills a command past `timeoutMs` and answers TIMED_OUT (exec.test.ts): here, a fetch that never ends.
    const exec: Exec = async (_, args, opts) => {
      calls.push({ args, ...(opts ? { opts } : {}) });
      return args.includes('fetch') ? { stdout: '', stderr: '', code: TIMED_OUT } : { stdout: 'origin/main\n', stderr: '', code: 0 };
    };
    await expect(makeRepoConfig({ exec, fetchDeadlineMs: 20 })(PROJECT)).rejects.toThrow(/^the forge no longer responds after 0.02 s$/);
    // No prompt for a credential, a stalled transfer ends git by itself, and the deadline kills it with its ssh.
    expect(calls[0]!.opts).toMatchObject({ env: { GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000' }, timeoutMs: 20 });
    expect(calls.some((c) => c.args.includes('ls-tree'))).toBe(false);
  });

  it('gives the socle when the default branch has no file', async () => {
    expect(await makeRepoConfig({ exec: git({ head: 'origin/main' }).exec })(PROJECT)).toEqual(parseRepoConfig(undefined));
  });

  it('rejects an invalid file, naming the fault', async () => {
    await expect(makeRepoConfig({ exec: git({ head: 'origin/main', config: 'env: [PATH]\n' }).exec })(PROJECT)).rejects.toThrow('env[0]');
  });

  it('rejects when the default branch cannot be read: a file it could not see is not an absent one', async () => {
    const log: string[] = [];
    const exec: Exec = async (_, args) => (args.includes('ls-tree') ? { stdout: '', stderr: 'fatal: Not a valid object name', code: 128 } : { stdout: 'origin/main\n', stderr: '', code: 0 });
    const err = await makeRepoConfig({ exec, log: (m) => log.push(m) })(PROJECT).catch((e: Error) => e);
    // What reaches Linear: neither the server's path nor a git command line, nor a hint for an origin/HEAD that is set.
    expect((err as Error).message).toBe('unreadable default branch (origin/main)');
    // The detail stays in the daemon's log.
    expect(log).toEqual([expect.stringMatching(/-C \/repo ls-tree .*Not a valid object name/)]);
  });

  it('suggests set-head only when origin/HEAD is what is missing', async () => {
    const exec: Exec = async (_, args) =>
      args.includes('symbolic-ref') || args.includes('ls-tree') ? { stdout: '', stderr: 'fatal: /repo: ref missing', code: 128 } : { stdout: '', stderr: '', code: 0 };
    const err = (await makeRepoConfig({ exec, log: () => {} })(PROJECT).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^unreadable default branch \(origin\/main\): origin\/HEAD is not set.*git remote set-head origin --auto/);
    expect(err.message).not.toContain('/repo');
  });

  it('names a file it could not read as such: the branch was read, set-head would fix nothing', async () => {
    const exec: Exec = async (_, args) => {
      if (args.includes('symbolic-ref') || args.includes('cat-file')) return { stdout: '', stderr: 'fatal', code: 128 };
      if (args.at(-1) === '.factory') return { stdout: '040000 tree def456\t.factory\0', stderr: '', code: 0 };
      if (args.includes('ls-tree')) return { stdout: '100644 blob abc123\t.factory/config.yml\0', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const err = (await makeRepoConfig({ exec, log: () => {} })(PROJECT).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('.factory/config.yml unreadable on origin/main (git object missing or damaged)');
  });

  it('names a submodule at .factory as such', async () => {
    const err = (await makeRepoConfig({ exec: git({ head: 'origin/main', config: CONFIG, dir: '160000 commit' }).exec })(PROJECT).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/\.factory is not a folder on origin\/main \(symbolic link, file or submodule\)/);
  });

  it('names neither the path nor the command when the fetch fails', async () => {
    const exec: Exec = async (_, args) => (args.includes('fetch') ? { stdout: '', stderr: "fatal: '/srv/factory/repo' does not appear to be a git repository", code: 128 } : { stdout: 'origin/main\n', stderr: '', code: 0 });
    const err = (await makeRepoConfig({ exec, log: () => {} })(PROJECT).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('the forge could not be read (git fetch, code 128)');
  });

  it.each(['120000 blob', '040000 tree'])('rejects a .factory/config.yml that is not a file (%s)', async (mode) => {
    await expect(makeRepoConfig({ exec: git({ head: 'origin/main', config: CONFIG, mode }).exec })(PROJECT)).rejects.toThrow(/is not a file/);
    // The repository's to fix, as an invalid file is: not a breakdown of the factory.
    await expect(makeRepoConfig({ exec: git({ head: 'origin/main', config: CONFIG, mode }).exec })(PROJECT)).rejects.toBeInstanceOf(RepoConfigError);
  });

  it('reads the remote branch, never a tag of its name, when origin/HEAD is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-repo-config-'));
    try {
      const { run, repo } = forgeAndClone(root, 'network: { level: none }\n');
      // An unmerged branch, and a tag named like the remote branch on it: pushed by anyone who can push to the forge.
      run(repo, 'checkout', '--quiet', '-b', 'widen');
      writeFileSync(join(repo, '.factory', 'config.yml'), 'network: { level: custom, allow: [evil.exemple.com] }\n');
      run(repo, 'commit', '--quiet', '-am', 'widen');
      run(repo, 'push', '--quiet', 'origin', 'widen', 'widen:refs/tags/origin/main');
      run(repo, 'remote', 'set-head', 'origin', '--delete');
      expect((await makeRepoConfig()({ repoPath: repo })).network).toEqual({ level: 'none', allow: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a .factory that is not a directory: git reads nothing through a link, which is not an absent file', async () => {
    await expect(makeRepoConfig({ exec: git({ head: 'origin/main', config: CONFIG, dir: '120000 blob' }).exec })(PROJECT)).rejects.toThrow(/\.factory is not a folder/);
    await expect(makeRepoConfig({ exec: git({ head: 'origin/main', config: CONFIG, dir: '120000 blob' }).exec })(PROJECT)).rejects.toBeInstanceOf(RepoConfigError);
    const root = mkdtempSync(join(tmpdir(), 'factory-repo-config-'));
    try {
      const { run, repo } = forgeAndClone(root, 'network: { level: none }\n');
      run(repo, 'mv', '.factory', 'ci');
      symlinkSync('ci', join(repo, '.factory'));
      run(repo, 'add', '-A');
      run(repo, 'commit', '--quiet', '-m', 'link');
      run(repo, 'push', '--quiet', 'origin', 'main');
      await expect(makeRepoConfig()({ repoPath: repo })).rejects.toThrow(/\.factory is not a folder/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores the agent's branch and its worktree: the default branch's file, as merged on the forge, applies (criterion 5)", async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-repo-config-'));
    try {
      const { run, forge, repo } = forgeAndClone(root, 'network: { level: none }\n');
      run(repo, 'checkout', '--quiet', '-b', 'agent');
      writeFileSync(join(repo, '.factory', 'config.yml'), 'network: { level: custom, allow: [evil.exemple.com] }\n');
      run(repo, 'commit', '--quiet', '-am', 'widen');
      const read = makeRepoConfig();
      expect((await read({ repoPath: repo })).network).toEqual({ level: 'none', allow: [] });
      // Merged on the forge since: the next launch takes it, without a fetch of its own before.
      const human = join(root, 'human');
      execFileSync('git', ['clone', '--quiet', forge, human]);
      writeFileSync(join(human, '.factory', 'config.yml'), 'network: { level: custom, allow: [docs.exemple.com] }\n');
      run(human, 'commit', '--quiet', '-am', 'allow docs');
      run(human, 'push', '--quiet', 'origin', 'main');
      expect((await read({ repoPath: repo })).network).toEqual({ level: 'custom', allow: ['docs.exemple.com'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('makeRepoVariables (ORC-211)', () => {
  it('takes the declaration it is given, and reads nothing of the repository but its origin', async () => {
    const { exec, calls } = git({ head: 'origin/trunk' });
    const vars = await makeRepoVariables({ yml: YML, exec, log: () => {} })(PROJECT, DECLARED);
    expect(vars).toEqual({ env: { NODE_ENV: 'test' }, setupSecrets: { REGISTRY_TOKEN: 'registry-secret' }, missing: [] });
    expect(calls.every((c) => c.includes('get-url'))).toBe(true);
  });

  it.each(['git@github.com:Org/App.git', 'https://x-access-token:t@github.com/org/app', 'ssh://git@github.com/ORG/app.git/'])('finds the entry of the repository from its origin %s', async (origin) => {
    const vars = await makeRepoVariables({ yml: YML, exec: git({ origin }).exec, log: () => {} })(PROJECT, DECLARED);
    expect(vars.setupSecrets).toEqual({ REGISTRY_TOKEN: 'registry-secret' });
  });

  it('gives nothing to a remote of the same path on another host', async () => {
    const { exec } = git({ origin: 'https://gitlab.exemple.com/org/app.git' });
    expect(await makeRepoVariables({ yml: YML, exec, log: () => {} })(PROJECT, DECLARED)).toEqual(NO_REPO_VARIABLES);
  });

  it('gives nothing to a project of another team, whatever its origin says', async () => {
    const { exec, calls } = git();
    expect(await makeRepoVariables({ yml: YML, exec, log: () => {} })({ ...PROJECT, teamKey: 'OTHER' }, DECLARED)).toEqual(NO_REPO_VARIABLES);
    expect(calls).toEqual([]);
  });

  it('gives nothing to a repository with no entry in factory.yml', async () => {
    const { exec } = git({ origin: 'https://github.com/org/other.git' });
    expect(await makeRepoVariables({ yml: YML, exec, log: () => {} })(PROJECT, DECLARED)).toEqual(NO_REPO_VARIABLES);
  });

  it('gives nothing without factory.yml', async () => {
    const { exec, calls } = git();
    expect(await makeRepoVariables({ yml: undefined, exec, log: () => {} })(PROJECT, DECLARED)).toEqual(NO_REPO_VARIABLES);
    expect(calls).toEqual([]);
  });

  it('gives nothing when the repository declares nothing', async () => {
    const vars = await makeRepoVariables({ yml: YML, exec: git().exec, log: () => {} })(PROJECT, parseRepoConfig(undefined));
    expect(vars).toEqual({ env: {}, setupSecrets: {}, missing: [] });
  });

  it('logs by name what the repository declares and the server does not give', async () => {
    const log: string[] = [];
    await makeRepoVariables({ yml: YML, exec: git().exec, log: (m) => log.push(m) })(PROJECT, parseRepoConfig('env: [NODE_ENV, API_URL]\n'));
    expect(log.join()).toContain('API_URL');
  });

  it('rejects when git fails, for the caller to log', async () => {
    const exec: Exec = async () => Promise.reject(new Error('no git'));
    await expect(makeRepoVariables({ yml: YML, exec, log: () => {} })(PROJECT, DECLARED)).rejects.toThrow('no git');
  });
});

describe('makeOriginUrl (ORC-151)', () => {
  it('reads the URL once by process: what changes in the repository config afterwards changes nothing', async () => {
    const urls = ['https://forge/real.git', 'https://evil/forged.git'];
    const exec = vi.fn(async () => ({ stdout: `${urls.shift()}\n`, stderr: '', code: 0 }));
    const url = makeOriginUrl({ exec });
    expect(await url({ repoPath: '/r' })).toBe('https://forge/real.git');
    expect(await url({ repoPath: '/r' })).toBe('https://forge/real.git');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
