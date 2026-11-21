import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeSecretSource, fakeSecretKind } from '../adapters/secrets/fake.js';
import { SECRET_SOURCE_KINDS } from '../adapters/secrets/registry.js';
import { FactoryYmlError } from './factory-yml.js';
import { saveSecrets } from './instance.js';
import { SECRETS_KEY_REQUIRED } from './secrets-file.js';
import { loadSealedFactoryYml, readSecretsKey, ROTATION_MAX_DAYS, serverSecretLines, serverSecretReport } from './server-secrets.js';

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
    appendFileSync(join(h, 'factory.yml'), 'host: 0.0.0.0\n');
    expect(await serverSecretReport(h, {}, { now: NOW, kinds: kindsWith({ 'factory#key': old }) })).toEqual(expected);
  });

  it('never reads a config.yaml left from before factory.yml (ORC-199): neither its GitHub key nor its host', async () => {
    const h = home('concurrency: 1\n');
    writeFileSync(join(h, 'config.yaml'), 'host: 0.0.0.0\ngithub: { appId: 1, privateKey: /srv/app.pem }\n');
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([]);
  });

  // ORC-470: on the loopback too, secrets.json without secrets_key stops the start.
  it('names a secrets.json kept in clear on disk, and the missing secrets_key that stops the start beside it', async () => {
    const h = home('concurrency: 1\n');
    writeFileSync(join(h, 'secrets.json'), JSON.stringify({ linear: { clientId: 'c', clientSecret: 's', webhookSecret: 'w', accessToken: 'a' } }));
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([
      { key: 'secrets_key', inClear: false, warnings: [`missing, the daemon refuses to start (Linear is set up): ${SECRETS_KEY_REQUIRED}`] },
      { key: 'secrets.json', inClear: true, warnings: ['in clear on disk'] },
    ]);
    writeFileSync(join(h, 'factory.yml'), 'secrets_key: env:FACTORY_SECRETS_KEY\n');
    expect((await serverSecretReport(h, { FACTORY_SECRETS_KEY: 'k'.repeat(32) }, { now: NOW })).find((r) => r.key === 'secrets.json')).toEqual({
      key: 'secrets.json',
      inClear: true,
      warnings: ['in clear on disk: the daemon encrypts it with secrets_key at its start'],
    });
    saveSecrets(h, {}, 'k'.repeat(32));
    expect((await serverSecretReport(h, { FACTORY_SECRETS_KEY: 'k'.repeat(32) }, { now: NOW })).find((r) => r.key === 'secrets.json')).toEqual({ key: 'secrets.json', inClear: false, warnings: [] });
  });

  it('says a missing secrets_key stops the start off the loopback, even before secrets.json exists, and beside a linear section', async () => {
    const h = home('concurrency: 1\n');
    writeFileSync(join(h, 'factory.yml'), 'host: 0.0.0.0\n');
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([
      { key: 'secrets_key', inClear: false, warnings: [`missing, the daemon refuses to start (host: 0.0.0.0): ${SECRETS_KEY_REQUIRED}`] },
    ]);
    // On the loopback without Linear: nothing to say.
    writeFileSync(join(h, 'factory.yml'), 'host: 127.0.0.1\n');
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([]);
    writeFileSync(join(h, 'factory.yml'), 'host: 127.0.0.1\nlinear: { app_client_id: cid }\n');
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([
      { key: 'secrets_key', inClear: false, warnings: [`missing, the daemon refuses to start (Linear is set up): ${SECRETS_KEY_REQUIRED}`] },
    ]);
  });

  it('says a key of a file in clear, for a workstation, with its date (ORC-470)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-key-'));
    const at = new Date(NOW - 400 * 86_400_000);
    writeFileSync(join(dir, 'secrets.key'), 'k'.repeat(44), { mode: 0o600 });
    utimesSync(join(dir, 'secrets.key'), at, at);
    const h = home(`secret_sources: { factory_home: { kind: file, dir: ${JSON.stringify(dir)} } }\nsecrets_key: factory_home:secrets.key\n`);
    expect(await serverSecretReport(h, {}, { now: NOW })).toEqual([
      {
        key: 'secrets_key',
        reference: 'factory_home:secrets.key',
        inClear: true,
        rotatedAt: at.toISOString(),
        warnings: ["in clear in a file, its owner's alone: for a workstation; on a server, a sealed source (systemd-creds) keeps it off the disk"],
      },
    ]);
  });

  it('reads secrets_key alone for init: another source\'s options need not be in its shell (ORC-470)', async () => {
    const h = home('secret_sources: { other: { kind: systemd-creds, store: env:CRED_STORE } }\nsecrets_key: env:FACTORY_SECRETS_KEY\ngithub: { app_id: 1, private_key: env:GH_APP_KEY }\n');
    expect(await readSecretsKey(h, { FACTORY_SECRETS_KEY: 'k'.repeat(32) })).toBe('k'.repeat(32));
    expect(await readSecretsKey(home('concurrency: 1\n'), {})).toBeUndefined();
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
