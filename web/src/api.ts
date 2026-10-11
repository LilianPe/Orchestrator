import type { BusMessage, Snapshot } from './types.js';

export async function fetchSnapshot(): Promise<Snapshot> {
  return (await fetch('/api/state')).json();
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
