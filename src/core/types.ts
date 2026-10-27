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
  /**
   * Taint of the event that brought the item; a run that consumes the pending feedback is as untrusted
   * as its least trusted item (I12). Absent on items written before ORC-269, when no source marked an
   * event untrusted (ORC-160): `decide` reads them as trusted, as `upcast` reads a version 1 event.
   */
  taint?: Taint;
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

/** What the factory needs to start tracking a ticket, read from the tracker when the event comes in. */
export interface IssueSnapshot {
  title: string;
  logical: LogicalState;
  priority: number;
}

/** The result of an outbox effect, back through the inbox as `effect:<id>` (ORC-150). */
export interface EffectResultPayload {
  /** Outbox id of the effect, `ticket:seq:i`. */
  effectId: string;
  kind: string;
  /** The event whose decision wrote the effect. */
  eventId: string;
  attempts: number;
}

export interface EventPayloads {
  'ticket.delegated': { linearSessionId?: string; promptContext?: string; issue?: IssueSnapshot };
  'ticket.undelegated': Record<string, never>;
  'session.mentioned': { linearSessionId: string; body: string; author: string; issue?: IssueSnapshot };
  'session.prompted': { linearSessionId: string; body: string; author: string; issue?: IssueSnapshot };
  'session.stopped': { linearSessionId?: string };
  'status.changed': { from: LogicalState | null; to: LogicalState | null };
  'label.changed': { label: string; change: 'added' | 'removed' };
  /** A commit pushed by a human on the ticket's branch. */
  'push.human': { branch: string; sha: string; author: string };
  command: { name: string; body: string; linearSessionId: string; author: string; issue?: IssueSnapshot };
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
  /** An outbox effect carried out (ORC-150). */
  'effect.done': EffectResultPayload;
  /** An outbox effect that failed on its last attempt (ORC-150): the ticket is blocked. */
  'effect.failed': EffectResultPayload & { error: string };
}

export type EventType = keyof EventPayloads;

/** Events that start tracking a ticket the factory does not track yet; their payload carries its `issue` snapshot. */
export const CREATES_TICKET: ReadonlySet<EventType> = new Set<EventType>(['ticket.delegated', 'session.mentioned', 'command', 'session.prompted']);

/** Event names of schema version 1, renamed in version 2. */
export const RENAMED_V1: Readonly<Record<string, EventType>> = { 'ticket.moved': 'status.changed', 'label.added': 'label.changed' };

/** Version of the event shape; `upcast` brings older journal rows up to it. */
export const SCHEMA_VERSION = 2;

/** `untrusted`: the event carries content from a source the factory does not trust. */
export type Taint = 'trusted' | 'untrusted';

/** Version and taint of an event produced by the factory itself or a source it trusts. */
export const TRUSTED = { schemaVersion: SCHEMA_VERSION, taint: 'trusted' } as const;

export type FactoryEvent<T extends EventType = EventType> = {
  [K in T]: {
    id: string;
    type: K;
    at: number;
    projectId: string;
    ticketId?: string;
    schemaVersion: typeof SCHEMA_VERSION;
    taint: Taint;
    payload: EventPayloads[K];
  };
}[T];

/** State changes decided by `decide`, applied to the ticket by `reduce`. */
export type DecidedEvent =
  | { type: 'ticket.blocked'; reason: string }
  | { type: 'ticket.unblocked' }
  | {
      type: 'ticket.patched';
      patch: Partial<Pick<TicketState, 'verifyAttempts' | 'prNumber' | 'prUrl' | 'prChecks' | 'prState' | 'linearSessionId'>>;
    }
  | { type: 'feedback.appended'; item: FeedbackItem }
  /** The ticket's dev work is stopped: nothing pending, no verification awaited. */
  | { type: 'work.cancelled' }
  | { type: 'verify.started'; runId: string };

export type PendingJob = { job: string; input?: InputKind; inputText?: string; resume?: boolean };

/** Facts the orchestrator records around an effect it carried out, applied to the ticket by `reduce`. */
export type ShellEvent =
  /** The factory itself moved the ticket in the tracker. */
  | { type: 'status.recorded'; to: LogicalState }
  | { type: 'session.linked'; linearSessionId: string }
  | { type: 'pending.set'; job: PendingJob }
  | { type: 'pending.cleared' }
  | { type: 'workspace.prepared'; path: string; port?: number; branch?: string }
  | { type: 'workspace.released' }
  | { type: 'run.started'; runId: string; job: string; queue: QueueName; claudeSessionId: string; feedbackConsumed: boolean }
  /** The active run is gone without a `run.finished` (launch failure). */
  | { type: 'run.cleared' }
  /** The factory restarted while the ticket had a run or a verification in flight. */
  | { type: 'run.interrupted'; reason: string };

export type InternalEvent = DecidedEvent | ShellEvent;

export interface TicketState {
  projectId: string;
  ticketId: string;
  title: string;
  logical: LogicalState;
  /** True only while the ticket is delegated to the app user: only then does it get dev-queue work. */
  delegated: boolean;
  /** Linear sessions opened by a mention or a command on this ticket: replies there are questions, never feedback. */
  questionSessionIds: string[];
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
  /** Job of `activeRunId`, read by `when: job == …` conditions. */
  activeJob?: string;
  verifyingRunId?: string;
  pendingJob?: PendingJob;
  verifyAttempts: number;
  pendingFeedback: FeedbackItem[];
  priority: number;
  costUsd: number;
  updatedAt: number;
  /** Hash of the workflow version the ticket was decided on first, read for all its later decisions (ORC-149). */
  workflowHash?: string;
}

/** Fills fields added after a row was first persisted. */
export function normalizeTicket(t: TicketState): TicketState {
  return { ...t, delegated: t.delegated ?? false, questionSessionIds: t.questionSessionIds ?? [] };
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
    delegated: false,
    questionSessionIds: [],
    blocked: false,
    verifyAttempts: 0,
    pendingFeedback: [],
    priority,
    costUsd: 0,
    updatedAt: now,
  };
}
