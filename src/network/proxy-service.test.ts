import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpsUpstream } from '../../test/helpers/egress-upstream.js';
import { EgressProxy } from './proxy.js';
import { EgressClient, serveEgressControl, type EgressControl } from './proxy-service.js';

const LIMITED = { level: 'limited' as const, allow: [] };

/** Windows has no Unix sockets for the unit tests: a named pipe, as EgressProxy does. */
const controlPath = (dir: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\factory-control-${dir.slice(-8)}` : join(dir, 'control.sock'));

describe('the egress proxy as a service of its own (ORC-203)', () => {
  let dir = '';
  let path = '';
  let proxy: EgressProxy;
  let control: EgressControl;
  let client: EgressClient;
  const logs: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'egress-control-'));
    path = controlPath(dir);
    proxy = new EgressProxy({ dir: join(dir, 'network'), caDir: join(dir, 'ca') });
    control = await serveEgressControl(proxy, path);
    logs.length = 0;
    client = new EgressClient(path, { log: (m) => logs.push(m) });
  });
  afterEach(async () => {
    await client.closeAll().catch(() => {});
    await control.close();
    await proxy.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the journal of a run where the proxy writes it: the control socket sits in the directory of the proxy (ORC-296)', () => {
    const at = join(dir, 'network');
    expect(new EgressClient(join(at, 'control.sock')).journalPath('r1')).toBe(proxy.journalPath('r1'));
    expect(() => client.journalPath('../r1')).toThrow('invalid run id');
  });

  /** A control socket that is not the proxy's. */
  const withServer = async (handler: RequestListener, body: (at: string) => Promise<void>) => {
    const server = createServer(handler);
    const at = `${path}-other`;
    await new Promise<void>((ok) => server.listen(at, ok));
    try {
      await body(at);
    } finally {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    }
  };

  it("hands the proxy the daemon's Claude token with each run, and none when the daemon has none (ORC-337)", async () => {
    // What reaches the Claude API through the run's socket: the token the run really uses.
    const { server, upstream } = await httpsUpstream(dir, (req, res) => res.end(String(req.headers.authorization)));
    // A token of its own: an undefined from the daemon must not fall back on it.
    const tokened = new EgressProxy({ dir: join(dir, 'tokened'), caDir: join(dir, 'ca'), claudeToken: () => 'sk-ant-oat01-proxy-option', upstream });
    const at = `${path}-tokened`;
    const served = await serveEgressControl(tokened, at);
    const modelCall = (socketPath: string) =>
      new Promise<string>((ok, ko) => {
        request({ socketPath, method: 'POST', path: 'http://api.anthropic.com/v1/messages', headers: { host: 'api.anthropic.com' } }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c));
          res.on('end', () => ok(body));
        }).on('error', ko).end('{}');
      });
    const daemon = new EgressClient(at, { claudeToken: () => 'sk-ant-oat01-daemon' });
    const bare = new EgressClient(at);
    try {
      expect(await modelCall(await daemon.open('run-1', LIMITED))).toBe('Bearer sk-ant-oat01-daemon');
      expect(await modelCall(await bare.open('run-2', LIMITED))).toBe('undefined');
    } finally {
      await daemon.closeAll();
      await bare.closeAll();
      await served.close();
      await tokened.closeAll();
      await new Promise((ok) => server.close(ok));
    }
  });

  it("opens the run's socket in the proxy's process and gives back its path and the authority's certificate", async () => {
    const socket = await client.open('run-1', LIMITED);
    expect(socket).toBe(proxy.socketPath('run-1'));
    expect(proxy.isOpen('run-1')).toBe(true);
    expect(client.isOpen('run-1')).toBe(true);
    expect(client.caCertPath).toBe(proxy.caCertPath);
    expect(readFileSync(client.caCertPath, 'utf8')).toContain('BEGIN CERTIFICATE');
  });

  it("has no certificate to give before a run is opened, like the proxy's own", () => {
    expect(() => client.caCertPath).toThrow(/no run opened/);
  });

  it('closes the run', async () => {
    await client.open('run-1', LIMITED);
    await client.close('run-1');
    expect(proxy.isOpen('run-1')).toBe(false);
    expect(client.isOpen('run-1')).toBe(false);
  });

  it('closes its runs at the shutdown of the daemon', async () => {
    await client.open('run-1', LIMITED);
    await client.closeAll();
    expect(proxy.isOpen('run-1')).toBe(false);
  });

  it('closes the runs of a daemon that dies: a new one starts from nothing, as with the proxy in its process', async () => {
    await client.open('run-1', LIMITED);
    // A crash: the connection drops, no close comes.
    const dead = (client as unknown as { watch: Promise<{ destroy(): void }> }).watch;
    (await dead).destroy();
    await vi.waitFor(() => expect(proxy.isOpen('run-1')).toBe(false));
    const next = new EgressClient(path);
    await next.open('run-1', { level: 'none', allow: [] });
    expect(proxy.isOpen('run-1')).toBe(true);
    await next.closeAll();
  });

  it('leaves the runs of the daemon that took over when an older watch ends late', async () => {
    const old = new EgressClient(path);
    await old.open('old-run', LIMITED);
    await client.open('new-run', LIMITED);
    await old.closeAll();
    expect(proxy.isOpen('new-run')).toBe(true);
  });

  it("passes on the proxy's refusal of another policy for an open run", async () => {
    await client.open('run-1', LIMITED);
    await expect(client.open('run-1', { level: 'none', allow: [] })).rejects.toThrow(/is open at limited/);
  });

  it('refuses a malformed request', async () => {
    const status = await new Promise<number>((ok, ko) => {
      const req = request({ socketPath: path, path: '/open', method: 'POST' }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.on('error', ko);
      req.end(JSON.stringify({ runId: 'run-1', policy: { level: 'everything', allow: [] } }));
    });
    expect(status).toBe(400);
    expect(proxy.isOpen('run-1')).toBe(false);
  });

  it('fails an open while the proxy is down, naming it', async () => {
    await control.close();
    await expect(client.open('run-1', LIMITED)).rejects.toThrow(/proxy/);
    expect(client.isOpen('run-1')).toBe(false);
  });

  it('forgets its runs when the proxy goes: their sockets died with it, so the provider replaces their containers', async () => {
    await client.open('run-1', LIMITED);
    await control.close();
    await vi.waitFor(() => expect(client.isOpen('run-1')).toBe(false));
  });

  it('opens again once a new proxy is up', async () => {
    await client.open('run-1', LIMITED);
    await control.close();
    await vi.waitFor(() => expect(client.isOpen('run-1')).toBe(false));
    control = await serveEgressControl(proxy, path);
    await client.open('run-2', LIMITED);
    expect(client.isOpen('run-2')).toBe(true);
  });

  it('fails an open the proxy does not answer, instead of holding the dev slot', async () => {
    await withServer(() => {}, async (at) => {
      await expect(new EgressClient(at, { timeoutMs: 50 }).open('run-1', LIMITED)).rejects.toThrow(/proxy/);
    });
  });

  it('rejects a reply that is not JSON, without throwing out of the event', async () => {
    const odd: RequestListener = (req, res) => {
      if (req.url === '/watch') return void res.writeHead(200).flushHeaders();
      res.end('not json');
    };
    await withServer(odd, async (at) => {
      const c = new EgressClient(at);
      await expect(c.open('run-1', LIMITED)).rejects.toThrow(/proxy/);
      await c.closeAll();
    });
  });

  it('never throws on a close while the proxy is down: the container is gone, the journal says it', async () => {
    await client.open('run-1', LIMITED);
    await control.close();
    await expect(client.close('run-1')).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('run-1');
  });

});
