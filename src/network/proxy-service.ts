import { chmodSync, rmSync } from 'node:fs';
import { createServer, request, type ClientRequest, type IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import { json } from 'node:stream/consumers';
import { z } from 'zod';
import type { NetworkLevel } from '../adapters/sandbox/types.js';
import { NETWORK_RANK, type EgressPolicy } from './levels.js';
import { egressJournalPath, PIPE, type EgressProxy } from './proxy.js';

/** What the daemon asks of the egress proxy, in its own process or in the `proxy` service. */
export type Egress = Pick<EgressProxy, 'open' | 'close' | 'closeAll' | 'isOpen' | 'caCertPath' | 'journalPath'>;

/** The name of the agent API in a sandbox: the daemon writes it in `FACTORY_API`, the proxy recognises it. */
export const sandboxAgentHost = (env: NodeJS.ProcessEnv) => env['FACTORY_SANDBOX_AGENT_HOST'] || 'host.docker.internal';

const CLOSE = z.object({ runId: z.string() });
const OPEN = CLOSE.extend({
  policy: z.object({ level: z.enum(Object.keys(NETWORK_RANK) as [NetworkLevel, ...NetworkLevel[]]), allow: z.array(z.string()) }),
  /** The run's Claude token, which the proxy sets on its model calls (ORC-337); held in memory only. */
  claudeToken: z.string().optional(),
});

export interface EgressControl {
  close(): Promise<void>;
}

/**
 * The `proxy` service's side (ORC-203): the same EgressProxy, driven over a Unix socket by the daemon.
 * The socket is mounted in `factoryd` only, never in a runner: a run's level stays out of the agent's reach.
 * `/watch` stays open as long as both live: each side learns from it that the other is gone.
 */
export async function serveEgressControl(proxy: EgressProxy, path: string): Promise<EgressControl> {
  const routes = new Map<string, (input: unknown) => Promise<object>>([
    ['/open', async (input) => {
      const { runId, policy, claudeToken } = OPEN.parse(input);
      const socket = await proxy.open(runId, policy, claudeToken);
      return { socket, ca: proxy.caCertPath };
    }],
    ['/close', async (input) => {
      await proxy.close(CLOSE.parse(input).runId);
      return {};
    }],
  ]);
  let watchers = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/watch') {
      watchers++;
      // The daemon gone, its runs go, as with the proxy in its process; unless a new one already took over.
      res.once('close', () => {
        if (--watchers === 0) void proxy.closeAll();
      });
      return void res.writeHead(200).flushHeaders();
    }
    const reply = (status: number, value: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    const route = req.method === 'POST' ? routes.get(req.url ?? '') : undefined;
    if (!route) return void reply(400, { error: `invalid request: ${req.method} ${req.url}` });
    json(req).then(route).then(
      (value) => reply(200, value),
      (err: Error) => reply(err instanceof z.ZodError || err instanceof SyntaxError ? 400 : 500, { error: err.message }),
    );
  });
  if (!PIPE) rmSync(path, { force: true }); // left by a crash
  await new Promise<void>((ok, ko) => server.once('error', ko).listen(path, ok));
  // Both services run under the same uid; a runner gets only its own run's socket mounted.
  if (!PIPE) chmodSync(path, 0o600);
  return {
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

/**
 * The daemon's side: EgressProxy's interface over the control socket. `isOpen` is sync, for the provider
 * that asks it: the runs opened here since the proxy started. The proxy gone, none is, as after a daemon
 * restart with the proxy in-process: the provider then replaces those containers, whose socket is dead.
 */
export class EgressClient implements Egress {
  private readonly opened = new Set<string>();
  private ca?: string;
  private watch?: Promise<ClientRequest>;

  constructor(
    private readonly path: string,
    private readonly log: (message: string) => void = () => {},
    /** A proxy that does not answer must not hold a run's place in the queue. */
    private readonly timeoutMs = 30_000,
    /** Handed to the proxy with each run it opens (ORC-337): the `proxy` service reads no secret of its own. */
    private readonly claudeToken: () => string | undefined = () => undefined,
  ) {}

  get caCertPath(): string {
    if (!this.ca) throw new Error('egress: no run opened yet, so no CA');
    return this.ca;
  }

  isOpen(runId: string): boolean {
    return this.opened.has(runId);
  }

  /** The control socket sits in the proxy's directory, mounted at the same path in both services (`compose.yaml`). */
  journalPath(runId: string): string {
    return egressJournalPath(dirname(this.path), runId);
  }

  async open(runId: string, policy: EgressPolicy): Promise<string> {
    await this.watching();
    const claudeToken = this.claudeToken();
    const { socket, ca } = (await this.call('/open', { runId, policy, ...(claudeToken ? { claudeToken } : {}) })) as { socket: string; ca: string };
    this.ca = ca;
    this.opened.add(runId);
    return socket;
  }

  /** Never rejects: the container is already gone, and a socket left open dies with the proxy. */
  async close(runId: string): Promise<void> {
    this.opened.delete(runId);
    await this.call('/close', { runId }).catch((err: Error) => this.log(`egress: run ${runId} not closed in the proxy: ${err.message}`));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.opened].map((id) => this.close(id)));
    const watch = this.watch;
    this.watch = undefined;
    (await watch?.catch(() => undefined))?.destroy();
  }

  /** Resolved once the proxy holds the watch, so a run opened after it cannot miss the proxy's end. */
  private watching(): Promise<ClientRequest> {
    return (this.watch ??= new Promise((ok, ko) => {
      const lost = () => {
        this.watch = undefined;
        this.opened.clear();
      };
      const req = this.send('GET', '/watch', (err) => {
        lost();
        ko(err);
      }, (res) => {
        req.setTimeout(0);
        res.resume();
        res.once('close', lost);
        // A watch that lasts must not keep the daemon alive at its shutdown.
        res.socket.unref();
        ok(req);
      });
      req.end();
    }));
  }

  private call(path: string, payload: object): Promise<unknown> {
    return new Promise((ok, ko) => {
      this.send('POST', path, ko, (res) => {
        json(res).then(
          (value) => {
            if (res.statusCode === 200) ok(value);
            else ko(new Error((value as { error?: string }).error ?? `egress: the proxy answered ${res.statusCode}`));
          },
          () => ko(new Error(`egress: the proxy answered ${res.statusCode}, not in JSON`)),
        );
      }).end(JSON.stringify(payload));
    });
  }

  private send(method: string, path: string, failed: (err: Error) => void, answered: (res: IncomingMessage) => void): ClientRequest {
    const req = request({ socketPath: this.path, path, method, timeout: this.timeoutMs }, answered);
    req.once('timeout', () => req.destroy(new Error(`no answer in ${this.timeoutMs} ms`)));
    req.once('error', (err) => failed(new Error(`egress: proxy unreachable at ${this.path}: ${err.message}`)));
    return req;
  }
}
