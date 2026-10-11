import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homePaths, loadInstance, loadSecrets, relaisHome, saveInstance, saveSecrets } from './instance.js';

describe('instance config', () => {
  it('resolves home', () => {
    expect(relaisHome({ RELAIS_HOME: '/x' } as NodeJS.ProcessEnv)).toBe('/x');
    expect(relaisHome({ HOME: '/home/u' } as NodeJS.ProcessEnv)).toBe('/home/u/.relais');
  });

  it('returns defaults, then round-trips', () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-home-'));
    expect(loadInstance(home)).toEqual({ port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const cfg = {
      port: 4100, host: '127.0.0.1', relay: { kind: 'smee' as const, url: 'https://smee.io/abc' },
      projects: [{ id: 'perso', repoPath: '/code/perso', linearTeamKey: 'REL' }], limits: { perDayUsd: 20 },
      knowledge: { repoPath: join(home, 'knowledge') },
    };
    saveInstance(home, cfg);
    expect(loadInstance(home)).toEqual(cfg);
  });

  it('writes secrets with mode 600', () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-home-'));
    expect(loadSecrets(home)).toEqual({});
    saveSecrets(home, { linear: { clientId: 'c', clientSecret: 's', webhookSecret: 'w' } });
    expect(loadSecrets(home).linear!.clientId).toBe('c');
    expect(statSync(homePaths(home).secrets).mode & 0o777).toBe(0o600);
  });

  it('rejects an invalid config with the key path', () => {
    const home = mkdtempSync(join(tmpdir(), 'relais-home-'));
    saveInstance(home, { port: 4100, host: 'h', relay: { kind: 'none' }, projects: [], limits: {} });
    expect(() => saveInstance(home, { port: -1 } as never)).toThrow(/port/);
  });
});
