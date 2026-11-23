import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubOAuthClient, githubWebhookSecret, resolveGithubApp } from './github-app.js';
import { parseFactoryYml } from './factory-yml.js';
import { effectiveInstance, type InstanceConfig } from './instance.js';

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBfake\n-----END PRIVATE KEY-----';

function base(): InstanceConfig {
  return { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] };
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
    expect(settings).toMatchObject({ appId: '123', installationId: 42 });
    expect(settings!.privateKey).toBe(`${PEM}\n`);
  });

  it('keeps factory.yml values above env vars', () => {
    const settings = resolveGithubApp(
      { ...base(), github: { appId: '7', privateKey: PEM, installationId: '99' } },
      { GH_APP_ID: '123', GH_APP_KEY: 'ignored', GH_APP_INSTALLATION_ID: '42' },
    );
    expect(settings).toMatchObject({ appId: '7', installationId: 99 });
  });

  it('reads a PEM from a file path instead of inlining it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-gh-app-'));
    const keyFile = join(dir, 'app.pem');
    writeFileSync(keyFile, PEM);
    expect(resolveGithubApp({ ...base(), github: { appId: '7', privateKey: keyFile } }, {})).toEqual({ appId: '7', privateKey: `${PEM}\n` });
  });

  it('fails fast on a partial configuration rather than silently using gh', () => {
    expect(() => resolveGithubApp(base(), { GH_APP_ID: '123' })).toThrow(/Incomplete/);
    expect(() => resolveGithubApp(base(), { GH_APP_KEY: PEM })).toThrow(/Incomplete/);
  });

  it('reads the GitHub webhook secret from factory.yml, else GH_WEBHOOK_SECRET, else none (ORC-134)', () => {
    const app = { appId: '7', privateKey: PEM };
    expect(githubWebhookSecret({ ...base(), github: { ...app, webhookSecret: ' conf ' } }, { GH_WEBHOOK_SECRET: 'env' })).toBe('conf');
    expect(githubWebhookSecret({ ...base(), github: { ...app, webhookSecret: '' } }, { GH_WEBHOOK_SECRET: 'env' })).toBe('env');
    expect(githubWebhookSecret(base(), { GH_WEBHOOK_SECRET: ' env ' })).toBe('env');
    expect(githubWebhookSecret(base(), {})).toBe('');
  });

  it("reads the App's OAuth client of the dashboard sign-in from factory.yml, else GH_APP_CLIENT_ID and GH_APP_CLIENT_SECRET (ORC-399)", () => {
    const app = { appId: '7', privateKey: PEM };
    expect(githubOAuthClient({ ...base(), github: { ...app, clientId: 'Iv1.conf', clientSecret: ' conf-secret ' } }, { GH_APP_CLIENT_ID: 'env' })).toEqual({ clientId: 'Iv1.conf', clientSecret: 'conf-secret' });
    expect(githubOAuthClient(base(), { GH_APP_CLIENT_ID: 'Iv1.env', GH_APP_CLIENT_SECRET: 'env-secret' })).toEqual({ clientId: 'Iv1.env', clientSecret: 'env-secret' });
    expect(githubOAuthClient(base(), {})).toBeUndefined();
    expect(() => githubOAuthClient(base(), { GH_APP_CLIENT_ID: 'Iv1.env' })).toThrow(/client id and its client secret/);
  });

  it('accepts a numeric app id from YAML', () => {
    expect(effectiveInstance(parseFactoryYml('github: { app_id: 123, private_key: env:GH_APP_KEY }\n', { GH_APP_KEY: PEM })).github).toEqual({ appId: '123', privateKey: PEM });
  });

  it('keeps the pinned installation as a number, from YAML written 42 or "42", or from GH_APP_INSTALLATION_ID (ORC-490)', () => {
    const pinned = (written: string, env: NodeJS.ProcessEnv = {}) =>
      resolveGithubApp(effectiveInstance(parseFactoryYml(`github: { app_id: 123, private_key: env:GH_APP_KEY${written} }\n`, { GH_APP_KEY: PEM })), env)?.installationId;
    expect(pinned(', installation_id: 42')).toBe(42);
    expect(pinned(', installation_id: "42"')).toBe(42);
    expect(pinned('', { GH_APP_INSTALLATION_ID: ' 42 ' })).toBe(42);
    // A leading zero changes nothing: YAML reads `042` unquoted as 42 already, its quoted form is the same id.
    expect(pinned(', installation_id: "042"')).toBe(42);
    expect(pinned('')).toBeUndefined();
  });

  it('refuses at the start a pinned installation that is not a positive integer, saying what to write (ORC-490)', () => {
    const start = (installationId: string) => () => resolveGithubApp({ ...base(), github: { appId: '7', privateKey: PEM, installationId } }, {});
    for (const written of ['abc', '0', '-42', '4.2', '42abc', '1e3', '99999999999999999999']) {
      expect(start(written)).toThrow(`github.installation_id: "${written}" is not an installation id.`);
    }
    expect(start('abc')).toThrow(/Write the positive integer GitHub shows at the end of the installation's URL .*settings\/installations\/<id>/);
    expect(() => resolveGithubApp(base(), { GH_APP_ID: '7', GH_APP_KEY: PEM, GH_APP_INSTALLATION_ID: 'abc' })).toThrow(/^GH_APP_INSTALLATION_ID: "abc" is not an installation id/);
    // factory.yml's key hides the variable: the refusal names the key read.
    expect(() => resolveGithubApp({ ...base(), github: { appId: '7', privateKey: PEM, installationId: 'abc' } }, { GH_APP_INSTALLATION_ID: '42' })).toThrow(/^github\.installation_id: "abc"/);
  });
});
