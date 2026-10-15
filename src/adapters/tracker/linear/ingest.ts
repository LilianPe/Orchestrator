import type { RelaisEvent } from '../../../core/types.js';
import { deliveryKey, FRESHNESS_MS, isFresh, mapLinearWebhook, verifyLinearSignature, type MapContext } from './webhook.js';

export interface IngestDeps {
  secret: () => string;
  ctx: MapContext;
  submit: (e: RelaisEvent) => void;
  ack: (sessionId: string) => Promise<void>;
  log: (m: string) => void;
}

const ACKED = new Set(['ticket.delegated', 'session.mentioned', 'command']);
// A replay is rejected as stale before its key expires.
const SEEN_TTL_MS = 2 * FRESHNESS_MS;

export function createLinearIngest(d: IngestDeps) {
  const seen = new Map<string, number>();
  return (raw: string, headers: Record<string, string | undefined>): { status: number } => {
    if (!verifyLinearSignature(raw, headers['linear-signature'], d.secret())) return { status: 401 };
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400 };
    }
    const now = d.ctx.now();
    if (!isFresh(body, now)) return { status: 401 };
    for (const [k, at] of seen) {
      if (now - at <= SEEN_TTL_MS) break;
      seen.delete(k);
    }
    const key = deliveryKey(body, raw);
    if (seen.has(key)) return { status: 200 };
    const events = mapLinearWebhook(body, key, d.ctx);
    for (const e of events) {
      const sessionId = (e.payload as { linearSessionId?: string }).linearSessionId;
      if (ACKED.has(e.type) && sessionId) d.ack(sessionId).catch((err: Error) => d.log(`ack failed: ${err.message}`));
      d.submit(e);
    }
    seen.set(key, now);
    return { status: 200 };
  };
}
