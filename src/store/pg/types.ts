import type { QueueName, TicketState } from '../../core/types.js';
import type { QueueItem, Store } from '../types.js';

/**
 * An outbox row claimed by `claim`: the caller runs `effect` with `id` as the idempotency key.
 * `payload` is the queued `QueueItem` for the current engine; the outbox is deliberately more
 * general than the queue it replaces.
 */
export interface DequeuedEffect {
  id: string;
  ticketId: string;
  effect: string;
  payload: QueueItem;
  status: 'running';
  attempts: number;
  availableAt: number;
  leaseUntil: number;
}

export interface PutTicketOptions {
  /** Workflow definition hash that produced this projection; omitted leaves the previous value. */
  workflowHash?: string;
}

/**
 * The `Store` port as Postgres serves it, plus the outbox operations the effect executors of
 * ORC-150 build on. `dequeue` (from `Store`) takes an item out for good, as the SQLite queue did;
 * `claim` hands it out under a lease instead, and `completeEffect` settles it.
 */
export interface AsyncStore extends Store {
  putTicket(t: TicketState, options?: PutTicketOptions): Promise<void>;
  claim(queue: QueueName, now?: number): Promise<DequeuedEffect | undefined>;
}
