import type { AuditListView, AuditSheetView, BlockParetoView, BusMessage, DefectEntry, FlowView, MaturityCardView, MeasuredTicketView, OverviewView, RunDetailView, RunSecurityView, SecurityPeriodView, Snapshot } from './types.js';

let reloading = false;

/**
 * `fetch`, signing in again when the session is gone (ORC-399): off the loopback a 401 is the GitHub sign-in's, and a
 * reload, once whatever else was in flight, sends the page through GitHub. On the loopback, no route the dashboard calls
 * answers 401. The live stream's errors say not why: the state, polled every 10 s, does.
 */
async function call(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (res.status === 401 && !reloading) {
    reloading = true;
    location.reload();
  }
  return res;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  return (await call('/api/state')).json();
}

async function getJson<T>(path: string): Promise<T> {
  const res = await call(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchFlow = () => getJson<FlowView>('/api/flow');

export const fetchMeasures = async () => (await getJson<{ tickets: MeasuredTicketView[] }>('/api/measures')).tickets;

/** The reduced overview over the last 90 days (ORC-299), computed by the factory. */
export const fetchOverview = () => getJson<OverviewView>('/api/overview');

/** The security log and the Pareto of the blocks over `[since, until)` (ORC-300). */
export const fetchSecurity = (since: number, until: number) => getJson<SecurityPeriodView>(`/api/security?since=${since}&until=${until}`);
export const fetchBlocks = (since: number, until: number) => getJson<BlockParetoView>(`/api/blocks?since=${since}&until=${until}`);
export const fetchRunSecurity = (runId: string) => getJson<RunSecurityView>(`/api/security/runs/${encodeURIComponent(runId)}`);

/** What `path` serves; undefined when the server knows no such thing (404). */
async function getJsonOrMissing<T>(path: string): Promise<T | undefined> {
  const res = await call(path);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** The detail of a run (ORC-298); undefined when the server knows no such run. */
export const fetchRunDetail = (runId: string) => getJsonOrMissing<RunDetailView>(`/api/runs/${encodeURIComponent(runId)}`);

/** The audit sheets (ORC-229): the PRs a human reviewed, the sheet of one (undefined for a ticket the server does not know), and a defect entered on it. */
export const fetchAuditList = () => getJson<AuditListView>('/api/audit');
const auditPath = (projectId: string, ticketId: string) => `/api/audit/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}`;
export const fetchAuditSheet = (projectId: string, ticketId: string) => getJsonOrMissing<AuditSheetView>(auditPath(projectId, ticketId));
export const postDefect = (projectId: string, ticketId: string, entry: DefectEntry) =>
  call(`${auditPath(projectId, ticketId)}/defects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });

export const post = (path: string) => call(path, { method: 'POST' });

/** The maturity cards of every project (ORC-410), and the approval of one, of the value shown. */
export const fetchMaturity = () => getJson<{ cards: MaturityCardView[] }>('/api/maturity').then((r) => r.cards);
export const postApproval = (c: Pick<MaturityCardView, 'projectId' | 'key' | 'value'>) =>
  call(`/api/maturity/${encodeURIComponent(c.projectId)}/${encodeURIComponent(c.key)}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: c.value }) });

/** A ticket taken over (ORC-234): `take-over` gives the command of a shell in its container, `take-over/bundle` takes a bundle. */
const takeOverPath = (projectId: string, ticketId: string, rest = '') => `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/take-over${rest}`;
export const fetchTakeOverShell = (projectId: string, ticketId: string) => call(takeOverPath(projectId, ticketId));
export const postBundle = (projectId: string, ticketId: string, file: File) => call(takeOverPath(projectId, ticketId, '/bundle'), { method: 'POST', body: file });

/** What the server answers to a refused action: its `error`, or its status. */
export async function refusal(res: Response, what: string): Promise<string> {
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  return error ?? `${what} refused (${res.status})`;
}

export function subscribe(onMessage: (m: BusMessage) => void, onConnection: (c: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  for (const kind of ['event', 'command', 'run', 'activity', 'ticket', 'log']) {
    es.addEventListener(kind, (e) => onMessage(JSON.parse((e as MessageEvent).data) as BusMessage));
  }
  es.onopen = () => onConnection(true);
  es.onerror = () => onConnection(false);
  return () => es.close();
}
