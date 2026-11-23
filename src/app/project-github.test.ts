import { describe, expect, it } from 'vitest';
import type { Exec } from '../adapters/exec.js';
import { originGithub, sameGithub } from './project-github.js';

/** A clone whose `origin` is `origin` (none: git fails to read it), every command it is asked kept. */
function clone(origin?: string): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (_, args) => {
    calls.push(args);
    return origin === undefined ? { stdout: '', stderr: "error: No such remote 'origin'", code: 2 } : { stdout: `${origin}\n`, stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('originGithub (ORC-478, ORC-480)', () => {
  it.each([
    ['https://github.com/Org/App.git', 'Org/App'],
    ['git@github.com:org/app.git', 'org/app'],
    ['https://x-access-token:t@github.com/org/app', 'org/app'],
  ])('names the GitHub repository of the origin %s', async (origin, github) => {
    expect(await originGithub('/repo', clone(origin).exec)).toBe(github);
  });

  it('reads the origin of the checkout once, and nothing else of it', async () => {
    const { exec, calls } = clone('https://github.com/org/site.git');
    expect(await originGithub('/repo', exec)).toBe('org/site');
    expect(calls).toEqual([['-C', '/repo', 'remote', 'get-url', 'origin']]);
  });

  it.each([
    ['another host', 'https://gitlab.example.com/org/app.git'],
    ['a local path', '/srv/git/app.git'],
    ['a GitHub URL that names no repository', 'https://github.com/org'],
  ])('refuses an origin on %s, with what to do and never its URL', async (_, origin) => {
    const err = await originGithub('/repo', clone(origin).exec).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^the origin remote of \/repo is not a GitHub repository: .*github\.com/);
    expect((err as Error).message).not.toContain(origin);
  });

  it('refuses a checkout without origin', async () => {
    await expect(originGithub('/repo', clone().exec)).rejects.toThrow(/^the origin remote of \/repo cannot be read: .*No such remote/);
  });

  it('tells one repository whatever its case', () => {
    expect(sameGithub('Org/App', 'org/app')).toBe(true);
    expect(sameGithub('org/app', 'org/app2')).toBe(false);
  });
});
