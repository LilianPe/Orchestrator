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

/** A ticket taken over (ORC-234): `take-over` gives the command of a shell in its container, `take-over/bundle` takes a bundle. */
const takeOverPath = (projectId: string, ticketId: string, rest = '') => `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(ticketId)}/take-over${rest}`;
export const fetchTakeOverShell = (projectId: string, ticketId: string) => fetch(takeOverPath(projectId, ticketId));
export const postBundle = (projectId: string, ticketId: string, file: File) => fetch(takeOverPath(projectId, ticketId, '/bundle'), { method: 'POST', body: file });

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
