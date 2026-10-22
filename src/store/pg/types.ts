import type { FactoryEvent, QueueName, TicketState } from '../../core/types.js';
import type { QueueItem, RunRecord, TimerRecord } from '../types.js';

/**
 * An outbox row claimed by `dequeue`: the caller runs `effect` with `id` as the idempotency key.
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
 * Async port of `Store`, backed by Postgres. It mirrors the current `Store` methods so part 2 can
 * switch callers one at a time. `enqueue` returns the outbox id and `dequeue` returns the claimed
 * effect (not just its payload), because the outbox needs the id for idempotency.
 */
export interface AsyncStore {
  getTicket(projectId: string, ticketId: string): Promise<TicketState | undefined>;
  putTicket(t: TicketState, options?: PutTicketOptions): Promise<void>;
  listTickets(): Promise<TicketState[]>;
  recordEvent(e: FactoryEvent): Promise<boolean>;
  recentEvents(limit: number, ticketId?: string): Promise<FactoryEvent[]>;
  putRun(r: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  runsByStatus(status: RunRecord['status']): Promise<RunRecord[]>;
  findRunByToken(token: string): Promise<RunRecord | undefined>;
  putTimer(t: TimerRecord): Promise<void>;
  dueTimers(now: number): Promise<TimerRecord[]>;
  deleteTimer(key: string): Promise<void>;
  deleteTimersFor(projectId: string, ticketId: string): Promise<void>;
  enqueue(q: QueueItem): Promise<string>;
  dequeue(queue: QueueName, now?: number): Promise<DequeuedEffect | undefined>;
  listQueue(): Promise<QueueItem[]>;
  removeFromQueue(projectId: string, ticketId: string): Promise<void>;
  putEcho(key: string, until: number): Promise<void>;
  isEcho(key: string, now: number): Promise<boolean>;
  costSince(ts: number): Promise<number>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
