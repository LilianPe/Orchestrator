import { connect, createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetworkLevel } from '../../src/adapters/sandbox/types.js';
import { AGENT_API, egressRunnable, useEgress } from './egress.js';
import { cli } from './helpers.js';

/**
 * Isolation n° 3: sockets and metadata addresses (ORC-219, against ORC-213). The sandbox has no interface but the
 * loopback, no socket of the host's, and its proxy reaches neither a cloud metadata service nor the host itself, at any
 * level, `full` included (the setup's), however the address is spelt. The control: the agent API, the one way to the
 * host, answers through the same proxy.
 */
const levels: NetworkLevel[] = ['limited', 'full'];
const METADATA = ['169.254.169.254', '169.254.170.2', '100.100.100.200', '[fd00:ec2::254]'];

describe.skipIf(!egressRunnable)(`isolation 3: sockets and metadata addresses (${cli})`, () => {
  const egress = useEgress('iso3');
  const boxes = {} as Record<NetworkLevel, Awaited<ReturnType<typeof egress.open>>>;
  /** An abstract Unix socket in this host's network namespace: only a sandbox sharing it would reach it. */
  const abstract = `factory-iso3-${process.pid}`;
  let host: Server;
  const hostHits: string[] = [];

  beforeAll(async () => {
    host = createServer((c) => {
      hostHits.push('abstract');
      c.end();
    });
    await new Promise<void>((ok) => host.listen(`\0${abstract}`, ok));
    for (const level of levels) boxes[level] = await egress.open(level);
  }, 300_000);

  afterAll(() => new Promise<void>((ok) => (host ? host.close(() => ok()) : ok())));

  it.each(levels)('%s: no interface but the loopback, no route', async (level) => {
    expect(await boxes[level].sh(`node -p "Object.keys(require('os').networkInterfaces()).join(',')"`)).toEqual({ code: 0, out: 'lo' });
    // The header line alone.
    expect(await boxes[level].sh('wc -l < /proc/net/route')).toEqual({ code: 0, out: '1' });
  });

  it.each(levels)('%s: no TCP or UDP socket of its own, to the internet, a metadata service or the host', async (level) => {
    const b = boxes[level];
    for (const ip of ['1.1.1.1', '2606:4700:4700::1111', ...METADATA.map((m) => m.replace(/[[\]]/g, ''))]) {
      expect(await b.probe('tcp', ip, '80'), ip).toMatch(/^ERR /);
      expect(await b.probe('udp', ip, '53'), ip).toMatch(/^ERR /);
    }
    expect(await b.probe('tcp', '127.0.0.1', String(egress.agentPort()))).toMatch(/^ERR /);
  });

  it.each(levels)("%s: no socket of the host's, the abstract ones included; no socket file but its proxy's", async (level) => {
    const b = boxes[level];
    // The control: from the host, the socket answers.
    await new Promise<void>((ok, ko) => connect(`\0${abstract}`, ok).on('error', ko));
    const before = hostHits.length;
    expect(await b.probe('unix', `@${abstract}`)).toMatch(/^ERR /);
    expect(await b.sh(`find / \\( -path /proc -o -path /sys \\) -prune -o -type s -print 2>/dev/null`)).toMatchObject({ out: '/run/factory/egress/egress.sock' });
    await new Promise((r) => setTimeout(r, 100));
    expect(hostHits.length).toBe(before);
  });

  it.each(levels)('%s: through the proxy, no metadata service and no port of the host, however spelt; the agent API answers', async (level) => {
    const b = boxes[level];
    const port = egress.agentPort();
    // The control: the proxy relays the agent API, to the stand-in on this host's loopback.
    expect(await b.probe('fetch', `${AGENT_API}/agent/mcp`, 'POST', '{}')).toMatch(/^200 /);
    const hits = egress.agentHits.length;
    for (const m of METADATA) expect(await b.probe('fetch', `http://${m}/latest/meta-data/`), m).not.toMatch(/^200 /);
    const spellings = [
      ...METADATA.map((m) => `${m}:80`),
      ...METADATA.map((m) => `${m}:443`),
      // 169.254.169.254 in octal, hex, decimal and IPv4-mapped: the resolver reads the first three as the address.
      '0251.0376.0251.0376:80', '0xa9fea9fe:80', '2852039166:80', '[::ffff:169.254.169.254]:80', '[::ffff:a9fe:a9fe]:443',
      // This host, by every name, on the agent API's real port: only its sandbox name may lead there.
      `127.0.0.1:${port}`, `localhost:${port}`, `0x7f.1:${port}`, `2130706433:${port}`, `[::1]:${port}`, `0.0.0.0:${port}`, `host.docker.internal:${port}`,
    ];
    for (const target of spellings) expect(await b.probe('connect', target), target).not.toMatch(/ 200 /);
    expect(egress.agentHits.length).toBe(hits);
    // Every refusal is journaled, and nothing went out but the agent API.
    const journal = await b.journal();
    expect(journal.filter((e) => e.ok && e.host !== 'host.docker.internal')).toEqual([]);
    for (const m of METADATA) expect(journal, m).toContainEqual(expect.objectContaining({ host: m.replace(/[[\]]/g, ''), ok: false }));
  });
});
