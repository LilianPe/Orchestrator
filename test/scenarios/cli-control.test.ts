import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runDryRunCommand, runQueueCommand, runStatusCommand, runStopCommand, type ControlDeps } from '../../src/cli/control.js';
import type { DryRun } from '../../src/core/dry-run.js';
import { EventBus } from '../../src/server/live-feed.js';
import { newTicketState, type FactoryEvent } from '../../src/core/types.js';
import { createApp, type ServerDeps } from '../../src/server/app.js';
import { listenCliSocket } from '../../src/server/cli-socket.js';
import { RUN_LEASE_MS } from '../../src/store/types.js';
import { createHarness, heldRun } from '../helpers/harness.js';

type H = ReturnType<typeof createHarness>;

/** The two commands against the daemon's own API, in this process, as ORC-220's criterion 4 asks; what they submit, kept. */
function control(h: H, extra: Partial<ServerDeps> = {}) {
  const submitted: FactoryEvent[] = [];
  const app = createApp({
    store: h.store,
    bus: new EventBus(),
    clock: h.clock,
    submit: (e) => {
      submitted.push(e);
      return h.orch.accept(e);
    },
    isPaused: () => h.orch.isPaused(),
    linearWebhook: () => ({ status: 200 }),
    githubWebhook: async () => ({ status: 200 }),
    linearConnected: () => true,
    capacity: () => ({ dev: { used: 1, total: 3 }, questions: { used: 0, total: 2 } }),
    transcriptsDir: mkdtempSync(join(tmpdir(), 'factory-cli-')),
    ...extra,
  });
  const lines: string[] = [];
  const deps: ControlDeps = { api: 'http://127.0.0.1:4100', out: (l) => void lines.push(l), fetch: (url, init) => app.request(url, init) };
  return { ...deps, lines, app, submitted };
}

describe('factory status and factory stop (ORC-220)', () => {
  it('status shows a run under way: its ticket, its job, since when', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    await h.advance(5 * 60_000);
    const c = control(h);
    expect(await runStatusCommand(c, h.clock.now())).toBe(0);
    expect(c.lines[0]).toContain('dev slots 1/3');
    expect(c.lines[0]).not.toContain('cost today'); // No day counted in dollars (ORC-194).
    expect(c.lines).toContain('  REL-1  dev  Export CSV');
    expect(c.lines).toContain(`    run ${runId}: dev, for 5 min, 0.00 $`);
  });

  it('status tells a lease expired that nothing took up yet, and a blocked ticket its reason', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    h.clock.advance(RUN_LEASE_MS + 1);
    const c = control(h);
    await runStatusCommand(c, h.clock.now());
    expect(c.lines.some((l) => l.includes(runId) && l.includes('lease expired'))).toBe(true);
    await runStopCommand(c, 'REL-1');
    await h.orch.drained();
    c.lines.length = 0;
    await runStatusCommand(c, h.clock.now());
    expect(c.lines).toContain('  REL-1  dev (blocked)  Export CSV');
    expect(c.lines).toContain('    Stopped on request');
  });

  it('stop goes to the project holding the ticket, not to a copy that only waited for its repo (ORC-316)', async () => {
    const copy = (projectId: string, patch: object) => ({ ...newTicketState(projectId, 'REL-1', 'T', 'dev', 1), ...patch });
    const tickets = [copy('api', { delegated: true, blocked: true, blockKind: 'pickup', awaitingRepo: ['api', 'web'] }), copy('web', { delegated: true })];
    const asked: string[] = [];
    const fetch = (url: string) => {
      asked.push(url);
      return Response.json(url.endsWith('/api/state') ? { tickets } : {});
    };
    expect(await runStopCommand({ api: 'http://d', out: () => {}, fetch }, 'REL-1')).toBe(0);
    expect(asked.at(-1)).toBe('http://d/api/tickets/web/REL-1/stop');
  });

  it('stop stops the run, one the daemon reattached to included', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    await h.restart({ mode: 'brutal' });
    const c = control(h);
    expect(await runStopCommand(c, 'REL-1')).toBe(0);
    expect(c.lines).toEqual(['Stop requested for REL-1.']);
    await h.orch.drained();
    expect((await h.store.getRun(runId))!.status).toBe('stopped');
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Stopped on request' });
    expect((await h.ticket()).activeRunId).toBeUndefined();
  });

  it('stop refuses a ticket the factory does not know', async () => {
    const c = control(createHarness());
    expect(await runStopCommand(c, 'REL-9')).toBe(1);
    expect(c.lines[0]).toContain('REL-9 unknown');
  });

  it('pauses and resumes the queue, and says so only once the daemon has taken the command', async () => {
    const h = createHarness();
    const c = control(h);
    expect(await runQueueCommand(c, 'pause')).toBe(0);
    expect(await runQueueCommand(c, 'resume')).toBe(0);
    expect(c.lines).toEqual(['Queue paused.', 'Queue resumed.']);
  });

  // ORC-399: off the loopback the daemon asks for a GitHub sign-in the CLI cannot give: each command says so, and never that
  // the queue is paused.
  it('says what to do when the daemon is down or asks for a GitHub sign-in, and never that it took the command', async () => {
    const lines: string[] = [];
    const deps = { api: 'http://127.0.0.1:1', out: (l: string) => void lines.push(l) };
    const down = async () => Promise.reject(new Error('fetch failed'));
    const signIn = async () => new Response('{"error":"sign in with GitHub first"}', { status: 401 });
    const SIGN_IN = 'Access refused by the daemon: off the loopback, it asks for a GitHub sign-in, which only the dashboard gives.';
    expect(await runStatusCommand({ ...deps, fetch: down })).toBe(1);
    expect(lines.at(-1)).toContain('factory up');
    expect(await runStopCommand({ ...deps, fetch: signIn }, 'REL-1')).toBe(1);
    expect(lines.at(-1)).toBe(SIGN_IN);
    expect(await runQueueCommand({ ...deps, fetch: signIn }, 'pause')).toBe(1);
    expect(lines.at(-1)).toBe(SIGN_IN);
    expect(await runQueueCommand({ ...deps, fetch: down }, 'resume')).toBe(1);
    expect(lines.at(-1)).toContain('factory up');
    expect(lines.join('\n')).not.toMatch(/Queue (paused|resumed)\./);
  });
});

/** ORC-409: `factory dry-run <project>` asks the daemon to run the dry run, and prints it once recorded. */
describe('factory dry-run', () => {
  const FINGERPRINT = { setup: 'a'.repeat(64), image: 'factory/runner:test', lockfiles: {}, config: null, hash: 'b'.repeat(64) };
  const dryRun = (ok: boolean): DryRun => ({
    id: 'dry-1', projectId: 'p', sha: 'c'.repeat(40), target: 'main', ok, fingerprint: FINGERPRINT, commands: ['npm test'], startedAt: 0, endedAt: 1,
    breaks: ok ? [] : [{ kind: 'dependency', step: 'setup', command: 'npm ci', detail: 'a dependency is missing: No matching version found for left-pad@9.9.9', output: 'npm error code ETARGET\nnpm error notarget' }],
  });

  it('runs it through the daemon, which records it, and prints it green', async () => {
    const h = createHarness({ sandboxed: true, dryRunner: async (req) => ({ ...dryRun(true), id: req.runId }) });
    const c = control(h, { dryRun: (id) => h.orch.dryRun(id) });
    expect(await runDryRunCommand(c, 'p')).toBe(0);
    expect(c.lines.at(-1)).toBe(`Dry run of p on ${'c'.repeat(12)}: green (npm test).`);
    expect(await h.store.lastDryRun('p')).toMatchObject({ ok: true });
  });

  it('red, it prints each break with its cause and what the command printed, and fails', async () => {
    const h = createHarness();
    const c = control(h, { dryRun: async () => dryRun(false) });
    expect(await runDryRunCommand(c, 'p')).toBe(1);
    expect(c.lines.slice(1)).toEqual([
      `Dry run of p on ${'c'.repeat(12)}: red (npm test).`,
      '  dependency, setup `npm ci`: a dependency is missing: No matching version found for left-pad@9.9.9',
      '    | npm error code ETARGET',
      '    | npm error notarget',
      expect.stringContaining('The tickets of p are refused while its dry run is red'),
    ]);
  });

  it('one that cannot run records nothing, and says why', async () => {
    const h = createHarness();
    const c = control(h, { dryRun: (id) => h.orch.dryRun(id) });
    expect(await runDryRunCommand(c, 'p')).toBe(1);
    expect(c.lines.at(-1)).toMatch(/^No dry run recorded \(409\): a dry run runs in the sandboxes: FACTORY_CONTAINER_CLI/);
    expect(await h.store.lastDryRun('p')).toBeUndefined();
  });

  it('over HTTP, without fetch, which gives up on an answer after 5 minutes', async () => {
    const server = createServer((req, res) => {
      expect([req.method, req.url]).toEqual(['POST', '/api/projects/p/dry-run']);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(dryRun(true)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const lines: string[] = [];
      expect(await runDryRunCommand({ api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, out: (l) => void lines.push(l) }, 'p')).toBe(0);
      expect(lines.at(-1)).toContain('green');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await new Promise((r) => server.close(r));
    }
  });

  it.skipIf(process.platform === 'win32')("goes through the daemon's Unix socket too", async () => {
    const h = createHarness();
    const { app, lines, ...http } = control(h, { dryRun: async () => dryRun(true) });
    const socket = join(mkdtempSync(join(tmpdir(), 'factory-home-')), 'cli', 'factory.sock');
    const server = (await listenCliSocket(app, socket, { host: 'srv-1', log: () => {} }))!;
    try {
      expect(await runDryRunCommand({ ...http, fetch: () => expect.unreachable(), socket }, 'p')).toBe(0);
      expect(lines.at(-1)).toContain('green');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ORC-405: an exposed daemon asks every HTTP request for a GitHub sign-in (ORC-399); on its server, the CLI goes through the
// Unix socket in FACTORY_HOME instead, which the file's mode guards.
describe.skipIf(process.platform === 'win32')("the CLI through the daemon's Unix socket (ORC-405)", () => {
  /** An exposed daemon's app, with its socket in a fresh FACTORY_HOME; every HTTP request refused as the sign-in refuses it. */
  async function exposed() {
    const h = createHarness();
    const { app, submitted, lines, ...http } = control(h, { githubLogin: { authorizeUrl: () => 'https://github.test/authorize', signIn: async (login) => ({ login, allowed: false }) } });
    const socket = join(mkdtempSync(join(tmpdir(), 'factory-home-')), 'cli', 'factory.sock');
    const server = await listenCliSocket(app, socket, { host: 'srv-1', log: () => {} });
    return { h, app, server: server!, socket, submitted, lines, deps: { ...http, socket } };
  }
  const close = (s: Server) => new Promise((r) => s.close(r));

  // Criterion 1: status, stop and pause work on the server of an exposed daemon, without a GitHub sign-in.
  it('runs status, pause, resume and stop on an exposed daemon, without a GitHub sign-in, as cli:<host>', async () => {
    const { h, server, submitted, lines, deps } = await exposed();
    try {
      await heldRun(h);
      expect(await runStatusCommand(deps, h.clock.now())).toBe(0);
      expect(lines).toContain('  REL-1  dev  Export CSV');
      expect(await runQueueCommand(deps, 'pause')).toBe(0);
      expect(await runQueueCommand(deps, 'resume')).toBe(0);
      expect(await runStopCommand(deps, 'REL-1')).toBe(0);
      expect(lines.slice(-3)).toEqual(['Queue paused.', 'Queue resumed.', 'Stop requested for REL-1.']);
      await h.orch.drained();
      // Checked on the matrix as an operator (ORC-186), and decided: the ticket is stopped.
      expect(submitted.map((e) => [e.type, e.actor, e.roles])).toEqual([
        ['control.pause', 'cli:srv-1', ['operator']],
        ['control.resume', 'cli:srv-1', ['operator']],
        ['control.stop', 'cli:srv-1', ['operator']],
      ]);
      expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Stopped on request' });
    } finally {
      await close(server);
    }
  });

  it("is the factory user's alone: mode 0600 in a folder 0700, and gone once the daemon closes it", async () => {
    const { server, socket } = await exposed();
    const st = statSync(socket);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
    expect(st.uid).toBe(process.getuid!());
    await close(server);
    expect(() => statSync(socket)).toThrow(/ENOENT/);
  });

  it("leaves another daemon's socket, never a file that is not a socket, and binds anew over what a daemon killed left", async () => {
    const first = await exposed();
    const logs: string[] = [];
    const log = (l: string) => void logs.push(l);
    // A second daemon on the same FACTORY_HOME: the first keeps its socket, and the CLI still reaches it.
    expect(await listenCliSocket(first.app, first.socket, { host: 'srv-2', log })).toBeUndefined();
    expect(await runQueueCommand(first.deps, 'pause')).toBe(0);
    expect(first.submitted.map((e) => e.actor)).toEqual(['cli:srv-1']);
    const notASocket = join(mkdtempSync(join(tmpdir(), 'factory-home-')), 'factory.sock');
    writeFileSync(notASocket, 'kept');
    expect(await listenCliSocket(first.app, notASocket, { host: 'srv-1', log })).toBeUndefined();
    expect(logs).toEqual([
      `CLI socket: ${first.socket} is held by another daemon: the CLI goes through HTTP on the loopback`,
      `CLI socket: ${notASocket} is not a socket, left as it is: the CLI goes through HTTP on the loopback`,
    ]);
    // What a kill -9 leaves: the socket file, nothing listening on it (a child killed with its server open).
    const stale = join(mkdtempSync(join(tmpdir(), 'factory-home-')), 'factory.sock');
    spawnSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, 'SIGKILL'))`], { stdio: 'ignore' });
    expect(statSync(stale).isSocket()).toBe(true);
    const again = await listenCliSocket(first.app, stale, { host: 'srv-3', log });
    expect(again).toBeDefined();
    expect(await runQueueCommand({ ...first.deps, socket: stale }, 'resume')).toBe(0);
    expect(first.submitted.map((e) => e.actor)).toEqual(['cli:srv-1', 'cli:srv-3']);
    await close(again!);
    await close(first.server);
  });

  // Without the socket (a client machine, a daemon not started), today's HTTP on the loopback.
  it('falls back to HTTP on the loopback when there is no socket, or nothing listens on it', async () => {
    const { server, socket, lines, deps } = await exposed();
    await close(server);
    const asked: string[] = [];
    const http = async (url: string) => {
      asked.push(url);
      return new Response('{"error":"sign in with GitHub first"}', { status: 401 });
    };
    expect(await runStatusCommand({ ...deps, fetch: http })).toBe(1);
    expect(asked).toEqual(['http://127.0.0.1:4100/api/state']);
    expect(lines.at(-1)).toBe(`Access refused by the daemon: off the loopback, it asks for a GitHub sign-in, which only the dashboard gives. On the server, the CLI goes through ${socket}: run it there as the factory's user (over SSH from elsewhere).`);
    writeFileSync(socket, '');
    expect(await runStatusCommand({ ...deps, fetch: http })).toBe(1);
    expect(asked).toHaveLength(2);
  });

  // A FACTORY_HOME deep enough to put its socket past the OS's limit (108 bytes on Linux): EINVAL, ENAMETOOLONG on macOS.
  it('falls back to HTTP on the loopback when the socket path is too long to connect to (ORC-431)', async () => {
    const c = control(createHarness());
    const asked: string[] = [];
    const tooLong = join(tmpdir(), 'x'.repeat(200), 'factory.sock');
    expect(await runStatusCommand({ ...c, socket: tooLong, fetch: (url, init) => (asked.push(url), c.fetch!(url, init)) })).toBe(0);
    expect(asked).toEqual(['http://127.0.0.1:4100/api/state']);
    expect(c.lines[0]).toContain('dev slots 1/3');
  });
});
