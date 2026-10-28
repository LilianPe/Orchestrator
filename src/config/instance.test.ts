import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homePaths, loadInstance, loadSecrets, factoryHome, saveInstance, saveSecrets, secretValues } from './instance.js';

describe('instance config', () => {
  it('resolves home', () => {
    expect(factoryHome({ FACTORY_HOME: '/x' } as NodeJS.ProcessEnv)).toBe('/x');
    expect(factoryHome({ HOME: '/home/u' } as NodeJS.ProcessEnv)).toBe('/home/u/.factory');
  });

  it('returns defaults, then round-trips', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    expect(loadInstance(home)).toEqual({ port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const cfg = {
      port: 4100, host: '127.0.0.1', relay: { kind: 'smee' as const, url: 'https://smee.io/abc' },
      projects: [{ id: 'perso', repoPath: '/code/perso', linearTeamKey: 'REL' }], limits: { perDayUsd: 20 },
      knowledge: { repoPath: join(home, 'knowledge') },
    };
    saveInstance(home, cfg);
    expect(loadInstance(home)).toEqual(cfg);
  });

  it("reads a project's authorization designations and its Linear → GitHub logins (ORC-186), with defaults for what is left out", () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    const project = { id: 'perso', repoPath: '/code/perso', linearTeamKey: 'REL', authz: { validators: ['user-v'], githubLogins: { 'user-v': 'v-gh' } } };
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [project as never], limits: {} });
    expect(loadInstance(home).projects[0]!.authz).toEqual({ maintainers: [], validators: ['user-v'], githubLogins: { 'user-v': 'v-gh' } });
    expect(() => saveInstance(home, { port: 4100, host: 'h', relay: { kind: 'none' }, projects: [{ ...project, authz: { maintainers: [''] } } as never], limits: {} })).toThrow(
      /projects\.0\.authz\.maintainers\.0/,
    );
  });

  it('writes secrets with mode 600', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    expect(loadSecrets(home)).toEqual({});
    saveSecrets(home, { linear: { clientId: 'c', clientSecret: 's', webhookSecret: 'w' } });
    expect(loadSecrets(home).linear!.clientId).toBe('c');
    expect(statSync(homePaths(home).secrets).mode & 0o777).toBe(0o600);
  });

  it('lists the secret values of the secrets file, not its identifiers', () => {
    expect(secretValues({})).toEqual([]);
    const linear = { clientId: 'c', clientSecret: 's', webhookSecret: 'w', accessToken: 'a', refreshToken: 'r', appUserId: 'u', organizationId: 'o' };
    expect(secretValues({ linear })).toEqual(['s', 'w', 'a', 'r']);
  });

  it('rejects an invalid config with the key path', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    saveInstance(home, { port: 4100, host: 'h', relay: { kind: 'none' }, projects: [], limits: {} });
    expect(() => saveInstance(home, { port: -1 } as never)).toThrow(/port/);
  });
});
