import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { NO_GITHUB_APP } from '../adapters/forge/no-forge.js';
import { saveInstance } from '../config/instance.js';
import { cliGithubForge } from './github.js';

describe('cliGithubForge (ORC-181)', () => {
  beforeEach(() => {
    vi.stubEnv('GH_APP_ID', '');
    vi.stubEnv('GH_APP_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  const home = (github?: { appId: string; privateKey: string }) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-cli-github-'));
    saveInstance(dir, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {}, ...(github ? { github } : {}) });
    return dir;
  };

  it('says the command reads GitHub by the App alone, without one: no gh fallback', () => {
    expect(cliGithubForge(home(), undefined, 'ghost')).toBe(`factory ghost reads GitHub by its App alone: ${NO_GITHUB_APP}.`);
  });

  it('gives the App forge with the daemon configuration', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(cliGithubForge(home({ appId: '123', privateKey: pem }), undefined, 'baseline')).toBeInstanceOf(GitHubAppForge);
  });
});
