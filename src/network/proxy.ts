import { createHash } from 'node:crypto';
import { lookup, type LookupAddress } from 'node:dns';
import { chmodSync, createWriteStream, mkdirSync, rmSync, type WriteStream } from 'node:fs';
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, connect, isIP, type LookupFunction, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { LeafIssuer, loadOrCreateCa, type FactoryCa } from './ca.js';
import { allowConnect, allowRequest, type EgressPolicy, type Verdict } from './levels.js';

/** One line of a run's egress journal: every request, allowed or refused (ORC-213). */
export interface EgressEntry {
  at: string;
  method: string;
  host: string;
  /** The path without its query (which can carry a token); none for a refused tunnel. */
  path?: string;
  ok: boolean;
  reason?: string;
  /** Bytes of the bodies sent and received; of the TLS records for the agent API's tunnel. */
  up: number;
  down: number;
}

export interface EgressProxyOptions {
  /** The runs' sockets and journals (`<home>/network`), the daemon's alone. */
  dir: string;
  /** The egress CA (`<home>/egress-ca`), made at the first open: its key never leaves the daemon. */
  caDir: string;
  /** The factory's agent API as the sandbox names it (`FACTORY_API`), and where the daemon listens for it. */
  agentApi?: { host: string; port: number; to: { host: string; port: number } };
  /** Where a journal that cannot be written is told; the run goes on. */
  log?: (message: string) => void;
  /** Tests only: the trust, the resolver and the port of the upstream connections (a local HTTPS server). */
  upstream?: { ca: string; lookup: LookupFunction; port: number };
}

interface Run {
  policy: EgressPolicy;
  /** The run's socket: HTTP proxy protocol. */
  server: Server;
  /** The decrypted requests of the run's tunnels. */
  mitm: Server;
  /** Tunnels outlive the HTTP servers' own bookkeeping: closed by hand. */
  sockets: Set<Duplex>;
  journal: WriteStream;
  closed: boolean;
}

/** Nothing reached through the proxy is the host's network, its engine's bridge or a cloud metadata service. */
const PRIVATE = new BlockList();
const V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
for (const [net, bits] of V4) PRIVATE.addSubnet(net, bits, 'ipv4');
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are checked against the IPv4 rules above; NAT64 and 6to4 embed any IPv4.
for (const [net, bits] of [['::', 127], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv6');
}

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

/** What a decrypted request was tunnelled to: the CONNECT's target, never its Host header. */
const targets = new WeakMap<object, { host: string; port: number }>();

/**
 * The factory's egress proxy (ORC-213): the only way out of a sandbox, which runs `--network none`
 * with this run's Unix socket mounted. One socket per run, so the journal knows the run without
 * trusting anything the sandbox sends. HTTP proxy protocol: a `CONNECT` to an allowed host is
 * decrypted with a leaf of the factory CA (which the sandbox trusts), each request checked (host,
 * method, path) and sent on over TLS, the upstream certificate verified; a plain HTTP request is
 * checked the same way and sent on in HTTPS.
 */
export class EgressProxy {
  private readonly runs = new Map<string, Run>();
  private ca?: FactoryCa;
  private issuer?: LeafIssuer;

  constructor(private readonly o: EgressProxyOptions) {}

  /** The CA certificate the sandboxes mount, made at the first call. */
  get caCertPath(): string {
    return this.leaves().ca.certPath;
  }

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

  /** Whether this process listens for the run: a container from before a restart has a dead socket. */
  isOpen(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** The run's socket, listening; the same on a replay (the policy of the first open stays). */
  async open(runId: string, policy: EgressPolicy): Promise<string> {
    const path = this.socketPath(runId);
    const journalPath = this.journalPath(runId);
    if (this.runs.has(runId)) return path;
    this.leaves();
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') rmSync(path, { force: true }); // left by a crash
    const journal = createWriteStream(journalPath, { flags: 'a' });
    journal.on('error', (err) => this.o.log?.(`egress: journal of ${runId} not written: ${err.message}`));
    const run: Run = { policy, server: createServer(), mitm: createServer(), sockets: new Set(), journal, closed: false };
    run.server.on('request', (req: IncomingMessage, res: ServerResponse) => this.forward(run, req, res));
    run.server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => this.tunnel(run, req, client, head));
    run.mitm.on('request', (req: IncomingMessage, res: ServerResponse) => this.decrypted(run, req, res));
    for (const s of [run.server, run.mitm]) {
      s.on('upgrade', (req: IncomingMessage, sock: Duplex) => {
        this.journal(run, { method: req.method ?? '?', host: targets.get(req.socket)?.host ?? req.headers.host ?? '?', ok: false, reason: 'protocol upgrade refused: HTTP/1.1 only' });
        sock.destroy();
      });
    }
    run.mitm.on('clientError', (err: Error & { code?: string }, sock: Duplex) => {
      this.journal(run, { method: 'CONNECT', host: targets.get(sock)?.host ?? '?', ok: false, reason: `${err.code ?? 'error'}: ${err.message}` });
      sock.destroy();
    });
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
    run.closed = true;
    for (const s of run.sockets) s.destroy();
    run.server.closeAllConnections();
    run.mitm.closeAllConnections();
    await Promise.all([
      new Promise<void>((ok) => run.server.close(() => ok())),
      new Promise<void>((ok) => run.journal.end(() => ok())),
    ]);
    if (process.platform !== 'win32') rmSync(this.socketPath(runId), { force: true });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.close(id)));
  }

  private leaves(): { ca: FactoryCa; issuer: LeafIssuer } {
    this.ca ??= loadOrCreateCa(this.o.caDir);
    this.issuer ??= new LeafIssuer(this.ca);
    return { ca: this.ca, issuer: this.issuer };
  }

  /** Where the daemon listens for the agent API, when `host:port` is its name in the sandbox. */
  private agent(host: string, port: number): { host: string; port: number } | undefined {
    const a = this.o.agentApi;
    return a && host === a.host && port === a.port ? a.to : undefined;
  }

  /** Never throws, never blocks: a journal that fails is logged, the run goes on. */
  private journal(run: Run, e: Omit<EgressEntry, 'at' | 'up' | 'down'> & Partial<Pick<EgressEntry, 'up' | 'down'>>): void {
    if (run.closed) return;
    run.journal.write(`${JSON.stringify({ at: new Date().toISOString(), up: 0, down: 0, ...e })}\n`);
  }

  private tunnel(run: Run, req: IncomingMessage, client: Duplex, head: Buffer): void {
    const { hostname: host, port } = target(req.url ?? '');
    client.on('error', () => client.destroy());
    // Node's fetch (factory-agent, the MCP) tunnels even an http:// URL: the agent API, in clear inside.
    const agent = this.agent(host, port);
    if (agent) return this.pipeToAgent(run, host, agent, client, head);
    const v = check(host, port === 443 || run.policy.level === 'full' ? allowConnect(run.policy, host) : { ok: false, reason: `port ${port} refused: 443 only` });
    if (!v.ok) {
      this.journal(run, { method: 'CONNECT', host, ok: false, reason: v.reason });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) client.unshift(head);
    const tls = new TLSSocket(client as Socket, {
      isServer: true,
      secureContext: this.leaves().issuer.context(host),
      // HTTP/1.1 alone: an h2-only client fails the handshake, and is journaled by clientError.
      ALPNCallback: ({ protocols }: { protocols: string[] }) => (protocols.includes('http/1.1') ? 'http/1.1' : undefined),
    } as ConstructorParameters<typeof TLSSocket>[1]);
    targets.set(tls, { host, port });
    run.sockets.add(tls);
    tls.on('close', () => run.sockets.delete(tls));
    run.mitm.emit('connection', tls);
  }

  private pipeToAgent(run: Run, host: string, agent: { host: string; port: number }, client: Duplex, head: Buffer): void {
    const v = agentVerdict(run.policy);
    if (!v.ok) {
      this.journal(run, { method: 'CONNECT', host, ok: false, reason: v.reason });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    run.sockets.add(client);
    const up: Socket = connect(agent);
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
      this.journal(run, { method: 'CONNECT', host, ok: open, ...(err && !open ? { reason: err.message } : {}), up: up.bytesWritten, down: up.bytesRead });
      if (!open) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
      up.destroy();
    };
    up.on('error', end).on('close', () => end());
    client.on('close', () => end());
  }

  /** A request read inside a tunnel: checked against the tunnel's host, whatever its Host header says. */
  private decrypted(run: Run, req: IncomingMessage, res: ServerResponse): void {
    const t = targets.get(req.socket);
    if (!t) return void res.destroy();
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const v = check(t.host, allowRequest(run.policy, t.host, method, path));
    if (!v.ok) return this.refuse(run, res, method, t.host, path, v.reason);
    const out = httpsRequest({
      host: t.host,
      port: this.o.upstream?.port ?? t.port,
      method,
      path,
      headers: { ...hopless(req), host: authority(t.host, t.port, 443) },
      ...(isIP(t.host) ? {} : { servername: t.host }),
      lookup: this.o.upstream?.lookup ?? publicLookup,
      ...(this.o.upstream ? { ca: this.o.upstream.ca } : {}),
    });
    this.relay(run, req, res, out, method, t.host, path);
  }

  /** A plain HTTP request (`GET http://host/path`): the agent API, or the internet in HTTPS below full. */
  private forward(run: Run, req: IncomingMessage, res: ServerResponse): void {
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
      ? agentVerdict(run.policy)
      : check(host, port === 80 || run.policy.level === 'full' ? allowRequest(run.policy, host, method, path) : { ok: false, reason: `port ${port} refused` });
    if (!v.ok) return this.refuse(run, res, method, host, path, v.reason);
    const full = run.policy.level === 'full';
    const opts = { method, path, headers: { ...hopless(req), host: agent ? authority(host, port, 80) : authority(host, full ? port : 443, full ? 80 : 443) } };
    const out = agent
      ? httpRequest({ ...opts, ...agent })
      : full
        ? httpRequest({ ...opts, host, port, lookup: publicLookup })
        : httpsRequest({ ...opts, host, port: 443, ...(isIP(host) ? {} : { servername: host }), lookup: this.o.upstream?.lookup ?? publicLookup, ...(this.o.upstream ? { ca: this.o.upstream.ca } : {}) });
    this.relay(run, req, res, out, method, host, path);
  }

  private refuse(run: Run, res: ServerResponse, method: string, host: string, path: string, reason: string): void {
    this.journal(run, { method, host, path: pathOf(path), ok: false, reason });
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`egress proxy: ${reason}\n`);
  }

  /** Streams both ways, journals once at the end; the upstream request dies with the client's. */
  private relay(run: Run, req: IncomingMessage, res: ServerResponse, out: ClientRequest, method: string, host: string, path: string): void {
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
    res.on('close', () => {
      if (!res.writableFinished) out.destroy();
      this.journal(run, { method, host, path: pathOf(path), ok: !failure, ...(failure ? { reason: failure } : {}), up, down });
    });
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

/** The request's headers, without the proxy's own; the Host is set by the caller to the host checked. */
function hopless(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const h = { ...req.headers };
  for (const k of ['proxy-connection', 'proxy-authorization', 'host']) delete h[k];
  return h;
}

/** `host[:port]` as a Host header, the default port left out. */
function authority(host: string, port: number, defaultPort: number): string {
  const h = isIP(host) === 6 ? `[${host}]` : host;
  return port === defaultPort ? h : `${h}:${port}`;
}

const pathOf = (path: string) => path.split('?')[0]!;

/** `host:port` of a CONNECT, IPv6 in brackets. */
function target(authority: string): { hostname: string; port: number } {
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(authority);
  return { hostname: m?.[1] ?? authority, port: Number(m?.[2] ?? 0) };
}
