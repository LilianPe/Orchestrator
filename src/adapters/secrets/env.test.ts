import { describe, expect, it } from 'vitest';
import { describeSecretSourceContract } from '../../../test/contracts/secret-source.contract.js';
import { envSecretKind } from './env.js';

describeSecretSourceContract('env', () => ({
  source: envSecretKind.create({}, { NPM_TOKEN: 'npm-secret-value' }),
  present: { path: 'NPM_TOKEN', value: 'npm-secret-value' },
  missing: 'NOT_SET',
  syntax: { kind: envSecretKind, valid: 'NPM_TOKEN', invalid: 'kv/app#seed' },
}));

describe('env secret source', () => {
  it('an empty variable is as missing as an unset one', async () => {
    await expect(envSecretKind.create({}, { EMPTY: '' }).read('EMPTY')).rejects.toThrow('the environment variable EMPTY is not set');
  });

  it('reads the environment at each read, not at its creation', async () => {
    const env: NodeJS.ProcessEnv = {};
    const source = envSecretKind.create({}, env);
    env['LATE'] = 'set-after-start';
    expect(await source.read('LATE')).toBe('set-after-start');
  });

  it('takes no option', () => {
    expect(envSecretKind.checkOptions({})).toEqual([]);
    expect(envSecretKind.checkOptions({ address: 'x' })).toEqual(['address: unknown key']);
  });
});
