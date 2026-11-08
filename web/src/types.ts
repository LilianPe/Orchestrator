import type { BlockCause } from '../../src/core/block-cause.js';

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
  /** Until when (ms) the Claude account's usage limit holds every launch (ORC-340); null when it holds none. Absent from an older server. */
  usageLimitedUntil?: number | null;
  linearConnected: boolean;
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
  tokens: TokensView | null;
  attemptsWithoutTokens: number;
  costUsd: number;
}

/** `GET /api/flow`: `Flow` of src/server/flow.ts, which the web's types cannot import (it reaches Node's). */
export interface FlowView {
  needsYou: {
    blocked: { cause: BlockCause; tickets: (FlowTicketView & { reason: string })[] }[];
    humanReview: FlowTicketView[];
    gates: FlowTicketView[];
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
  | { kind: 'ticket' }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: number };

export type TokensView = { input: number; output: number; cacheRead: number; cacheCreation: number };

/** One attempt of a ticket: `RunMeasure` of src/core/measures.ts (ORC-223). */
export interface RunMeasureView {
  id: string;
  job: string;
  role: 'implementer' | 'reviewer' | 'answerer' | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  tokens: TokensView | null;
  costUsd: number;
  turns: number;
}

/** The part of `TicketMeasures` of src/core/measures.ts the dashboard reads (ORC-223). */
export interface TicketMeasuresView {
  mergedAt: number | null;
  tokens: TokensView | null;
  attempts: number;
  attemptsWithoutTokens: number;
  firstTry: boolean | null;
  reworks: { cause: string; id: string }[];
  revertedWithin14Days: boolean | null;
  ciCost: { durationMs: number; runs: number } | null;
  messages: { eventId: string; type: string; kind: string; at: number; signOfLifeMs: number | null; answerMs: number | null }[];
  startedAt: number | null;
  leadTimeMs: number | null;
  workMs: number;
  costUsd: number;
  reviewRounds: { ai: number; human: number };
  runs: RunMeasureView[];
}

/** An entry of `GET /api/measures`; `measures` null when they could not be read. */
export interface MeasuredTicketView extends FlowTicketView {
  logical: string;
  blocked: boolean;
  measures: TicketMeasuresView | null;
}
