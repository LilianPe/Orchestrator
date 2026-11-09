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
import { allowConnect, allowRequest, CLAUDE_API, CLAUDE_BETAS, CLAUDE_BODY_MAX, CLAUDE_READ_MS, CLAUDE_READS_MAX, CLAUDE_READS_PER_RUN, claudeBody, norm, type EgressPolicy, type Verdict } from './levels.js';

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

/**
 * A journal line that is no request nor refusal (ORC-337): a beta dropped, a model call throttled, cut for its slowness,
 * or whose client went away. Kept in the journal, out of the security log's requests and refusals.
 */
export interface EgressNote {
  at: string;
  kind: 'note';
  method: string;
  host: string;
  path?: string;
  note: string;
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
  /** The Claude token of the runs `open` opens (ORC-337): the proxy in the daemon's process. The `proxy` service gets each run's from the daemon (`openRun`). */
  claudeToken?: () => string | undefined;
  /** Tests only: the trust, the resolver and the port of the upstream connections (a local HTTPS server). */
  upstream?: { ca: string; lookup: LookupFunction; port: number };
  /** Tests only: how long a model call's body may take, `CLAUDE_READ_MS` otherwise. */
  claudeReadMs?: number;
}

interface Run {
  policy: EgressPolicy;
  /** Set on its requests to the Claude API in place of the client's (ORC-337): the sandbox never holds it. */
  claudeToken: string | undefined;
  /** Its model calls held, read or being sent on (ORC-337), against `CLAUDE_READS_PER_RUN`. */
  reading: number;
  /** The `anthropic-beta` values dropped already: each is noted once, `DROPPED_BETAS_LISTED` at most. */
  droppedBetas: Set<string>;
  /** Past that bound, noted once. */
  betasUnlisted: boolean;
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

/** The dropped `anthropic-beta` values a run's journal lists (ORC-337). */
const DROPPED_BETAS_LISTED = 64;

/** What a cut call's client may still send before its socket goes, so that it reads the answer rather than a reset (ORC-337). */
const CUT_DRAIN_BYTES = 1024 * 1024;
const CUT_DRAIN_MS = 5000;

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
export const PIPE = process.platform === 'win32';

/** HTTP/1.1 alone: an h2-only client fails the handshake, and is journaled by clientError. */
const ALPN = ({ protocols }: { protocols: string[] }) => (protocols.includes('http/1.1') ? 'http/1.1' : undefined);

const samePolicy = (a: EgressPolicy, b: EgressPolicy) => a.level === b.level && a.allow.length === b.allow.length && a.allow.every((h, i) => h === b.allow[i]);

/** The journal of a run under the proxy's directory: the daemon reads it there, whichever process wrote it (ORC-296). */
export function egressJournalPath(dir: string, runId: string): string {
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`egress: invalid run id ${runId}`);
  return join(dir, `${runId}.jsonl`);
}

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
  /** Model calls held, all runs together (ORC-337), against `CLAUDE_READS_MAX`. */
  private reading = 0;
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

  /** A JSONL per run, read into the base when the run's sandbox is destroyed (ORC-296), purged at 30 days. */
  journalPath(runId: string): string {
    return egressJournalPath(this.o.dir, runId);
  }

  /** Whether this process listens for the run: a container from before a restart waits on a socket that is gone, until `open`. */
  isOpen(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * The run's socket, listening; the same on a replay or a concurrent call. Another policy for an
   * open run is refused: the container's mount holds this socket, it cannot be swapped under it.
   * Its model calls get the `claudeToken` option's token.
   */
  open(runId: string, policy: EgressPolicy): Promise<string> {
    return this.openRun(runId, policy, this.o.claudeToken?.());
  }

  /** `open`, the run's model calls getting `claudeToken`, none when undefined (ORC-337): the run's own, as the daemon hands it to the `proxy` service. */
  async openRun(runId: string, policy: EgressPolicy, claudeToken: string | undefined): Promise<string> {
    const path = this.socketPath(runId);
    const journalPath = this.journalPath(runId);
    const existing = this.runs.get(runId);
    if (existing) {
      if (!samePolicy(existing.policy, policy)) {
        throw new Error(`egress: run ${runId} is open at ${existing.policy.level} [${existing.policy.allow.join(', ')}], asked ${policy.level} [${policy.allow.join(', ')}]`);
      }
      await existing.ready;
      // A daemon restarted with another account: the next model calls get it (ORC-337).
      existing.claudeToken = claudeToken;
      return path;
    }
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    const journal = createWriteStream(journalPath, { flags: 'a' });
    journal.on('error', (err) => this.o.log?.(`egress: journal of ${runId} not written: ${err.message}`));
    const run: Run = { policy, claudeToken, reading: 0, droppedBetas: new Set(), betasUnlisted: false, ready: Promise.resolve(), server: createServer(), mitm: createServer(), sockets: new Set(), journal, inflight: 0, closed: false };
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

  /**
   * Idempotent. What was in flight is journaled before the journal ends. The run's socket folder goes with it, an unknown
   * run's too (one a daemon before this one opened); `keep`: it stays, the run's container still mounting it, for the
   * next daemon to listen in again (ORC-344).
   */
  async close(runId: string, { keep = false }: { keep?: boolean } = {}): Promise<void> {
    const folder = PIPE || keep ? undefined : dirname(this.socketPath(runId));
    const run = this.runs.get(runId);
    if (!run) {
      if (folder) rmSync(folder, { recursive: true, force: true });
      return;
    }
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
    if (folder) rmSync(folder, { recursive: true, force: true });
  }

  /** `keep`: a clean shutdown, or the daemon gone, whose runs go on in their containers (`close`). */
  async closeAll(o: { keep?: boolean } = {}): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.close(id, o)));
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

  /** A note of the run's journal (`EgressNote`): never throws, never blocks. */
  private note(run: Run, method: string, host: string, path: string, note: string): void {
    if (run.closed) return;
    run.journal.write(`${JSON.stringify({ at: new Date().toISOString(), kind: 'note', method, host, path: pathOf(path), note })}\n`);
  }

  /** Something of the run under way: close() waits for its release (idempotent). */
  private hold(run: Run): () => void {
    run.inflight++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--run.inflight === 0) run.drained?.();
    };
  }

  /** One request or tunnel under way: its `done` journals it once, and lets close() finish. */
  private track(run: Run, entry: (failure?: string) => Omit<EgressEntry, 'at'>): (failure?: string) => void {
    const release = this.hold(run);
    let done = false;
    return (failure) => {
      if (done) return;
      done = true;
      this.journal(run, entry(failure));
      release();
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
    // A path alone: an absolute URL would go upstream as is, its authority naming a host other than the one checked (ORC-219).
    const v = path.startsWith('/') ? check(t.host, allowRequest(run.policy, t.host, method, path)) : { ok: false as const, reason: 'request target refused: not a path' };
    if (!v.ok) return this.refuse(run, res, method, t.host, path, v.reason);
    this.readClaudeBody(run, req, res, method, t.host, path, (body, sent) =>
      this.guarded(run, res, method, t.host, path, sent, () => {
        const out = httpsRequest({ ...this.tlsTo(t.host, t.port), method, path, headers: { ...this.upstreamHeaders(run, t.host, req, method, path, body), host: authority(t.host, t.port, 443) } });
        this.relay(run, req, res, out, method, t.host, path, body, sent);
      }),
    );
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
    this.readClaudeBody(run, req, res, method, host, path, (body, sent) =>
      this.guarded(run, res, method, host, path, sent, () => {
        // Below full the port is 80 (checked above), so the Host is the bare host either way.
        const opts = { method, path, headers: { ...this.upstreamHeaders(run, host, req, method, path, body), host: authority(host, port, 80) } };
        let out: ClientRequest;
        if (agent) out = httpRequest({ ...opts, ...agent });
        else if (run.policy.level === 'full') out = httpRequest({ ...opts, host, port, lookup: publicLookup });
        else out = httpsRequest({ ...opts, ...this.tlsTo(host, 443) });
        this.relay(run, req, res, out, method, host, path, body, sent);
      }),
    );
  }

  /**
   * Sends a checked request on; whatever throws on the way (a header Node refuses, ORC-337) is answered 502 and
   * journaled, never thrown out of the server, which would take the proxy down, and the daemon with it outside compose.
   */
  private guarded(run: Run, res: ServerResponse, method: string, host: string, path: string, sent: (() => void) | undefined, go: () => void): void {
    try {
      go();
    } catch (err) {
      sent?.();
      const reason = `not sent on: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      this.journal(run, { method, host, path: pathOf(path), ok: false, reason });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`egress proxy: ${reason}\n`);
      else res.destroy();
    }
  }

  /** Where a checked request goes over TLS: the host's real certificate verified, no private address. */
  private tlsTo(host: string, port: number) {
    const u = this.o.upstream;
    return { host, port: u?.port ?? port, ...(isIP(host) ? {} : { servername: host }), lookup: u?.lookup ?? publicLookup, ...(u ? { ca: u.ca } : {}) };
  }

  /**
   * A model call (a POST to the Claude API below `full`) is read whole, up to `CLAUDE_BODY_MAX` and within
   * `CLAUDE_READ_MS`, and checked before it goes on with the factory's token (ORC-337); what goes on is the call as
   * checked (`claudeBody`). It holds a place, of the run's and the proxy's, from its first byte until it is sent on:
   * the bound on the memory. Nothing it holds can throw out of here. Any other request streams.
   */
  private readClaudeBody(run: Run, req: IncomingMessage, res: ServerResponse, method: string, host: string, path: string, send: (body?: Buffer, sent?: () => void) => void): void {
    if (!isModelApi(run, host) || method !== 'POST') return send();
    const refuse = (reason: string, status?: number) => this.refuse(run, res, method, host, path, reason, status);
    const note = (text: string) => this.note(run, method, host, path, text);
    /**
     * Answered with `Connection: close`: once the answer is flushed the server half-closes, and what the client still
     * sends is read and dropped, up to `CUT_DRAIN_BYTES` or `CUT_DRAIN_MS`, before the socket goes. Closed outright
     * under a client still sending, the connection would be reset, the answer lost before the client reads it.
     */
    const cut = (status: number, text: string) => {
      const socket = req.socket;
      // The server's own close once the answer is out (`destroySoon`), made a linger.
      socket.destroySoon = () => {
        socket.end();
        let left = CUT_DRAIN_BYTES;
        socket.on('data', (c: Buffer) => {
          left -= c.length;
          if (left < 0) socket.destroy();
        });
        socket.once('end', () => socket.destroy());
        setTimeout(() => socket.destroy(), CUT_DRAIN_MS).unref();
        socket.resume();
      };
      req.resume();
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(`egress proxy: ${text}\n`);
    };
    const encoding = req.headers['content-encoding'];
    if (encoding !== undefined && encoding !== 'identity') return refuse(`Claude API body refused: content-encoding ${encoding}`);
    const tooBig = `Claude API body refused: over ${CLAUDE_BODY_MAX} bytes`;
    if (Number(req.headers['content-length'] ?? 0) > CLAUDE_BODY_MAX) {
      this.journal(run, { method, host, path: pathOf(path), ok: false, reason: tooBig });
      return cut(413, tooBig);
    }
    if (run.reading >= CLAUDE_READS_PER_RUN || this.reading >= CLAUDE_READS_MAX) {
      note('model call throttled: too many held at once (429)');
      return cut(429, 'too many model calls held at once, retry');
    }
    run.reading++;
    this.reading++;
    const release = this.hold(run);
    let freed = false;
    /** Its place given back: refused, cut, gone, or sent on (idempotent). */
    const free = () => {
      if (freed) return;
      freed = true;
      clearTimeout(deadline);
      run.reading--;
      this.reading--;
      release();
    };
    let reading = true;
    let chunks: Buffer[] = [];
    let size = 0;
    const deadline = setTimeout(() => {
      if (!reading) return;
      reading = false;
      chunks = [];
      free();
      note('model call cut: its body too slow to come in');
      cut(408, 'body too slow');
    }, this.o.claudeReadMs ?? CLAUDE_READ_MS);
    deadline.unref();
    req.on('data', (c: Buffer) => {
      if (!reading) return;
      size += c.length;
      if (size <= CLAUDE_BODY_MAX) return void chunks.push(c);
      reading = false;
      chunks = [];
      free();
      this.journal(run, { method, host, path: pathOf(path), ok: false, reason: tooBig });
      cut(413, tooBig);
    });
    req.on('end', () => {
      if (!reading) return;
      reading = false;
      try {
        let raw: Buffer | undefined = Buffer.concat(chunks);
        chunks = [];
        const checked = claudeBody(raw);
        raw = undefined;
        if (!checked.ok) {
          free();
          return refuse(checked.reason);
        }
        send(checked.body, free);
      } catch (err) {
        // Whatever slipped by the checks: refused, never thrown out of the server.
        free();
        if (!res.headersSent) refuse(`Claude API body refused: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), 400);
        else res.destroy();
      }
    });
    const gone = () => {
      if (!reading) return;
      reading = false;
      chunks = [];
      free();
      note('model call dropped: its client went away while sending the body');
    };
    req.on('error', gone).on('close', gone);
  }

  /**
   * What goes upstream of the request's headers. To the Claude API below `full` (ORC-337): never the client's
   * credentials, the run's token in their place, or none; only the betas Claude Code sends, each other one journaled
   * once per run; the length of a body read whole. At `full` (a setup, which runs no agent) nothing is changed.
   */
  private upstreamHeaders(run: Run, host: string, req: IncomingMessage, method: string, path: string, body: Buffer | undefined): Record<string, string | string[] | undefined> {
    const h = hopless(req);
    if (!isModelApi(run, host)) return h;
    delete h['authorization'];
    delete h['x-api-key'];
    const sent = String(h['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    delete h['anthropic-beta'];
    for (const b of sent.filter((b) => !CLAUDE_BETAS.has(b) && !run.droppedBetas.has(b))) {
      // Bounded: a client sending a new value with each call cannot grow the run's memory, nor its journal.
      if (run.droppedBetas.size >= DROPPED_BETAS_LISTED) {
        if (!run.betasUnlisted) this.note(run, method, host, path, `more anthropic-beta values dropped: past ${DROPPED_BETAS_LISTED}, they are not listed`);
        run.betasUnlisted = true;
        break;
      }
      run.droppedBetas.add(b);
      this.note(run, method, host, path, `anthropic-beta ${b} dropped, the request went on without it`);
    }
    const betas = sent.filter((b) => CLAUDE_BETAS.has(b));
    if (body) {
      delete h['transfer-encoding'];
      h['content-length'] = String(body.length);
    }
    return { ...h, ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}), ...(run.claudeToken ? { authorization: `Bearer ${run.claudeToken}` } : {}) };
  }

  private refuse(run: Run, res: ServerResponse, method: string, host: string, path: string, reason: string, status = 403): void {
    this.journal(run, { method, host, path: pathOf(path), ok: false, reason });
    res.writeHead(status, { 'content-type': 'text/plain' }).end(`egress proxy: ${reason}\n`);
  }

  /**
   * Streams both ways and journals once: by the response's pipeline once there is one (an upstream
   * cut mid-body ends the client's response and is a failure), by the request's errors before. The
   * upstream request dies with the client's.
   */
  private relay(run: Run, req: IncomingMessage, res: ServerResponse, out: ClientRequest, method: string, host: string, path: string, body?: Buffer, sent?: () => void): void {
    let up = body?.length ?? 0;
    let down = 0;
    let responded = false;
    const finished = this.track(run, (failure) => ({ method, host, path: pathOf(path), ok: !failure, ...(failure ? { reason: failure } : {}), up, down }));
    const done = (failure?: string) => {
      sent?.();
      finished(failure);
    };
    // A model call read whole gives its place back once written upstream: its buffer is no longer held. Its response
    // streams, held by nothing; a run's calls in flight are not bounded, only those read.
    out.once('finish', () => sent?.());
    if (!body) req.on('data', (c: Buffer) => (up += c.length));
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
    if (body) out.end(body);
    else req.pipe(out);
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

/** The Claude API, below `full`: where the proxy signs the requests with the run's token and reads them (ORC-337). */
function isModelApi(run: Run, host: string): boolean {
  return run.policy.level !== 'full' && CLAUDE_API.includes(host);
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
