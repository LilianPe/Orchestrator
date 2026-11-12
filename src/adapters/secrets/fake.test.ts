import { describe, expect, it } from 'vitest';
import { describeSecretSourceContract } from '../../../test/contracts/secret-source.contract.js';
import { FakeSecretSource, fakeSecretKind } from './fake.js';

describeSecretSourceContract('FakeSecretSource', () => {
  const values = { 'kv/app#seed_key': 'seed-secret-value' };
  return {
    source: new FakeSecretSource(values),
    present: { path: 'kv/app#seed_key', value: 'seed-secret-value' },
    missing: 'kv/app#absent',
    down: new FakeSecretSource(values, { down: true }),
    syntax: { kind: fakeSecretKind({}), valid: 'kv/app#seed_key', invalid: 'no-hash' },
  };
});

describe('FakeSecretSource', () => {
  it('records each path it was asked', async () => {
    const source = new FakeSecretSource({ a: 'value-of-a' });
    await source.read('a');
    await source.read('b').catch(() => undefined);
    expect(source.reads).toEqual(['a', 'b']);
  });

  it('its kind hands out the source of its declaration', async () => {
    const kind = fakeSecretKind({ coffre: new FakeSecretSource({ p: 'value-of-p' }) });
    expect(await kind.create({ name: 'coffre' }, {}).read('p')).toBe('value-of-p');
    expect(kind.checkOptions({ name: 'coffre' })).toEqual([]);
    expect(kind.checkOptions({})).toEqual(['name: required']);
  });
});
