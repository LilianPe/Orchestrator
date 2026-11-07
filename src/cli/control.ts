import { PRODUCT_NAME } from '../product.js';
import type { RunRecord } from '../store/types.js';
import { holds } from '../core/routing.js';
import type { TicketState } from '../core/types.js';

/** The daemon's HTTP API, as `factory status` and `factory stop` reach it. */
export interface ControlDeps {
  api: string;
  headers: Record<string, string>;
  out: (line: string) => void;
  /** The global `fetch`; a test hands the server's own. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
}

/** What `/api/state` answers and these commands read. */
interface State {
  linearConnected: boolean;
  paused: boolean;
  capacity: { dev: { used: number; total: number } };
  costTodayUsd: number;
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
    `Linear: ${s.linearConnected ? 'connected' : 'not connected'} · queue: ${s.paused ? 'paused' : 'active'} (${s.queue.length} waiting) · dev slots ${s.capacity.dev.used}/${s.capacity.dev.total} · cost today ${s.costTodayUsd.toFixed(2)} $`,
  ];
  for (const t of s.tickets) {
    lines.push(`  ${t.ticketId}  ${t.logical}${t.blocked ? ' (blocked)' : ''}${t.verifyingRunId ? ' (check running)' : ''}  ${t.title}`);
    if (t.blocked && t.blockReason) lines.push(`    ${t.blockReason}`);
    for (const run of s.activeRuns) if (run.projectId === t.projectId && run.ticketId === t.ticketId) lines.push(runLine(run, now));
  }
  return lines;
}

/** The state; or undefined, the reason told: a daemon down, a password missing. */
async function readState(d: ControlDeps): Promise<State | undefined> {
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${d.api}/api/state`, { headers: d.headers });
  } catch (err) {
    d.out(`${PRODUCT_NAME} does not answer on ${d.api} (${(err as Error).message}): run \`factory up\`, or check the port and FACTORY_HOME.`);
    return undefined;
  }
  if (res.status === 401) d.out('Access refused by the daemon: set FACTORY_UI_PASSWORD in this shell.');
  else if (!res.ok) d.out(`The daemon answers ${res.status} on /api/state.`);
  return res.ok ? ((await res.json()) as State) : undefined;
}

export async function runStatusCommand(d: ControlDeps, now: number = Date.now()): Promise<number> {
  const s = await readState(d);
  if (!s) return 1;
  for (const line of formatStatus(s, now)) d.out(line);
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
  const res = await (d.fetch ?? fetch)(`${d.api}/api/tickets/${t.projectId}/${ticketId}/stop`, { method: 'POST', headers: d.headers });
  if (!res.ok) {
    d.out(`The daemon refuses to stop ${ticketId} (${res.status}).`);
    return 1;
  }
  d.out(`Stop requested for ${ticketId}.`);
  return 0;
}
