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

export interface Store {
  getTicket(projectId: string, ticketId: string): TicketState | undefined;
  putTicket(t: TicketState): void;
  listTickets(): TicketState[];
  recordEvent(e: FactoryEvent): boolean;
  recentEvents(limit: number, ticketId?: string): FactoryEvent[];
  putRun(r: RunRecord): void;
  getRun(id: string): RunRecord | undefined;
  runsByStatus(status: RunRecord['status']): RunRecord[];
  findRunByToken(token: string): RunRecord | undefined;
  putTimer(t: TimerRecord): void;
  dueTimers(now: number): TimerRecord[];
  deleteTimer(key: string): void;
  deleteTimersFor(projectId: string, ticketId: string): void;
  enqueue(q: QueueItem): void;
  dequeue(queue: QueueName): QueueItem | undefined;
  listQueue(): QueueItem[];
  /** Drops the ticket's queued runs, of every queue or of `queue` only. */
  removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): void;
  putEcho(key: string, until: number): void;
  isEcho(key: string, now: number): boolean;
  costSince(ts: number): number;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  close(): void;
}
