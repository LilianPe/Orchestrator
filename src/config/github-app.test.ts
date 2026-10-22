import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGithubApp } from './github-app.js';
import { loadInstance, saveInstance, type InstanceConfig } from './instance.js';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBfake\n-----END PRIVATE KEY-----';

function base(): InstanceConfig {
  return { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} };
}

describe('GitHub App configuration', () => {
  it('returns undefined when no GitHub App is configured (gh fallback)', () => {
    expect(resolveGithubApp(base(), {})).toBeUndefined();
  });

  it('reads GH_APP_* env vars as a fallback, including a one-line PEM', () => {
    const settings = resolveGithubApp(base(), {
      GH_APP_ID: '123',
      GH_APP_KEY: PEM.replace(/\n/g, '\\n'),
      GH_APP_INSTALLATION_ID: '42',
    });
    expect(settings).toMatchObject({ appId: '123', installationId: '42' });
    expect(settings!.privateKey).toBe(`${PEM}\n`);
  });

  it('keeps config.yaml values above env vars', () => {
    const settings = resolveGithubApp(
      { ...base(), github: { appId: '7', privateKey: PEM, installationId: '99' } },
      { GH_APP_ID: '123', GH_APP_KEY: 'ignored', GH_APP_INSTALLATION_ID: '42' },
    );
    expect(settings).toMatchObject({ appId: '7', installationId: '99' });
  });

  it('reads a PEM from a file path instead of inlining it in config.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-gh-app-'));
    const keyFile = join(dir, 'app.pem');
    writeFileSync(keyFile, PEM);
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    const config = { ...base(), github: { appId: '7', privateKey: keyFile } };
    saveInstance(home, config);
    expect(loadInstance(home).github).toEqual({ appId: '7', privateKey: keyFile });
    expect(resolveGithubApp(loadInstance(home), {})).toEqual({ appId: '7', privateKey: `${PEM}\n` });
  });

  it('fails fast on a partial configuration rather than silently using gh', () => {
    expect(() => resolveGithubApp(base(), { GH_APP_ID: '123' })).toThrow(/incomplète/);
    expect(() => resolveGithubApp(base(), { GH_APP_KEY: PEM })).toThrow(/incomplète/);
  });

  it('accepts a numeric app id from YAML', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    saveInstance(home, { ...base(), github: { appId: 123, privateKey: PEM } } as never);
    expect(loadInstance(home).github).toEqual({ appId: '123', privateKey: PEM });
  });
});
