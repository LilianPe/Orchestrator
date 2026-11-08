import type { FactoryEvent } from '../../../core/types.js';
import type { MessageClassifier } from '../../runner/message-classifier.js';
import { serial, type Serial } from './labels.js';
import { deliveryKey, isFresh, issueKeyOf, mapLinearWebhook, mayCarryMessage, messageToClassify, recordIssueLabels, verifyLinearSignature, withVerdict, type MapContext } from './webhook.js';

/** What the store keeps of a delivery answered before the inbox (ORC-336). */
export interface DeliveryStore {
  receiveDelivery(key: string, value: string): Promise<boolean>;
  pendingDeliveries(): Promise<{ key: string; value: string }[]>;
  deleteDelivery(key: string): Promise<void>;
  inboxHas(id: string): Promise<boolean>;
}

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
  /** The small model that classifies a message (ORC-336); without it, the fallback rule alone, and every webhook is written before its answer. */
  classify?: MessageClassifier;
  /** Where a delivery answered before the inbox is kept until written (ORC-336); required with `classify`. */
  deliveries?: DeliveryStore;
}

/** At most this many classifications at once: past it, a message gets the fallback rule at once, no process queued. */
export const MAX_CLASSIFICATIONS = 4;
/** A classifier failure is logged once per reason in this window, so a model that never answers shows without flooding. */
const FAILURE_LOG_MS = 10 * 60_000;
/** Tries of a delivery whose write fails; past them it stays kept, for the next start. */
const WRITE_TRIES = 5;
const WRITE_RETRY_MS = 1_000;

interface Delivery {
  raw: string;
  at: number;
}

/**
 * The Linear webhook (ORC-147). A webhook with no message for the model is answered once its events are in the inbox:
 * 200 means written (or already there), 500 that nothing may have been, and Linear sends it again. A webhook that may
 * carry one (ORC-336) is answered as soon as it is kept in the store, and classified and written after: Linear's
 * answer never waits on the model. A restart writes what was kept and not written (`resume`).
 */
export function createLinearIngest(d: IngestDeps) {
  // Webhooks are mapped and written one at a time, in arrival order: the echo lookup awaits the
  // store, and a later webhook of the same ticket must not reach the inbox first.
  const inTurn = d.serial ?? serial();
  // Per issue, by its stable id: webhooks are mapped in arrival order and written in arrival order, while their
  // messages are classified side by side; those of other issues wait for none of it.
  const mapped = new Map<string, Promise<unknown>>();
  const written = new Map<string, Promise<unknown>>();
  const failures = new Map<string, number>();
  let classifying = 0;

  const failed = (reason: string): undefined => {
    const now = Date.now();
    if (now - (failures.get(reason) ?? -Infinity) >= FAILURE_LOG_MS) {
      failures.set(reason, now);
      d.log(`message classifier: no verdict (${reason}), the fallback rule classifies; this reason is logged at most every 10 min`);
    }
    return undefined;
  };

  const settle = (into: Map<string, Promise<unknown>>, issue: string, p: Promise<unknown>) => {
    into.set(issue, p);
    void p.catch(() => undefined).finally(() => {
      if (into.get(issue) === p) into.delete(issue);
    });
  };
  const after = (p: Promise<unknown> | undefined) => (p ?? Promise.resolve()).catch(() => undefined);

  /** `work` tried again on failure, `WRITE_TRIES` times in all; past them, the delivery stays kept for the next start. */
  async function tried<T>(key: string, work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        d.log(`webhook ${key} not written to the inbox (try ${attempt} of ${WRITE_TRIES}): ${(err as Error).message}`);
        if (attempt >= WRITE_TRIES) throw err;
        await new Promise((r) => setTimeout(r, WRITE_RETRY_MS * 2 ** (attempt - 1)));
      }
    }
  }

  /** The model's verdict on an event's message, if it has one, the inbox does not hold it yet, and a slot is free. */
  async function classified(e: FactoryEvent): Promise<FactoryEvent> {
    const text = messageToClassify(e);
    if (text === undefined || !d.classify || (await d.deliveries?.inboxHas(e.id))) return e;
    if (classifying >= MAX_CLASSIFICATIONS) return failed(`${MAX_CLASSIFICATIONS} classifications already running`) ?? e;
    classifying++;
    try {
      return withVerdict(e, await d.classify(text).catch((err: Error) => failed(err.message)));
    } finally {
      classifying--;
    }
  }

  async function write(body: any, events: FactoryEvent[]): Promise<void> {
    for (const e of events) await d.accept(e);
    // Only once the events are written: a webhook sent again must not find its change already known.
    await recordIssueLabels(body, d.ctx).catch((err: Error) => d.log(`labels not recorded: ${err.message}`));
  }

  /**
   * A kept delivery: mapped in the turn after the issue's earlier maps, classified out of any turn, written in the turn
   * after the issue's earlier writes, then let go. A webhook with no message waits for the earlier writes before it is
   * mapped, as when it is written before its answer: what it reads (labels known, echoes) is theirs.
   */
  function deliver(key: string, { raw, at }: Delivery): Promise<void> {
    const body = JSON.parse(raw);
    const issue = issueKeyOf(body) ?? '';
    const message = mayCarryMessage(body);
    const map = after(message ? mapped.get(issue) : written.get(issue)).then(() => tried(key, () => inTurn(() => mapLinearWebhook(body, key, d.ctx, { at }))));
    const events = map.then((list) => Promise.all(list.map(classified)));
    const done = Promise.all([events, after(written.get(issue))]).then(async ([list]) => {
      await tried(key, () => inTurn(() => write(body, list)));
      await d.deliveries!.deleteDelivery(key);
    });
    settle(mapped, issue, message ? map : done);
    settle(written, issue, done);
    return done.catch(() => undefined);
  }

  const ingest = async (raw: string, headers: Record<string, string | undefined>): Promise<{ status: number }> => {
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
    const issue = issueKeyOf(body) ?? '';
    // Kept, then answered: classified and written after, behind the ticket's earlier webhooks. One that waits behind
    // such a webhook goes the same way, so that the answer never waits on the model.
    if (d.classify && d.deliveries && (mayCarryMessage(body) || written.has(issue))) {
      try {
        // Kept already: answered, written once by the first.
        if (await d.deliveries.receiveDelivery(key, JSON.stringify({ raw, at } satisfies Delivery))) void deliver(key, { raw, at });
      } catch (err) {
        d.log(`webhook not kept: ${(err as Error).message}`);
        return { status: 500 };
      }
      return { status: 200 };
    }
    const done = after(written.get(issue)).then(() => inTurn(async () => write(body, await mapLinearWebhook(body, key, d.ctx, { at }))));
    settle(mapped, issue, done);
    settle(written, issue, done);
    try {
      await done;
    } catch (err) {
      d.log(`webhook not written to the inbox: ${(err as Error).message}`);
      return { status: 500 };
    }
    return { status: 200 };
  };

  return Object.assign(ingest, {
    /** At start: writes the deliveries kept and not written before a stop, in the order received. */
    async resume(): Promise<number> {
      const kept = (await d.deliveries?.pendingDeliveries()) ?? [];
      for (const { key, value } of kept) void deliver(key, JSON.parse(value) as Delivery);
      return kept.length;
    },
    /** Resolves once every webhook taken so far is written, or given up: for tests and a clean stop. */
    async settled(): Promise<void> {
      while (written.size) await Promise.allSettled([...written.values()]);
    },
  });
}
