import { createHash } from 'node:crypto';
import { lookup, type LookupAddress } from 'node:dns';
import { chmodSync, createWriteStream, mkdirSync, rmSync, type WriteStream } from 'node:fs';
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, connect, isIP, type LookupFunction, type NetConnectOpts, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { pipeline, type Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { LeafIssuer, loadOrCreateCa, type FactoryCa } from './ca.js';
import { allowConnect, allowRequest, norm, type EgressPolicy, type Verdict } from './levels.js';

/** One line of a run's egress journal: every request, allowed or refused (ORC-213). */
export interface EgressEntry {
  at: string;
  method: string;
  host: string;
  /** For a plain TCP tunnel (the agent API, a non-443 port at full). */
  port?: number;
  /** The path without its query (which can carry a token); none for a tunnel. */
  path?: string;
  ok: boolean;
  reason?: string;
  /** Bytes of the bodies sent and received; of the whole stream for a plain TCP tunnel. */
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
  /** Listening once it resolves; a concurrent open waits on it. */
  ready: Promise<void>;
  /** The run's socket: HTTP proxy protocol. */
  server: Server;
  /** The decrypted requests of the run's tunnels. */
  mitm: Server;
  /** Tunnels outlive the HTTP servers' own bookkeeping: closed by hand. */
  sockets: Set<Duplex>;
  journal: WriteStream;
  /** Requests and plain tunnels not journaled yet: close() waits for their line. */
  inflight: number;
  drained?: () => void;
  closed: boolean;
}

/** Nothing reached through the proxy is the host's network, its engine's bridge or a cloud metadata service. */
const PRIVATE = new BlockList();
const V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
for (const [net, bits] of V4) PRIVATE.addSubnet(net, bits, 'ipv4');
/**
 * IPv4-mapped addresses (::ffff:a.b.c.d) go through the IPv4 rules above (BlockList maps them). The
 * other forms that embed an IPv4 are refused whole: IPv4-compatible (::/96), IPv4-translated
 * (::ffff:0:0:0/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16); and site-local, discard, ULA, link-local, multicast.
 */
const V6: [string, number][] = [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];
for (const [net, bits] of V6) PRIVATE.addSubnet(net, bits, 'ipv6');

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
/** Tunnels that carried a request: their end is that request's, journaled with it. */
const served = new WeakSet<object>();

/** ponytail: Windows named pipes, for the unit tests only; sandboxes need a Linux daemon (a Unix socket file). */
const PIPE = process.platform === 'win32';

/** HTTP/1.1 alone: an h2-only client fails the handshake, and is journaled by clientError. */
const ALPN = ({ protocols }: { protocols: string[] }) => (protocols.includes('http/1.1') ? 'http/1.1' : undefined);

const samePolicy = (a: EgressPolicy, b: EgressPolicy) => a.level === b.level && a.allow.length === b.allow.length && a.allow.every((h, i) => h === b.allow[i]);

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
  /** The CA and its leaves, made at the first open. */
  private tlsReady?: Promise<void>;
  private tls?: { ca: FactoryCa; issuer: LeafIssuer };
  /** The agent API's name in the sandbox, normalised as every CONNECT host is. */
  private readonly agentHost?: string;

  constructor(private readonly o: EgressProxyOptions) {
    if (o.agentApi) this.agentHost = norm(o.agentApi.host);
  }

  /** The CA certificate the sandboxes mount: there once a run was opened. */
  get caCertPath(): string {
    if (!this.tls) throw new Error('egress: no run opened yet, so no CA');
    return this.tls.ca.certPath;
  }

  socketPath(runId: string): string {
    // Hashed: a Unix socket path is capped near 108 bytes. In a dir of its own, the sandbox's mount:
    // bound anew after a daemon restart, the living container sees it (ORC-220).
    const name = createHash('sha256').update(`${this.o.dir}\0${runId}`).digest('hex').slice(0, 16);
    return PIPE ? `\\\\.\\pipe\\factory-egress-${name}` : join(this.o.dir, name, 'egress.sock');
  }

  // TODO(dashboard): the journal goes to the base and the security log of the dashboard; a JSONL per run until then.
  journalPath(runId: string): string {
    if (!/^[\w.-]+$/.test(runId)) throw new Error(`egress: invalid run id ${runId}`);
    return join(this.o.dir, `${runId}.jsonl`);
  }

  /** Whether this process listens for the run: a container from before a restart waits on a socket that is gone, until `open`. */
  isOpen(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * The run's socket, listening; the same on a replay or a concurrent call. Another policy for an
   * open run is refused: the container's mount holds this socket, it cannot be swapped under it.
   */
  async open(runId: string, policy: EgressPolicy): Promise<string> {
    const path = this.socketPath(runId);
    const journalPath = this.journalPath(runId);
    const existing = this.runs.get(runId);
    if (existing) {
      if (!samePolicy(existing.policy, policy)) {
        throw new Error(`egress: run ${runId} is open at ${existing.policy.level} [${existing.policy.allow.join(', ')}], asked ${policy.level} [${policy.allow.join(', ')}]`);
      }
      await existing.ready;
      return path;
    }
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    const journal = createWriteStream(journalPath, { flags: 'a' });
    journal.on('error', (err) => this.o.log?.(`egress: journal of ${runId} not written: ${err.message}`));
    const run: Run = { policy, ready: Promise.resolve(), server: createServer(), mitm: createServer(), sockets: new Set(), journal, inflight: 0, closed: false };
    this.runs.set(runId, run);
    run.ready = this.listen(run, path).catch((err: unknown) => {
      this.runs.delete(runId);
      run.closed = true;
      journal.end();
      throw err;
    });
    await run.ready;
    return path;
  }

  private async listen(run: Run, path: string): Promise<void> {
    this.tlsReady ??= (async () => {
      const ca = loadOrCreateCa(this.o.caDir);
      this.tls = { ca: await ca, issuer: await LeafIssuer.create(ca) };
    })();
    await this.tlsReady;
    if (!PIPE) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      rmSync(path, { force: true }); // left by a crash
    }
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
      if (!served.has(sock)) this.journal(run, { method: 'CONNECT', host: targets.get(sock)?.host ?? '?', ok: false, reason: `${err.code ?? 'error'}: ${err.message}` });
      sock.destroy();
    });
    await new Promise<void>((ok, ko) => run.server.once('error', ko).listen(path, ok));
    // The sandbox runs under the daemon's uid: no one else on the host opens it.
    if (!PIPE) chmodSync(path, 0o600);
  }

  /** Idempotent: an unknown run is ignored. What was in flight is journaled before the journal ends. */
  async close(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    await run.ready.catch(() => {});
    for (const s of run.sockets) s.destroy();
    run.server.closeAllConnections();
    run.mitm.closeAllConnections();
    if (run.inflight) {
      await new Promise<void>((ok) => {
        run.drained = ok;
        setTimeout(ok, 2000).unref();
      });
    }
    run.closed = true;
    await Promise.all([
      new Promise<void>((ok) => run.server.close(() => ok())),
      new Promise<void>((ok) => run.journal.end(() => ok())),
    ]);
    if (!PIPE) rmSync(dirname(this.socketPath(runId)), { recursive: true, force: true });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.close(id)));
  }

  /** Where the daemon listens for the agent API, when `host:port` is its name in the sandbox. */
  private agent(host: string, port: number): { host: string; port: number } | undefined {
    const a = this.o.agentApi;
    return a && host === this.agentHost && port === a.port ? a.to : undefined;
  }

  /** Never throws, never blocks: a journal that fails is logged, the run goes on. */
  private journal(run: Run, e: Omit<EgressEntry, 'at' | 'up' | 'down'> & Partial<Pick<EgressEntry, 'up' | 'down'>>): void {
    if (run.closed) return;
    run.journal.write(`${JSON.stringify({ at: new Date().toISOString(), up: 0, down: 0, ...e })}\n`);
  }

  /** One request or tunnel under way: its `done` journals it once, and lets close() finish. */
  private track(run: Run, entry: (failure?: string) => Omit<EgressEntry, 'at'>): (failure?: string) => void {
    run.inflight++;
    let done = false;
    return (failure) => {
      if (done) return;
      done = true;
      this.journal(run, entry(failure));
      if (--run.inflight === 0) run.drained?.();
    };
  }

  private tunnel(run: Run, req: IncomingMessage, client: Duplex, head: Buffer): void {
    const { hostname: host, port } = target(req.url ?? '');
    client.on('error', () => client.destroy());
    // Node's fetch (factory-agent, the MCP) tunnels even an http:// URL: the agent API, in clear inside.
    const agent = this.agent(host, port);
    if (agent) {
      const v = agentVerdict(run.policy);
      if (!v.ok) return this.refuseTunnel(run, client, host, v.reason);
      return this.pipe(run, client, head, host, port, agent);
    }
    const full = run.policy.level === 'full';
    const v = check(host, port === 443 || full ? allowConnect(run.policy, host) : { ok: false, reason: `port ${port} refused: 443 only` });
    if (!v.ok) return this.refuseTunnel(run, client, host, v.reason);
    // At full, another port is any protocol: piped as is, the private addresses still out of reach.
    if (port !== 443) return this.pipe(run, client, head, host, port, { host, port, lookup: publicLookup });
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) client.unshift(head);
    const tls = new TLSSocket(client as Socket, {
      isServer: true,
      secureContext: this.tls!.issuer.context(host),
      ALPNCallback: ALPN,
    } as ConstructorParameters<typeof TLSSocket>[1]);
    targets.set(tls, { host, port });
    run.sockets.add(tls);
    tls.on('close', () => run.sockets.delete(tls));
    run.mitm.emit('connection', tls);
  }

  private refuseTunnel(run: Run, client: Duplex, host: string, reason: string): void {
    this.journal(run, { method: 'CONNECT', host, ok: false, reason });
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  }

  /** A plain TCP tunnel: the bytes counted, not read. */
  private pipe(run: Run, client: Duplex, head: Buffer, host: string, port: number, dest: NetConnectOpts): void {
    run.sockets.add(client);
    const up: Socket = connect(dest);
    let open = false;
    const done = this.track(run, (failure) => ({ method: 'CONNECT', host, port, ok: open, ...(failure && !open ? { reason: failure } : {}), up: up.bytesWritten, down: up.bytesRead }));
    up.on('connect', () => {
      open = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      client.pipe(up).pipe(client);
    });
    const end = (err?: Error) => {
      run.sockets.delete(client);
      done(err?.message);
      if (!open && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
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
    served.add(req.socket);
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const v = check(t.host, allowRequest(run.policy, t.host, method, path));
    if (!v.ok) return this.refuse(run, res, method, t.host, path, v.reason);
    const out = httpsRequest({ ...this.tlsTo(t.host, t.port), method, path, headers: { ...hopless(req), host: authority(t.host, t.port, 443) } });
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
    const host = norm(url.hostname.replace(/^\[|\]$/g, ''));
    const port = Number(url.port || 80);
    const path = url.pathname + url.search;
    const agent = this.agent(host, port);
    const v: Verdict = agent
      ? agentVerdict(run.policy)
      : check(host, port === 80 || run.policy.level === 'full' ? allowRequest(run.policy, host, method, path) : { ok: false, reason: `port ${port} refused` });
    if (!v.ok) return this.refuse(run, res, method, host, path, v.reason);
    // Below full the port is 80 (checked above), so the Host is the bare host either way.
    const opts = { method, path, headers: { ...hopless(req), host: authority(host, port, 80) } };
    let out: ClientRequest;
    if (agent) out = httpRequest({ ...opts, ...agent });
    else if (run.policy.level === 'full') out = httpRequest({ ...opts, host, port, lookup: publicLookup });
    else out = httpsRequest({ ...opts, ...this.tlsTo(host, 443) });
    this.relay(run, req, res, out, method, host, path);
  }

  /** Where a checked request goes over TLS: the host's real certificate verified, no private address. */
  private tlsTo(host: string, port: number) {
    const u = this.o.upstream;
    return { host, port: u?.port ?? port, ...(isIP(host) ? {} : { servername: host }), lookup: u?.lookup ?? publicLookup, ...(u ? { ca: u.ca } : {}) };
  }

  private refuse(run: Run, res: ServerResponse, method: string, host: string, path: string, reason: string): void {
    this.journal(run, { method, host, path: pathOf(path), ok: false, reason });
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`egress proxy: ${reason}\n`);
  }

  /**
   * Streams both ways and journals once: by the response's pipeline once there is one (an upstream
   * cut mid-body ends the client's response and is a failure), by the request's errors before. The
   * upstream request dies with the client's.
   */
  private relay(run: Run, req: IncomingMessage, res: ServerResponse, out: ClientRequest, method: string, host: string, path: string): void {
    let up = 0;
    let down = 0;
    let responded = false;
    const done = this.track(run, (failure) => ({ method, host, path: pathOf(path), ok: !failure, ...(failure ? { reason: failure } : {}), up, down }));
    req.on('data', (c: Buffer) => (up += c.length));
    out.on('response', (r) => {
      responded = true;
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.on('data', (c: Buffer) => (down += c.length));
      pipeline(r, res, (err) => done(err?.message));
    });
    out.on('error', (err) => {
      if (responded) return; // the pipeline has it
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`egress proxy: ${err.message}\n`);
      done(err.message);
    });
    res.on('close', () => {
      if (res.writableFinished) return;
      out.destroy();
      if (!responded) done('client closed before the response');
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

/** `host:port` of a CONNECT, IPv6 in brackets, the host normalised. */
function target(authority: string): { hostname: string; port: number } {
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(authority);
  return { hostname: norm(m?.[1] ?? authority), port: Number(m?.[2] ?? 0) };
}
