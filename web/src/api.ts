import type { BusMessage, FlowView, MeasuredTicketView, RunDetailView, Snapshot } from './types.js';

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
  for (const kind of ['event', 'command', 'run', 'ticket', 'log']) {
    es.addEventListener(kind, (e) => onMessage(JSON.parse((e as MessageEvent).data) as BusMessage));
  }
  es.onopen = () => onConnection(true);
  es.onerror = () => onConnection(false);
  return () => es.close();
}
