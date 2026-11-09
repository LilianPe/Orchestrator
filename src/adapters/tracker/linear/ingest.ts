import type { FactoryEvent } from '../../../core/types.js';
import type { Store } from '../../../store/types.js';
import type { MessageClassifier } from '../../runner/message-classifier.js';
import { serial, type Serial } from './labels.js';
import { deliveryKey, isFresh, issueKeyOf, mapLinearWebhook, mayCarryMessage, messageToClassify, recordIssueLabels, verifyLinearSignature, withVerdict, type MapContext } from './webhook.js';

/** What the store keeps of a delivery answered before the inbox (ORC-336). */
export type DeliveryStore = Pick<Store, 'receiveDelivery' | 'pendingDeliveries' | 'deleteDelivery' | 'asideDelivery' | 'inboxHas'>;

/** How a kept delivery is tried again: from `baseMs`, doubling up to `maxMs`, until `horizonMs` after its first arrival. */
export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  horizonMs: number;
}

export const DELIVERY_RETRY: RetryPolicy = { baseMs: 1_000, maxMs: 5 * 60_000, horizonMs: 60 * 60_000 };

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
  /** Where a delivery answered before the inbox is kept until written (ORC-336): required with `classify`, and read back by `resume` even without it. */
  deliveries?: DeliveryStore;
  retry?: RetryPolicy;
}

/** At most this many classifications at once: past it, a live message gets the fallback rule at once, no process queued. */
export const MAX_CLASSIFICATIONS = 4;
/** A classifier failure is logged once per reason in this window, so a model that never answers shows without flooding. */
const FAILURE_LOG_MS = 10 * 60_000;

interface Delivery {
  raw: string;
  at: number;
}

type KeptDelivery = { delivery: Delivery; body: any };

function readDelivery(value: string): KeptDelivery {
  const delivery = JSON.parse(value) as Delivery;
  if (typeof delivery?.raw !== 'string' || typeof delivery.at !== 'number') throw new Error('not a kept delivery');
  return { delivery, body: JSON.parse(delivery.raw) };
}

/**
 * The Linear webhook (ORC-147). A webhook with no message for the model is answered once its events are in the inbox:
 * 200 means written (or already there), 500 that nothing may have been, and Linear sends it again. A webhook that may
 * carry one (ORC-336) is answered as soon as it is kept in the store, and classified and written after: Linear's
 * answer never waits on the model. A restart writes what was kept and not written (`resume`).
 *
 * ponytail: one daemon delivers the kept rows. Two daemons on one Postgres could both deliver a row (the deliveries
 * have no lease); the inbox keeps each event once by its id, so the cost is a second model call, never a second
 * event. A claim with an owner goes with ORC-129's leases if several daemons ever share a database.
 */
export function createLinearIngest(d: IngestDeps) {
  const retry = d.retry ?? DELIVERY_RETRY;
  // Webhooks are mapped and written one at a time, in arrival order: the echo lookup awaits the
  // store, and a later webhook of the same ticket must not reach the inbox first.
  const inTurn = d.serial ?? serial();
  // Per issue, by its stable id: webhooks are mapped in arrival order and written in arrival order, while their
  // messages are classified side by side; those of other issues wait for none of it.
  const mapped = new Map<string, Promise<unknown>>();
  const written = new Map<string, Promise<unknown>>();
  // The kept deliveries this process is delivering, or keeping (how many at once): a redelivery of one changes nothing.
  const active = new Map<string, number>();
  const failures = new Map<string, number>();
  let classifying = 0;
  // Resumed deliveries wait for a slot rather than take the fallback rule: at most as many as rows kept.
  const waiting: (() => void)[] = [];
  let closed = false;
  // The retries waiting: `close` cuts them short.
  const sleepers = new Set<() => void>();

  /** Logs `message` at most every 10 min for the same `reason`: a fault that lasts shows without flooding. */
  const once = (reason: string, message: string) => {
    const now = Date.now();
    if (now - (failures.get(reason) ?? -Infinity) >= FAILURE_LOG_MS) {
      failures.set(reason, now);
      d.log(`${message}; this reason is logged at most every 10 min`);
    }
  };
  const failed = (reason: string): undefined => {
    once(reason, `message classifier: no verdict (${reason}), the fallback rule classifies`);
    return undefined;
  };

  const settle = (into: Map<string, Promise<unknown>>, issue: string, p: Promise<unknown>) => {
    into.set(issue, p);
    void p.catch(() => undefined).finally(() => {
      if (into.get(issue) === p) into.delete(issue);
    });
  };
  const after = (p: Promise<unknown> | undefined) => (p ?? Promise.resolve()).catch(() => undefined);

  /** Waits `ms`, or less when the ingest closes. */
  const pause = (ms: number) =>
    new Promise<void>((r) => {
      const done = () => {
        clearTimeout(t);
        sleepers.delete(done);
        r();
      };
      const t = setTimeout(done, ms);
      sleepers.add(done);
    });

  /**
   * `work` tried again with backoff until the horizon from `since` (the delivery's first arrival, as kept, so that a
   * restart does not start the hour again): a blip in Linear or the
   * store strands nothing. Past it, or once the ingest closes, it throws: the caller moves the row aside, or leaves it
   * kept for the next start.
   */
  async function tried<T>(key: string, since: number, what: string, work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        const delay = Math.min(retry.baseMs * 2 ** (attempt - 1), retry.maxMs);
        if (closed || d.ctx.now() + delay - since > retry.horizonMs) throw err;
        d.log(`webhook ${key}: ${what} failed (try ${attempt}), tried again in ${Math.round(delay / 1000)} s: ${(err as Error).message}`);
        await pause(delay);
      }
    }
  }

  async function slot(wait: boolean): Promise<boolean> {
    if (classifying < MAX_CLASSIFICATIONS) return (classifying++, true);
    if (!wait) return false;
    // The slot is handed over by `release`, never freed in between: no live message takes it meanwhile.
    await new Promise<void>((r) => waiting.push(r));
    return true;
  }
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else classifying--;
  };

  /** The model's verdict on an event's message, if it has one and the inbox does not hold it yet. */
  async function classified(e: FactoryEvent, key: string, since: number, resumed: boolean): Promise<FactoryEvent> {
    const text = messageToClassify(e);
    if (text === undefined || !d.classify) return e;
    // Only spares a model call for an event the inbox holds already: when the lookup fails, the event is classified anyway.
    const held = await d.deliveries!.inboxHas(e.id).catch((err: Error) => {
      once('inbox lookup', `webhook ${key}: inbox lookup failed, classified anyway: ${err.message}`);
      return false;
    });
    // Stopping: no model call to wait for, the fallback rule the mapping applied stands (ORC-355).
    if (held || closed) return e;
    if (!(await slot(resumed))) return failed(`${MAX_CLASSIFICATIONS} classifications already running`) ?? e;
    try {
      // Closed while it waited for its slot.
      if (closed) return e;
      return withVerdict(e, await d.classify(text).catch((err: Error) => failed(err.message)));
    } finally {
      release();
    }
  }

  async function write(body: any, events: FactoryEvent[]): Promise<void> {
    for (const e of events) await d.accept(e);
    // Only once the events are written: a webhook sent again must not find its change already known.
    await recordIssueLabels(body, d.ctx).catch((err: Error) => d.log(`labels not recorded: ${err.message}`));
  }

  /** Moves a row that will not be written aside: logged, kept for an operator, no longer tried at each start. */
  async function aside(key: string, why: string): Promise<void> {
    d.log(`ERROR: webhook ${key} set aside, not written to the inbox (${why}): its row stays set aside for an operator`);
    await d.deliveries!.asideDelivery(key).catch((err: Error) => d.log(`ERROR: webhook ${key} not set aside: ${err.message}`));
  }

  /** A kept row read back, or moved aside when it cannot be read: never tried again (ORC-355: one helper for both). */
  async function readOrAside(key: string, value: string): Promise<KeptDelivery | undefined> {
    try {
      return readDelivery(value);
    } catch (err) {
      await aside(key, `unreadable: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * A kept delivery: mapped in the turn after the issue's earlier maps, classified out of any turn, written in the turn
   * after the issue's earlier writes, then let go. A webhook with no message waits for the earlier writes before it is
   * mapped, as when it is written before its answer: what it reads (labels known, echoes) is theirs.
   */
  function deliver(key: string, { delivery: { at }, body }: KeptDelivery, o: { resumed?: boolean; kept?: Promise<boolean> } = {}): Promise<void> {
    const issue = issueKeyOf(body) ?? '';
    const message = mayCarryMessage(body);
    // The events' ids: a reply and the comment Linear writes for it share them, and the inbox keeps the first.
    const eventKey = deliveryKey(body);
    // Registered at once, before the row is even kept: a later webhook of the issue goes behind it. Not kept (kept
    // already, or the insert failed): nothing to do, and the chain lets the next one go.
    active.set(key, (active.get(key) ?? 0) + 1);
    const map = after(message ? mapped.get(issue) : written.get(issue)).then(async () => {
      if (!(await (o.kept ?? Promise.resolve(true)))) return undefined;
      return tried(key, at, 'mapping', () => inTurn(() => mapLinearWebhook(body, eventKey, d.ctx, { at })));
    });
    const events = map.then((list) => list && Promise.all(list.map((e) => classified(e, key, at, !!o.resumed))));
    const done = Promise.all([events, after(written.get(issue))]).then(async ([list]) => {
      if (!list) return;
      await tried(key, at, 'inbox write', () => inTurn(() => write(body, list)));
      await tried(key, at, 'kept row removal', () => d.deliveries!.deleteDelivery(key));
    });
    settle(mapped, issue, message ? map : done);
    settle(written, issue, done);
    return done
      .catch(async (err: Error) => {
        // Closing: left kept, the next start writes it.
        if (!closed) await aside(key, `retried for ${Math.round(retry.horizonMs / 60_000)} min: ${err.message}`);
      })
      .finally(() => {
        const n = (active.get(key) ?? 1) - 1;
        if (n) active.set(key, n);
        else active.delete(key);
      });
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
    if (closed) {
      // Stopping: kept for the next start, which writes it; a relay could not send it again. Without a store, 503.
      if (!d.deliveries) return { status: 503 };
      try {
        await d.deliveries.receiveDelivery(`${body.type}:${key}`, JSON.stringify({ raw, at } satisfies Delivery));
      } catch (err) {
        d.log(`webhook not kept: ${(err as Error).message}`);
        return { status: 500 };
      }
      return { status: 200 };
    }
    // Kept, then answered: classified and written after, behind the ticket's earlier webhooks. One that waits behind
    // such a webhook goes the same way, so that the answer never waits on the model.
    if (d.classify && d.deliveries && (mayCarryMessage(body) || written.has(issue))) {
      // Kept by its kind as well: a reply and the comment Linear writes for it share `key`, and neither may drop the other.
      const row = `${body.type}:${key}`;
      // The value kept already, if any: undefined when this request kept it.
      const before = d.deliveries.receiveDelivery(row, JSON.stringify({ raw, at } satisfies Delivery));
      void deliver(row, { delivery: { raw, at }, body }, { kept: before.then((v) => v === undefined, () => false) });
      try {
        // Kept already and no longer being delivered here: delivered again, timed at its first arrival.
        // This request's own `deliver` counts once: another keeps or delivers it when the count is above that.
        const value = await before;
        if (value !== undefined && (active.get(row) ?? 0) <= 1) {
          const read = await readOrAside(row, value);
          if (read) void deliver(row, read);
        }
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
    /**
     * At start, before webhooks are taken: sets the deliveries kept and not written before a stop on their way, in
     * the order received, so that a new webhook of their issue goes behind them. A row that cannot be read is set aside.
     */
    async resume(): Promise<number> {
      const kept = (await d.deliveries?.pendingDeliveries()) ?? [];
      for (const { key, value } of kept) {
        const row = await readOrAside(key, value);
        if (row) void deliver(key, row, { resumed: true });
      }
      return kept.length;
    },
    /** Resolves once every webhook taken so far is written, given up, or left kept by `close`. */
    async settled(): Promise<void> {
      while (written.size) await Promise.allSettled([...written.values()]);
    },
    /**
     * Stopping: a webhook still received is kept for the next start, not delivered (503 only without a store), and the
     * retries stop short: what is not written stays kept. The relay is closed before, so that nothing is refused.
     */
    close(): void {
      closed = true;
      for (const done of [...sleepers]) done();
    },
  });
}
