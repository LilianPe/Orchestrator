import { liftDeadLetterBlock, repairedEvent } from './dead-letter.js';
import { CREATES_TICKET, newTicketState, type InternalEvent, type FactoryEvent, type IssueSnapshot, type TicketState } from './types.js';

const MAX_QUESTION_SESSIONS = 50;

/** A human takes a delivered ticket back: it is no longer merged, and dev work may start again (I8 b ends). */
function reopened(t: TicketState): TicketState {
  return t.prState === 'MERGED' ? { ...t, prState: undefined } : t;
}

function external(t: TicketState, e: FactoryEvent): TicketState {
  switch (e.type) {
    case 'ticket.delegated':
      return reopened({ ...t, delegated: true, linearSessionId: t.linearSessionId ?? e.payload.linearSessionId });
    case 'ticket.undelegated':
      return { ...t, delegated: false };
    case 'session.mentioned':
    case 'command': {
      const id = e.payload.linearSessionId;
      if (id === t.linearSessionId) return t;
      return { ...t, questionSessionIds: [...t.questionSessionIds.filter((s) => s !== id), id].slice(-MAX_QUESTION_SESSIONS) };
    }
    case 'status.changed': {
      // Cancelled (ORC-170): nothing waits for a human any longer, and the replies kept for a next run are dropped.
      if (e.payload.cancelled) return { ...t, blocked: false, blockReason: undefined, pendingFeedback: [] };
      const to = e.payload.to;
      if (!to) return t;
      // A human moves a merged ticket anywhere but done (the factory's own moves are no status.changed): it is
      // reopened, out of done or, when the factory's move to done failed, out of the status it stayed in.
      const next = { ...t, logical: to };
      return to === 'done' ? next : reopened(next);
    }
    case 'run.finished': {
      const active = t.activeRunId === e.payload.runId;
      return {
        ...t,
        costUsd: t.costUsd + e.payload.costUsd,
        activeRunId: active ? undefined : t.activeRunId,
        activeJob: active ? undefined : t.activeJob,
      };
    }
    case 'verify.passed':
    case 'verify.failed':
      return e.payload.runId === t.verifyingRunId ? { ...t, verifyingRunId: undefined } : t;
    case 'pr.merged':
      return { ...t, prState: 'MERGED', prNumber: e.payload.number, prUrl: e.payload.url };
    default:
      return t;
  }
}

function internal(t: TicketState, e: InternalEvent): TicketState {
  switch (e.type) {
    case 'ticket.blocked':
      return { ...t, blocked: true, blockReason: e.reason };
    case 'ticket.unblocked':
      return { ...t, blocked: false, blockReason: undefined };
    case 'ticket.patched':
      return { ...t, ...e.patch };
    case 'feedback.appended':
      return { ...t, pendingFeedback: [...t.pendingFeedback, e.item] };
    case 'work.cancelled':
      return { ...t, pendingJob: undefined, verifyingRunId: undefined };
    case 'verify.started':
      return { ...t, verifyingRunId: e.runId };
    case 'status.recorded':
      return { ...t, logical: e.to };
    case 'session.linked':
      return { ...t, linearSessionId: e.linearSessionId };
    case 'pending.set':
      return { ...t, pendingJob: e.job };
    case 'pending.cleared':
      return { ...t, pendingJob: undefined };
    case 'workspace.prepared':
      return { ...t, worktreePath: e.path, port: e.port, branch: e.branch ?? t.branch };
    case 'workspace.released':
      return { ...t, worktreePath: undefined, port: undefined };
    case 'run.started': {
      const out = e.feedbackConsumed ? { ...t, pendingFeedback: [] } : { ...t };
      if (e.queue !== 'dev') return out;
      return { ...out, activeRunId: e.runId, activeJob: e.job, claudeSessionId: t.claudeSessionId ?? e.claudeSessionId };
    }
    case 'run.cleared':
      return { ...t, activeRunId: undefined, activeJob: undefined };
    case 'run.interrupted':
      return { ...t, activeRunId: undefined, activeJob: undefined, verifyingRunId: undefined, blocked: true, blockReason: e.reason };
  }
}

/** A ticket the factory does not track yet starts from the snapshot its creating event carries. */
function tracked(e: FactoryEvent): TicketState | undefined {
  const issue = CREATES_TICKET.has(e.type) ? (e.payload as { issue?: IssueSnapshot }).issue : undefined;
  if (!issue || !e.ticketId) return undefined;
  return newTicketState(e.projectId, e.ticketId, issue.title, issue.logical, e.at, issue.priority);
}

function isExternal(e: FactoryEvent | InternalEvent): e is FactoryEvent {
  return 'id' in e;
}

/**
 * A repair (ORC-175) lifts the block of its dead-lettered event, not another one, then records the
 * facts of the event it replays or forces, as that event would on the unblocked ticket.
 */
function repaired(state: TicketState | undefined, e: FactoryEvent<'dead_letter.repaired'>): TicketState | undefined {
  const base = liftDeadLetterBlock(state, e.payload.eventId);
  const event = repairedEvent(e);
  return event ? reduce(base, event) : base;
}

/** Pure: applies one event to a ticket's state and returns the new state; the input is never mutated. */
export function reduce(state: TicketState | undefined, event: FactoryEvent | InternalEvent): TicketState | undefined {
  if (isExternal(event) && event.type === 'dead_letter.repaired') return repaired(state, event);
  if (!state) {
    const created = isExternal(event) ? tracked(event) : undefined;
    return created && external(created, event as FactoryEvent);
  }
  return isExternal(event) ? external(state, event) : internal(state, event);
}
