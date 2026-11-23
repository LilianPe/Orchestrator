import { describe, expect, it } from 'vitest';
import { isSealed, MIN_SECRETS_KEY_LENGTH, openSecretsFile, sealSecretsFile } from './secrets-file.js';

const KEY = 'k'.repeat(MIN_SECRETS_KEY_LENGTH);
const PLAIN = JSON.stringify({ linear: { accessToken: 'lin-access-token-value', refreshToken: 'lin-refresh-token-value' } });

describe('secrets.json at rest (ORC-398)', () => {
  it('seals a text that only its key opens, with nothing of it in clear', () => {
    const sealed = sealSecretsFile(PLAIN, KEY);
    expect(sealed).not.toContain('lin-access-token-value');
    expect(sealed).not.toContain('linear');
    expect(isSealed(sealed)).toBe(true);
    expect(openSecretsFile(sealed, KEY)).toBe(PLAIN);
  });

  it('gives a new text at each seal: a data key and a salt of their own', () => {
    expect(sealSecretsFile(PLAIN, KEY)).not.toBe(sealSecretsFile(PLAIN, KEY));
  });

  it('refuses another key, and an altered file, without saying more', () => {
    const sealed = sealSecretsFile(PLAIN, KEY);
    expect(() => openSecretsFile(sealed, 'x'.repeat(MIN_SECRETS_KEY_LENGTH))).toThrow('secrets.json could not be decrypted: another key (secrets_key) or an altered file');
    const file = JSON.parse(sealed) as Record<string, string>;
    const altered = JSON.stringify({ ...file, data: Buffer.from('altered data of the same kind').toString('base64') });
    expect(() => openSecretsFile(altered, KEY)).toThrow('secrets.json could not be decrypted');
  });

  it('refuses a sealed file cut short, naming it and what it lacks, before any key is derived (ORC-494)', () => {
    const file = JSON.parse(sealSecretsFile(PLAIN, KEY)) as Record<string, unknown>;
    const incomplete = (what: string) => `secrets.json is encrypted at rest but incomplete: ${what} is missing`;
    expect(() => openSecretsFile(JSON.stringify({ ...file, salt: undefined }), KEY)).toThrow(incomplete('its salt'));
    expect(() => openSecretsFile(JSON.stringify({ ...file, key: undefined }), KEY)).toThrow(incomplete('its key'));
    expect(() => openSecretsFile(JSON.stringify({ ...file, key: 'not a box' }), KEY)).toThrow(incomplete('its key'));
    expect(() => openSecretsFile(JSON.stringify({ ...file, key: { ...(file['key'] as object), tag: undefined } }), KEY)).toThrow(incomplete('its key'));
    expect(() => openSecretsFile(JSON.stringify({ ...file, data: undefined }), KEY)).toThrow(incomplete('its data'));
    expect(() => openSecretsFile(JSON.stringify({ ...file, salt: undefined }), 'short')).toThrow(incomplete('its salt'));
  });

  it('refuses a key too short to derive one from', () => {
    expect(() => sealSecretsFile(PLAIN, 'short-key')).toThrow(`secrets_key: at least ${MIN_SECRETS_KEY_LENGTH} characters expected`);
  });

  it('tells a plaintext secrets.json from a sealed one', () => {
    expect(isSealed(PLAIN)).toBe(false);
    expect(isSealed('{}')).toBe(false);
    expect(isSealed('not json')).toBe(false);
  });
});
