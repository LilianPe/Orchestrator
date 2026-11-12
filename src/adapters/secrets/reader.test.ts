import { describe, expect, it } from 'vitest';
import { FakeSecretSource, fakeSecretKind } from './fake.js';
import { SecretReader } from './reader.js';
import { openSecretSources, SECRET_SOURCE_KINDS } from './registry.js';

const vault = new FakeSecretSource({ 'kv/app#seed_key': 'seed-secret-value', 'kv/app#short': 'short' });
const reader = () => new SecretReader({ coffre: vault, env: SECRET_SOURCE_KINDS['env']!.create({}, { NPM_TOKEN: 'npm-secret-value' }) });

describe('SecretReader', () => {
  it('reads each name from its source', async () => {
    const values = await reader().read({ NPM_TOKEN: { source: 'env', path: 'NPM_TOKEN' }, DB_SEED_KEY: { source: 'coffre', path: 'kv/app#seed_key' } });
    expect(values).toEqual({ NPM_TOKEN: 'npm-secret-value', DB_SEED_KEY: 'seed-secret-value' });
  });

  it('a failed read names the secret and its reference, and the source says why', async () => {
    await expect(reader().read({ DB_SEED_KEY: { source: 'coffre', path: 'kv/app#absent' } })).rejects.toThrow('the secret DB_SEED_KEY (coffre:kv/app#absent) could not be read: no secret at kv/app#absent');
  });

  it('a value too short to be sealed is refused, without the value', async () => {
    const err = await reader()
      .read({ SHORT: { source: 'coffre', path: 'kv/app#short' } })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe('the secret SHORT (coffre:kv/app#short): at least 8 characters expected');
  });

  it('a source that is not open is a failed read', async () => {
    await expect(reader().read({ X: { source: 'gone', path: 'p' } })).rejects.toThrow('the secret X (gone:p) could not be read: no source gone');
  });

  it('keeps every value it read, for the masking', async () => {
    const r = reader();
    expect(r.values()).toEqual([]);
    await r.read({ NPM_TOKEN: { source: 'env', path: 'NPM_TOKEN' } });
    await r.read({ NPM_TOKEN: { source: 'env', path: 'NPM_TOKEN' }, DB_SEED_KEY: { source: 'coffre', path: 'kv/app#seed_key' } });
    expect(r.values()).toEqual(['npm-secret-value', 'seed-secret-value']);
  });
});

describe('openSecretSources', () => {
  it('opens env without a declaration, and each declared source with its kind', async () => {
    const fake = new FakeSecretSource({ p: 'value-of-p' });
    const sources = openSecretSources({ coffre: { kind: 'fake', options: { name: 'coffre' } } }, { ...SECRET_SOURCE_KINDS, fake: fakeSecretKind({ coffre: fake }) }, { A: 'value-of-a' });
    expect(Object.keys(sources).sort()).toEqual(['coffre', 'env']);
    expect(await sources['coffre']!.read('p')).toBe('value-of-p');
    expect(await sources['env']!.read('A')).toBe('value-of-a');
  });

  it('only env is registered: no real secret manager is shipped', () => {
    expect(Object.keys(SECRET_SOURCE_KINDS)).toEqual(['env']);
  });
});
