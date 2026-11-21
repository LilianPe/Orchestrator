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
  relayWarnings,
  saveInstance,
  saveLinearTokens,
  saveSecrets,
  sealSecretsAtRest,
  secretValues,
} from './instance.js';
import { isSealed } from './secrets-file.js';

describe('instance config', () => {
  it('resolves home', () => {
    expect(factoryHome({ FACTORY_HOME: '/x' } as NodeJS.ProcessEnv)).toBe('/x');
    expect(factoryHome({ HOME: '/home/u' } as NodeJS.ProcessEnv)).toBe(join('/home/u', '.factory'));
  });

  it('returns defaults, then round-trips', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    expect(loadInstance(home)).toEqual({ port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const cfg = {
      port: 4100, host: '127.0.0.1', relay: { kind: 'smee' as const, url: 'https://smee.io/abc' },
      projects: [{ id: 'perso', repoPath: '/code/perso', linearTeamKey: 'REL' }], limits: {},
      knowledge: { repoPath: join(home, 'knowledge') },
    };
    saveInstance(home, cfg);
    expect(loadInstance(home)).toEqual(cfg);
  });

  it('loads a config.yaml that still has the daily budget in dollars, without it: no queue waits on dollars (ORC-216)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    writeFileSync(join(home, 'config.yaml'), 'limits:\n  perDayUsd: 20\n');
    expect(loadInstance(home).limits).toEqual({});
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

  // Windows has no POSIX mode bits: Node reports 0o666 whatever chmod asked. The file takes its folder's ACL there,
  // which docs/installation.md asks to keep private (saveSecrets).
  it.skipIf(process.platform === 'win32')('writes secrets with mode 600', () => {
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

// ORC-444, ORC-446: Smee is the workstation's relay, in the development mode `factory init --dev` writes.
describe('the Smee relay outside the development mode', () => {
  const smee = { kind: 'smee' as const, url: 'https://smee.io/abc' };

  it('says nothing without a relay, nor in the development mode', () => {
    expect(relayWarnings({ relay: { kind: 'none' } })).toEqual([]);
    expect(relayWarnings({ relay: { kind: 'none' }, dev: false, publicUrl: 'https://f.example.com' })).toEqual([]);
    expect(relayWarnings({ relay: smee, dev: true })).toEqual([]);
  });

  it('warns of a config written before the marker, naming factory init --dev', () => {
    expect(relayWarnings({ relay: smee })).toEqual([expect.stringMatching(/^Warning: relay: \{ kind: smee \}.*dev: true.*factory init --dev/)]);
  });

  it('refuses dev: false, naming publicUrl and factory init --dev', () => {
    expect(() => relayWarnings({ relay: smee, dev: false })).toThrow(/relay: \{ kind: smee \}.*dev: false.*publicUrl.*factory init --dev/);
  });

  it('names relay: { kind: none } alone to a config that has a publicUrl, where factory init --dev writes nothing', () => {
    const server = { relay: smee, publicUrl: 'https://f.example.com' };
    expect(relayWarnings(server)).toEqual([expect.stringMatching(/publicUrl: https:\/\/f\.example\.com brings Linear's webhooks already, set relay: \{ kind: none \}\.$/)]);
    expect(() => relayWarnings({ ...server, dev: false })).toThrow(/dev: false.*set relay: \{ kind: none \}\.$/);
  });

  it('refuses a publicUrl beside the relay in the development mode, naming relay: { kind: none }', () => {
    expect(() => relayWarnings({ relay: smee, dev: true, publicUrl: 'https://f.example.com' })).toThrow(/publicUrl: https:\/\/f\.example\.com.*relay: \{ kind: none \}/);
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

  it('masks the secrets of factory.yml in run transcripts too', () => {
    const h = home('linear: { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\n');
    expect(daemonSecretValues(h, loadFactoryYml(h, env))).toEqual(expect.arrayContaining(['yml-secret', 'yml-webhook-secret-1']));
  });

  it("masks a repository's env secrets from the start, a restart included, never its plain variables (ORC-211, ORC-308)", () => {
    const h = home('repos: [{ linear_team: REL, github: org/app, env: { NODE_ENV: test-value }, secrets: { NPM_TOKEN: env:ORG_NPM_TOKEN, UNSET: env:ORG_UNSET, SEED: alias:ORG_SEED } }]\nsecret_sources: { alias: { kind: env } }\n');
    const daemonEnv = { ...env, ORG_NPM_TOKEN: 'npm-secret-value', ORG_SEED: 'seed-secret-value' };
    const values = daemonSecretValues(h, loadFactoryYml(h, daemonEnv), daemonEnv);
    expect(values).toEqual(expect.arrayContaining(['npm-secret-value', 'seed-secret-value']));
    expect(values).not.toContain('test-value');
    expect(values).not.toContain(undefined);
  });
});

describe('secrets.json encrypted at rest (ORC-398)', () => {
  const KEY = 'secrets-key-of-at-least-32-characters!';
  const home = () => mkdtempSync(join(tmpdir(), 'factory-sealed-'));
  const linear = { clientId: 'c', clientSecret: 'client-secret-value', webhookSecret: 'webhook-secret-value', accessToken: 'access-token-value' };

  it('with its key, writes nothing of the file in clear, and reads it back', () => {
    const h = home();
    saveSecrets(h, { linear }, KEY);
    const text = readFileSync(homePaths(h).secrets, 'utf8');
    expect(isSealed(text)).toBe(true);
    expect(text).not.toContain('access-token-value');
    expect(loadSecrets(h, KEY)).toEqual({ linear });
  });

  it('refuses to read a sealed file without its key, naming secrets_key', () => {
    const h = home();
    saveSecrets(h, { linear }, KEY);
    expect(() => loadSecrets(h)).toThrow('secrets.json is encrypted at rest: it is read with the key secrets_key of factory.yml names');
  });

  it('Linear tokens saved and read through factory.yml\'s key stay sealed', () => {
    const h = home();
    saveLinearTokens(h, { accessToken: 'refreshed-token-value' }, { secretsKey: KEY });
    expect(readFileSync(homePaths(h).secrets, 'utf8')).not.toContain('refreshed-token-value');
    expect(linearSettings(h, { secretsKey: KEY })?.accessToken).toBe('refreshed-token-value');
  });

  it('seals a plaintext file at the start, once, and leaves a home without one alone', () => {
    const h = home();
    expect(sealSecretsAtRest(h, KEY)).toBe(false);
    saveSecrets(h, { linear });
    expect(sealSecretsAtRest(h, KEY)).toBe(true);
    expect(readFileSync(homePaths(h).secrets, 'utf8')).not.toContain('access-token-value');
    expect(sealSecretsAtRest(h, KEY)).toBe(false);
    expect(loadSecrets(h, KEY)).toEqual({ linear });
  });

  it('masks the key, and an option of a source resolved from the environment', () => {
    const h = home();
    writeFileSync(join(h, 'factory.yml'), 'secrets_key: env:SECRETS_KEY\nsecret_sources: { creds: { kind: systemd-creds, store: env:CRED_STORE } }\n');
    const daemonEnv = { SECRETS_KEY: KEY, CRED_STORE: '/etc/credstore.encrypted' };
    expect(daemonSecretValues(h, loadFactoryYml(h, daemonEnv), daemonEnv)).toEqual(expect.arrayContaining([KEY, '/etc/credstore.encrypted']));
  });
});
