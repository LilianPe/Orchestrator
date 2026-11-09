import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { WORKSPACE_TARGET, type NetworkLevel, type Sandbox } from '../../src/adapters/sandbox/types.js';
import { EgressProxy, type EgressEntry } from '../../src/network/proxy.js';
import { httpsUpstream, toLocal } from '../helpers/egress-upstream.js';
import { enabled, useSandboxes } from './helpers.js';

/**
 * The egress proxy of isolation n° 3 to 6 (ORC-219): the real `EgressProxy` in this process, as the daemon runs it, its
 * run's socket mounted in a real sandbox under `--network none`. Linux only: elsewhere a host socket does not cross into
 * the engine's VM (network.test.ts tells why, and runs a helper container there instead).
 */
export const egressRunnable = enabled && process.platform === 'linux';

/** The agent API as the sandbox names it: the proxy relays it to a stand-in on this host's loopback. */
export const AGENT_API = 'http://host.docker.internal:4101';

/** A request that reached the stand-in internet: the tunnel's name (SNI), the Host it was sent with, method and path. */
interface Seen {
  sni: string;
  host: string;
  method: string;
  url: string;
}

/**
 * Every upstream the proxy reaches over TLS is a local stand-in, whatever its name, which records what reaches it and the
 * names the proxy resolved: nothing leaves the host. `answer` may answer a request itself (a redirect); 200 otherwise.
 */
interface EgressOptions {
  image?: string;
  answer?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

export function useEgress(name: string, o: EgressOptions = {}) {
  let dir = '';
  let proxy: EgressProxy;
  let agent: Server;
  let upstream: HttpsServer;
  /** What reached the stand-in internet, the names the proxy resolved for it, and what reached the agent API stand-in. */
  const seen: Seen[] = [];
  const lookups: string[] = [];
  const agentHits: string[] = [];
  /** The agent API stand-in's real address, on this host's loopback: only its sandbox name may lead there. */
  let agentPort = 0;
  const sbx = useSandboxes(name, {
    ...(o.image ? { image: o.image } : {}),
    egress: {
      open: (id, policy) => proxy.open(id, policy),
      close: (id) => proxy.close(id),
      isOpen: (id) => proxy.isOpen(id),
      get caCertPath() {
        return proxy.caCertPath;
      },
    },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `factory-${name}-`));
    agent = createServer((req, res) => {
      agentHits.push(`${req.method} ${req.url}`);
      res.end(`agent ${req.method} ${req.url}`);
    });
    await new Promise<void>((ok) => agent.listen(0, '127.0.0.1', ok));
    agentPort = (agent.address() as AddressInfo).port;
    const s = await httpsUpstream(dir, (req, res) => {
      seen.push({ sni: (req.socket as { servername?: string }).servername ?? '', host: req.headers.host ?? '', method: req.method ?? '', url: req.url ?? '' });
      req.resume();
      if (!o.answer?.(req, res)) res.end('stand-in');
    });
    upstream = s.server;
    const record = ((host: string, opts: object, cb: never) => {
      lookups.push(host);
      (toLocal as (h: string, o: object, c: never) => void)(host, opts, cb);
    }) as unknown as LookupFunction;
    proxy = new EgressProxy({
      dir: join(dir, 'network'),
      caDir: join(dir, 'ca'),
      agentApi: { host: 'host.docker.internal', port: 4101, to: { host: '127.0.0.1', port: agentPort } },
      upstream: { ...s.upstream, lookup: record },
    });
  }, 120_000);

  afterAll(async () => {
    await proxy?.closeAll();
    for (const s of [agent, upstream]) await new Promise((ok) => (s ? s.close(ok) : ok(undefined)));
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  /** A sandbox at `level`, the probe in its workspace, its relay up: what the agent of a run at that level would have. */
  async function open(level: NetworkLevel, allow: readonly string[] = []) {
    const workspacePath = sbx.workspace();
    copyFileSync(join(import.meta.dirname, 'egress-probe.mjs'), join(workspacePath, 'egress-probe.mjs'));
    const req = sbx.request({ workspacePath, network: level, allow });
    const box: Sandbox = await sbx.provider.create(req);
    const sh = async (script: string) => {
      const r = await sbx.sh(box.id, script);
      return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
    };
    /** One probe of egress-probe.mjs: the line it printed. */
    const probe = async (...args: string[]) => (await sbx.provider.exec(box.id, ['node', `${WORKSPACE_TARGET}/egress-probe.mjs`, ...args])).stdout.trim();
    /** The run's journal, read once it has not grown for 300 ms: a line is written as its connection ends, a moment after the client saw it. */
    const journal = async (): Promise<EgressEntry[]> => {
      const path = proxy.journalPath(req.runId);
      const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : '');
      for (let last = read(), same = 0, i = 0; i < 30 && same < 3; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const now = read();
        same = now === last ? same + 1 : 0;
        last = now;
      }
      const text = read().trim();
      return text ? text.split('\n').map((l) => JSON.parse(l) as EgressEntry) : [];
    };
    // The relay is the container's PID 1: up a moment after it.
    expect(await sh(`for i in $(seq 50); do node -e "require('net').connect(3128,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && exit 0; sleep 0.1; done; exit 1`)).toMatchObject({ code: 0 });
    return { runId: req.runId, sh, probe, journal };
  }

  return { open, seen, lookups, agentHits, agentPort: () => agentPort, proxy: () => proxy };
}

/** A raw HTTP/1.1 request, as `egress-probe.mjs tunnel` sends it. */
export const http1 = (method: string, path: string, host: string, extra: Record<string, string> = {}) =>
  `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n${Object.entries({ 'content-length': '0', ...extra }).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;
