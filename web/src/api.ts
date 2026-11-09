import type { BlockParetoView, BusMessage, FlowView, MeasuredTicketView, RunSecurityView, SecurityPeriodView, Snapshot } from './types.js';

export async function fetchSnapshot(): Promise<Snapshot> {
  return (await fetch('/api/state')).json();
}

export async function fetchFlow(): Promise<FlowView> {
  const res = await fetch('/api/flow');
  if (!res.ok) throw new Error(`/api/flow: ${res.status}`);
  return res.json();
}

export async function fetchMeasures(): Promise<MeasuredTicketView[]> {
  const res = await fetch('/api/measures');
  if (!res.ok) throw new Error(`/api/measures: ${res.status}`);
  return ((await res.json()) as { tickets: MeasuredTicketView[] }).tickets;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** The security log and the Pareto of the blocks over `[since, until)` (ORC-300). */
export const fetchSecurity = (since: number, until: number) => getJson<SecurityPeriodView>(`/api/security?since=${since}&until=${until}`);
export const fetchBlocks = (since: number, until: number) => getJson<BlockParetoView>(`/api/blocks?since=${since}&until=${until}`);
export const fetchRunSecurity = (runId: string) => getJson<RunSecurityView>(`/api/security/runs/${encodeURIComponent(runId)}`);

export const post = (path: string) => fetch(path, { method: 'POST' });

export function subscribe(onMessage: (m: BusMessage) => void, onConnection: (c: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  for (const kind of ['event', 'command', 'run', 'ticket', 'log']) {
    es.addEventListener(kind, (e) => onMessage(JSON.parse((e as MessageEvent).data) as BusMessage));
  }
  es.onopen = () => onConnection(true);
  es.onerror = () => onConnection(false);
  return () => es.close();
}
