import type { FactoryEvent } from '../../../core/types.js';
import { deliveryKey, isFresh, mapLinearWebhook, verifyLinearSignature, type MapContext } from './webhook.js';

export interface IngestDeps {
  secret: () => string;
  ctx: MapContext;
  /**
   * Writes an event to the inbox (ORC-147) and resolves once it is committed: `false` when the
   * inbox already holds its id. Rejects when the write fails.
   */
  accept: (e: FactoryEvent) => Promise<boolean>;
  ack: (sessionId: string) => Promise<void>;
  /** Records that the event got its ack, once posted: the first sign of life a measure reads (ORC-235). */
  acked?: (eventId: string) => Promise<void>;
  log: (m: string) => void;
}

const ACKED = new Set(['ticket.delegated', 'session.mentioned', 'command']);

/**
 * The Linear webhook (ORC-147): the response comes only once the events are in the inbox. 200
 * means written (or already there: a replay is a duplicate by event id, before or after a
 * restart); 500 means nothing may have been written, and Linear sends the webhook again.
 */
export function createLinearIngest(d: IngestDeps) {
  // Webhooks are mapped and written one at a time, in arrival order: the echo lookup awaits the
  // store, and a later webhook of the same ticket must not reach the inbox first.
  let tail: Promise<unknown> = Promise.resolve();
  return async (raw: string, headers: Record<string, string | undefined>): Promise<{ status: number }> => {
    if (!verifyLinearSignature(raw, headers['linear-signature'], d.secret())) return { status: 401 };
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400 };
    }
    if (!isFresh(body, d.ctx.now())) return { status: 401 };
    const key = deliveryKey(body);
    const turn = tail.then(async () => {
      const events = await mapLinearWebhook(body, key, d.ctx);
      for (const e of events) {
        // A duplicate (already in the inbox) is neither acked nor processed again.
        if (!(await d.accept(e))) continue;
        const sessionId = (e.payload as { linearSessionId?: string }).linearSessionId;
        if (ACKED.has(e.type) && sessionId) {
          d.ack(sessionId)
            .then(() => d.acked?.(e.id))
            .catch((err: Error) => d.log(`ack failed: ${err.message}`));
        }
      }
    });
    tail = turn.catch(() => undefined);
    try {
      await turn;
    } catch (err) {
      d.log(`webhook not written to the inbox: ${(err as Error).message}`);
      return { status: 500 };
    }
    return { status: 200 };
  };
}
