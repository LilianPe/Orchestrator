import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * `secrets.json` encrypted at rest (ORC-398): the tokens the daemon writes itself (Linear's OAuth), which no read-only source
 * can hold. Envelope encryption: a data key drawn at each write encrypts the text, and is itself encrypted by a key derived
 * from `secrets_key` of factory.yml, read through a `SecretSource` at the daemon's start. An internal utility, not a port.
 */
const FORMAT = 'factory-secrets/1';
const CIPHER = 'aes-256-gcm';
/** The file's name binds each ciphertext: a block moved from elsewhere does not open. */
const AAD = Buffer.from('secrets.json');

/** What a derived key needs to start from: `openssl rand -base64 32` gives 44 characters. */
export const MIN_SECRETS_KEY_LENGTH = 32;

/** How to set `secrets_key` (ORC-398, ORC-470): the start, doctor, init and the token writes say it alike. */
export const SECRETS_KEY_REQUIRED = `set secrets_key in factory.yml (a reference, at least ${MIN_SECRETS_KEY_LENGTH} characters: openssl rand -base64 32; on a workstation, factory init --dev writes one): it encrypts secrets.json at rest`;

/**
 * Why nothing of Linear goes on without `secrets_key`, on the loopback too (ORC-470): its tokens and credentials are written to
 * secrets.json, never in clear. The start and doctor refuse with it, Connect Linear and init alike.
 */
export const LINEAR_NEEDS_SECRETS_KEY = `Linear's tokens and credentials are kept in secrets.json, never in clear: ${SECRETS_KEY_REQUIRED}`;

interface Box {
  iv: string;
  tag: string;
  data: string;
}

/** The text, encrypted by the data key, its box at the top level. */
interface Sealed extends Box {
  format: typeof FORMAT;
  salt: string;
  /** The data key, encrypted by the key derived from `secrets_key`. */
  key: Box;
}

const b64 = (b: Buffer) => b.toString('base64');

function encrypt(key: Buffer, plain: Buffer): Box {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv).setAAD(AAD);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) };
}

function decrypt(key: Buffer, box: Box): Buffer {
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(box.iv, 'base64')).setAAD(AAD);
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
}

function keyFrom(secret: string, salt: Buffer): Buffer {
  if (secret.length < MIN_SECRETS_KEY_LENGTH) throw new Error(`secrets_key: at least ${MIN_SECRETS_KEY_LENGTH} characters expected`);
  return Buffer.from(hkdfSync('sha256', secret, salt, FORMAT, 32));
}

/** Whether a secrets.json's text is sealed, rather than the plaintext JSON written before ORC-398. */
export function isSealed(text: string): boolean {
  try {
    return (JSON.parse(text) as Partial<Sealed> | null)?.format === FORMAT;
  } catch {
    return false;
  }
}

/** `plain` encrypted under `secret`, as secrets.json keeps it. */
export function sealSecretsFile(plain: string, secret: string): string {
  const salt = randomBytes(16);
  const dataKey = randomBytes(32);
  const sealed: Sealed = { format: FORMAT, salt: b64(salt), key: encrypt(keyFrom(secret, salt), dataKey), ...encrypt(dataKey, Buffer.from(plain, 'utf8')) };
  return JSON.stringify(sealed, null, 2);
}

const isBox = (v: unknown): v is Box => typeof v === 'object' && v !== null && ['iv', 'tag', 'data'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string');

/**
 * A sealed file cut short (ORC-494): its format's mark but no salt, data key or ciphertext. Said by name rather than by Node's
 * TypeError on `Buffer.from(undefined)`, which names no file, or as another key, which it is not.
 */
function incompleteSealed(sealed: Partial<Sealed>): string | undefined {
  const missing = typeof sealed.salt !== 'string' ? 'its salt' : !isBox(sealed.key) ? 'its key' : !isBox(sealed) ? 'its data' : undefined;
  return missing && `secrets.json is encrypted at rest but incomplete: ${missing} is missing`;
}

/** The plaintext of a sealed secrets.json. Another key or an altered file throws, saying nothing of the content. */
export function openSecretsFile(text: string, secret: string): string {
  const sealed = JSON.parse(text) as Sealed;
  const incomplete = incompleteSealed(sealed);
  if (incomplete) throw new Error(incomplete);
  const key = keyFrom(secret, Buffer.from(sealed.salt, 'base64'));
  try {
    return decrypt(decrypt(key, sealed.key), sealed).toString('utf8');
  } catch {
    throw new Error('secrets.json could not be decrypted: another key (secrets_key) or an altered file');
  }
}
