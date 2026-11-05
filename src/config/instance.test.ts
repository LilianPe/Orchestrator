import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFactoryYml } from './factory-yml.js';
import {
  daemonSecretValues,
  effectiveInstance,
  homePaths,
  linearSettings,
  loadInstance,
  loadSecrets,
  factoryHome,
  saveInstance,
  saveLinearTokens,
  saveSecrets,
  secretValues,
} from './instance.js';

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

describe('factory.yml over the instance files (ORC-209, part B)', () => {
  const env = { LINEAR_CLIENT_ID: 'yml-client', LINEAR_CLIENT_SECRET: 'yml-secret', LINEAR_WEBHOOK_SECRET: 'yml-webhook-secret-1', GH_APP_KEY: '-----BEGIN RSA PRIVATE KEY-----\nk\n-----END RSA PRIVATE KEY-----' };
  function home(yml?: string): string {
    const h = mkdtempSync(join(tmpdir(), 'factory-yml-'));
    if (yml) writeFileSync(join(h, 'factory.yml'), yml);
    return h;
  }

  it('takes the GitHub App from factory.yml, and never writes it to config.yaml', () => {
    const h = home('github: { app_id: 42, private_key: env:GH_APP_KEY }\n');
    saveInstance(h, loadInstance(h));
    expect(effectiveInstance(h, loadFactoryYml(h, env)).github).toMatchObject({ appId: '42', privateKey: env.GH_APP_KEY });
    expect(loadInstance(h).github).toBeUndefined();
    expect(readFileSync(homePaths(h).config, 'utf8')).not.toContain('PRIVATE KEY');
  });

  it('keeps the GitHub fields of config.yaml that factory.yml leaves out', () => {
    const h = home('github: { app_id: 42, private_key: env:GH_APP_KEY }\n');
    saveInstance(h, { ...loadInstance(h), github: { appId: '1', privateKey: '/k.pem', installationId: '77', webhookSecret: 'gh-webhook-secret-xyz' } });
    expect(effectiveInstance(h, loadFactoryYml(h, env)).github).toEqual({ appId: '42', privateKey: env.GH_APP_KEY, installationId: '77', webhookSecret: 'gh-webhook-secret-xyz' });
  });

  it('takes the static Linear values from factory.yml, the OAuth tokens from secrets.json', () => {
    const h = home('linear: { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\n');
    saveSecrets(h, { linear: { clientId: 'old', clientSecret: 'old', webhookSecret: 'old-webhook-secret', accessToken: 'tok' } });
    expect(linearSettings(h, loadFactoryYml(h, env))).toMatchObject({ clientId: 'yml-client', clientSecret: 'yml-secret', webhookSecret: 'yml-webhook-secret-1', accessToken: 'tok' });
  });

  it('saves refreshed tokens without copying a secret of the environment to secrets.json', () => {
    const h = home('linear: { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\n');
    saveLinearTokens(h, { accessToken: 'new', refreshToken: 'r' });
    const stored = readFileSync(homePaths(h).secrets, 'utf8');
    expect(stored).toContain('new');
    expect(stored).not.toContain('yml-secret');
    expect(linearSettings(h, loadFactoryYml(h, env))).toMatchObject({ clientSecret: 'yml-secret', accessToken: 'new' });
  });

  it('masks the secrets of a repository in run transcripts too, not its plain variables (ORC-211)', () => {
    const h = home('repos: [{ linear_team: REL, github: org/app, env: { NODE_ENV: test-value }, secrets: { REGISTRY_TOKEN: env:LINEAR_CLIENT_SECRET } }]\n');
    const values = daemonSecretValues(h, loadFactoryYml(h, env));
    expect(values).toContain('yml-secret');
    expect(values).not.toContain('test-value');
  });

  it('masks the secrets of factory.yml in run transcripts too', () => {
    const h = home('linear: { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\n');
    expect(daemonSecretValues(h, loadFactoryYml(h, env))).toEqual(expect.arrayContaining(['yml-secret', 'yml-webhook-secret-1']));
  });
});
