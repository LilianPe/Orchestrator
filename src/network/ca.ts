import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
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

/** `<dir>/ca.crt` and `<dir>/ca.key` (0600), made at the first call. */
export function loadOrCreateCa(dir: string): FactoryCa {
  const certPath = join(dir, 'ca.crt');
  const keyPath = join(dir, 'ca.key');
  if (existsSync(certPath) && existsSync(keyPath)) return { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8'), certPath };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = rsa();
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
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  writeFileSync(certPath, certPem, { mode: 0o644 });
  return { certPem, keyPem: privateKey, certPath };
}

/** Leaf certificates signed by the CA, one per host, cached; one key for all of them. */
export class LeafIssuer {
  private readonly key = rsa();
  private readonly caCert: forge.pki.Certificate;
  private readonly caKey: forge.pki.rsa.PrivateKey;
  private readonly cache = new Map<string, { ctx: SecureContext; pem: string; until: number }>();

  constructor(ca: FactoryCa) {
    this.caCert = forge.pki.certificateFromPem(ca.certPem);
    this.caKey = forge.pki.privateKeyFromPem(ca.keyPem);
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
    cert.publicKey = forge.pki.publicKeyFromPem(this.key.publicKey);
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
      { name: 'authorityKeyIdentifier', keyIdentifier: this.caCert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    // Issued for 30 days, renewed after 7: a long-lived daemon never presents an expired one.
    const entry = { ctx: createSecureContext({ key: this.key.privateKey, cert: pem }), pem, until: Date.now() + 7 * DAY };
    this.cache.set(host, entry);
    return entry;
  }
}

function rsa() {
  return generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
}

/** A positive serial: 16 random bytes, the first below 0x80. */
function serial(): string {
  const b = randomBytes(16);
  b[0] = b[0]! & 0x7f;
  return b.toString('hex');
}
