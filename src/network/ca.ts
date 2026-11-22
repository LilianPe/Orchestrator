import { createPrivateKey, generateKeyPair, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import forge from 'node-forge';

/** The factory's egress CA (ORC-213): the sandboxes trust it alone, the proxy signs a leaf per host with it. */
export interface FactoryCa {
  certPem: string;
  keyPem: string;
  /** The certificate on disk, mounted read-only in each sandbox; the key never leaves the daemon. */
  certPath: string;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * `<dir>/ca.crt` and `<dir>/ca.key` (0600), made at the first call. A stored certificate OpenSSL cannot read is replaced,
 * `log` told (ORC-483): before ORC-477, one serial in 65,536 was written with illegal padding, and Node drops such a CA
 * from a client's `ca` without a word, so no sandbox could trust it. So is one whose key is not its own (ORC-484): one file
 * restored alone, or two processes racing on the folder. A readable pair that belongs together is kept as it is.
 */
export async function loadOrCreateCa(dir: string, log?: (message: string) => void): Promise<FactoryCa> {
  const certPath = join(dir, 'ca.crt');
  const keyPath = join(dir, 'ca.key');
  let unusable: string | undefined;
  if (existsSync(certPath) && existsSync(keyPath)) {
    const certPem = readFileSync(certPath, 'utf8');
    const keyPem = readFileSync(keyPath, 'utf8');
    unusable = unusableReason(certPem, keyPem);
    if (!unusable) return { certPem, keyPem, certPath };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = await rsa();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const name = [{ name: 'commonName', value: 'Factory egress CA' }, { name: 'organizationName', value: randomBytes(4).toString('hex') }];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  // The key first, the certificate last: cut in between, the old certificate stays, still unreadable, and the next start makes another.
  replace(keyPath, privateKey, 0o600);
  replace(certPath, certPem, 0o644);
  if (unusable) log?.(`egress: the CA in ${dir} could not be used (${unusable}): a new one replaced it`);
  return { certPem, keyPem: privateKey, certPath };
}

/**
 * Why the stored pair cannot sign: a certificate OpenSSL cannot read (no sandbox trusts it), or a key that is not its own
 * (every leaf fails verification, ORC-484). Never the key's content; undefined when the pair is usable.
 */
function unusableReason(certPem: string, keyPem: string): string | undefined {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch (err) {
    return `certificate unreadable to OpenSSL, so no sandbox trusted it: ${(err as Error).message}`;
  }
  try {
    if (cert.checkPrivateKey(createPrivateKey(keyPem))) return undefined;
  } catch {
    // An unreadable key; OpenSSL's message is not passed on, in case it quotes the key.
  }
  return 'its key does not match its certificate, so every leaf failed verification';
}

/**
 * Written beside `path` at `mode`, then renamed over it: a reader sees the old file or the new one, never half of it. Both
 * on disk before it returns, so the renames land in their order even across a power cut.
 */
function replace(path: string, content: string, mode: number): void {
  const next = `${path}.tmp`;
  rmSync(next, { force: true }); // left by a crash: made anew, never written through a link planted there
  writeFileSync(next, content, { mode, flush: true });
  chmodSync(next, mode); // whatever the umask
  renameSync(next, path);
  if (process.platform === 'win32') return; // a folder cannot be opened there
  const folder = openSync(dirname(path), 'r');
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}

/**
 * Leaf certificates signed by the CA, one per host, cached; one key for all of them, made once. A
 * miss costs one forge signature (milliseconds, on the event loop); a hit is free.
 */
export class LeafIssuer {
  private readonly caCert: forge.pki.Certificate;
  private readonly caKey: forge.pki.rsa.PrivateKey;
  /** Parsed once: the same for every leaf. */
  private readonly leafPublic: forge.pki.rsa.PublicKey;
  private readonly caKeyId: string;
  private readonly cache = new Map<string, { ctx: SecureContext; pem: string; until: number }>();

  private constructor(ca: FactoryCa, private readonly key: { publicKey: string; privateKey: string }) {
    this.caCert = forge.pki.certificateFromPem(ca.certPem);
    this.caKey = forge.pki.privateKeyFromPem(ca.keyPem);
    this.leafPublic = forge.pki.publicKeyFromPem(key.publicKey);
    this.caKeyId = this.caCert.generateSubjectKeyIdentifier().getBytes();
  }

  /** The leaf key is made while the CA loads: neither waits on the other. */
  static async create(ca: FactoryCa | Promise<FactoryCa>): Promise<LeafIssuer> {
    const [c, key] = await Promise.all([ca, rsa()]);
    return new LeafIssuer(c, key);
  }

  /** The TLS context the proxy presents for `host`. */
  context(host: string): SecureContext {
    return this.leaf(host).ctx;
  }

  /** The leaf for `host`, as PEM. */
  certPem(host: string): string {
    return this.leaf(host).pem;
  }

  private leaf(host: string) {
    const hit = this.cache.get(host);
    if (hit && hit.until > Date.now()) return hit;
    const cert = forge.pki.createCertificate();
    cert.publicKey = this.leafPublic;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - DAY);
    cert.validity.notAfter = new Date(Date.now() + 30 * DAY);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }] },
      { name: 'authorityKeyIdentifier', keyIdentifier: this.caKeyId },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    // Issued for 30 days, renewed after 7: a long-lived daemon never presents an expired one.
    const entry = { ctx: createSecureContext({ key: this.key.privateKey, cert: pem }), pem, until: Date.now() + 7 * DAY };
    this.cache.delete(host);
    // ponytail: a cap, the oldest out first; at `full` every host would otherwise stay for the daemon's life.
    if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(host, entry);
    return entry;
  }
}

/** Off the event loop: an RSA key takes tens of milliseconds. */
function rsa(): Promise<{ publicKey: string; privateKey: string }> {
  return new Promise((ok, ko) =>
    generateKeyPair('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }, (err, publicKey, privateKey) =>
      err ? ko(err) : ok({ publicKey, privateKey }),
    ),
  );
}

/**
 * A positive serial, 126 random bits: its first byte from 0x40 to 0x7f, so its DER is minimal as it stands. A first byte
 * of zero, before another one, was written by forge with a zero byte left in front: illegal padding to OpenSSL, which then
 * read neither that CA in a client's `ca` (dropped without a word, the client trusting nothing) nor that leaf (ORC-477).
 */
function serial(): string {
  const b = randomBytes(16);
  b[0] = (b[0]! & 0x3f) | 0x40;
  return b.toString('hex');
}
