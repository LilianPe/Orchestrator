import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_SOURCE_KINDS } from '../adapters/secrets/registry.js';
import { loadFactoryYml, parseFactoryYml } from './factory-yml.js';
import {
  daemonSecretValues,
  effectiveInstance,
  homePaths,
  linearSettings,
  loadInstance,
  loadSecrets,
  factoryHome,
  oldInstanceFileWarnings,
  relayWarnings,
  saveInstance,
  saveLinearTokens,
  saveSecrets,
  sealSecretsAtRest,
  secretValues,
} from './instance.js';
import { isSealed, LINEAR_NEEDS_SECRETS_KEY, openSecretsFile } from './secrets-file.js';

describe('instance config', () => {
  it('resolves home', () => {
    expect(factoryHome({ FACTORY_HOME: '/x' } as NodeJS.ProcessEnv)).toBe('/x');
    expect(factoryHome({ HOME: '/home/u' } as NodeJS.ProcessEnv)).toBe(join('/home/u', '.factory'));
  });

  it('returns defaults without factory.yml, then round-trips its instance keys (ORC-199)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    expect(loadInstance(home)).toEqual({ port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const cfg = {
      port: 4100, host: '127.0.0.1', relay: { kind: 'smee' as const, url: 'https://smee.io/abc' }, dev: true,
      projects: [{ id: 'perso', github: 'org/perso', linearTeamKey: 'REL', effects: 'none' as const }],
      knowledge: { repoPath: join(home, 'knowledge') },
    };
    saveInstance(home, cfg);
    expect(loadInstance(home)).toEqual(cfg);
    expect(readFileSync(homePaths(home).factoryYml, 'utf8')).toContain('repos:\n  - id: perso\n    github: org/perso\n    linear_team: REL\n    effects: none\n');
  });

  it('never reads config.yaml: its keys are not the instance (ORC-199)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    writeFileSync(join(home, 'config.yaml'), 'port: 4555\nprojects: [{ id: old, repoPath: /old, linearTeamKey: OLD }]\n');
    expect(loadInstance(home)).toEqual({ port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
  });

  it('writes its instance keys into factory.yml, leaving the rest of the file and its comments as they are (ORC-199)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    writeFileSync(join(home, 'factory.yml'), '# the budgets\nbudgets: { per_ticket_tokens: 1000 } # per ticket\nconcurrency: 2\n');
    saveInstance(home, { port: 4101, host: '127.0.0.1', relay: { kind: 'none' }, projects: [] });
    const text = readFileSync(homePaths(home).factoryYml, 'utf8');
    expect(text).toContain('# the budgets\nbudgets: { per_ticket_tokens: 1000 } # per ticket\nconcurrency: 2\n');
    expect(loadFactoryYml(home, {})).toMatchObject({ port: 4101, concurrency: 2, budgets: { perTicketTokens: 1000 } });
  });

  it("reads a project's authorization designations and its Linear → GitHub logins (ORC-186), with defaults for what is left out", () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    writeFileSync(join(home, 'factory.yml'), 'repos:\n  - { id: perso, github: org/perso, linear_team: REL, authz: { validators: [user-v], github_logins: { user-v: v-gh } } }\n');
    expect(loadInstance(home).projects[0]!.authz).toEqual({ maintainers: [], validators: ['user-v'], githubLogins: { 'user-v': 'v-gh' } });
    const project = { id: 'perso', github: 'org/perso', linearTeamKey: 'REL', authz: { maintainers: [''], validators: [], githubLogins: {} } };
    expect(() => saveInstance(home, { port: 4100, host: 'h', relay: { kind: 'none' }, projects: [project] })).toThrow(/repos\[0\]\.authz\.maintainers\[0\]/);
  });

  it("writes each repository's entry with the env and secrets the file holds, as written, comments included, never a value read from them (ORC-480)", () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    const env = '    env:\n      NODE_ENV: test\n      API_URL: env:ORG_API_URL\n    secrets:\n      NPM_TOKEN: env:ORG_NPM_TOKEN # rotated each quarter\n';
    writeFileSync(join(home, 'factory.yml'), `repos:\n  - id: app\n    github: org/app\n    linear_team: REL\n${env}`);
    const yml = loadFactoryYml(home, { ORG_API_URL: 'https://api', ORG_NPM_TOKEN: 'npm-secret-value' })!;
    // What the daemon resolved, handed back as init would: none of its values is written.
    const [app] = effectiveInstance(yml).projects;
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ ...app!, linearTeamKey: 'ENG' }, { id: 'site', github: 'org/site', linearTeamKey: 'ENG' }] });
    const text = readFileSync(homePaths(home).factoryYml, 'utf8');
    expect(text).toBe(`repos:\n  - id: app\n    github: org/app\n    linear_team: ENG\n${env}  - id: site\n    github: org/site\n    linear_team: ENG\n`);
    expect(text).not.toContain('npm-secret-value');
    expect(text).not.toContain('https://api');
  });

  it('refuses to read or write the instance of a factory.yml that still lists projects, saying how to rewrite it (ORC-480)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    writeFileSync(join(home, 'factory.yml'), 'projects:\n  - { id: perso, repo_path: /code/perso, linear_team_key: REL }\n');
    expect(() => loadInstance(home)).toThrow(/projects: replaced by repos \(ORC-480\)/);
    // A bare `projects:` too: `repos` would be read as the old list's otherwise.
    writeFileSync(join(home, 'factory.yml'), 'projects:\nrepos:\n  - { id: app, github: org/app, linear_team: REL }\n');
    expect(() => loadInstance(home)).toThrow(/projects: replaced by repos/);
    expect(() => parseFactoryYml('projects:\nrepos:\n  - { id: app, github: org/app, linear_team: REL }\n', {})).toThrow(/projects: replaced by repos/);
    expect(() => saveInstance(home, { port: 4100, host: 'h', relay: { kind: 'none' }, projects: [] })).toThrow(/projects: replaced by repos/);
  });

  // Windows has no POSIX mode bits: Node reports 0o666 whatever chmod asked. The file takes its folder's ACL there,
  // which docs/installation.md asks to keep private (saveSecrets).
  it.skipIf(process.platform === 'win32')('writes secrets with mode 600', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    expect(loadSecrets(home)).toEqual({});
    saveSecrets(home, { linear: { clientId: 'c', clientSecret: 's', webhookSecret: 'w' } }, 'k'.repeat(32));
    expect(loadSecrets(home, 'k'.repeat(32)).linear!.clientId).toBe('c');
    expect(statSync(homePaths(home).secrets).mode & 0o777).toBe(0o600);
  });

  it('lists the secret values of the secrets file, not its identifiers', () => {
    expect(secretValues({})).toEqual([]);
    const linear = { clientId: 'c', clientSecret: 's', webhookSecret: 'w', accessToken: 'a', refreshToken: 'r', appUserId: 'u', organizationId: 'o' };
    expect(secretValues({ linear })).toEqual(['s', 'w', 'a', 'r']);
  });

  it('rejects an invalid instance key with its path, and an unknown one', () => {
    expect(() => parseFactoryYml('port: -1\n')).toThrow(/port: a positive integer is expected/);
    expect(() => parseFactoryYml('repos: [{ id: a, githb: org/a, linear_team: A }]\n')).toThrow(/repos\[0\]\.github: .*\n- repos\[0\]: .*githb/s);
    expect(() => parseFactoryYml('relay: { kind: smee }\n')).toThrow(/relay\.url/);
    expect(() => parseFactoryYml('limits: {}\n')).toThrow(/limits: unknown key/);
    expect(() => parseFactoryYml('knowledge: {}\n')).toThrow(/knowledge\.repo_path: /);
  });
});

describe('the files of the instance before factory.yml (ORC-199)', () => {
  it('names each one left in the home, never reading it, and does not create logs/', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-home-'));
    saveSecrets(home, {}, 'k'.repeat(32));
    saveInstance(home, loadInstance(home));
    expect(existsSync(join(home, 'logs'))).toBe(false);
    expect(oldInstanceFileWarnings(home)).toEqual([]);
    writeFileSync(join(home, 'config.yaml'), 'github: { appId: 1, privateKey: /k.pem }\n');
    writeFileSync(join(home, 'run-settings.json'), '{}');
    mkdirSync(join(home, 'logs'));
    expect(oldInstanceFileWarnings(home)).toEqual([
      expect.stringMatching(/^config\.yaml: left from before factory\.yml, not read \(ORC-199\).*then delete it; it may hold the GitHub App's key in clear$/),
      'run-settings.json: left from before ORC-199, not read: delete it',
      'logs: left from before ORC-199, not read: delete it',
    ]);
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

  it('refuses dev: false, naming public_url and factory init --dev', () => {
    expect(() => relayWarnings({ relay: smee, dev: false })).toThrow(/relay: \{ kind: smee \}.*dev: false.*public_url.*factory init --dev/);
  });

  it('names relay: { kind: none } alone to a config that has a publicUrl, where factory init --dev writes nothing', () => {
    const server = { relay: smee, publicUrl: 'https://f.example.com' };
    expect(relayWarnings(server)).toEqual([expect.stringMatching(/public_url: https:\/\/f\.example\.com brings Linear's webhooks already, set relay: \{ kind: none \}\.$/)]);
    expect(() => relayWarnings({ ...server, dev: false })).toThrow(/dev: false.*set relay: \{ kind: none \}\.$/);
  });

  it('refuses a publicUrl beside the relay in the development mode, naming relay: { kind: none }', () => {
    expect(() => relayWarnings({ relay: smee, dev: true, publicUrl: 'https://f.example.com' })).toThrow(/public_url: https:\/\/f\.example\.com.*relay: \{ kind: none \}/);
  });
});

describe('factory.yml and secrets.json (ORC-209, part B)', () => {
  const env = { LINEAR_CLIENT_ID: 'yml-client', LINEAR_CLIENT_SECRET: 'yml-secret', LINEAR_WEBHOOK_SECRET: 'yml-webhook-secret-1', GH_APP_KEY: '-----BEGIN RSA PRIVATE KEY-----\nk\n-----END RSA PRIVATE KEY-----' };
  function home(yml?: string): string {
    const h = mkdtempSync(join(tmpdir(), 'factory-yml-'));
    if (yml) writeFileSync(join(h, 'factory.yml'), yml);
    return h;
  }

  it('takes the GitHub App from factory.yml, and never writes it back with the instance keys', () => {
    const h = home('github: { app_id: 42, private_key: env:GH_APP_KEY }\n');
    saveInstance(h, effectiveInstance(loadFactoryYml(h, env)));
    expect(effectiveInstance(loadFactoryYml(h, env)).github).toMatchObject({ appId: '42', privateKey: env.GH_APP_KEY });
    expect(loadInstance(h).github).toBeUndefined();
    expect(readFileSync(homePaths(h).factoryYml, 'utf8')).not.toContain('PRIVATE KEY');
  });

  it('takes the static Linear values from factory.yml, the OAuth tokens from secrets.json', () => {
    const h = home('linear: { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\n');
    writeFileSync(homePaths(h).secrets, JSON.stringify({ linear: { clientId: 'old', clientSecret: 'old', webhookSecret: 'old-webhook-secret', accessToken: 'tok' } }));
    expect(linearSettings(h, loadFactoryYml(h, env))).toMatchObject({ clientId: 'yml-client', clientSecret: 'yml-secret', webhookSecret: 'yml-webhook-secret-1', accessToken: 'tok' });
  });

  it('saves refreshed tokens without copying a secret of the environment to secrets.json', () => {
    const h = home('linear: { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\nsecrets_key: env:SECRETS_KEY\n');
    const yml = loadFactoryYml(h, { ...env, SECRETS_KEY: 'k'.repeat(32) });
    saveLinearTokens(h, { accessToken: 'new', refreshToken: 'r' }, yml);
    const stored = openSecretsFile(readFileSync(homePaths(h).secrets, 'utf8'), 'k'.repeat(32));
    expect(stored).toContain('new');
    expect(stored).not.toContain('yml-secret');
    expect(linearSettings(h, yml)).toMatchObject({ clientSecret: 'yml-secret', accessToken: 'new' });
  });

  it('masks the secrets of factory.yml in run transcripts too', () => {
    const h = home('linear: { app_client_id: env:LINEAR_CLIENT_ID, client_secret: env:LINEAR_CLIENT_SECRET, webhook_secret: env:LINEAR_WEBHOOK_SECRET }\n');
    expect(daemonSecretValues(h, loadFactoryYml(h, env))).toEqual(expect.arrayContaining(['yml-secret', 'yml-webhook-secret-1']));
  });

  it('masks the API key of the small model of messages, whatever its source (ORC-445)', () => {
    const yml = parseFactoryYml('message_model: { api_key: vault:message }\nsecret_sources: { vault: { kind: env } }\n', env, SECRET_SOURCE_KINDS, new Map([['vault:message', 'sk-message-value']]));
    expect(daemonSecretValues(home(''), yml)).toContain('sk-message-value');
  });

  it("masks a repository's env secrets from the start, a restart included, never its plain variables (ORC-211, ORC-308)", () => {
    const h = home('repos: [{ id: app, linear_team: REL, github: org/app, env: { NODE_ENV: test-value }, secrets: { NPM_TOKEN: env:ORG_NPM_TOKEN, UNSET: env:ORG_UNSET, SEED: alias:ORG_SEED } }]\nsecret_sources: { alias: { kind: env } }\n');
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

  // ORC-470: on the loopback too, Connect Linear and a refresh write nothing without it.
  it('refuses to write Linear tokens without secrets_key, writing nothing', () => {
    const h = home();
    for (const yml of [undefined, {}]) expect(() => saveLinearTokens(h, { accessToken: 'canary-access-token-470' }, yml)).toThrow(`${LINEAR_NEEDS_SECRETS_KEY}.`);
    expect(existsSync(homePaths(h).secrets)).toBe(false);
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
    // Written in clear before ORC-398.
    writeFileSync(homePaths(h).secrets, JSON.stringify({ linear }));
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
