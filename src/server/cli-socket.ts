import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { cliOnly } from './app.js';

/**
 * The CLI's listener on the daemon's server (ORC-405): a Unix socket at `path` (FACTORY_HOME), mode 0600, owned by the
 * factory's user, serving the CLI's routes of `app` (`cliOnly`) without a GitHub sign-in. The file's mode is the guard: no
 * token, no secret; from elsewhere, SSH to the server. Undefined, told in the log, when it cannot listen: the CLI then goes
 * through HTTP on the loopback, as before. Closing the server removes the file.
 */
export function listenCliSocket(app: Hono, path: string, o: { host?: string; log: (line: string) => void }): Server | undefined {
  const fallback = 'the CLI goes through HTTP on the loopback';
  const left = lstatSync(path, { throwIfNoEntry: false });
  if (left && !left.isSocket()) {
    o.log(`CLI socket: ${path} is not a socket, left as it is: ${fallback}`);
    return undefined;
  }
  // What a daemon killed left: nothing listens on it any more (its HTTP port, bound before, says no other daemon runs here).
  if (left) unlinkSync(path);
  const server = createAdaptorServer({ fetch: cliOnly(app, o.host ?? hostname()) }) as Server;
  server.on('error', (err) => o.log(`CLI socket ${path}: ${err.message}: ${fallback}`));
  // Bound in listen() itself, under this umask: the file is never open to others, not even before the chmod.
  const umask = process.umask(0o177);
  try {
    server.listen(path);
  } finally {
    process.umask(umask);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not bound (too long a path, a folder not writable): the error event above tells why.
    return undefined;
  }
  return server;
}
