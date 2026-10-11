import { randomUUID } from 'node:crypto';
import type { RelaisEvent } from '../../../core/types.js';
import { isFresh, mapLinearWebhook, verifyLinearSignature, type MapContext } from './webhook.js';

export interface IngestDeps {
  secret: () => string;
  ctx: MapContext;
  submit: (e: RelaisEvent) => void;
  ack: (sessionId: string) => Promise<void>;
  log: (m: string) => void;
}

const ACKED = new Set(['ticket.delegated', 'session.mentioned', 'command']);

export function createLinearIngest(d: IngestDeps) {
  return (raw: string, headers: Record<string, string | undefined>): { status: number } => {
    if (!verifyLinearSignature(raw, headers['linear-signature'], d.secret())) return { status: 401 };
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400 };
    }
    if (!isFresh(body, d.ctx.now())) return { status: 401 };
    const events = mapLinearWebhook(body, headers['linear-delivery'] ?? randomUUID(), d.ctx);
    for (const e of events) {
      const sessionId = (e.payload as { linearSessionId?: string }).linearSessionId;
      if (ACKED.has(e.type) && sessionId) d.ack(sessionId).catch((err: Error) => d.log(`ack failed: ${err.message}`));
      d.submit(e);
    }
    return { status: 200 };
  };
}
