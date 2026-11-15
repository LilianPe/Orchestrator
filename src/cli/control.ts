import { PRODUCT_NAME } from '../product.js';
import type { RunRecord } from '../store/types.js';
import { holds } from '../core/routing.js';
import type { TicketState } from '../core/types.js';

/** The daemon's HTTP API, as `factory status` and `factory stop` reach it. */
export interface ControlDeps {
  api: string;
  out: (line: string) => void;
  /** The global `fetch`; a test hands the server's own. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
}

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
 * The daemon's answer to `path`; or undefined, the reason told: a daemon that does not answer, or one that asks for a
 * GitHub sign-in (ORC-399), which the CLI cannot give: it sends no credential.
 */
async function ask(d: ControlDeps, path: string, init: RequestInit = {}): Promise<Response | undefined> {
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${d.api}${path}`, init);
  } catch (err) {
    d.out(`${PRODUCT_NAME} does not answer on ${d.api} (${(err as Error).message}): run \`factory up\`, or check the port and FACTORY_HOME.`);
    return undefined;
  }
  if (res.status !== 401) return res;
  d.out('Access refused by the daemon: off the loopback, it asks for a GitHub sign-in, which only the dashboard gives.');
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
