import { liftDeadLetterBlock, repairedEvent } from './dead-letter.js';
import { CREATES_TICKET, newTicketState, type InternalEvent, type FactoryEvent, type FeedbackItem, type IssueSnapshot, type TicketState } from './types.js';

const MAX_QUESTION_SESSIONS = 50;

const MAX_ANSWERED_MESSAGES = 50;

/**
 * Only an implementer's run empties the human inbox, and a ticket may never see one. What already had its answer (a
 * question of a thread, a command) stays within a bound, its oldest dropped: it is in the journal, and was answered. What waits for the agent is never dropped (I6).
 */
function withinBound(inbox: FeedbackItem[]): FeedbackItem[] {
  const answered = (i: FeedbackItem) => i.source === 'thread' || i.kind === 'command';
  let excess = inbox.filter(answered).length - MAX_ANSWERED_MESSAGES;
  return excess <= 0 ? inbox : inbox.filter((i) => !answered(i) || excess-- <= 0);
}

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
      // Any human move, a cancel or an unmapped status included, ends the status the factory put the ticket in.
      // A cancel also ends a wait for the ticket's repo: delegated and unblocked, it would hold this repo (ORC-291).
      if (e.payload.cancelled) return { ...t, ...(t.awaitingRepo ? { delegated: false, awaitingRepo: null } : {}), blocked: false, blockReason: undefined, blockedJob: undefined, humanInbox: [], recordedStatus: undefined };
      if (isOwnMoveEcho(t, e)) return t;
      const to = e.payload.to;
      if (!to) return { ...t, recordedStatus: undefined };
      // A human moves a merged ticket anywhere but done (the factory's own moves are no status.changed): it is
      // reopened, out of done or, when the factory's move to done failed, out of the status it stayed in.
      const next = { ...t, logical: to, recordedStatus: undefined };
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
    case 'run.lost':
      return t.activeRunId === e.payload.runId ? { ...t, activeRunId: undefined, activeJob: undefined } : t;
    case 'verify.passed':
    case 'verify.failed':
    case 'verify.errored':
    case 'publish.done':
    case 'publish.refused':
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
      return { ...t, blocked: true, blockReason: e.reason, blockedJob: e.job };
    case 'ticket.unblocked':
      return { ...t, blocked: false, blockReason: undefined, blockedJob: undefined };
    case 'ticket.patched':
      return { ...t, ...e.patch };
    case 'feedback.appended':
      return { ...t, humanInbox: withinBound([...t.humanInbox, e.item]) };
    case 'work.cancelled':
      return { ...t, pendingJob: undefined, verifyingRunId: undefined };
    case 'verify.started':
      return { ...t, verifyingRunId: e.runId };
    case 'status.recorded':
      // The commit under human review is the one shown at this move; any other move leaves it unreviewed.
      return { ...t, logical: e.to, recordedStatus: e.to, reviewSha: e.to === 'human_review' ? e.reviewSha : undefined };
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
      // The first untrusted run in the ticket's worktree marks its branch, for good (ORC-338).
      const next = e.untrusted && t.untrustedSince === undefined ? { ...t, untrustedSince: e.untrusted.head } : { ...t };
      if (e.queue !== 'dev') return next;
      const claudeSessionId = e.ticketSession === false ? t.claudeSessionId : (t.claudeSessionId ?? e.claudeSessionId);
      return { ...next, activeRunId: e.runId, activeJob: e.job, claudeSessionId };
    }
    case 'feedback.consumed':
      return { ...t, humanInbox: [] };
    case 'run.cleared':
      return { ...t, activeRunId: undefined, activeJob: undefined };
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

/**
 * The Linear webhook of the factory's own move, come after its echo expired (ORC-148): a move to the status the
 * factory put the ticket in, while it is still there and no human moved it since. It records nothing (`reduce`) and
 * decides nothing (`decide`). Only a status the factory recorded: `logical` alone may be a fallback (an unmapped
 * Linear status reads as todo), and a human move to it is a move.
 */
export function isOwnMoveEcho(t: TicketState | undefined, e: FactoryEvent | InternalEvent): boolean {
  if (e.type !== 'status.changed' || !t?.recordedStatus) return false;
  const { to, cancelled } = (e as FactoryEvent<'status.changed'>).payload;
  return !cancelled && to === t.recordedStatus && t.logical === t.recordedStatus;
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
