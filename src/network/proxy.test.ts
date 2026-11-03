import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EgressProxy, isPrivate, type EgressEntry } from './proxy.js';

let dir = '';
let proxy: EgressProxy;
let agent: Server;
let agentPort = 0;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'egress-'));
  agent = createServer((req, res) => res.end(`agent ${req.method} ${req.url}`));
  await new Promise<void>((ok) => agent.listen(0, '127.0.0.1', ok));
  agentPort = (agent.address() as AddressInfo).port;
  proxy = new EgressProxy({ dir, agentApi: { host: 'host.docker.internal', port: 4101, to: { host: '127.0.0.1', port: agentPort } } });
});

afterEach(async () => {
  await proxy.closeAll();
  await new Promise((ok) => agent.close(ok));
  rmSync(dir, { recursive: true, force: true });
});

/** A plain HTTP request through the run's socket, as the in-sandbox relay hands it over. */
function viaProxy(socketPath: string, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, ko) => {
    const req = request({ socketPath, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', ko).end();
  });
}

/** A CONNECT through the run's socket: the proxy's status line. */
function tunnel(socketPath: string, target: string): Promise<string> {
  return new Promise((ok, ko) => {
    const s = connect(socketPath, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d: Buffer) => {
      ok(String(d).split('\r\n')[0]!);
      s.destroy();
    });
    s.on('error', ko);
  });
}

const journal = async (runId: string): Promise<EgressEntry[]> => {
  // Written when the connection closes, a tick after the client sees its end.
  await new Promise((r) => setTimeout(r, 50));
  return readFileSync(proxy.journalPath(runId), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as EgressEntry);
};

describe('EgressProxy', () => {
  it('refuses a tunnel the policy refuses, and journals it', async () => {
    const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
    expect(await tunnel(sock, 'evil.example:443')).toBe('HTTP/1.1 403 Forbidden');
    expect(await tunnel(sock, 'github.com:443')).toBe('HTTP/1.1 403 Forbidden');
    expect(await journal('run-1')).toEqual([
      expect.objectContaining({ method: 'CONNECT', host: 'evil.example', ok: false, reason: expect.stringMatching(/not allowed/) as string }),
      expect.objectContaining({ method: 'CONNECT', host: 'github.com', ok: false }),
    ]);
  });

  it('refuses a write to GitHub, and journals it', async () => {
    const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
    const r = await viaProxy(sock, 'POST', 'http://api.github.com/gists');
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/GET, HEAD and OPTIONS only/);
    expect(await journal('run-1')).toEqual([expect.objectContaining({ method: 'POST', host: 'api.github.com', ok: false })]);
  });

  it('tunnels only to port 443 below full', async () => {
    const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
    expect(await tunnel(sock, 'nodejs.org:22')).toBe('HTTP/1.1 403 Forbidden');
  });

  it('never reaches a private address, even at full', async () => {
    const sock = await proxy.open('run-1', { level: 'full', allow: [] });
    expect(await tunnel(sock, `127.0.0.1:${agentPort}`)).toBe('HTTP/1.1 403 Forbidden');
    expect(await tunnel(sock, 'localhost:443')).toBe('HTTP/1.1 502 Bad Gateway');
    expect((await viaProxy(sock, 'GET', 'http://169.254.169.254/latest/meta-data/')).status).toBe(403);
    expect((await journal('run-1')).map((e) => e.ok)).toEqual([false, false, false]);
  });

  it('tells private addresses from public ones', () => {
    for (const a of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.17.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      expect(isPrivate(a), a).toBe(true);
    }
    for (const a of ['104.16.10.34', '1.1.1.1', '2606:4700::1111']) expect(isPrivate(a), a).toBe(false);
  });

  it('forwards the agent API to the daemon, every method, at any level but none', async () => {
    const sock = await proxy.open('run-1', { level: 'claude-api', allow: [] });
    expect(await viaProxy(sock, 'POST', 'http://host.docker.internal:4101/agent/ask')).toEqual({ status: 200, body: 'agent POST /agent/ask' });
    expect(await journal('run-1')).toEqual([
      expect.objectContaining({ method: 'POST', host: 'host.docker.internal', ok: true, down: 'agent POST /agent/ask'.length }),
    ]);
    expect(await tunnel(sock, 'host.docker.internal:4101')).toBe('HTTP/1.1 200 Connection Established');
    const none = await proxy.open('run-2', { level: 'none', allow: [] });
    expect(await tunnel(none, 'host.docker.internal:4101')).toBe('HTTP/1.1 403 Forbidden');
    expect((await viaProxy(none, 'GET', 'http://host.docker.internal:4101/agent/issue')).status).toBe(403);
  });

  it('keeps one socket per run, the same on a replay, gone once closed', async () => {
    const a = await proxy.open('run-1', { level: 'limited', allow: [] });
    expect(await proxy.open('run-1', { level: 'limited', allow: [] })).toBe(a);
    expect(await proxy.open('run-2', { level: 'limited', allow: [] })).not.toBe(a);
    await proxy.close('run-1');
    await proxy.close('run-1');
    await expect(tunnel(a, 'nodejs.org:443')).rejects.toThrow();
  });
});
