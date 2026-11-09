// What a hijacked agent would try from its sandbox, one probe per run, each printing one line: what it got.
// Copied into the sandbox's workspace by egress.ts; run there with the sandbox's node.
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const RELAY = { host: '127.0.0.1', port: 3128 };
const [cmd, ...args] = process.argv.slice(2);
const done = (line) => {
  console.log(line);
  process.exit(0);
};
const failed = (e) => done(`ERR ${e?.cause?.code ?? e?.code ?? e?.message ?? e}`);
setTimeout(() => done('TIMEOUT'), 15_000);

/** The status codes of the HTTP/1.1 answers in `text`, in order. */
const statuses = (text) => [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]).join(' ') || 'NONE';

/** A socket to the relay that has sent `CONNECT target`: the proxy's answer line, then the socket. */
function connectThrough(target, extra = '') {
  return new Promise((ok, ko) => {
    const s = net.connect(RELAY, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`));
    s.once('error', ko);
    s.once('data', (d) => ok({ line: d.toString('latin1').split('\r\n')[0], socket: s }));
  });
}

const probes = {
  /** A TCP connection of its own, bypassing the proxy. */
  tcp: ([host, port]) => net.connect({ host, port: Number(port) }, () => done('OPEN')).on('error', failed),
  /** A Unix socket; `@name` is an abstract one. */
  unix: ([path]) => net.connect(path.startsWith('@') ? `\0${path.slice(1)}` : path, () => done('OPEN')).on('error', failed),
  udp: ([host, port]) => {
    const s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    s.send('x', Number(port), host, (e) => (e ? failed(e) : done('SENT')));
  },
  /** getaddrinfo, as any tool resolves a name. */
  lookup: ([name]) => dns.lookup(name, (e, a) => (e ? failed(e) : done(`RESOLVED ${a}`))),
  /** A DNS query of its own to `server`, UDP then TCP as the resolver falls back. */
  query: ([name, server]) => {
    const r = new dns.Resolver({ timeout: 3000, tries: 1 });
    r.setServers([server]);
    r.resolve4(name, (e, a) => (e ? failed(e) : done(`RESOLVED ${a}`)));
  },
  /** Node's fetch through the proxy (NODE_USE_ENV_PROXY): the status, and the URL it ended on, once the body is read. */
  fetch: ([url, method = 'GET', body]) =>
    fetch(url, { method, body, headers: { authorization: 'token the-agent-s-own-token' } }).then((r) => r.arrayBuffer().then(() => done(`${r.status} ${r.url}`)), failed),
  /** Raw bytes to the relay (a JSON string, escapes and all): the first line of what comes back. */
  raw: ([json]) => {
    const s = net.connect(RELAY, () => s.write(JSON.parse(json)));
    let got = '';
    s.on('data', (d) => (got += d.toString('latin1')));
    s.on('error', failed);
    s.on('close', () => done(got ? got.split('\r\n')[0] : 'CLOSED'));
  },
  /** `CONNECT target` with extra header lines (a JSON string): the proxy's answer line. */
  connect: ([target, extra = '""']) => connectThrough(target, JSON.parse(extra)).then(({ line }) => done(line), failed),
  /**
   * Requests (a JSON list of raw HTTP/1.1 requests) sent one after the other on one tunnel to `host:443`, over TLS with
   * the factory CA, `servername` and `alpn` as given: the status of each answer, in order.
   */
  tunnel: async ([host, json, servername = host, alpn = 'http/1.1']) => {
    const { line, socket } = await connectThrough(`${host}:443`).catch(failed);
    if (!line.includes(' 200 ')) return done(`CONNECT ${line}`);
    const ca = readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8');
    // Another servername than the tunnel's: its certificate cannot match, the agent checks nothing.
    const t = tls.connect({ socket, ca, servername, ALPNProtocols: [alpn], rejectUnauthorized: servername === host });
    let got = '';
    t.on('secureConnect', () => t.write(JSON.parse(json).join('')));
    t.on('data', (d) => (got += d.toString('latin1')));
    t.on('error', (e) => done(got ? statuses(got) : `TLS ${e.code ?? e.message}`));
    t.on('close', () => done(statuses(got)));
  },
};

if (!probes[cmd]) done(`unknown probe ${cmd}`);
else probes[cmd](args);
