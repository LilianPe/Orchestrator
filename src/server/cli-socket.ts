import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { cliOnly } from './app.js';

/** Whether a daemon still listens on the socket at `path`. */
const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const s = connect(path);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });

/**
 * The CLI's listener on the daemon's server (ORC-405): a Unix socket at `path`, in a folder of FACTORY_HOME that is the
 * factory user's alone (0700), itself 0600, serving the CLI's routes of `app` (`cliOnly`) without a GitHub sign-in. The
 * modes are the guard: no token, no secret; from elsewhere, SSH to the server. Undefined, told in the log, when it does not
 * listen: the CLI then goes through HTTP on the loopback, as before; never on Windows, whose sockets are named pipes.
 * Closing the server removes the file.
 */
export async function listenCliSocket(app: Hono, path: string, o: { host?: string; log: (line: string) => void }): Promise<Server | undefined> {
  if (process.platform === 'win32') return undefined;
  const fail = (why: string) => {
    o.log(`CLI socket: ${path} ${why}: the CLI goes through HTTP on the loopback`);
    return undefined;
  };
  let server: Server | undefined;
  try {
    // The folder first: the socket is never reachable by another user, not even before its own chmod.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const left = lstatSync(path, { throwIfNoEntry: false });
    if (left && !left.isSocket()) return fail('is not a socket, left as it is');
    // Another daemon on this FACTORY_HOME keeps its own; what a daemon killed left is replaced.
    if (left && (await answers(path))) return fail('is held by another daemon');
    if (left) unlinkSync(path);
    const listening = (server = createAdaptorServer({ fetch: cliOnly(app, o.host ?? hostname()) }) as Server);
    const bound = await new Promise<Error | undefined>((resolve) => {
      listening.once('error', resolve);
      listening.listen(path, () => resolve(undefined));
    });
    if (bound) return fail(`cannot be listened on (${bound.message})`);
    chmodSync(path, 0o600);
    listening.on('error', (err) => o.log(`CLI socket ${path}: ${err.message}`));
    return listening;
  } catch (err) {
    server?.close();
    return fail(`cannot be set up (${(err as Error).message})`);
  }
}
