import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
