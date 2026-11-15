import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSecretSourceContract } from '../../../test/contracts/secret-source.contract.js';
import { systemdCredsKind } from './systemd-creds.js';

const ROTATED = new Date('2026-09-01T10:00:00Z');

/** A service's `$CREDENTIALS_DIRECTORY`, as systemd fills it at start, and the store of the encrypted credentials. */
function credentials(): { dir: string; store: string } {
  const root = mkdtempSync(join(tmpdir(), 'systemd-creds-'));
  const dir = join(root, 'credentials');
  const store = join(root, 'credstore.encrypted');
  mkdirSync(dir);
  mkdirSync(store);
  writeFileSync(join(dir, 'github-key'), 'pem-secret-value\n');
  writeFileSync(join(store, 'github-key.cred'), 'encrypted blob');
  utimesSync(join(store, 'github-key.cred'), ROTATED, ROTATED);
  return { dir, store };
}

describeSecretSourceContract('systemd-creds', () => {
  const { dir, store } = credentials();
  return {
    source: systemdCredsKind.create({ store }, { CREDENTIALS_DIRECTORY: dir }),
    present: { path: 'github-key', value: 'pem-secret-value' },
    missing: 'absent',
    down: systemdCredsKind.create({ store }, {}),
    syntax: { kind: systemdCredsKind, valid: 'github-key', invalid: '../github-key' },
    rotated: { path: 'github-key', at: ROTATED },
  };
});

describe('systemd-creds secret source', () => {
  it('keeps a value as the file holds it, but for the one line break its encryption from a shell adds', async () => {
    const { dir } = credentials();
    writeFileSync(join(dir, 'two-lines'), 'line-one\nline-two\n\n');
    writeFileSync(join(dir, 'crlf'), 'value-crlf\r\n');
    const source = systemdCredsKind.create({}, { CREDENTIALS_DIRECTORY: dir });
    expect(await source.read('two-lines')).toBe('line-one\nline-two\n');
    expect(await source.read('crlf')).toBe('value-crlf');
  });

  it('out of a systemd service, says so without a value', async () => {
    await expect(systemdCredsKind.create({}, {}).read('github-key')).rejects.toThrow(
      'CREDENTIALS_DIRECTORY is not set: the daemon does not run as a systemd service with LoadCredentialEncrypted=github-key',
    );
  });

  it('names a credential it does not hold', async () => {
    const { dir } = credentials();
    await expect(systemdCredsKind.create({}, { CREDENTIALS_DIRECTORY: dir }).read('absent')).rejects.toThrow('no credential absent in CREDENTIALS_DIRECTORY');
  });

  it('accepts a credential name only: no path, no dot name', () => {
    for (const valid of ['github-key', 'claude_token.1', 'A-b_c.d']) expect(systemdCredsKind.checkPath(valid)).toBeUndefined();
    for (const invalid of ['', '.', '..', 'a/b', 'a\\b', 'a b', 'kv/app#k']) expect(systemdCredsKind.checkPath(invalid)).toEqual(expect.any(String));
  });

  it('takes an optional absolute store, nothing else', () => {
    expect(systemdCredsKind.checkOptions({})).toEqual([]);
    expect(systemdCredsKind.checkOptions({ store: '/etc/credstore.encrypted' })).toEqual([]);
    expect(systemdCredsKind.checkOptions({ store: 'credstore', token: 'x' })).toEqual(['store: an absolute path is expected', 'token: unknown key']);
    expect(systemdCredsKind.checkOptions({ store: 3 })).toEqual(['store: an absolute path is expected']);
  });

  it('knows no rotation date without a store, and finds a credential stored without its .cred suffix', async () => {
    const { dir, store } = credentials();
    expect(await systemdCredsKind.create({}, { CREDENTIALS_DIRECTORY: dir }).describe!('github-key')).toEqual({});
    writeFileSync(join(store, 'webhook'), 'encrypted blob');
    utimesSync(join(store, 'webhook'), ROTATED, ROTATED);
    expect((await systemdCredsKind.create({ store }, {}).describe!('webhook')).rotatedAt).toEqual(ROTATED);
  });
});
