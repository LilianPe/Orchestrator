import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rejection } from '../../../test/contracts/cases.js';
import { describeSecretSourceContract } from '../../../test/contracts/secret-source.contract.js';
import { sopsKind, sopsRotation } from './sops.js';

const ROTATED = new Date('2026-09-01T10:00:00Z');
const AGE_KEY = 'AGE-SECRET-KEY-1FAKEFAKEFAKE';

/**
 * A `sops` binary that decrypts nothing: its "encrypted" file holds the clear document under `plain`, beside the metadata a real
 * one keeps (`sops.lastmodified`). It refuses to decrypt without the age key, as sops does, and logs its arguments.
 */
const FAKE_SOPS = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SOPS_LOG, JSON.stringify({ args, key: process.env.SOPS_AGE_KEY_FILE ?? null }) + '\\n');
const keyFile = process.env.SOPS_AGE_KEY_FILE;
if (!keyFile || !fs.existsSync(keyFile) || !fs.readFileSync(keyFile, 'utf8').split('\\n').includes('${AGE_KEY}')) {
  process.stderr.write('Failed to get the data key required to decrypt the SOPS file.\\n');
  process.exit(128);
}
const doc = JSON.parse(fs.readFileSync(args[args.length - 1], 'utf8'));
process.stdout.write(doc.garbage ?? JSON.stringify(doc.plain));
`;

interface Fixture {
  file: string;
  keyFile: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

function fixture(plain: unknown = { github: { key: 'pem-secret-value' }, port: 5432, list: ['first-value-x'] }, extra: Record<string, unknown> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'sops-'));
  const sops = join(root, 'sops');
  writeFileSync(sops, FAKE_SOPS);
  chmodSync(sops, 0o755);
  const file = join(root, 'secrets.enc.json');
  writeFileSync(file, JSON.stringify({ plain, sops: { lastmodified: ROTATED.toISOString(), version: '3.9.0' }, ...extra }));
  const keyFile = join(root, 'keys.txt');
  writeFileSync(keyFile, `# public key: age1fake\n${AGE_KEY}\n`);
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  return { file, keyFile, log, env: { PATH: `${root}:${dirname(process.execPath)}`, FAKE_SOPS_LOG: log } };
}

const calls = (f: Fixture) =>
  readFileSync(f.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; key: string | null });

describeSecretSourceContract('sops', () => {
  const f = fixture();
  return {
    source: sopsKind.create({ file: f.file, age_key_file: f.keyFile }, f.env),
    present: { path: 'github.key', value: 'pem-secret-value' },
    missing: 'github.absent',
    down: sopsKind.create({ file: f.file, age_key_file: join(dirname(f.file), 'no-key.txt') }, f.env),
    syntax: { kind: sopsKind, valid: 'github.key', invalid: 'github..key' },
    rotated: { path: 'github.key', at: ROTATED },
  };
});

describe('sops secret source', () => {
  it('decrypts the file with sops into JSON, its age key handed to sops through SOPS_AGE_KEY_FILE', async () => {
    const f = fixture();
    expect(await sopsKind.create({ file: f.file, age_key_file: f.keyFile }, f.env).read('github.key')).toBe('pem-secret-value');
    expect(calls(f)).toEqual([{ args: ['--decrypt', '--output-type', 'json', f.file], key: f.keyFile }]);
  });

  it("without age_key_file, leaves sops to the daemon's environment (SOPS_AGE_KEY_FILE, its default keys.txt, a KMS)", async () => {
    const f = fixture();
    const source = sopsKind.create({ file: f.file }, { ...f.env, SOPS_AGE_KEY_FILE: f.keyFile });
    expect(await source.read('github.key')).toBe('pem-secret-value');
    expect(calls(f)[0]?.key).toBe(f.keyFile);
  });

  it('reaches an item of a list by its index', async () => {
    const f = fixture();
    expect(await sopsKind.create({ file: f.file, age_key_file: f.keyFile }, f.env).read('list.0')).toBe('first-value-x');
  });

  it('refuses a key that holds no text, a number or a section, without its content', async () => {
    const f = fixture();
    const source = sopsKind.create({ file: f.file, age_key_file: f.keyFile }, f.env);
    await expect(source.read('port')).rejects.toThrow('the key port of the sops file is not a text');
    const err = (await rejection(source.read('github'))) as Error;
    expect(err.message).toBe('the key github of the sops file is not a text');
    expect(JSON.stringify(err)).not.toContain('pem-secret-value');
  });

  it('names a key the file does not hold', async () => {
    const f = fixture();
    await expect(sopsKind.create({ file: f.file, age_key_file: f.keyFile }, f.env).read('github.absent')).rejects.toThrow('no key github.absent in the sops file');
  });

  it("says why sops failed, by its own words, when it cannot decrypt", async () => {
    const f = fixture();
    await expect(sopsKind.create({ file: f.file }, f.env).read('github.key')).rejects.toThrow(
      'sops could not decrypt the file: Failed to get the data key required to decrypt the SOPS file.',
    );
  });

  it('says sops is missing from the PATH', async () => {
    const f = fixture();
    await expect(sopsKind.create({ file: f.file, age_key_file: f.keyFile }, { PATH: join(dirname(f.file), 'nothing') }).read('github.key')).rejects.toThrow(
      'sops is not installed (no sops in the PATH)',
    );
  });

  it('an output that is not JSON fails without quoting it: it would be the clear document', async () => {
    const f = fixture({}, { garbage: 'pem-secret-value is not json' });
    const err = (await rejection(sopsKind.create({ file: f.file, age_key_file: f.keyFile }, f.env).read('github.key'))) as Error;
    expect(err.message).toBe('sops answered no JSON document');
    expect(err.cause).toBeUndefined();
  });

  it('accepts dotted key names: letters, digits, _ and -, an index for a list', () => {
    for (const valid of ['github', 'github.key', 'DB_SEED_KEY', 'a-b.c_d.0']) expect(sopsKind.checkPath(valid)).toBeUndefined();
    for (const invalid of ['', '.', 'a.', '.a', 'a..b', 'a/b', 'a b', 'kv/app#k']) expect(sopsKind.checkPath(invalid)).toEqual(expect.any(String));
  });

  it('takes an absolute file, an optional absolute age_key_file, nothing else', () => {
    expect(sopsKind.checkOptions({ file: '/etc/factory/secrets.enc.yaml' })).toEqual([]);
    expect(sopsKind.checkOptions({ file: '/etc/factory/secrets.enc.yaml', age_key_file: '/etc/factory/age.txt' })).toEqual([]);
    expect(sopsKind.checkOptions({})).toEqual(['file: an absolute path is expected']);
    expect(sopsKind.checkOptions({ file: 'secrets.yaml', age_key_file: 3, token: 'x' })).toEqual([
      'file: an absolute path is expected',
      'age_key_file: an absolute path is expected',
      'token: unknown key',
    ]);
  });

  it('knows no rotation date in a file without sops metadata it can read', async () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ plain: { github: { key: 'pem-secret-value' } } }));
    expect(await sopsKind.create({ file: f.file, age_key_file: f.keyFile }, f.env).describe!('github.key')).toEqual({});
  });

  it('reads the rotation date from the metadata of a YAML, JSON or dotenv file, and none from anything else', () => {
    const at = ROTATED.toISOString();
    expect(sopsRotation(`db:\n    password: ENC[AES256_GCM,data:x]\nsops:\n    lastmodified: "${at}"\n    version: 3.9.0\n`)).toEqual(ROTATED);
    expect(sopsRotation(JSON.stringify({ db: 'ENC[AES256_GCM,data:x]', sops: { lastmodified: at } }))).toEqual(ROTATED);
    expect(sopsRotation(`DB_PASSWORD=ENC[AES256_GCM,data:x]\nsops_lastmodified=${at}\n`)).toEqual(ROTATED);
    expect(sopsRotation(`[db]\nlastmodified = ENC[AES256_GCM,data:x]\n\n[sops]\nmac = ENC[AES256_GCM,data:m]\nversion = 3.9.0\nlastmodified = ${at}\n`)).toEqual(ROTATED);
    for (const none of ['', 'a: [', 'sops: { lastmodified: not-a-date }', 'sops_lastmodified=', '[unclosed', '[sops]\nversion = 3\n[db]\nlastmodified = 2026-09-01T10:00:00Z\n']) expect(sopsRotation(none)).toBeUndefined();
  });
});
