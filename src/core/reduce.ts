import { isDeepStrictEqual } from 'node:util';
import { liftDeadLetterBlock, repairedEvent } from './dead-letter.js';
import { CREATES_TICKET, newTicketState, type InternalEvent, type FactoryEvent, type FeedbackItem, type IssueSnapshot, type PendingJob, type TicketState } from './types.js';

const MAX_QUESTION_SESSIONS = 50;

const MAX_ANSWERED_MESSAGES = 50;

const MAX_HUMAN_PUSHES = 50;

/**
 * Only an implementer's run empties the human inbox, and a ticket may never see one. What already had its answer (a
 * question of a thread, a command) stays within a bound, its oldest dropped: it is in the journal, and was answered. What waits for the agent is never dropped (I6).
 */
function withinBound(inbox: FeedbackItem[]): FeedbackItem[] {
  const answered = (i: FeedbackItem) => i.source === 'thread' || i.kind === 'command';
  let excess = inbox.filter(answered).length - MAX_ANSWERED_MESSAGES;
  return excess <= 0 ? inbox : inbox.filter((i) => !answered(i) || excess-- <= 0);
}

/**
 * What a start is, in the shape of a pending job (ORC-339): its job and all it starts it with. Read off anything that
 * carries those fields (a queue item, a start's options): an absent field and an empty one are the same start.
 */
export function pendingOf(start: PendingJob): PendingJob {
  return {
    job: start.job,
    ...(start.input ? { input: start.input } : {}),
    ...(start.inputText !== undefined ? { inputText: start.inputText } : {}),
    ...(start.resume ? { resume: true } : {}),
    ...(start.sensitivePaths?.length ? { sensitivePaths: [...start.sensitivePaths] } : {}),
    ...(start.relaunchOf ? { relaunchOf: start.relaunchOf } : {}),
  };
}

/** The same pending job, every field of it (ORC-339): a store's JSON may keep the keys in another order. */
export const samePending = (a: PendingJob | undefined, b: PendingJob | undefined): boolean =>
  !!a && !!b && isDeepStrictEqual(pendingOf(a), pendingOf(b));

/** The start of the active run goes with it, when it had one: a ticket that never held one keeps its shape. */
const ended = (t: TicketState, active: boolean): Partial<TicketState> => (active && t.activeStart ? { activeStart: undefined } : {});

/** What tells a message of the inbox from another (ORC-339): its author, its moment, its source and its words. */
const itemKey = (i: FeedbackItem): string => JSON.stringify([i.authorId ?? i.author, i.at, i.source, i.body]);

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
    case 'push.human':
      // What a human pushed is theirs (ORC-338): the newest pushes are kept, once each.
      return { ...t, humanPushes: [...(t.humanPushes ?? []).filter((p) => p.after !== e.payload.sha), { ...(e.payload.before ? { before: e.payload.before } : {}), after: e.payload.sha }].slice(-MAX_HUMAN_PUSHES) };
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
        ...ended(t, active),
      };
    }
    case 'run.lost':
      return t.activeRunId === e.payload.runId ? { ...t, activeRunId: undefined, activeJob: undefined, ...ended(t, true) } : t;
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
      return e.job && !samePending(t.pendingJob, e.job) ? { ...t } : { ...t, pendingJob: undefined };
    case 'workspace.prepared':
      return { ...t, worktreePath: e.path, port: e.port, branch: e.branch ?? t.branch };
    case 'workspace.released':
      return { ...t, worktreePath: undefined, port: undefined };
    case 'run.started': {
      // Another launch took the ticket first (a settle whose lease went to another worker, ORC-339): one dev run at a
      // time, this one does not take it, nor marks it. The launch sees it and lets go.
      if (e.queue === 'dev' && t.activeRunId && t.activeRunId !== e.runId) return { ...t };
      // The first untrusted run in the ticket's worktree marks its branch, for good (ORC-338). Over `null` only, the read
      // that found no untrusted run before; a ticket never read (the launch reads it first) takes its whole branch: fail closed.
      const mark = !e.untrusted ? t.untrustedSince : t.untrustedSince === null ? e.untrusted.head : (t.untrustedSince ?? '');
      const next = { ...t, ...(mark === undefined ? {} : { untrustedSince: mark }) };
      if (e.queue !== 'dev') return next;
      const claudeSessionId = e.ticketSession === false ? t.claudeSessionId : (t.claudeSessionId ?? e.claudeSessionId);
      // The run that starts the pending job takes it off the ticket in the same write, whoever launched it (settle,
      // the queue, a decision): never both, never neither (ORC-339). The same job with another input, or the relaunch of
      // a lost attempt, is not it.
      const startsPending = !!e.starts && samePending(t.pendingJob, e.starts);
      return {
        ...next,
        activeRunId: e.runId,
        activeJob: e.job,
        claudeSessionId,
        ...(e.starts ? { activeStart: pendingOf(e.starts) } : {}),
        ...(startsPending ? { pendingJob: undefined } : {}),
      };
    }
    case 'feedback.consumed': {
      if (!e.items) return { ...t, humanInbox: [] };
      const read = new Set(e.items.map(itemKey));
      return { ...t, humanInbox: t.humanInbox.filter((i) => !read.has(itemKey(i))) };
    }
    case 'run.cleared':
      return { ...t, activeRunId: undefined, activeJob: undefined, ...ended(t, true) };
    case 'untrusted.read':
      // Only once, and never over a mark a run set meanwhile.
      return t.untrustedSince === undefined ? { ...t, untrustedSince: e.since } : t;
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

/**
 * Whether `event` moved the ticket on, and so ends its wait on the usage limit (ORC-340): its `usage.reset` timer then resumes nothing.
 * Only what changes its work: a block, an undelegation or a delegation again, a new code run, a move to another state or a cancel. An event that starts no
 * work (a move recorded to the state it is in, a `work.cancelled` of a failed effect) leaves the wait as it is.
 */
function movesOn(state: TicketState, next: TicketState, event: FactoryEvent | InternalEvent): boolean {
  switch (event.type) {
    // A delegation again starts the ticket's work afresh: the cut step is not resumed behind it.
    case 'ticket.blocked':
    case 'ticket.undelegated':
    case 'ticket.delegated':
      return true;
    case 'run.started':
      return event.queue === 'dev';
    case 'status.changed':
      return !!event.payload.cancelled || next.logical !== state.logical;
    case 'status.recorded':
      return next.logical !== state.logical;
    default:
      return false;
  }
}

/** Pure: applies one event to a ticket's state and returns the new state; the input is never mutated. */
export function reduce(state: TicketState | undefined, event: FactoryEvent | InternalEvent): TicketState | undefined {
  if (isExternal(event) && event.type === 'dead_letter.repaired') return repaired(state, event);
  if (!state) {
    const created = isExternal(event) ? tracked(event) : undefined;
    return created && external(created, event as FactoryEvent);
  }
  const next = isExternal(event) ? external(state, event) : internal(state, event);
  const waiting = next && WAITS.filter((w) => next[w]);
  if (!waiting?.length || !movesOn(state, next!, event)) return next;
  return { ...next!, ...Object.fromEntries(waiting.map((w) => [w, null])) };
}

/** The waits `movesOn` ends: the usage limit's (ORC-340) and `clarify`'s answers (ORC-210), whose timers then find nothing to do. */
const WAITS = ['usageWait', 'clarify'] as const;
