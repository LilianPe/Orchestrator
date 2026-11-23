import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejection } from '../../../test/contracts/cases.js';
import { describeSecretSourceContract } from '../../../test/contracts/secret-source.contract.js';
import { loadSealedFactoryYml, serverSecretReport } from '../../config/server-secrets.js';
import { vaultKind } from './vault.js';

const ROTATED = new Date('2026-09-01T10:00:00Z');
const TOKEN = 'hvs.fake-vault-token';

/** A Vault server's KV v2 engine, as its HTTP API answers: `GET /v1/<mount>/data/<path>`, the token in `X-Vault-Token`. */
const SECRETS: Record<string, Record<string, unknown>> = {
  'kv/data/app/github': { key: 'pem-secret-value', port: 5432 },
  'kv/data/team a/db': { password: 'spaced-secret-value' },
  'kv/data/factory/github': { private_key: 'pem-secret-value' },
};

let server: Server;
let address: string;
const requests: { url: string; token: string | undefined; namespace: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const token = req.headers['x-vault-token'] as string | undefined;
    const namespace = req.headers['x-vault-namespace'] as string | undefined;
    requests.push({ url: req.url ?? '', token, namespace });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { errors: [] });
    if (token !== TOKEN) return send(403, { errors: ['permission denied'] });
    const path = decodeURIComponent((req.url ?? '').replace(/^\/v1\//, ''));
    if (path === 'kv/data/broken') return send(200, 'pem-secret-value, not json');
    if (path === 'kv/data/flaky') return send(503, { errors: ['Vault is sealed'] });
    if (path === 'kv/data/cut') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data": {"data": {"key": "pem-sec');
      return setTimeout(() => res.destroy(), 50);
    }
    if (path === 'kv/data/moved') {
      res.writeHead(307, { location: 'http://127.0.0.2:1/v1/kv/data/app/github' });
      return res.end();
    }
    const data = SECRETS[path];
    if (!data) return send(404, { errors: [] });
    send(200, { data: { data, metadata: { created_time: ROTATED.toISOString(), version: 3 } } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const vault = (options: Record<string, unknown> = {}) => vaultKind.create({ address, token: TOKEN, mount: 'kv', ...options }, {});

describeSecretSourceContract('vault', () => ({
  source: vault(),
  present: { path: 'app/github#key', value: 'pem-secret-value' },
  missing: 'app/absent#key',
  down: vault({ token: 'hvs.revoked' }),
  syntax: { kind: vaultKind, valid: 'app/github#key', invalid: 'app/github' },
  rotated: { path: 'app/github#key', at: ROTATED },
}));

describe('vault secret source', () => {
  it("reads a field of a KV v2 secret with the token, in the namespace when one is given", async () => {
    requests.length = 0;
    expect(await vault({ namespace: 'team/a' }).read('app/github#key')).toBe('pem-secret-value');
    expect(requests).toEqual([{ url: '/v1/kv/data/app/github', token: TOKEN, namespace: 'team/a' }]);
  });

  it('mounts at secret/ without a mount, and reaches a path with a space', async () => {
    requests.length = 0;
    await vault({ mount: undefined }).read('app/github#key').catch(() => undefined);
    expect(await vault().read('team a/db#password')).toBe('spaced-secret-value');
    expect(requests.map((r) => r.url)).toEqual(['/v1/secret/data/app/github', '/v1/kv/data/team%20a/db']);
  });

  it('reads its token from token_file at each read: a Vault Agent renews it there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const file = join(dir, 'token');
    writeFileSync(file, 'hvs.stale\n', { mode: 0o640 });
    const source = vaultKind.create({ address, token_file: file, mount: 'kv' }, {});
    await expect(source.read('app/github#key')).rejects.toThrow('Vault refused the token (403)');
    writeFileSync(file, `${TOKEN}\n`);
    expect(await source.read('app/github#key')).toBe('pem-secret-value');
  });

  it.skipIf(process.platform === 'win32')('refuses a token_file any user can read; a Vault Agent sink of its group (0640) is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const file = join(dir, 'token');
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o644 });
    const source = vaultKind.create({ address, token_file: file, mount: 'kv' }, {});
    await expect(source.read('app/github#key')).rejects.toThrow(`the token_file ${file} is readable by any user: chmod 600 it (640 for a Vault Agent of its group)`);
    chmodSync(file, 0o640);
    expect(await source.read('app/github#key')).toBe('pem-secret-value');
  });

  it('names a secret, or a field, it does not hold, and a field that is not a text', async () => {
    await expect(vault().read('app/absent#key')).rejects.toThrow('no secret app/absent in Vault (kv)');
    await expect(vault().read('app/github#absent')).rejects.toThrow('no field absent in the Vault secret app/github');
    await expect(vault().read('app/github#port')).rejects.toThrow('the field port of the Vault secret app/github is not a text');
  });

  it('says what Vault answered when it is out of service, unreachable, or answers no JSON, never its body', async () => {
    await expect(vault().read('flaky#key')).rejects.toThrow('Vault answered 503');
    const err = (await rejection(vault().read('broken#key'))) as Error;
    expect(err.message).toBe('Vault answered no JSON document');
    expect(err.cause).toBeUndefined();
    await expect(vaultKind.create({ address: 'http://127.0.0.1:1', token: TOKEN }, {}).read('app/github#key')).rejects.toThrow('Vault is unreachable at http://127.0.0.1:1');
  });

  it('says Vault is unreachable when the connection dies in the middle of its answer, not that it answered no JSON', async () => {
    const err = (await rejection(vault().read('cut#key'))) as Error;
    expect(err.message).toBe(`Vault is unreachable at ${address}`);
  });

  it('requests the path it was given, whatever ends the address or the path', async () => {
    requests.length = 0;
    for (const end of ['?', '#', '/']) expect(await vault({ address: `${address}${end}` }).read('app/github#key')).toBe('pem-secret-value');
    await expect(vault().read('app/github #key')).rejects.toThrow('no secret app/github  in Vault (kv)');
    await expect(vault().read('app/.. #key')).rejects.toThrow('no secret app/..  in Vault (kv)');
    expect(requests.map((r) => r.url)).toEqual([...Array(3).fill('/v1/kv/data/app/github'), '/v1/kv/data/app/github%20', '/v1/kv/data/app/..%20']);
  });

  it('never follows a redirect: the token would go to another host', async () => {
    await expect(vault().read('moved#key')).rejects.toThrow('Vault answered 307: a redirect is not followed');
  });

  it('refuses a token that is no header value without quoting it: fetch would put it in its error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const file = join(dir, 'token');
    writeFileSync(file, 'hvs.first\nhvs.second\n', { mode: 0o600 });
    for (const source of [vaultKind.create({ address, token_file: file }, {}), vaultKind.create({ address, token: 'hvs.a b' }, {})]) {
      const err = (await rejection(source.read('app/github#key'))) as Error;
      expect(err.message).toBe('the Vault token is not a valid header value (printable characters, no space)');
      expect(err.cause).toBeUndefined();
    }
    writeFileSync(file, '\n');
    await expect(vaultKind.create({ address, token_file: file }, {}).read('app/github#key')).rejects.toThrow('the Vault token_file is empty');
  });

  it('accepts `<path>#<field>`: segments of letters, digits, spaces, _ . -, never a dot segment', () => {
    for (const valid of ['app/github#key', 'github#key', 'team a/db#password', 'a.b/c-d_e#f.g']) expect(vaultKind.checkPath(valid)).toBeUndefined();
    for (const invalid of ['', 'app/github', '#key', 'app/#key', '/app#key', 'app/../x#key', 'app/./x#key', 'app#', 'app#a#b', 'app?x#key']) {
      expect(vaultKind.checkPath(invalid)).toEqual(expect.any(String));
    }
  });

  it('takes an https address (http on the loopback only), a token or a token_file, an optional mount and namespace', () => {
    expect(vaultKind.checkOptions({ address: 'https://vault.example.com:8200', token: 'hvs.x' })).toEqual([]);
    expect(vaultKind.checkOptions({ address: 'http://127.0.0.1:8200', token_file: '/run/vault/token', mount: 'kv', namespace: 'team/a' })).toEqual([]);
    expect(vaultKind.checkOptions({ address: 'http://[::1]:8200', token: 'hvs.x' })).toEqual([]);
    // A name is resolved, and a resolver without it in its hosts file may ask a DNS server: an address of the loopback alone.
    expect(vaultKind.checkOptions({ address: 'http://localhost:8200', token: 'hvs.x' })).toEqual(['address: an https URL is expected (http on the loopback only)']);
    expect(vaultKind.checkOptions({ address: 'http://vault.example.com', token: 'hvs.x' })).toEqual(['address: an https URL is expected (http on the loopback only)']);
    for (const address of ['https://u:p@vault.example.com', 'https://vault.example.com?x=1', 'https://vault.example.com#a', 'https://vault.example.com/v1']) {
      expect(vaultKind.checkOptions({ address, token: 'hvs.x' })).toEqual(['address: the server alone is expected (`https://<host>:<port>`), no path, query or credentials']);
    }
    expect(vaultKind.checkOptions({})).toEqual(['address: an https URL is expected (http on the loopback only)', 'token: required, or token_file']);
    expect(vaultKind.checkOptions({ address: 'https://v', token: 'hvs.x', token_file: '/t' })).toEqual(['token: token or token_file, not both']);
    expect(vaultKind.checkOptions({ address: 'https://v', token_file: 'token', mount: 'a/../b', namespace: 3, role: 'x' })).toEqual([
      'token_file: an absolute path is expected',
      'mount: a mount path is expected (`secret`, `team/kv`)',
      'namespace: a non-empty text is expected',
      'role: unknown key',
    ]);
  });

  it('knows the rotation date of a field by its version, and none for a field it does not hold', async () => {
    expect((await vault().describe!('app/github#key')).rotatedAt).toEqual(ROTATED);
    expect(await vault().describe!('app/github#absent')).toEqual({});
  });
});

describe('switching a server secret from systemd-creds to vault (ORC-418, criterion 1)', () => {
  it('is a change of factory.yml alone: the same key read, sealed in doctor, the token an env: reference', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-vault-'));
    const credentials = join(home, 'credentials');
    mkdirSync(credentials);
    writeFileSync(join(credentials, 'github-app-key'), 'pem-secret-value\n');
    const env = { CREDENTIALS_DIRECTORY: credentials, VAULT_TOKEN: TOKEN };
    const yml = (sources: string, ref: string) => writeFileSync(join(home, 'factory.yml'), `secret_sources:\n  ${sources}\ngithub: { app_id: 123456, private_key: "${ref}" }\n`);

    yml('creds: { kind: systemd-creds }', 'creds:github-app-key');
    expect((await loadSealedFactoryYml(home, env)).yml?.github?.privateKey).toBe('pem-secret-value');

    yml(`coffre: { kind: vault, address: "${address}", mount: kv, token: env:VAULT_TOKEN }`, 'coffre:factory/github#private_key');
    const { yml: parsed, reader } = await loadSealedFactoryYml(home, env);
    expect(parsed?.github?.privateKey).toBe('pem-secret-value');
    expect(reader.values()).toContain('pem-secret-value');
    expect(parsed?.secretRefs?.['secret_sources.coffre.token']).toEqual({ source: 'env', path: 'VAULT_TOKEN' });
    expect((await serverSecretReport(home, env, { now: ROTATED.getTime() })).find((r) => r.key === 'github.private_key')).toEqual({
      key: 'github.private_key',
      reference: 'coffre:factory/github#private_key',
      inClear: false,
      rotatedAt: ROTATED.toISOString(),
      warnings: [],
    });
  });
});
