import { createHash } from 'node:crypto';
import { lookup, type LookupAddress } from 'node:dns';
import { appendFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, connect, isIP, type LookupFunction, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { allowConnect, allowRequest, type EgressPolicy, type Verdict } from './levels.js';

/** One line of a run's egress journal: every connection, allowed or refused (ORC-213). */
export interface EgressEntry {
  at: string;
  method: string;
  host: string;
  ok: boolean;
  reason?: string;
  /** Bytes sent and received, body and TLS records included. */
  up: number;
  down: number;
}

export interface EgressProxyOptions {
  /** The runs' sockets and journals (`<home>/network`), the daemon's alone. */
  dir: string;
  /** The factory's agent API as the sandbox names it (`FACTORY_API`), and where the daemon listens for it. */
  agentApi?: { host: string; port: number; to: { host: string; port: number } };
}

interface Run {
  server: Server;
  /** Tunnels outlive the HTTP server's own bookkeeping: closed by hand. */
  sockets: Set<Duplex>;
}

/** Nothing reached through the proxy is the host's network, its engine's bridge or a cloud metadata service. */
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
// IPv4-mapped IPv6 addresses are checked against the IPv4 rules above.
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

export const isPrivate = (address: string) => PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

/** `dns.lookup`, failing on a private address: a host on a list cannot be pointed at the inside. */
const publicLookup = ((host: string, opts: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
  lookup(host, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const bad = addresses.find((a) => isPrivate(a.address));
    if (bad) return cb(new Error(`${host} resolves to the private address ${bad.address}`), []);
    if ((opts as { all?: boolean }).all) return cb(null, addresses);
    cb(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as LookupFunction;

/**
 * The factory's egress proxy (ORC-213): the only way out of a sandbox, which runs `--network none`
 * with this run's Unix socket mounted. One socket per run, so the journal knows the run without
 * trusting anything the sandbox sends. HTTP proxy protocol: `CONNECT` tunnels (host checked) and
 * plain HTTP requests (host, method and path checked, sent on in HTTPS).
 */
export class EgressProxy {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly o: EgressProxyOptions) {}

  socketPath(runId: string): string {
    // Hashed: a Unix socket path is capped near 108 bytes.
    const name = createHash('sha256').update(`${this.o.dir}\0${runId}`).digest('hex').slice(0, 16);
    // ponytail: a named pipe on Windows, for the unit tests only; sandboxes need a Linux daemon.
    return process.platform === 'win32' ? `\\\\.\\pipe\\factory-egress-${name}` : join(this.o.dir, `${name}.sock`);
  }

  // TODO(dashboard): the journal goes to the base and the security log of the dashboard; a JSONL per run until then.
  journalPath(runId: string): string {
    if (!/^[\w.-]+$/.test(runId)) throw new Error(`egress: invalid run id ${runId}`);
    return join(this.o.dir, `${runId}.jsonl`);
  }

  /** The run's socket, listening; the same on a replay (the policy of the first open stays). */
  async open(runId: string, policy: EgressPolicy): Promise<string> {
    const path = this.socketPath(runId);
    this.journalPath(runId);
    if (this.runs.has(runId)) return path;
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') rmSync(path, { force: true }); // left by a crash
    const run: Run = { server: createServer((req, res) => this.forward(runId, policy, req, res)), sockets: new Set() };
    run.server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => this.tunnel(runId, policy, run, req, client, head));
    await new Promise<void>((ok, ko) => run.server.once('error', ko).listen(path, ok));
    // The sandbox runs under the daemon's uid: no one else on the host opens it.
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    this.runs.set(runId, run);
    return path;
  }

  /** Idempotent: an unknown run is ignored. */
  async close(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    for (const s of run.sockets) s.destroy();
    run.server.closeAllConnections();
    await new Promise<void>((ok) => run.server.close(() => ok()));
    if (process.platform !== 'win32') rmSync(this.socketPath(runId), { force: true });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.close(id)));
  }

  /** Where the daemon listens for the agent API, when `host:port` is its name in the sandbox. */
  private agent(host: string, port: number): { host: string; port: number } | undefined {
    const a = this.o.agentApi;
    return a && host === a.host && port === a.port ? a.to : undefined;
  }

  private journal(runId: string, e: Omit<EgressEntry, 'at'>): void {
    appendFileSync(this.journalPath(runId), `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
  }

  private tunnel(runId: string, policy: EgressPolicy, run: Run, req: IncomingMessage, client: Duplex, head: Buffer): void {
    const { hostname, port } = target(req.url ?? '');
    const base = { method: 'CONNECT', host: hostname };
    // Node's fetch (factory-agent) tunnels even an http:// URL.
    const agent = this.agent(hostname, port);
    const v = agent
      ? agentVerdict(policy)
      : check(hostname, port === 443 || policy.level === 'full' ? allowConnect(policy, hostname) : { ok: false, reason: `port ${port} refused: 443 only` });
    if (!v.ok) {
      this.journal(runId, { ...base, ok: false, reason: v.reason, up: 0, down: 0 });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    run.sockets.add(client);
    const up: Socket = agent ? connect(agent) : connect({ host: hostname, port, lookup: publicLookup });
    let open = false;
    up.on('connect', () => {
      open = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      client.pipe(up).pipe(client);
    });
    let done = false;
    const end = (err?: Error) => {
      if (done) return;
      done = true;
      run.sockets.delete(client);
      this.journal(runId, { ...base, ok: open, ...(err && !open ? { reason: err.message } : {}), up: up.bytesWritten, down: up.bytesRead });
      if (!open) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
      up.destroy();
    };
    up.on('error', end).on('close', () => end());
    client.on('error', () => end()).on('close', () => end());
  }

  private forward(runId: string, policy: EgressPolicy, req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error();
    } catch {
      res.writeHead(400).end('egress proxy: absolute http:// URL expected\n');
      return;
    }
    const method = req.method ?? 'GET';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || 80);
    const path = url.pathname + url.search;
    const agent = this.agent(host, port);
    const v: Verdict = agent
      ? agentVerdict(policy)
      : check(host, port === 80 || policy.level === 'full' ? allowRequest(policy, host, method, path) : { ok: false, reason: `port ${port} refused` });
    if (!v.ok) {
      this.journal(runId, { method, host, ok: false, reason: v.reason, up: 0, down: 0 });
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`egress proxy: ${v.reason}\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const opts = { method, path, headers };
    // Below full, the internet is reached in HTTPS only: `http://` is how the sandbox lets the proxy see the method.
    const out = agent
      ? httpRequest({ ...opts, ...agent })
      : policy.level === 'full'
        ? httpRequest({ ...opts, host, port, lookup: publicLookup })
        : httpsRequest({ ...opts, host, port: 443, servername: host, lookup: publicLookup });
    let up = 0;
    let down = 0;
    let failure: string | undefined;
    req.on('data', (c: Buffer) => (up += c.length));
    out.on('response', (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.on('data', (c: Buffer) => (down += c.length));
      r.pipe(res);
    });
    out.on('error', (err) => {
      failure = err.message;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`egress proxy: ${err.message}\n`);
      else res.destroy();
    });
    res.on('close', () => this.journal(runId, { method, host, ok: !failure, ...(failure ? { reason: failure } : {}), up, down }));
    req.pipe(out);
  }
}

/** The factory's own API: every method, at any level but none (a `verify` step calls nothing). */
function agentVerdict(policy: EgressPolicy): Verdict {
  return policy.level === 'none' ? { ok: false, reason: 'agent API not reachable at none' } : { ok: true };
}

/** An IP literal is checked here: `connect` skips the lookup for it. */
function check(host: string, v: Verdict): Verdict {
  if (v.ok && isIP(host) && isPrivate(host)) return { ok: false, reason: `${host} is a private address` };
  return v;
}

/** `host:port` of a CONNECT, IPv6 in brackets. */
function target(authority: string): { hostname: string; port: number } {
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(authority);
  return { hostname: m?.[1] ?? authority, port: Number(m?.[2] ?? 0) };
}
