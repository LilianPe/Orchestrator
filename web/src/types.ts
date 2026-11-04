import type { BlockCause } from '../../src/core/block-cause.js';

export type Logical = 'todo' | 'dev' | 'human_review' | 'ai_review' | 'ready' | 'done';

export interface TicketView {
  projectId: string;
  ticketId: string;
  title: string;
  logical: Logical;
  blocked: boolean;
  blockReason?: string;
  activeRunId?: string;
  prUrl?: string;
  costUsd: number;
  updatedAt: number;
}

export interface RunView {
  id: string;
  ticketId: string;
  job: string;
  startedAt: number;
  turns: number;
  costUsd: number;
}

export interface QueueView {
  ticketId: string;
  job: string;
  queue: 'dev' | 'questions';
}

export interface Snapshot {
  paused: boolean;
  linearConnected: boolean;
  tickets: TicketView[];
  queue: QueueView[];
  activeRuns: RunView[];
  costTodayUsd: number;
  budgetUsd: number | null;
  capacity: { dev: { used: number; total: number }; questions: { used: number; total: number } };
}

export interface FlowTicketView {
  projectId: string;
  ticketId: string;
  title: string;
  prUrl?: string;
}

export interface WorkingRunView extends FlowTicketView {
  runId: string;
  step: string;
  verifying: boolean;
  stoppable: boolean;
  durationMs: number;
  measured: boolean;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  attemptsWithoutTokens: number;
  costUsd: number;
}

/** `GET /api/flow`: `Flow` of src/server/flow.ts. */
export interface FlowView {
  needsYou: {
    blocked: { cause: BlockCause; tickets: (FlowTicketView & { reason: string })[] }[];
    humanReview: FlowTicketView[];
    gates: (FlowTicketView & { gate: 'merge' })[];
  };
  working: WorkingRunView[];
  queued: { ticketId: string; job: string }[];
  done: FlowTicketView[];
  others: FlowTicketView[];
}

export type RunLine =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'tool_result'; isError: boolean }
  | { kind: 'result'; isError: boolean; costUsd: number; turns: number; text: string };

export interface EventView {
  id: string;
  type: string;
  at: number;
  projectId: string;
  ticketId?: string;
  payload: unknown;
}

export type BusMessage =
  | { kind: 'event'; event: EventView }
  | { kind: 'command'; projectId: string; ticketId?: string; command: { kind: string } }
  | { kind: 'run'; runId: string; ticketId: string; ev: RunLine }
  | { kind: 'ticket'; ticket: TicketView }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };
