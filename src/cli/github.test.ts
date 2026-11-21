import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppForge } from '../adapters/forge/github-app.js';
import { NO_GITHUB_APP } from '../adapters/forge/no-forge.js';
import { cliGithubForge } from './github.js';

describe('cliGithubForge (ORC-181)', () => {
  beforeEach(() => {
    vi.stubEnv('GH_APP_ID', '');
    vi.stubEnv('GH_APP_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('says the command reads GitHub by the App alone, without one: no gh fallback', () => {
    expect(cliGithubForge(undefined, 'ghost')).toBe(`factory ghost reads GitHub by its App alone: ${NO_GITHUB_APP}.`);
  });

  it("gives the App forge with factory.yml's App", () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(cliGithubForge({ github: { appId: '123', privateKey: pem } }, 'baseline')).toBeInstanceOf(GitHubAppForge);
  });
});
