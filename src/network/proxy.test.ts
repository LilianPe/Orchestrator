import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo, type LookupFunction, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeafIssuer, loadOrCreateCa } from './ca.js';
import { EgressProxy, isPrivate, type EgressEntry } from './proxy.js';

let dir = '';
let proxy: EgressProxy;
let agent: Server;
let agentPort = 0;

/** A docs host of its own, `docs.test`, on HTTPS under a CA the proxy's upstream trusts in these tests. */
const upDir = mkdtempSync(join(tmpdir(), 'egress-up-'));
const upCa = await loadOrCreateCa(join(upDir, 'ca'));
const upIssuer = await LeafIssuer.create(upCa);
const upstream = createHttpsServer({ SNICallback: (name, cb) => cb(null, upIssuer.context(name)) }, (req, res) => {
  req.resume();
  // Half a body, then the connection cut; or a response that never ends.
  if (req.url === '/cut') return void res.writeHead(200, { 'content-length': '100' }).write('half', () => res.destroy());
  if (req.url === '/slow') return void res.writeHead(200).write('start');
  // The credentials it got, when it got any: what the proxy set on a Claude API call (ORC-337).
  const creds = (['authorization', 'x-api-key'] as const).filter((k) => req.headers[k] !== undefined).map((k) => ` ${k}=${req.headers[k]}`).join('');
  req.on('end', () => res.end(`up ${req.method} ${req.headers.host} ${req.url}${creds}`));
});
const toLocal = ((_h: string, opts: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
  opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as unknown as LookupFunction;

beforeAll(async () => {
  await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
});
afterAll(async () => {
  await new Promise((ok) => upstream.close(ok));
  rmSync(upDir, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'egress-'));
  agent = createServer((req, res) => res.end(`agent ${req.method} ${req.url}`));
  await new Promise<void>((ok) => agent.listen(0, '127.0.0.1', ok));
  agentPort = (agent.address() as AddressInfo).port;
  proxy = new EgressProxy({
    dir,
    caDir: join(dir, 'ca'),
    agentApi: { host: 'host.docker.internal', port: 4101, to: { host: '127.0.0.1', port: agentPort } },
    claudeToken: () => FACTORY_TOKEN,
    upstream: { ca: upCa.certPem, lookup: toLocal, port: (upstream.address() as AddressInfo).port },
  });
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

/** A CONNECT through the run's socket: the proxy's status line, and the socket. */
function tunnel(socketPath: string, target: string): Promise<{ line: string; socket: Socket }> {
  return new Promise((ok, ko) => {
    const s = connect(socketPath, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d: Buffer) => ok({ line: String(d).split('\r\n')[0]!, socket: s }));
    s.on('error', ko);
  });
}

const status = async (socketPath: string, target: string) => {
  const { line, socket } = await tunnel(socketPath, target);
  socket.destroy();
  return line;
};

/** An HTTPS request inside a CONNECT, trusting the factory CA as a sandbox does. */
async function viaTls(socketPath: string, host: string, method: string, path: string, headers: Record<string, string> = {}, alpn = ['http/1.1']) {
  const { line, socket } = await tunnel(socketPath, `${host}:443`);
  expect(line).toBe('HTTP/1.1 200 Connection Established');
  const tls = tlsConnect({ socket, servername: host, ca: readFileSync(proxy.caCertPath, 'utf8'), ALPNProtocols: alpn });
  return new Promise<{ status: number; body: string }>((ok, ko) => {
    tls.on('error', ko);
    const req = request({ createConnection: () => tls, method, path, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
      res.on('close', () => res.complete || ko(new Error('response cut')));
    });
    req.on('error', ko).end();
  });
}

const journal = async (runId: string): Promise<EgressEntry[]> => {
  // Written when the connection closes, a tick after the client sees its end.
  await new Promise((r) => setTimeout(r, 100));
  return readFileSync(proxy.journalPath(runId), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EgressEntry);
};

const docs = { level: 'limited' as const, allow: ['docs.test'] };
const FACTORY_TOKEN = 'sk-ant-oat01-the-factory-token';
const CLAUDE = 'api.anthropic.com';

describe('EgressProxy', () => {
  it('refuses a tunnel the policy refuses, and journals it', async () => {
    const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
    expect(await status(sock, 'evil.example:443')).toBe('HTTP/1.1 403 Forbidden');
    expect(await status(sock, 'statsig.anthropic.com:443')).toBe('HTTP/1.1 403 Forbidden');
    expect(await journal('run-1')).toEqual([
      expect.objectContaining({ method: 'CONNECT', host: 'evil.example', ok: false, reason: expect.stringMatching(/not allowed/) as string }),
      expect.objectContaining({ method: 'CONNECT', host: 'statsig.anthropic.com', ok: false }),
    ]);
  });

  it('decrypts an allowed tunnel: a GET passes, journaled with its path, a POST is refused', async () => {
    const sock = await proxy.open('run-1', docs);
    expect(await viaTls(sock, 'docs.test', 'GET', '/page?token=s3cr3t')).toEqual({ status: 200, body: 'up GET docs.test /page?token=s3cr3t' });
    const post = await viaTls(sock, 'docs.test', 'POST', '/form');
    expect(post.status).toBe(403);
    expect(post.body).toMatch(/GET, HEAD and OPTIONS only/);
    const entries = await journal('run-1');
    expect(entries).toEqual([
      expect.objectContaining({ method: 'GET', host: 'docs.test', path: '/page', ok: true }),
      expect.objectContaining({ method: 'POST', host: 'docs.test', path: '/form', ok: false }),
    ]);
    expect(entries[0]!.down).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain('s3cr3t');
  });

  it('sends the host it checked upstream, whatever Host the client sets (no fronting)', async () => {
    const sock = await proxy.open('run-1', docs);
    expect((await viaTls(sock, 'docs.test', 'GET', '/', { host: 'evil.example' })).body).toBe('up GET docs.test /');
  });

  it('speaks HTTP/1.1 alone: an h2-only client is refused, and journaled', async () => {
    const sock = await proxy.open('run-1', docs);
    await expect(viaTls(sock, 'docs.test', 'GET', '/', {}, ['h2'])).rejects.toThrow();
    expect(await journal('run-1')).toContainEqual(expect.objectContaining({ host: 'docs.test', ok: false }));
  });

  it('refuses a plain write to GitHub, and journals it', async () => {
    const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
    const r = await viaProxy(sock, 'POST', 'http://api.github.com/gists');
    expect(r.status).toBe(403);
    expect(await journal('run-1')).toEqual([expect.objectContaining({ method: 'POST', host: 'api.github.com', path: '/gists', ok: false })]);
  });

  it('tunnels only to port 443 below full', async () => {
    const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
    expect(await status(sock, 'nodejs.org:22')).toBe('HTTP/1.1 403 Forbidden');
  });

  it('never reaches a private address, even at full', async () => {
    const sock = await proxy.open('run-1', { level: 'full', allow: [] });
    expect(await status(sock, `127.0.0.1:${agentPort}`)).toBe('HTTP/1.1 403 Forbidden');
    expect((await viaProxy(sock, 'GET', 'http://localhost/')).status).toBe(502);
    expect((await viaProxy(sock, 'GET', 'http://169.254.169.254/latest/meta-data/')).status).toBe(403);
    expect((await journal('run-1')).map((e) => e.ok)).toEqual([false, false, false]);
  });

  it('tells private addresses from public ones, an IPv4 embedded in an IPv6 included', () => {
    const inside = ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.17.0.1', '192.168.1.1', '100.64.0.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '240.0.0.1'];
    const embedded = ['::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::a00:1', '::ffff:0:a00:1', '64:ff9b::a00:1', '2002:a00:1::1'];
    for (const a of [...inside, ...embedded, '::1', 'fd00::1', 'fe80::1', 'fec0::1', '100::1']) {
      expect(isPrivate(a), a).toBe(true);
    }
    for (const a of ['104.16.10.34', '1.1.1.1', '::ffff:1.1.1.1', '2606:4700::1111']) expect(isPrivate(a), a).toBe(false);
  });

  it('forwards the agent API to the daemon, every method, at any level but none, plain or tunnelled', async () => {
    const sock = await proxy.open('run-1', { level: 'claude-api', allow: [] });
    expect(await viaProxy(sock, 'POST', 'http://host.docker.internal:4101/agent/mcp')).toEqual({ status: 200, body: 'agent POST /agent/mcp' });
    expect(await journal('run-1')).toEqual([
      expect.objectContaining({ method: 'POST', host: 'host.docker.internal', path: '/agent/mcp', ok: true, down: 'agent POST /agent/mcp'.length }),
    ]);
    expect(await status(sock, 'host.docker.internal:4101')).toBe('HTTP/1.1 200 Connection Established');
    const none = await proxy.open('run-2', { level: 'none', allow: [] });
    expect((await viaProxy(none, 'GET', 'http://host.docker.internal:4101/agent/issue')).status).toBe(403);
    expect(await status(none, 'host.docker.internal:4101')).toBe('HTTP/1.1 403 Forbidden');
  });

  it('matches the host whatever its case or trailing dot, and journals it normalised', async () => {
    const sock = await proxy.open('run-1', docs);
    expect((await viaTls(sock, 'DOCS.Test.', 'GET', '/a')).body).toBe('up GET docs.test /a');
    expect(await journal('run-1')).toEqual([expect.objectContaining({ host: 'docs.test', path: '/a', ok: true })]);
  });

  it('journals an upstream cut mid-body as a failure, and ends the client’s response', async () => {
    const sock = await proxy.open('run-1', docs);
    await expect(viaTls(sock, 'docs.test', 'GET', '/cut')).rejects.toThrow();
    expect(await journal('run-1')).toEqual([expect.objectContaining({ path: '/cut', ok: false })]);
  });

  it('journals what is in flight when the run closes', async () => {
    const sock = await proxy.open('run-1', docs);
    const { socket } = await tunnel(sock, 'docs.test:443');
    const tls = tlsConnect({ socket, servername: 'docs.test', ca: readFileSync(proxy.caCertPath, 'utf8') });
    const started = new Promise<void>((ok) => request({ createConnection: () => tls, path: '/slow', headers: { host: 'docs.test' } }, () => ok()).on('error', () => {}).end());
    await started;
    const path = proxy.journalPath('run-1');
    await proxy.close('run-1');
    expect(readFileSync(path, 'utf8')).toContain('"path":"/slow"');
  });

  it('pipes another port as is at full, never to a private address', async () => {
    const sock = await proxy.open('run-1', { level: 'full', allow: [] });
    expect(await status(sock, 'localhost:22')).toBe('HTTP/1.1 502 Bad Gateway');
    expect(await journal('run-1')).toEqual([expect.objectContaining({ method: 'CONNECT', host: 'localhost', port: 22, ok: false, reason: expect.stringMatching(/private/) as string })]);
  });

  describe('the Claude API (ORC-337)', () => {
    const attacker = { authorization: 'Bearer sk-ant-api03-attacker', 'x-api-key': 'sk-ant-api03-attacker' };

    it("replaces any credential of the client with the run's token, tunnelled or plain", async () => {
      const sock = await proxy.open('run-1', { level: 'claude-api', allow: [] });
      expect(await viaTls(sock, CLAUDE, 'POST', '/v1/messages?beta=true', attacker)).toEqual({ status: 200, body: `up POST ${CLAUDE} /v1/messages?beta=true authorization=Bearer ${FACTORY_TOKEN}` });
      expect(await viaTls(sock, CLAUDE, 'POST', '/v1/messages/count_tokens', { authorization: 'Bearer set-by-the-factory-egress-proxy' })).toEqual({ status: 200, body: `up POST ${CLAUDE} /v1/messages/count_tokens authorization=Bearer ${FACTORY_TOKEN}` });
      expect((await viaTls(sock, CLAUDE, 'GET', '/api/claude_code/settings')).body).toBe(`up GET ${CLAUDE} /api/claude_code/settings authorization=Bearer ${FACTORY_TOKEN}`);
      expect((await viaProxy(sock, 'POST', `http://${CLAUDE}/v1/messages`)).body).toBe(`up POST ${CLAUDE} /v1/messages authorization=Bearer ${FACTORY_TOKEN}`);
      // The journal never holds a token.
      expect(JSON.stringify(await journal('run-1'))).not.toMatch(/sk-ant/);
    });

    it('prefers the token the run was opened with: the proxy service gets it from the daemon', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] }, 'sk-ant-oat01-of-this-run');
      expect((await viaTls(sock, CLAUDE, 'POST', '/v1/messages', attacker)).body).toBe(`up POST ${CLAUDE} /v1/messages authorization=Bearer sk-ant-oat01-of-this-run`);
    });

    it("sends none of the client's credentials when the factory has no token", async () => {
      const bare = new EgressProxy({ dir: join(dir, 'bare'), caDir: join(dir, 'ca'), upstream: { ca: upCa.certPem, lookup: toLocal, port: (upstream.address() as AddressInfo).port } });
      try {
        // The same CA: the one viaTls trusts, made by the first open.
        await proxy.open('run-0', { level: 'claude-api', allow: [] });
        const sock = await bare.open('run-1', { level: 'claude-api', allow: [] });
        expect((await viaTls(sock, CLAUDE, 'POST', '/v1/messages', attacker)).body).toBe(`up POST ${CLAUDE} /v1/messages`);
      } finally {
        await bare.closeAll();
      }
    });

    it('refuses a path Claude Code does not call, /v1/files first, and journals it', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      const files = await viaTls(sock, CLAUDE, 'POST', '/v1/files', attacker);
      expect(files.status).toBe(403);
      expect(files.body).toMatch(/not a call of Claude Code/);
      expect((await viaProxy(sock, 'POST', `http://${CLAUDE}/v1/files`)).status).toBe(403);
      expect((await viaTls(sock, CLAUDE, 'POST', '/api/event_logging/v2/batch')).status).toBe(403);
      expect(await journal('run-1')).toEqual([
        expect.objectContaining({ method: 'POST', host: CLAUDE, path: '/v1/files', ok: false }),
        expect.objectContaining({ method: 'POST', host: CLAUDE, path: '/v1/files', ok: false }),
        expect.objectContaining({ method: 'POST', host: CLAUDE, path: '/api/event_logging/v2/batch', ok: false }),
      ]);
    });

    it('leaves the credentials of other hosts alone', async () => {
      const sock = await proxy.open('run-1', docs);
      expect((await viaTls(sock, 'docs.test', 'GET', '/', { authorization: 'Bearer docs' })).body).toBe('up GET docs.test / authorization=Bearer docs');
    });
  });

  it('shares one socket between concurrent opens, and refuses another policy for an open run', async () => {
    const [a, b] = await Promise.all([proxy.open('run-1', docs), proxy.open('run-1', docs)]);
    expect(a).toBe(b);
    await expect(proxy.open('run-1', { level: 'full', allow: [] })).rejects.toThrow(/open at limited/);
    await expect(proxy.open('run-1', { level: 'limited', allow: [] })).rejects.toThrow(/docs.test/);
  });

  it('keeps one socket per run, the same on a replay, gone once closed', async () => {
    const a = await proxy.open('run-1', { level: 'limited', allow: [] });
    expect(await proxy.open('run-1', { level: 'limited', allow: [] })).toBe(a);
    expect(proxy.isOpen('run-1')).toBe(true);
    expect(await proxy.open('run-2', { level: 'limited', allow: [] })).not.toBe(a);
    await proxy.close('run-1');
    await proxy.close('run-1');
    expect(proxy.isOpen('run-1')).toBe(false);
    await expect(tunnel(a, 'nodejs.org:443')).rejects.toThrow();
  });
});
