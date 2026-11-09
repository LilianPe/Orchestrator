import type { BlockParetoView, BusMessage, FlowView, MeasuredTicketView, RunDetailView, RunSecurityView, SecurityPeriodView, Snapshot } from './types.js';

export async function fetchSnapshot(): Promise<Snapshot> {
  return (await fetch('/api/state')).json();
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchFlow = () => getJson<FlowView>('/api/flow');

export const fetchMeasures = async () => (await getJson<{ tickets: MeasuredTicketView[] }>('/api/measures')).tickets;

/** The security log and the Pareto of the blocks over `[since, until)` (ORC-300). */
export const fetchSecurity = (since: number, until: number) => getJson<SecurityPeriodView>(`/api/security?since=${since}&until=${until}`);
export const fetchBlocks = (since: number, until: number) => getJson<BlockParetoView>(`/api/blocks?since=${since}&until=${until}`);
export const fetchRunSecurity = (runId: string) => getJson<RunSecurityView>(`/api/security/runs/${encodeURIComponent(runId)}`);

/** The detail of a run (ORC-298); undefined when the server knows no such run. */
export async function fetchRunDetail(runId: string): Promise<RunDetailView | undefined> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`/api/runs/${runId}: ${res.status}`);
  return res.json();
}

export const post = (path: string) => fetch(path, { method: 'POST' });

export function subscribe(onMessage: (m: BusMessage) => void, onConnection: (c: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  for (const kind of ['event', 'command', 'run', 'activity', 'ticket', 'log']) {
    es.addEventListener(kind, (e) => onMessage(JSON.parse((e as MessageEvent).data) as BusMessage));
  }
  es.onopen = () => onConnection(true);
  es.onerror = () => onConnection(false);
  return () => es.close();
}
