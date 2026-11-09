import type { BusMessage, FlowView, MeasuredTicketView, Snapshot } from './types.js';

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
