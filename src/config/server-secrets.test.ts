import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeSecretSource, fakeSecretKind } from '../adapters/secrets/fake.js';
import { SECRET_SOURCE_KINDS } from '../adapters/secrets/registry.js';
import { FactoryYmlError } from './factory-yml.js';
import { saveSecrets } from './instance.js';
import { loadSealedFactoryYml, ROTATION_MAX_DAYS, SECRETS_KEY_REQUIRED, serverSecretLines, serverSecretReport } from './server-secrets.js';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nsealed\n-----END RSA PRIVATE KEY-----\n';
const NOW = Date.parse('2026-11-15T00:00:00Z');
const DAY = 86_400_000;

function home(yml: string): string {
  const h = mkdtempSync(join(tmpdir(), 'factory-server-secrets-'));
  writeFileSync(join(h, 'factory.yml'), yml);
  return h;
}

const YML = `secret_sources: { coffre: { kind: fake, name: coffre } }
github: { app_id: 42, private_key: "coffre:gh#key", webhook_secret: env:GH_WEBHOOK_SECRET }
claude: { runtime: claude-code, accounts: [{ name: a, token: "coffre:claude#a" }], active: a, default_model: m }
`;
const ENV = { GH_WEBHOOK_SECRET: 'gh-webhook-secret-123' };

describe('the server secrets read at the start (ORC-398)', () => {
  it('reads each reference from its source once, and hands the values to the file and to the masking', async () => {
    const coffre = new FakeSecretSource({ 'gh#key': PEM, 'claude#a': 'tok-sealed-value' });
    const kinds = { ...SECRET_SOURCE_KINDS, fake: fakeSecretKind({ coffre }) };
    const h = home(YML);
    const { yml, sealed, reader } = await loadSealedFactoryYml(h, ENV, { kinds });
    expect(yml?.github).toEqual({ appId: '42', privateKey: PEM, webhookSecret: 'gh-webhook-secret-123' });
    expect(coffre.reads.sort()).toEqual(['claude#a', 'gh#key']);
    expect(reader.values()).toEqual(expect.arrayContaining([PEM, 'tok-sealed-value']));
    expect(sealed.get('coffre:claude#a')).toBe('tok-sealed-value');
  });

  it('a source that fails stops the start, naming the key and its reference, never a value', async () => {
    const coffre = new FakeSecretSource({ 'gh#key': PEM, 'claude#a': 'tok-sealed-value' }, { down: true });
    const kinds = { ...SECRET_SOURCE_KINDS, fake: fakeSecretKind({ coffre }) };
    const err = await loadSealedFactoryYml(home(YML), ENV, { kinds }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FactoryYmlError);
    expect((err as FactoryYmlError).message).toContain('the secret github.private_key (coffre:gh#key) could not be read: the secret manager does not answer');
    expect((err as FactoryYmlError).message).not.toContain('sealed');
  });

  it('a command reads only the keys it needs: a source out of its reach for the others does not stop it', async () => {
    const coffre = new FakeSecretSource({ 'gh#key': PEM });
    const kinds = { ...SECRET_SOURCE_KINDS, fake: fakeSecretKind({ coffre }) };
    const { yml } = await loadSealedFactoryYml(home(YML), ENV, { kinds, only: ['github.private_key'] });
    expect(coffre.reads).toEqual(['gh#key']);
    expect(yml?.github?.privateKey).toBe(PEM);
    expect(yml?.claude?.accounts).toEqual([{ name: 'a', token: '' }]);
  });

  it('a server secret has no minimal length: it is never sealed in files', async () => {
    const coffre = new FakeSecretSource({ 'gh#key': PEM, 'claude#a': 'short' });
    const kinds = { ...SECRET_SOURCE_KINDS, fake: fakeSecretKind({ coffre }) };
    expect((await loadSealedFactoryYml(home(YML), ENV, { kinds })).yml?.claude?.accounts[0]?.token).toBe('short');
  });

  it('without factory.yml, nothing to read', async () => {
    const h = mkdtempSync(join(tmpdir(), 'factory-server-secrets-'));
    expect((await loadSealedFactoryYml(h, {})).yml).toBeUndefined();
  });
});

describe("doctor's report of the server secrets (ORC-398)", () => {
  const kindsWith = (rotatedAt: Record<string, Date>) => ({ ...SECRET_SOURCE_KINDS, fake: fakeSecretKind({ coffre: new FakeSecretSource({}, { rotatedAt }) }) });

  it('gives the rotation date of a sealed secret, warns past the limit, when unknown, and for a secret in clear', async () => {
    const recent = new Date(NOW - 10 * DAY);
    const old = new Date(NOW - (ROTATION_MAX_DAYS + 1) * DAY);
    const reports = await serverSecretReport(home(YML), ENV, { now: NOW, kinds: kindsWith({ 'gh#key': recent }) });
    expect(reports).toEqual([
      { key: 'github.private_key', reference: 'coffre:gh#key', inClear: false, rotatedAt: recent.toISOString(), warnings: [] },
      { key: 'github.webhook_secret', reference: 'env:GH_WEBHOOK_SECRET', inClear: true, warnings: ["in clear in the daemon's environment: a sealed source (systemd-creds) keeps it off the disk"] },
      { key: 'claude.accounts[0].token', reference: 'coffre:claude#a', inClear: false, warnings: ['its source knows no rotation date'] },
    ]);
    const stale = await serverSecretReport(home(YML), ENV, { now: NOW, kinds: kindsWith({ 'gh#key': old }) });
    expect(stale[0]!.warnings).toEqual([`rotated ${ROTATION_MAX_DAYS + 1} days ago, past ${ROTATION_MAX_DAYS}`]);
  });

  it('never warns about the rotation of secrets_key: rotating it would leave secrets.json unreadable', async () => {
    const h = home('secret_sources: { coffre: { kind: fake, name: coffre } }\nsecrets_key: "coffre:factory#key"\n');
    const old = new Date(NOW - (ROTATION_MAX_DAYS + 30) * DAY);
    const expected = [{ key: 'secrets_key', reference: 'coffre:factory#key', inClear: false, rotatedAt: old.toISOString(), warnings: [] }];
    expect(await serverSecretReport(h, {}, { now: NOW, kinds: kindsWith({ 'factory#key': old }) })).toEqual(expected);
    // Off the loopback too: declared from a source, unread here, it is there all the same.
    writeFileSync(join(h, 'config.yaml'), 'host: 0.0.0.0\n');
    expect(await serverSecretReport(h, {}, { now: NOW, kinds: kindsWith({ 'factory#key': old }) })).toEqual(expected);
  });

  it('names a GitHub key left in config.yaml though factory.yml reads it from a source', async () => {
    const h = home(YML);
    writeFileSync(join(h, 'config.yaml'), 'github: { appId: 1, privateKey: /srv/app.pem }\n');
    expect((await serverSecretReport(h, ENV, { now: NOW, kinds: kindsWith({}) })).map((r) => r.key)).toContain('github.privateKey');
  });

  it('names a GitHub key and a secrets.json kept in clear on disk', async () => {
    const h = home('concurrency: 1\n');
    writeFileSync(join(h, 'config.yaml'), 'github: { appId: 1, privateKey: /srv/app.pem }\n');
    saveSecrets(h, { linear: { clientId: 'c', clientSecret: 's', webhookSecret: 'w', accessToken: 'a' } });
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([
      { key: 'github.privateKey', reference: 'config.yaml', inClear: true, warnings: ['in clear on disk: write github.private_key in factory.yml with a sealed source (systemd-creds)'] },
      { key: 'secrets.json', inClear: true, warnings: ['in clear on disk: set secrets_key in factory.yml to encrypt it'] },
    ]);
    saveSecrets(h, {}, 'k'.repeat(32));
    expect((await serverSecretReport(h, {}, { now: NOW })).find((r) => r.key === 'secrets.json')).toEqual({ key: 'secrets.json', inClear: false, warnings: [] });
  });

  it('off the loopback, says a missing secrets_key stops the start, even before secrets.json exists', async () => {
    const h = home('concurrency: 1\n');
    writeFileSync(join(h, 'config.yaml'), 'host: 0.0.0.0\n');
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([
      { key: 'secrets_key', inClear: false, warnings: [`missing, the daemon refuses to start (host: 0.0.0.0): ${SECRETS_KEY_REQUIRED}`] },
    ]);
    // On the loopback, it stays optional: nothing to say without secrets.json.
    writeFileSync(join(h, 'config.yaml'), 'host: 127.0.0.1\n');
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([]);
  });

  it('says it in lines, the date first, then each warning', () => {
    expect(
      serverSecretLines([
        { key: 'github.private_key', reference: 'coffre:gh#key', inClear: false, rotatedAt: '2026-11-05T00:00:00.000Z', warnings: [] },
        { key: 'secrets.json', inClear: true, warnings: ['in clear on disk: set secrets_key in factory.yml to encrypt it'] },
      ]),
    ).toEqual([
      'Server secrets:',
      '  github.private_key (coffre:gh#key): sealed, rotated 2026-11-05',
      '  secrets.json: in clear — warning: in clear on disk: set secrets_key in factory.yml to encrypt it',
    ]);
  });
});
