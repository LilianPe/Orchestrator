import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LeafIssuer, loadOrCreateCa } from './ca.js';

/** The next 16-byte draws (a serial's), as given: the real ones otherwise. */
const draws = vi.hoisted(() => [] as Buffer[]);
vi.mock('node:crypto', async (real) => {
  const crypto = await real<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: (n: number) => (n === 16 && draws.length ? Buffer.from(draws.shift()!) : crypto.randomBytes(n)) };
});

const dir = mkdtempSync(join(tmpdir(), 'egress-ca-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the egress CA', () => {
  let ca: Awaited<ReturnType<typeof loadOrCreateCa>>;
  beforeAll(async () => {
    ca = await loadOrCreateCa(join(dir, 'ca'));
  });

  it('is made once, its key the daemon’s alone, and read back after', async () => {
    expect(new X509Certificate(ca.certPem).ca).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'ca', 'ca.key')).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateCa(join(dir, 'ca'))).toEqual(ca);
  });

  it('signs a leaf per host: issued by the CA, the host its SAN, cached', async () => {
    const issuer = await LeafIssuer.create(ca);
    const leaf = new X509Certificate(issuer.certPem('nodejs.org'));
    const root = new X509Certificate(ca.certPem);
    expect(leaf.checkIssued(root)).toBe(true);
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toBe('DNS:nodejs.org');
    expect(leaf.ca).toBe(false);
    expect(leaf.checkHost('nodejs.org')).toBe('nodejs.org');
    expect(leaf.checkHost('evil.example')).toBeUndefined();
    expect(issuer.certPem('nodejs.org')).toBe(issuer.certPem('nodejs.org'));
  });
});

describe('the serials of its certificates (ORC-477)', () => {
  // The draws forge once wrote with illegal padding, which OpenSSL refuses (see serial()): two zero bytes first.
  const unlucky = ['0000', '800000'].map((head) => ({ head, draw: Buffer.from(head.padEnd(32, '2'), 'hex') }));
  // A case failing before it drew both leaves nothing for the next one.
  afterEach(() => void (draws.length = 0));

  it.each(unlucky)('are read by OpenSSL whatever their draw, the CA and a leaf: drawn $head', async ({ head, draw }) => {
    draws.push(draw, draw);
    const made = loadOrCreateCa(join(dir, `ca-${head}`));
    const issuer = await LeafIssuer.create(made);
    const unluckyCa = await made;
    const root = new X509Certificate(unluckyCa.certPem);
    const leaf = new X509Certificate(issuer.certPem('api.anthropic.com'));
    expect(draws).toEqual([]);
    expect(leaf.checkIssued(root)).toBe(true);
    expect(() => issuer.context('api.anthropic.com')).not.toThrow();
    for (const serial of [root.serialNumber, leaf.serialNumber]) expect(serial).toMatch(/^[4-7][0-9A-F]{31}$/);
  });
});

describe('a CA stored before ORC-477 that OpenSSL cannot read (ORC-483)', () => {
  /** A CA made as the daemon makes it, then signed anew under a serial forge writes with illegal padding: the stored files a pre-#321 install could hold. */
  async function stored(at: string): Promise<{ certPem: string; keyPem: string }> {
    const made = await loadOrCreateCa(at);
    const cert = forge.pki.certificateFromPem(made.certPem);
    cert.serialNumber = '0000'.padEnd(32, '2');
    cert.sign(forge.pki.privateKeyFromPem(made.keyPem), forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    writeFileSync(made.certPath, certPem);
    return { certPem, keyPem: made.keyPem };
  }

  /** Loaded from `at`, the stored pair is replaced: a new pair that belongs together, both files at their modes, said once and without a key. */
  async function expectReplaced(at: string, oldKeys: string[]): Promise<void> {
    const log = vi.fn();
    const ca = await loadOrCreateCa(at, log);
    // The pair on disk belongs together: the key renamed first, the certificate last.
    expect(new X509Certificate(ca.certPem).checkPrivateKey(createPrivateKey(ca.keyPem))).toBe(true);
    expect(oldKeys).not.toContain(ca.keyPem);
    if (process.platform !== 'win32') {
      expect(statSync(join(at, 'ca.key')).mode & 0o777).toBe(0o600);
      expect(statSync(ca.certPath).mode & 0o777).toBe(0o644);
    }
    expect(readdirSync(at).sort()).toEqual(['ca.crt', 'ca.key']);
    expect(log).toHaveBeenCalledOnce();
    const [message] = log.mock.calls[0]! as [string];
    expect(message).toContain(at);
    for (const key of [...oldKeys, ca.keyPem]) expect(message).not.toContain(key.split('\n')[1]);
    // Read back from disk as it is after: no second word.
    expect(await loadOrCreateCa(at, log)).toEqual(ca);
    expect(log).toHaveBeenCalledOnce();
  }

  it('is replaced by a new one, both files at their modes, said once and without its key', async () => {
    const at = join(dir, 'ca-padded');
    const before = await stored(at);
    expect(() => new X509Certificate(before.certPem)).toThrow();
    await expectReplaced(at, [before.keyPem]);
  });

  it('a readable certificate whose key is another one is replaced the same way (ORC-484)', async () => {
    const at = join(dir, 'ca-mismatched');
    const made = await loadOrCreateCa(at);
    // Another key beside this certificate: one file restored from a backup, or two processes racing on the folder.
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(join(at, 'ca.key'), other);
    expect(new X509Certificate(made.certPem).checkPrivateKey(createPrivateKey(other))).toBe(false);
    await expectReplaced(at, [made.keyPem, other]);
  });

  it('a key OpenSSL cannot parse fails the load and is never written over (ORC-484)', async () => {
    const at = join(dir, 'ca-encrypted');
    const keyPath = join(at, 'ca.key');
    const made = await loadOrCreateCa(at);
    // An operator's key behind a passphrase: not ours to replace.
    const encrypted = createPrivateKey(made.keyPem).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'operator' }) as string;
    writeFileSync(keyPath, encrypted);
    const log = vi.fn();
    await expect(loadOrCreateCa(at, log)).rejects.toThrow();
    expect(readFileSync(keyPath, 'utf8')).toBe(encrypted);
    expect(readFileSync(made.certPath, 'utf8')).toBe(made.certPem);
    expect(log).not.toHaveBeenCalled();
  });

  it('a CA OpenSSL reads is kept byte for byte, nothing said', async () => {
    const at = join(dir, 'ca-valid');
    const keyPath = join(at, 'ca.key');
    const made = await loadOrCreateCa(at);
    const cert = readFileSync(made.certPath);
    const key = readFileSync(keyPath);
    const log = vi.fn();
    expect(await loadOrCreateCa(at, log)).toEqual(made);
    expect(readFileSync(made.certPath).equals(cert)).toBe(true);
    expect(readFileSync(keyPath).equals(key)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});
