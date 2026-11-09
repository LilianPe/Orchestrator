import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { httpsUpstream } from '../../test/helpers/egress-upstream.js';
import { HttpPackageRegistry } from '../checks/registry.js';
import { egressFetch, registriesViaEgress } from './egress-fetch.js';
import { EgressProxy, type EgressProxyOptions } from './proxy.js';
import { readSecurityLog } from './security-log.js';

let upDir = '';
let upServer: Server;
let upstream: EgressProxyOptions['upstream'];
let dir = '';
let proxy: EgressProxy;

beforeAll(async () => {
  upDir = mkdtempSync(join(tmpdir(), 'egress-fetch-up-'));
  ({ server: upServer, upstream } = await httpsUpstream(upDir, (req, res) => {
    if (req.url === '/express') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ versions: { '1.0.0': {} } }));
    res.writeHead(404).end(`no ${req.headers.host} ${req.url}`);
  }));
});
afterAll(async () => {
  await new Promise((ok) => upServer.close(ok));
  rmSync(upDir, { recursive: true, force: true });
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'egress-fetch-'));
  proxy = new EgressProxy({ dir, caDir: join(dir, 'ca'), upstream });
});
afterEach(async () => {
  await proxy.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const opened = async (runId = 'r1-dependencies') => {
  const socket = await proxy.open(runId, { level: 'limited', allow: [] });
  return egressFetch(socket, readFileSync(proxy.caCertPath, 'utf8'));
};

describe('egressFetch (ORC-371)', () => {
  it("reaches a registry through the proxy's socket, under the factory's CA, and the proxy journals it", async () => {
    const registry = new HttpPackageRegistry({ fetch: await opened() });
    expect(await registry.lookup('npm', 'express')).toEqual({ status: 'found' });
    expect(await registry.lookup('npm', 'nope')).toEqual({ status: 'missing' });
    await proxy.close('r1-dependencies');
    const log = readSecurityLog({ runId: 'r1-dependencies', projectId: 'p', ticketId: 'ORC-1', at: 0 }, { egress: proxy.journalPath('r1-dependencies'), refusals: join(dir, 'none') });
    expect(log.egress.map((e) => [e.method, e.host, e.ok])).toEqual([
      ['GET', 'registry.npmjs.org', true],
      ['GET', 'registry.npmjs.org', true],
    ]);
  });

  it('a host the run\'s level does not allow is refused by the proxy, never reached', async () => {
    const fetch = await opened();
    await expect(fetch('https://evil.test/express')).rejects.toThrow(/egress proxy refused evil\.test:443 \(403\)/);
  });

  it('a request the level refuses (a write) comes back as the proxy\'s answer', async () => {
    const fetch = await opened();
    expect((await fetch('https://registry.npmjs.org/express', { method: 'PUT' })).status).toBe(403);
  });

  it('only HTTPS: a plain URL is refused before anything is sent', async () => {
    const fetch = await opened();
    await expect(fetch('http://registry.npmjs.org/express')).rejects.toThrow('HTTPS only');
  });

  it('a closed run\'s socket fails, as a registry that does not answer', async () => {
    const fetch = await opened();
    await proxy.close('r1-dependencies');
    expect(await new HttpPackageRegistry({ fetch }).lookup('npm', 'express')).toMatchObject({ status: 'unknown' });
  });

  it('registriesViaEgress opens a run of its own at limited, and closes it', async () => {
    const { registry, close } = await registriesViaEgress(proxy)('r2-dependencies');
    expect(proxy.isOpen('r2-dependencies')).toBe(true);
    expect(await registry.lookup('pypi', 'nope')).toEqual({ status: 'missing' });
    await close();
    expect(proxy.isOpen('r2-dependencies')).toBe(false);
  });

  it('gives up at the signal', async () => {
    const fetch = await opened();
    await expect(fetch('https://registry.npmjs.org/express', { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
