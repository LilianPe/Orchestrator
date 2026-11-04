import { PRODUCT_NAME } from '../product.js';
import type { RunRecord } from '../store/types.js';
import type { TicketState } from '../core/types.js';

/** The daemon's HTTP API, as `factory status` and `factory stop` reach it. */
export interface ControlDeps {
  api: string;
  headers: Record<string, string>;
  out: (line: string) => void;
  now: () => number;
  /** The global `fetch`; a test hands the server's own. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
}

/** What `/api/state` answers and these commands read. */
interface State {
  linearConnected: boolean;
  paused: boolean;
  capacity: { dev: { used: number; total: number }; questions: { used: number; total: number } };
  costTodayUsd: number;
  queue: unknown[];
  tickets: (TicketState & { title: string })[];
  activeRuns: Omit<RunRecord, 'token'>[];
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** A run in one line: what it runs, since when, and whether the heartbeat still holds it (ORC-220). */
function runLine(run: Omit<RunRecord, 'token'>, now: number): string {
  const lease = run.leaseUntil === undefined ? '' : run.leaseUntil >= now ? '' : ', bail expiré';
  return `    run ${run.id} : ${run.job}, depuis ${minutes(now - run.startedAt)} min, ${run.costUsd.toFixed(2)} $${lease}`;
}

export function formatStatus(s: State, now: number): string[] {
  const lines = [
    `Linear : ${s.linearConnected ? 'connecté' : 'non connecté'} · file : ${s.paused ? 'en pause' : 'active'} (${s.queue.length} en attente) · places dev ${s.capacity.dev.used}/${s.capacity.dev.total} · coût du jour ${s.costTodayUsd.toFixed(2)} $`,
  ];
  for (const t of s.tickets) {
    lines.push(`  ${t.ticketId}  ${t.logical}${t.blocked ? ' (bloqué)' : ''}${t.verifyingRunId ? ' (contrôle en cours)' : ''}  ${t.title}`);
    if (t.blocked && t.blockReason) lines.push(`    ${t.blockReason}`);
    for (const run of s.activeRuns) if (run.projectId === t.projectId && run.ticketId === t.ticketId) lines.push(runLine(run, now));
  }
  return lines;
}

/** The state, or the line that says why not: a daemon down, a password missing. */
async function readState(d: ControlDeps): Promise<State | string> {
  const get = d.fetch ?? fetch;
  let res: Response;
  try {
    res = await get(`${d.api}/api/state`, { headers: d.headers });
  } catch (err) {
    return `${PRODUCT_NAME} ne répond pas sur ${d.api} (${(err as Error).message}) : lancez \`factory up\`, ou vérifiez le port et FACTORY_HOME.`;
  }
  if (res.status === 401) return 'Accès refusé par le démon : définissez FACTORY_UI_PASSWORD dans ce shell.';
  if (!res.ok) return `Le démon répond ${res.status} sur /api/state.`;
  return (await res.json()) as State;
}

export async function runStatusCommand(d: ControlDeps): Promise<number> {
  const s = await readState(d);
  if (typeof s === 'string') {
    d.out(s);
    return 1;
  }
  for (const line of formatStatus(s, d.now())) d.out(line);
  return 0;
}

/** Asks for the stop of a ticket's work: `control.stop`, decided as any stop, whatever process started its run. */
export async function runStopCommand(d: ControlDeps, ticketId: string): Promise<number> {
  const s = await readState(d);
  if (typeof s === 'string') {
    d.out(s);
    return 1;
  }
  const t = s.tickets.find((x) => x.ticketId === ticketId);
  if (!t) {
    d.out(`Ticket ${ticketId} inconnu de ${PRODUCT_NAME}.`);
    return 1;
  }
  const res = await (d.fetch ?? fetch)(`${d.api}/api/tickets/${t.projectId}/${ticketId}/stop`, { method: 'POST', headers: d.headers });
  if (!res.ok) {
    d.out(`Le démon refuse l'arrêt de ${ticketId} (${res.status}).`);
    return 1;
  }
  d.out(`Arrêt demandé pour ${ticketId}.`);
  return 0;
}
