import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LeafIssuer, loadOrCreateCa } from './ca.js';

const dir = mkdtempSync(join(tmpdir(), 'egress-ca-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the egress CA', () => {
  const ca = loadOrCreateCa(join(dir, 'ca'));

  it('is made once, its key the daemon’s alone, and read back after', () => {
    expect(new X509Certificate(ca.certPem).ca).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'ca', 'ca.key')).mode & 0o777).toBe(0o600);
    expect(loadOrCreateCa(join(dir, 'ca'))).toEqual(ca);
  });

  it('signs a leaf per host: issued by the CA, the host its SAN, cached', () => {
    const issuer = new LeafIssuer(ca);
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
