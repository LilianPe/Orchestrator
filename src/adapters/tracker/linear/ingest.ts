import type { ModelVerdict } from '../../../core/human-message.js';
import type { FactoryEvent } from '../../../core/types.js';
import type { MessageClassifier } from '../../runner/message-classifier.js';
import { serial, type Serial } from './labels.js';
import { deliveryKey, isFresh, issueIdentifier, mapLinearWebhook, messageToClassify, recordIssueLabels, verifyLinearSignature, type MapContext } from './webhook.js';

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
  /** The small model that classifies a message (ORC-336); without it, the fallback rule alone. */
  classify?: MessageClassifier;
  /** Whether the inbox already holds an event id: a redelivered webhook asks no model again. */
  inboxHas?: (id: string) => Promise<boolean>;
}

/** A classifier failure is logged once per reason in this window, so a model that never answers shows without flooding. */
const FAILURE_LOG_MS = 10 * 60_000;

/**
 * The Linear webhook (ORC-147): the response comes only once the events are in the inbox. 200
 * means written (or already there: a replay is a duplicate by event id, before or after a
 * restart); 500 means nothing may have been written, and Linear sends the webhook again.
 */
export function createLinearIngest(d: IngestDeps) {
  // Webhooks are mapped and written one at a time, in arrival order: the echo lookup awaits the
  // store, and a later webhook of the same ticket must not reach the inbox first.
  const inTurn = d.serial ?? serial();
  // A webhook waits for the earlier ones of its ticket, not for those of other tickets (ORC-336).
  const tails = new Map<string, Promise<unknown>>();
  // One call per delivery, however often Linear sends it meanwhile.
  const inFlight = new Map<string, Promise<ModelVerdict>>();
  const failures = new Map<string, number>();

  const failed = (reason: string): undefined => {
    const now = Date.now();
    if (now - (failures.get(reason) ?? -Infinity) >= FAILURE_LOG_MS) {
      failures.set(reason, now);
      d.log(`message classifier: no verdict (${reason}), the fallback rule classifies; this reason is logged at most every 10 min`);
    }
    return undefined;
  };

  /**
   * The model's verdict on the webhook's message, outside the turn: classifications run side by side, and nothing
   * else waits for them. Nothing for a webhook without a message to classify, or one the inbox already holds.
   */
  async function verdictOf(body: any, key: string): Promise<ModelVerdict> {
    const classify = d.classify;
    if (!classify) return undefined;
    const text = await messageToClassify(body, d.ctx);
    if (text === undefined || (await d.inboxHas?.(`linear:${key}`))) return undefined;
    let call = inFlight.get(key);
    if (!call) {
      call = classify(text).catch((err: Error) => failed(err.message));
      inFlight.set(key, call);
      void call.finally(() => inFlight.delete(key));
    }
    return call;
  }

  return async (raw: string, headers: Record<string, string | undefined>): Promise<{ status: number }> => {
    if (!verifyLinearSignature(raw, headers['linear-signature'], d.secret())) return { status: 401 };
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400 };
    }
    // The webhook's arrival: the sign of life is measured from here, before any wait (ORC-336).
    const at = d.ctx.now();
    if (!isFresh(body, at)) return { status: 401 };
    const key = deliveryKey(body);
    const verdict = verdictOf(body, key).catch((err: Error) => failed(err.message));
    const ticket = issueIdentifier(body) ?? '';
    const before = tails.get(ticket);
    const turn = Promise.all([verdict, before?.catch(() => undefined)]).then(([v]) =>
      inTurn(async () => {
        const events = await mapLinearWebhook(body, key, d.ctx, { at, verdict: v });
        for (const e of events) await d.accept(e);
        // Only once the events are written: a webhook sent again must not find its change already known.
        await recordIssueLabels(body, d.ctx).catch((err: Error) => d.log(`labels not recorded: ${err.message}`));
      }),
    );
    tails.set(ticket, turn);
    void turn.catch(() => undefined).finally(() => {
      if (tails.get(ticket) === turn) tails.delete(ticket);
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
