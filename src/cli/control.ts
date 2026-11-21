import { request, type RequestOptions } from 'node:http';
import { PRODUCT_NAME } from '../product.js';
import type { DryRun } from '../core/dry-run.js';
import type { RunRecord } from '../store/types.js';
import { holds } from '../core/routing.js';
import type { TicketState } from '../core/types.js';

/** The daemon's API, as `factory status`, `stop`, `pause` and `resume` reach it. */
export interface ControlDeps {
  api: string;
  /**
   * The daemon's Unix socket in FACTORY_HOME (ORC-405), taken first when it is there: on the server, the CLI needs no GitHub
   * sign-in. Absent, or nothing listening on it: HTTP on `api`.
   */
  socket?: string;
  out: (line: string) => void;
  /** The global `fetch`, for `api`; a test hands the server's own. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
}

/**
 * The socket's errors before any byte is sent: nothing reached the daemon, HTTP may be tried instead. A path past the
 * OS's limit is refused as EINVAL on Linux, ENAMETOOLONG on macOS (ORC-431).
 */
const NOT_REACHED = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK', 'EINVAL', 'ENAMETOOLONG']);

/**
 * A request of the CLI's (its commands carry no body) with node's own client, which never gives up on a slow answer: through the
 * daemon's Unix socket, rejected when nothing listens there; or over HTTP, where `fetch` gives up after 5 minutes, before a dry run
 * ends (ORC-409).
 */
function nodeRequest(to: RequestOptions, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ ...to, method: init.method ?? 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers: { 'content-type': res.headers['content-type'] ?? 'text/plain' } })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const viaSocket = (socketPath: string, path: string, init: RequestInit) => nodeRequest({ socketPath, path, headers: { host: 'localhost' } }, init);

/** `fetch`'s stand-in for a slow answer over HTTP. */
const slowFetch = (url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  return nodeRequest({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}` }, init);
};

/** What `/api/state` answers and these commands read. */
interface State {
  linearConnected: boolean;
  paused: boolean;
  capacity: { dev: { used: number; total: number } };
  queue: unknown[];
  tickets: (TicketState & { title: string })[];
  activeRuns: Omit<RunRecord, 'token'>[];
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** A run in one line: what it runs, since when, and whether the heartbeat still holds it (ORC-220). */
function runLine(run: Omit<RunRecord, 'token'>, now: number): string {
  const lease = run.leaseUntil !== undefined && run.leaseUntil < now ? ', lease expired' : '';
  return `    run ${run.id}: ${run.job}, for ${minutes(now - run.startedAt)} min, ${run.costUsd.toFixed(2)} $${lease}`;
}

function formatStatus(s: State, now: number): string[] {
  const lines = [
    `Linear: ${s.linearConnected ? 'connected' : 'not connected'} · queue: ${s.paused ? 'paused' : 'active'} (${s.queue.length} waiting) · dev slots ${s.capacity.dev.used}/${s.capacity.dev.total}`,
  ];
  for (const t of s.tickets) {
    lines.push(`  ${t.ticketId}  ${t.logical}${t.blocked ? ' (blocked)' : ''}${t.verifyingRunId ? ' (check running)' : ''}  ${t.title}`);
    if (t.blocked && t.blockReason) lines.push(`    ${t.blockReason}`);
    for (const run of s.activeRuns) if (run.projectId === t.projectId && run.ticketId === t.ticketId) lines.push(runLine(run, now));
  }
  return lines;
}

/**
 * The daemon's answer to `path`, through its socket when it listens there (ORC-405), else over HTTP; or undefined, the
 * reason told: a daemon that does not answer, or one that asks over HTTP for a GitHub sign-in (ORC-399), which the CLI
 * cannot give: it sends no credential.
 */
async function ask(d: ControlDeps, path: string, init: RequestInit = {}, o: { slow?: boolean } = {}): Promise<Response | undefined> {
  if (d.socket) {
    try {
      return await viaSocket(d.socket, path, init);
    } catch (err) {
      // A socket a daemon killed left, or one this user may not open: HTTP, as without one. Any later error may come after
      // the daemon took the command: never sent twice.
      if (!NOT_REACHED.has((err as NodeJS.ErrnoException).code ?? '')) {
        d.out(`${PRODUCT_NAME} did not answer through ${d.socket} (${(err as Error).message}): the command may have been taken, check with \`factory status\`.`);
        return undefined;
      }
    }
  }
  let res: Response;
  try {
    const url = `${d.api}${path}`;
    const send = d.fetch ?? (o.slow && url.startsWith('http:') ? slowFetch : fetch);
    res = await send(url, init);
  } catch (err) {
    d.out(`${PRODUCT_NAME} does not answer on ${d.api} (${(err as Error).message}): run \`factory up\`, or check the port and FACTORY_HOME.`);
    return undefined;
  }
  if (res.status !== 401) return res;
  const onServer = d.socket ? ` On the server, the CLI goes through ${d.socket}: run it there as the factory's user (over SSH from elsewhere).` : '';
  d.out(`Access refused by the daemon: off the loopback, it asks for a GitHub sign-in, which only the dashboard gives.${onServer}`);
  return undefined;
}

/** The state; or undefined, the reason told. */
async function readState(d: ControlDeps): Promise<State | undefined> {
  const res = await ask(d, '/api/state');
  if (res && !res.ok) d.out(`The daemon answers ${res.status} on /api/state.`);
  return res?.ok ? ((await res.json()) as State) : undefined;
}

export async function runStatusCommand(d: ControlDeps, now: number = Date.now()): Promise<number> {
  const s = await readState(d);
  if (!s) return 1;
  for (const line of formatStatus(s, now)) d.out(line);
  return 0;
}

/** Pauses or resumes the queue, said done only once the daemon has taken the command (ORC-399: never on a refusal). */
export async function runQueueCommand(d: ControlDeps, command: 'pause' | 'resume'): Promise<number> {
  const res = await ask(d, `/api/control/${command}`, { method: 'POST' });
  if (!res) return 1;
  if (!res.ok) {
    d.out(`The daemon refuses to ${command} the queue (${res.status}).`);
    return 1;
  }
  d.out(`Queue ${command === 'pause' ? 'paused' : 'resumed'}.`);
  return 0;
}

/** Asks for the stop of a ticket's work: `control.stop`, decided as any stop, whatever process started its run. */
export async function runStopCommand(d: ControlDeps, ticketId: string): Promise<number> {
  const s = await readState(d);
  if (!s) return 1;
  // A copy per project (ORC-316): the work is under the one holding the ticket.
  const copies = s.tickets.filter((x) => x.ticketId === ticketId);
  const t = copies.find(holds) ?? copies[0];
  if (!t) {
    d.out(`Ticket ${ticketId} unknown to ${PRODUCT_NAME}.`);
    return 1;
  }
  const res = await ask(d, `/api/tickets/${t.projectId}/${ticketId}/stop`, { method: 'POST' });
  if (!res) return 1;
  if (!res.ok) {
    d.out(`The daemon refuses to stop ${ticketId} (${res.status}).`);
    return 1;
  }
  d.out(`Stop requested for ${ticketId}.`);
  return 0;
}

/**
 * `factory dry-run <project>` (ORC-409): the daemon runs the dry run of the project's default branch and records it, as a delegated
 * ticket's launch does, and the CLI prints it once recorded: green, or red with each break, its step, command, cause and an excerpt
 * of what the command printed. 0 when green.
 */
export async function runDryRunCommand(d: ControlDeps, projectId: string): Promise<number> {
  d.out(`Dry run of ${projectId} under way: its setup and commands in the sandbox, as verify runs them (minutes)…`);
  const res = await ask(d, `/api/projects/${encodeURIComponent(projectId)}/dry-run`, { method: 'POST' }, { slow: true });
  if (!res) return 1;
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    d.out(`No dry run recorded (${res.status}): ${error ?? 'the daemon refuses it'}.`);
    return 1;
  }
  const run = (await res.json()) as DryRun;
  d.out(`Dry run of ${projectId} on ${run.sha.slice(0, 12)}: ${run.ok ? 'green' : 'red'}${run.commands.length ? ` (${run.commands.join(' · ')})` : ''}.`);
  for (const b of run.breaks) {
    d.out(`  ${b.kind}, ${b.step} \`${b.command}\`: ${b.detail}`);
    for (const line of b.output.split('\n').filter((l) => l.trim())) d.out(`    | ${line}`);
  }
  if (!run.ok) d.out(`The tickets of ${projectId} are refused while its dry run is red: fix what breaks, then run this again. A ticket it refused starts on a reply once it is green.`);
  return run.ok ? 0 : 1;
}
