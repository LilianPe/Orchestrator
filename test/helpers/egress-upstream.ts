import { createServer, type Server } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { join } from 'node:path';
import type { RequestListener } from 'node:http';
import { LeafIssuer, loadOrCreateCa } from '../../src/network/ca.js';

/** The egress proxy's resolver in tests: every host is the local upstream below. */
export const toLocal = ((_h: string, opts: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
  opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as unknown as LookupFunction;

/** An HTTPS server for any host name, under a CA of its own made in `dir`: what `EgressProxyOptions.upstream` points at. */
export async function httpsUpstream(dir: string, handler: RequestListener): Promise<{ server: Server; upstream: { ca: string; lookup: LookupFunction; port: number } }> {
  const ca = await loadOrCreateCa(join(dir, 'upstream-ca'));
  const issuer = await LeafIssuer.create(ca);
  const server = createServer({ SNICallback: (name, cb) => cb(null, issuer.context(name)) }, handler);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, upstream: { ca: ca.certPem, lookup: toLocal, port: (server.address() as AddressInfo).port } };
}
