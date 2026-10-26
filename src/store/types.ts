import type { InputKind, QueueName, FactoryEvent, RunOutcome, TicketState } from '../core/types.js';

export interface RunRecord {
  id: string;
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  /** `interrupted`: cut by a daemon shutdown; recover() settles it on the next start. */
  status: 'running' | 'interrupted' | RunOutcome;
  claudeSessionId: string;
  linearSessionId?: string;
  startedAt: number;
  endedAt?: number;
  costUsd: number;
  turns: number;
  lastText: string;
  token: string;
  cwd: string;
}

export interface TimerRecord {
  key: string;
  projectId: string;
  ticketId: string;
  job: string;
  fireAt: number;
}

export interface QueueItem {
  projectId: string;
  ticketId: string;
  job: string;
  queue: QueueName;
  input?: InputKind;
  inputText?: string;
  linearSessionId?: string;
  resume?: boolean;
  priority: number;
  enqueuedAt: number;
}

/**
 * The state port. Asynchronous because Postgres is (ORC-132): `SqliteStore` implements it by
 * wrapping its synchronous calls, `PgStore` natively.
 */
export interface Store {
  getTicket(projectId: string, ticketId: string): Promise<TicketState | undefined>;
  putTicket(t: TicketState): Promise<void>;
  listTickets(): Promise<TicketState[]>;
  /** False when an event with this id was already recorded. */
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
  /** Queues an item (deduped by ticket + job) and returns its id. */
  enqueue(q: QueueItem): Promise<string>;
  /** Takes the next item of a queue out of the store: it is not handed out again. */
  dequeue(queue: QueueName): Promise<QueueItem | undefined>;
  listQueue(): Promise<QueueItem[]>;
  /** Drops the ticket's queued runs, of every queue or of `queue` only. */
  removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): Promise<void>;
  putEcho(key: string, until: number): Promise<void>;
  isEcho(key: string, now: number): Promise<boolean>;
  costSince(ts: number): Promise<number>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}
