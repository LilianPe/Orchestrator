import { describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import { httpsGithub, projectGithub } from './project-github.js';

/** A clone whose `origin` is `origin` (none: git fails to read it), every command it is asked kept. */
function clone(origin?: string): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (_, args) => {
    calls.push(args);
    return origin === undefined ? { stdout: '', stderr: "error: No such remote 'origin'", code: 2 } : { stdout: `${origin}\n`, stderr: '', code: 0 };
  };
  return { exec, calls };
}

const REPOS = [
  { linearTeam: 'REL', github: 'Org/App' },
  { linearTeam: 'REL', github: 'org/site' },
  { linearTeam: 'OPS', github: 'org/infra' },
];

describe('projectGithub (ORC-478)', () => {
  it.each(['https://github.com/org/app.git', 'git@github.com:ORG/app.git', 'https://x-access-token:t@github.com/org/app'])(
    "takes the spelling of the team's factory.yml entry its origin %s names",
    async (origin) => {
      expect(await projectGithub({ repoPath: '/repo', teamKey: 'REL', repos: REPOS, exec: clone(origin).exec })).toMatchObject({ github: 'Org/App' });
    },
  );

  it('reads the origin of the clone once, and nothing else of it', async () => {
    const { exec, calls } = clone('https://github.com/org/site.git');
    expect(await projectGithub({ repoPath: '/repo', teamKey: 'REL', repos: REPOS, exec })).toEqual({ github: 'org/site', https: true });
    expect(calls).toEqual([['-C', '/repo', 'remote', 'get-url', 'origin']]);
  });

  it("falls back on the origin's own name when no entry of the team names it: another team's entry is never taken", async () => {
    expect(await projectGithub({ repoPath: '/repo', teamKey: 'REL', repos: REPOS, exec: clone('https://github.com/org/infra').exec })).toEqual({ github: 'org/infra', https: true });
    expect(await projectGithub({ repoPath: '/repo', teamKey: 'NEW', exec: clone('git@github.com:acme/tool.git').exec })).toEqual({ github: 'acme/tool', https: false });
  });

  it.each([
    ['another host', 'https://gitlab.example.com/org/app.git'],
    ['a local path', '/srv/git/app.git'],
    ['a GitHub URL that names no repository', 'https://github.com/org'],
  ])('refuses an origin on %s, with what to do and never its URL', async (_, origin) => {
    const err = await projectGithub({ repoPath: '/repo', teamKey: 'REL', repos: REPOS, exec: clone(origin).exec }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^the origin remote of \/repo is not a GitHub repository: .*github\.com/);
    expect((err as Error).message).not.toContain(origin);
  });

  it("refuses a clone without origin, whatever the team's entries", async () => {
    await expect(projectGithub({ repoPath: '/repo', teamKey: 'OPS', repos: REPOS, exec: clone().exec })).rejects.toThrow(/^the origin remote of \/repo cannot be read: .*No such remote/);
  });
});

describe('httpsGithub (ORC-478)', () => {
  it('names the GitHub repository a clone fetches over HTTPS, and nothing for one over ssh, elsewhere or without origin', async () => {
    expect(await httpsGithub('/kb', clone('https://github.com/org/kb.git').exec)).toBe('org/kb');
    expect(await httpsGithub('/kb', clone('https://x-access-token:t@github.com/org/kb').exec)).toBe('org/kb');
    expect(await httpsGithub('/kb', clone('git@github.com:org/kb.git').exec)).toBeUndefined();
    expect(await httpsGithub('/kb', clone('ssh://git@github.com/org/kb.git').exec)).toBeUndefined();
    expect(await httpsGithub('/kb', clone('https://gitlab.example.com/org/kb.git').exec)).toBeUndefined();
    expect(await httpsGithub('/kb', clone().exec)).toBeUndefined();
  });
});
