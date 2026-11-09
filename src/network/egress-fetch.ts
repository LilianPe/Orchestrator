import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { HttpPackageRegistry, type PackageRegistry } from '../checks/registry.js';
import type { Egress } from './proxy-service.js';

/** Statuses a `Response` holds no body for. */
const NULL_BODY = new Set([204, 205, 304]);

/**
 * The package registries `verify` asks (`factory/dependances`, ORC-371), from the daemon through the egress proxy: a run of
 * its own, `id`, at `limited`, whose rules let reads of the registries' hosts through and journal them; closed by `close`.
 */
export function registriesViaEgress(egress: Pick<Egress, 'open' | 'close' | 'caCertPath'>) {
  return async (id: string): Promise<{ registry: PackageRegistry; close: () => Promise<void> }> => {
    const socket = await egress.open(id, { level: 'limited', allow: [] });
    const close = () => egress.close(id);
    try {
      return { registry: new HttpPackageRegistry({ fetch: egressFetch(socket, await readFile(egress.caCertPath, 'utf8')) }), close };
    } catch (err) {
      await close();
      throw err;
    }
  };
}

/**
 * `fetch` for the daemon's own requests through a run's socket of the egress proxy (ORC-213, ORC-371): `CONNECT host:443`,
 * then TLS under the factory's CA (`ca`, PEM), the request inside. The proxy applies the run's level to each request and
 * journals it, as for a sandbox. HTTPS only, a URL as a string or `URL`: what `HttpPackageRegistry` asks of it.
 */
export function egressFetch(socketPath: string, ca: string): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.protocol !== 'https:') throw new Error(`egress: ${url.protocol} refused, HTTPS only`);
    const signal = init.signal ?? undefined;
    const target = `${url.hostname}:${url.port || 443}`;
    const tls = await tunnel(socketPath, target, url.hostname, ca, signal);
    return new Promise<Response>((ok, ko) => {
      const headers = { ...Object.fromEntries(new Headers(init.headers)), host: url.host, connection: 'close' };
      const req = request({ createConnection: () => tls, method: init.method ?? 'GET', path: url.pathname + url.search, headers, ...(signal ? { signal } : {}) }, (res) => {
        res.once('close', () => tls.destroy());
        const status = res.statusCode ?? 0;
        const body = NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        try {
          ok(new Response(body, { status }));
        } catch (err) {
          res.destroy();
          ko(err as Error);
        }
      });
      req.once('error', (err) => {
        tls.destroy();
        ko(err);
      });
      req.end(init.body as string | undefined);
    });
  }) as typeof fetch;
}

/** The proxy's tunnel to `target`, and TLS on it: a refusal of the proxy rejects with its status. */
async function tunnel(socketPath: string, target: string, servername: string, ca: string, signal: AbortSignal | undefined): Promise<TLSSocket> {
  signal?.throwIfAborted();
  const req = request({ socketPath, method: 'CONNECT', path: target, headers: { host: target }, ...(signal ? { signal } : {}) });
  req.end();
  // The signal aborts the request, whose error `once` rejects with.
  const [res, socket] = (await once(req, 'connect')) as [{ statusCode?: number }, Socket];
  if (res.statusCode !== 200) {
    socket.destroy();
    throw new Error(`egress proxy refused ${target} (${res.statusCode})`);
  }
  const tls = tlsConnect({ socket, servername, ca, ALPNProtocols: ['http/1.1'] });
  const abort = () => tls.destroy(signal!.reason as Error);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await once(tls, 'secureConnect');
  } catch (err) {
    tls.destroy();
    throw err;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return tls;
}
