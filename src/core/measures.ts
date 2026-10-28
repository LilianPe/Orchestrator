import type { MeasureFacts, Store } from '../store/types.js';
import { isQuestionSession } from './engine.js';
import { reduce } from './reduce.js';
import { addTokens, newTicketState, NO_TOKENS, type FactoryEvent, type LogicalState, type TicketState, type TokenUsage } from './types.js';
import { upcast, type StoredEvent } from './upcast.js';

/** What a human message asks for, read from the event type and its Linear session, never from its text. */
export type MessageKind = 'delegation' | 'question' | 'command' | 'instruction';

/** A human message and how fast the factory reacted to it. */
export interface MessageMeasure {
  eventId: string;
  type: 'ticket.delegated' | 'session.mentioned' | 'session.prompted' | 'command';
  kind: MessageKind;
  linearSessionId: string | undefined;
  /** When the factory received it (`at` of the event). */
  at: number;
  /**
   * Delay to the first sign of life in its Linear session: the ack of the webhook (inbox `acked_at`),
   * or the first factory output carried out on that session (activity or posted output), the earlier of
   * the two. Null while there is none.
   */
  signOfLifeMs: number | null;
  /**
   * Questions and commands only: delay to the answer, the first posted output of a run started for it
   * or the first response, error or elicitation activity on its session. Null for an instruction or a
   * delegation, and while unanswered.
   */
  answerMs: number | null;
}

/**
 * Why a merged ticket was not ready at the first try: an event of the journal before the merge,
 * never the agent's text. `feedback` is a human reply in the dev session (a requested change, or an
 * answer to the agent's own question: either way the first try needed a human); `sent_back` a human
 * moving the ticket back to dev once handed over; `changes_requested` a GitHub review asking for changes
 * (ORC-134). A review comment alone, or a conflict with the base branch (`pr.conflicted`), is not one.
 */
export interface Rework {
  cause: 'pr.checks_failed' | 'verify.failed' | 'push.human' | 'feedback' | 'sent_back' | 'changes_requested';
  /** Id of the journal event. */
  id: string;
}

/**
 * The measures of the MVP doc for one ticket (ORC-235), computed from what the store holds: the
 * journal, the attempts, the outbox and the inbox acks. None is read from what an agent wrote.
 * A measure whose source does not reach the store yet is `null`, with the ticket that brings it.
 */
export interface TicketMeasures {
  projectId: string;
  ticketId: string;
  /** Time of the first `pr.merged` of the journal; null while the ticket is not merged. */
  mergedAt: number | null;
  /** Sum over the ticket's attempts that reported their usage; null when none did. */
  tokens: TokenUsage | null;
  attempts: number;
  /** Attempts without a usage report (a launch failure, a runner that reports none, a run older than ORC-235): `tokens` leaves them out. */
  attemptsWithoutTokens: number;
  /** Share of the usage limit consumed: no limit in tokens yet (ORC-216). */
  usageLimitShare: null;
  /**
   * PR mergeable at the first try: merged, with no rework before the merge (`reworks` empty). Null
   * while not merged.
   */
  firstTry: boolean | null;
  reworks: Rework[];
  /**
   * Minutes of human review: `pr.reviewed` (ORC-134) says when a review was posted, not how long it took;
   * the time spent needs the review loop of ORC-190 (start of each human review).
   */
  humanReviewMinutes: null;
  /** Reverted within 14 days of the merge: the GitHub webhook (ORC-134) maps no push of the default branch; no ticket brings it yet. */
  revertedWithin14Days: null;
  /** CI cost of the ticket: the GitHub webhook (ORC-134) maps check verdicts, not workflow run durations; no ticket brings it yet. */
  ciCostUsd: null;
  messages: MessageMeasure[];
}

type Message = FactoryEvent<MessageMeasure['type']>;

/** The kind of a human message, by its type; a reply (`session.prompted`) depends on its session. */
const KIND = { 'ticket.delegated': 'delegation', 'session.mentioned': 'question', command: 'command' } as const satisfies Record<string, MessageKind>;

/** A factory output carried out on a Linear session: what a human sees there, and when. */
interface Output {
  session: string | undefined;
  at: number;
  /** An answer: a posted output, or a response, error or elicitation activity (not a thought). */
  answer: boolean;
  /** Start of the run the output comes from: an output of a run started before a message does not answer it. */
  runStartedAt?: number;
}

function outputs(facts: MeasureFacts, events: FactoryEvent[], devSession: string | undefined): Output[] {
  const runs = new Map(facts.runs.map((r) => [r.id, r]));
  const doneAt = new Map<string, number>();
  for (const e of events) if (e.type === 'effect.done') doneAt.set(e.payload.effectId, e.at);
  const out: Output[] = [];
  for (const row of facts.effects) {
    const at = doneAt.get(row.id);
    if (row.status !== 'done' || at === undefined) continue;
    const c = row.effect;
    if (c.kind !== 'activity' && c.kind !== 'post_output') continue;
    const run = c.runId ? runs.get(c.runId) : undefined;
    const session = (c.kind === 'activity' ? c.linearSessionId : undefined) ?? run?.linearSessionId ?? devSession;
    out.push({ session, at, answer: c.kind === 'post_output' || c.type !== 'thought', runStartedAt: run?.startedAt });
  }
  return out.sort((a, b) => a.at - b.at);
}

function messageMeasure(m: Message, kind: MessageKind, outs: Output[], ack: number | undefined): MessageMeasure {
  const session = m.payload.linearSessionId;
  const after = outs.filter((o) => o.session === session && o.at >= m.at);
  const signs = [ack, after[0]?.at].filter((t): t is number => t !== undefined);
  const answered =
    kind === 'question' || kind === 'command' ? after.find((o) => o.answer && (o.runStartedAt === undefined || o.runStartedAt >= m.at)) : undefined;
  return {
    eventId: m.id,
    type: m.type,
    kind,
    linearSessionId: session,
    at: m.at,
    signOfLifeMs: signs.length ? Math.min(...signs) - m.at : null,
    answerMs: answered ? answered.at - m.at : null,
  };
}

/** States a human sends a ticket back to dev from: its work had been handed over. */
const HANDED_OVER = new Set<LogicalState>(['human_review', 'ai_review', 'ready', 'done']);

/** The rework an event of the journal is, if any; `ticket` is the ticket once the event applied. */
function rework(e: FactoryEvent, ticket: TicketState): Rework | undefined {
  switch (e.type) {
    case 'pr.checks_failed':
    case 'verify.failed':
    case 'push.human':
      return { cause: e.type, id: e.id };
    case 'session.prompted':
      return isQuestionSession(ticket, e.payload.linearSessionId) ? undefined : { cause: 'feedback', id: e.id };
    case 'pr.reviewed':
      return e.payload.kind === 'review' && e.payload.state?.toLowerCase() === 'changes_requested' ? { cause: 'changes_requested', id: e.id } : undefined;
    case 'status.changed':
      return e.payload.to === 'dev' && e.payload.from !== null && HANDED_OVER.has(e.payload.from) ? { cause: 'sent_back', id: e.id } : undefined;
    default:
      return undefined;
  }
}

/**
 * The measures of a ticket from its facts (ORC-235). Pure: the same facts always give the same
 * measures, whenever they are computed. The journal is read as `decide` reads it: upcast, and folded
 * by `reduce` to tell a question session from the dev session as the engine does. The agent's text
 * (`lastText`, `run.finished.lastText`) is never read.
 */
export function ticketMeasures(projectId: string, ticketId: string, facts: MeasureFacts): TicketMeasures {
  const events = facts.events.map((e) => upcast(e as StoredEvent));
  // The fold starts from a tracked ticket (a journal row may lack the issue snapshot), with the dev session the
  // projection knows.
  let ticket: TicketState = { ...newTicketState(projectId, ticketId, '', 'todo', 0), linearSessionId: facts.devSession };
  let mergedAt: number | null = null;
  const reworks: Rework[] = [];
  const messages: { m: Message; kind: MessageKind }[] = [];
  for (const e of events) {
    ticket = reduce(ticket, e) ?? ticket;
    if (mergedAt === null) {
      if (e.type === 'pr.merged') mergedAt = e.at;
      const r = rework(e, ticket);
      if (r) reworks.push(r);
    }
    if (e.type === 'session.prompted') messages.push({ m: e, kind: isQuestionSession(ticket, e.payload.linearSessionId) ? 'question' : 'instruction' });
    else if (e.type in KIND) messages.push({ m: e as Message, kind: KIND[e.type as keyof typeof KIND] });
  }
  const outs = outputs(facts, events, ticket.linearSessionId);
  const withTokens = facts.runs.filter((r) => r.tokens !== undefined);
  return {
    projectId,
    ticketId,
    mergedAt,
    tokens: withTokens.length ? withTokens.reduce((sum, r) => addTokens(sum, r.tokens!), NO_TOKENS) : null,
    attempts: facts.runs.length,
    attemptsWithoutTokens: facts.runs.length - withTokens.length,
    usageLimitShare: null,
    firstTry: mergedAt === null ? null : reworks.length === 0,
    reworks: mergedAt === null ? [] : reworks,
    humanReviewMinutes: null,
    revertedWithin14Days: null,
    ciCostUsd: null,
    messages: messages.map(({ m, kind }) => messageMeasure(m, kind, outs, facts.acks[m.id])),
  };
}

/** The measures of a ticket, computed now from what the store holds (ORC-235): read by the dashboard (ORC-223). */
export async function measureTicket(store: Pick<Store, 'measureFacts'>, projectId: string, ticketId: string): Promise<TicketMeasures> {
  return ticketMeasures(projectId, ticketId, await store.measureFacts(projectId, ticketId));
}
