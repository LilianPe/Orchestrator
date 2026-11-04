import { describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import { NO_REPO_VARIABLES } from '../config/repo-variables.js';
import { makeRepoVariables } from './repo-variables.js';

const YML = { repos: [{ linearTeam: 'REL', github: 'Org/App', env: { NODE_ENV: 'test' }, secrets: { REGISTRY_TOKEN: 'registry-secret' } }] };
const CONFIG = 'env: [NODE_ENV]\nsetup_secrets: [REGISTRY_TOKEN]\n';

/** A repository: its origin, its default branch, the config committed on it. */
function git(o: { origin?: string; head?: string; config?: string } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  const ko = { stdout: '', stderr: 'fatal', code: 128 };
  const exec: Exec = async (_, args) => {
    calls.push(args);
    if (args.includes('get-url')) return ok(`${o.origin ?? 'https://github.com/org/app.git'}\n`);
    if (args.includes('symbolic-ref')) return o.head === undefined ? ko : ok(`${o.head}\n`);
    if (args.includes('show')) return o.config === undefined ? ko : ok(o.config);
    return ko;
  };
  return { exec, calls };
}

const PROJECT = { id: 'p', repoPath: '/repo', teamKey: 'REL' };

describe('makeRepoVariables (ORC-211)', () => {
  it('reads the declaration on the default branch, never in a worktree the agent writes', async () => {
    const { exec, calls } = git({ head: 'origin/trunk', config: CONFIG });
    const vars = await makeRepoVariables({ yml: YML, exec, log: () => {} })(PROJECT);
    expect(vars).toEqual({ env: { NODE_ENV: 'test' }, setupSecrets: { REGISTRY_TOKEN: 'registry-secret' }, missing: [] });
    expect(calls.at(-1)).toEqual(['-C', '/repo', 'show', 'origin/trunk:.factory/config.yml']);
  });

  it.each(['git@github.com:Org/App.git', 'https://x-access-token:t@github.com/org/app', 'ssh://git@github.com/ORG/app.git/'])('finds the entry of the repository from its origin %s', async (origin) => {
    const vars = await makeRepoVariables({ yml: YML, exec: git({ origin, head: 'origin/main', config: CONFIG }).exec, log: () => {} })(PROJECT);
    expect(vars.setupSecrets).toEqual({ REGISTRY_TOKEN: 'registry-secret' });
  });

  it('gives nothing to a remote of the same path on another host', async () => {
    const { exec, calls } = git({ origin: 'https://gitlab.exemple.com/org/app.git', config: CONFIG });
    expect(await makeRepoVariables({ yml: YML, exec, log: () => {} })(PROJECT)).toEqual(NO_REPO_VARIABLES);
    expect(calls.some((c) => c.includes('show'))).toBe(false);
  });

  it('gives nothing to a project of another team, whatever its origin says', async () => {
    const { exec, calls } = git({ head: 'origin/main', config: CONFIG });
    expect(await makeRepoVariables({ yml: YML, exec, log: () => {} })({ ...PROJECT, teamKey: 'OTHER' })).toEqual(NO_REPO_VARIABLES);
    expect(calls).toEqual([]);
  });

  it('gives nothing to a repository with no entry in factory.yml, and reads nothing of it', async () => {
    const { exec, calls } = git({ origin: 'https://github.com/org/other.git', config: CONFIG });
    expect(await makeRepoVariables({ yml: YML, exec, log: () => {} })(PROJECT)).toEqual(NO_REPO_VARIABLES);
    expect(calls.some((c) => c.includes('show'))).toBe(false);
  });

  it('gives nothing without factory.yml', async () => {
    const { exec, calls } = git({ config: CONFIG });
    expect(await makeRepoVariables({ yml: undefined, exec, log: () => {} })(PROJECT)).toEqual(NO_REPO_VARIABLES);
    expect(calls).toEqual([]);
  });

  it('gives nothing when the default branch has no config', async () => {
    const vars = await makeRepoVariables({ yml: YML, exec: git({ head: 'origin/main' }).exec, log: () => {} })(PROJECT);
    expect(vars).toEqual({ env: {}, setupSecrets: {}, missing: [] });
  });

  it('gives nothing on an invalid config, and logs why', async () => {
    const log: string[] = [];
    const vars = await makeRepoVariables({ yml: YML, exec: git({ head: 'origin/main', config: 'env: [PATH]\n' }).exec, log: (m) => log.push(m) })(PROJECT);
    expect(vars).toEqual(NO_REPO_VARIABLES);
    expect(log.join()).toContain('env[0]');
  });

  it('logs by name what the repository declares and the server does not give', async () => {
    const log: string[] = [];
    await makeRepoVariables({ yml: YML, exec: git({ head: 'origin/main', config: 'env: [NODE_ENV, API_URL]\n' }).exec, log: (m) => log.push(m) })(PROJECT);
    expect(log.join()).toContain('API_URL');
  });

  it('gives nothing when git fails, without failing the launch', async () => {
    const exec: Exec = async () => Promise.reject(new Error('no git'));
    const log: string[] = [];
    expect(await makeRepoVariables({ yml: YML, exec, log: (m) => log.push(m) })(PROJECT)).toEqual(NO_REPO_VARIABLES);
    expect(log.join()).toContain('no git');
  });
});
