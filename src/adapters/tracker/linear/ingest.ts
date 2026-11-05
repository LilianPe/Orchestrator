import type { FactoryEvent } from '../../../core/types.js';
import { serial, type Serial } from './labels.js';
import { deliveryKey, isFresh, mapLinearWebhook, recordIssueLabels, verifyLinearSignature, type MapContext } from './webhook.js';

export interface IngestDeps {
  secret: () => string;
  ctx: MapContext;
  /**
   * Writes an event to the inbox (ORC-147) and resolves once it is committed, or when the inbox
   * already holds its id. Rejects when the write fails.
   */
  accept: (e: FactoryEvent) => Promise<unknown>;
  log: (m: string) => void;
  /** The turn the reconciliation shares, around the known labels (ORC-185); one of its own otherwise. */
  serial?: Serial;
}

/**
 * The Linear webhook (ORC-147): the response comes only once the events are in the inbox. 200
 * means written (or already there: a replay is a duplicate by event id, before or after a
 * restart); 500 means nothing may have been written, and Linear sends the webhook again.
 */
export function createLinearIngest(d: IngestDeps) {
  // Webhooks are mapped and written one at a time, in arrival order: the echo lookup awaits the
  // store, and a later webhook of the same ticket must not reach the inbox first.
  const inTurn = d.serial ?? serial();
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
    const turn = inTurn(async () => {
      const events = await mapLinearWebhook(body, key, d.ctx);
      for (const e of events) await d.accept(e);
      // Only once the events are written: a webhook sent again must not find its change already known.
      await recordIssueLabels(body, d.ctx).catch((err: Error) => d.log(`labels not recorded: ${err.message}`));
    });
    try {
      await turn;
    } catch (err) {
      d.log(`webhook not written to the inbox: ${(err as Error).message}`);
      return { status: 500 };
    }
    return { status: 200 };
  };
}
