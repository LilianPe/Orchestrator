export const LOGICAL_STATES = ['todo', 'dev', 'human_review', 'ai_review', 'ready', 'done'] as const;
export type LogicalState = (typeof LOGICAL_STATES)[number];
export function isLogicalState(v: string): v is LogicalState {
  return (LOGICAL_STATES as readonly string[]).includes(v);
}

export type RunOutcome = 'success' | 'failure' | 'stopped' | 'limit';
export type InputKind = 'feedback' | 'ci_failures' | 'thread' | 'verify_failures';
export type QueueName = 'dev' | 'questions';

export interface FeedbackItem {
  author: string;
  body: string;
  at: number;
  source: 'session' | 'review' | 'label' | 'verify' | 'ci';
}

export interface VerifyFailure {
  command: string;
  exitCode: number | null;
  output: string;
}

export interface PrPayload {
  number: number;
  url: string;
  branch: string;
}

export interface EventPayloads {
  'ticket.delegated': { linearSessionId?: string; promptContext?: string };
  'session.mentioned': { linearSessionId: string; body: string; author: string };
  'session.prompted': { linearSessionId: string; body: string; author: string };
  'session.stopped': { linearSessionId?: string };
  'ticket.moved': { from: LogicalState | null; to: LogicalState | null };
  'label.added': { label: string };
  command: { name: string; body: string; linearSessionId: string; author: string };
  'pr.opened': PrPayload;
  'pr.checks_passed': PrPayload;
  'pr.checks_failed': PrPayload & { failures: string[] };
  'pr.merged': PrPayload;
  'pr.closed': PrPayload;
  'run.finished': { runId: string; job: string; outcome: RunOutcome; costUsd: number; turns: number; lastText: string };
  'verify.passed': { runId: string; job: string };
  'verify.failed': { runId: string; job: string; failures: VerifyFailure[] };
  'debounce.fired': { job: string };
  'control.pause': Record<string, never>;
  'control.resume': Record<string, never>;
  'control.stop': Record<string, never>;
}

export type EventType = keyof EventPayloads;

export type RelaisEvent<T extends EventType = EventType> = {
  [K in T]: {
    id: string;
    type: K;
    at: number;
    projectId: string;
    ticketId?: string;
    payload: EventPayloads[K];
  };
}[T];

export interface TicketState {
  projectId: string;
  ticketId: string;
  title: string;
  logical: LogicalState;
  blocked: boolean;
  blockReason?: string;
  claudeSessionId?: string;
  linearSessionId?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  prChecks?: 'pending' | 'pass' | 'fail' | 'none';
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  worktreePath?: string;
  port?: number;
  activeRunId?: string;
  pendingJob?: { job: string; input?: InputKind; inputText?: string; resume?: boolean };
  verifyAttempts: number;
  pendingFeedback: FeedbackItem[];
  priority: number;
  costUsd: number;
  updatedAt: number;
}

export function newTicketState(
  projectId: string,
  ticketId: string,
  title: string,
  logical: LogicalState,
  now: number,
  priority = 0,
): TicketState {
  return {
    projectId,
    ticketId,
    title,
    logical,
    blocked: false,
    verifyAttempts: 0,
    pendingFeedback: [],
    priority,
    costUsd: 0,
    updatedAt: now,
  };
}
