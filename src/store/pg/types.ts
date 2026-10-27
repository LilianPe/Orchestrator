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
 * The `Store` port as Postgres serves it, plus the raw queue claim `claimQueued` builds on: `claim`
 * hands a queue row out under a lease (`FOR UPDATE SKIP LOCKED`), and `completeEffect` settles it.
 */
export interface AsyncStore extends Store {
  putTicket(t: TicketState, options?: PutTicketOptions): Promise<void>;
  claim(queue: QueueName, now?: number, leaseMs?: number, token?: string): Promise<DequeuedEffect | undefined>;
}
