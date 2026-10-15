import { EventSource } from 'eventsource';

export interface RelayOptions {
  url: string;
  onWebhook: (raw: string, headers: Record<string, string | undefined>) => { status: number };
  log: (m: string) => void;
}

const REJECTED_401_HINT =
  'wrong webhook secret, clock skew over 60 s, or a body smee.io cannot replay byte for byte: ' +
  'smee.io re-serializes the JSON it receives, so a signature over other bytes no longer matches; ' +
  'if secret and clock are right, set publicUrl instead of the smee relay';

export function startSmeeRelay(o: RelayOptions): { close(): void } {
  const es = new EventSource(o.url);
  // eventsource v3 types its own MessageEvent; adapt the annotation if tsc complains.
  es.addEventListener('message', (msg: MessageEvent) => {
    try {
      const data = JSON.parse(String(msg.data)) as Record<string, unknown>;
      if (!('body' in data)) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
      // smee.io forwards only the parsed body: JSON.stringify restores Linear's bytes only when Linear itself
      // produced them with compact JSON.stringify, which is what it sends today.
      const { status } = o.onWebhook(JSON.stringify(data['body']), headers);
      if (status === 401) o.log(`relay: webhook rejected with 401 (${REJECTED_401_HINT})`);
      else if (status !== 200) o.log(`relay: webhook rejected with ${status}`);
    } catch (err) {
      o.log(`relay: bad message (${(err as Error).message})`);
    }
  });
  es.addEventListener('error', () => o.log('relay: connection error, retrying'));
  return { close: () => es.close() };
}

export async function createSmeeChannel(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl('https://smee.io/new', { method: 'HEAD', redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error('smee.io did not return a channel URL');
  return new URL(location, 'https://smee.io').toString();
}
