import { chmodSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSecretSourceContract } from '../../../test/contracts/secret-source.contract.js';
import { fileSecretKind } from './file.js';

const ROTATED = new Date('2026-09-01T10:00:00Z');
const posix = process.platform !== 'win32';

/** A folder of key files, each mode 0600 as `factory init --dev` writes them. */
function keys(): string {
  const dir = mkdtempSync(join(tmpdir(), 'file-secrets-'));
  writeFileSync(join(dir, 'secrets.key'), 'file-secret-value\n', { mode: 0o600 });
  utimesSync(join(dir, 'secrets.key'), ROTATED, ROTATED);
  return dir;
}

describeSecretSourceContract('file', () => {
  const dir = keys();
  return {
    source: fileSecretKind.create({ dir }, {}),
    present: { path: 'secrets.key', value: 'file-secret-value' },
    missing: 'absent.key',
    down: fileSecretKind.create({ dir: join(dir, 'gone') }, {}),
    syntax: { kind: fileSecretKind, valid: 'secrets.key', invalid: '../secrets.key' },
    rotated: { path: 'secrets.key', at: ROTATED },
  };
});

describe('file secret source', () => {
  it('accepts a file name only: no path, no dot name', () => {
    for (const valid of ['secrets.key', 'a_b-c.1']) expect(fileSecretKind.checkPath(valid)).toBeUndefined();
    for (const invalid of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a b']) expect(fileSecretKind.checkPath(invalid)).toEqual(expect.any(String));
  });

  it('takes a required absolute dir, nothing else', () => {
    expect(fileSecretKind.checkOptions({ dir: '/srv/factory' })).toEqual([]);
    expect(fileSecretKind.checkOptions({})).toEqual(['dir: an absolute path is expected']);
    expect(fileSecretKind.checkOptions({ dir: 'keys', token: 'x' })).toEqual(['dir: an absolute path is expected', 'token: unknown key']);
  });

  it.runIf(posix)('refuses a file others than its owner can read, without its value', async () => {
    const dir = keys();
    chmodSync(join(dir, 'secrets.key'), 0o644);
    const err = (await fileSecretKind.create({ dir }, {}).read('secrets.key').catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('the file secrets.key is readable by others than its owner: chmod 600 it');
    expect(JSON.stringify(err)).not.toContain('file-secret-value');
  });

  it.runIf(posix)('refuses a symbolic link: the file is read where it is declared', async () => {
    const dir = keys();
    symlinkSync(join(dir, 'secrets.key'), join(dir, 'link.key'));
    await expect(fileSecretKind.create({ dir }, {}).read('link.key')).rejects.toThrow('the file link.key is not a regular file');
  });

  it('names a file it does not hold', async () => {
    await expect(fileSecretKind.create({ dir: keys() }, {}).read('absent.key')).rejects.toThrow('no file absent.key in its folder');
  });
});
