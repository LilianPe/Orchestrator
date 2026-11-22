import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  // Drawn with two zero bytes first, forge wrote the serial with a zero byte left before one under 0x80: a DER integer
  // OpenSSL refuses (illegal padding). A CA so drawn was dropped without a word from a client's `ca`, which then trusted
  // nothing ("unable to verify the first certificate"); a leaf so drawn threw where the proxy made its TLS context.
  const unlucky = [
    { draw: Buffer.from([0x00, 0x00, ...Array(14).fill(0x22)]), name: '00 00 22' },
    { draw: Buffer.from([0x80, 0x00, 0x00, ...Array(13).fill(0x22)]), name: '80 00 00' },
  ];

  it.each(unlucky)('are read by OpenSSL whatever their draw, the CA and a leaf: drawn $name', async ({ draw }) => {
    draws.push(draw, draw);
    const unluckyCa = await loadOrCreateCa(join(dir, `ca-${draw[0]}`));
    const issuer = await LeafIssuer.create(unluckyCa);
    const root = new X509Certificate(unluckyCa.certPem);
    const leaf = new X509Certificate(issuer.certPem('api.anthropic.com'));
    expect(draws).toEqual([]);
    expect(leaf.checkIssued(root)).toBe(true);
    expect(() => issuer.context('api.anthropic.com')).not.toThrow();
    for (const serial of [root.serialNumber, leaf.serialNumber]) expect(serial).toMatch(/^[4-7][0-9A-F]{31}$/);
  });
});
