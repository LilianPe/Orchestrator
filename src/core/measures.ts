import type { RedCause } from '../checks/red.js';
import type { MeasureFacts, Store } from '../store/types.js';
import { isQuestionSession } from './engine.js';
import { reduce } from './reduce.js';
import { addTokens, newTicketState, NO_TOKENS, type FactoryEvent, type LogicalState, type MessageKind, type TicketState, type TokenUsage } from './types.js';
import { upcast, type StoredEvent } from './upcast.js';

/** What a human message asks for: the class journaled with it (ORC-180), else, on a row written before, from its event type and its Linear session. */
export type MeasuredKind = 'delegation' | MessageKind;

/** A human message and how fast the factory reacted to it. */
export interface MessageMeasure {
  eventId: string;
  type: 'ticket.delegated' | 'session.mentioned' | 'session.prompted' | 'command';
  kind: MeasuredKind;
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
 * journal, the attempts, the outbox and the inbox acks. None is read from what an agent wrote: the
 * reverts and the CI cost (ORC-278) come from GitHub webhooks, as the ingestion resolved them.
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
  /** Ended attempts without a usage report (a launch failure, a runner that reports none, a run older than ORC-235): `tokens` leaves them out. One still running reports at its end. */
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
  /**
   * A merged PR of the ticket reverted on the default branch within 14 days of its merge (ORC-278): a
   * `default_branch.pushed` commit that reverts it, timed by the push (`pushedAt`) against GitHub's merge
   * time (`mergedAt`), both on GitHub's clock (else when the factory received each). Null while not
   * merged, and while no push of the default branch concerning the ticket is in the journal (its merge
   * commit or a revert): without that source, `false` would be a guess. `false` is final only from
   * `revertWindowEndsAt`.
   */
  revertedWithin14Days: boolean | null;
  /** End of the 14 days after the first merge (`mergedAt` of GitHub, else of the journal); null while not merged. */
  revertWindowEndsAt: number | null;
  /** CI cost of the ticket (ORC-278): the durations of its workflow run attempts. Null while none is in the journal. */
  ciCost: CiCost | null;
  messages: MessageMeasure[];
  /**
   * Verdicts of the `red` check (ORC-123), in journal order: what it would have blocked in measure mode is each one
   * not `verified`. Its returns to the tests step are measured here, not as reworks.
   */
  red: { id: string; verified: boolean; cause: RedCause }[];
}

/** Workflow run attempts of a ticket's CI, summed per PR then for the ticket, one per run id and attempt (ORC-278). */
export interface CiCost {
  /** Sum of the attempts' durations (`run_started_at` to `updated_at` of the completed run), in milliseconds. */
  durationMs: number;
  runs: number;
  /** Per PR, by number; `null` for runs on the branch before its PR was known. */
  byPr: { number: number | null; durationMs: number; runs: number }[];
}

const REVERT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Whether a merged PR of the ticket was reverted within 14 days of its merge (ORC-278); null without a
 * push of the default branch about the ticket. Reads the numbers the ingestion resolved, never a message.
 */
/** When a PR was merged: GitHub's time when the source read it, else when the factory received the merge. */
const mergeTime = (e: FactoryEvent<'pr.merged'>): number => e.payload.mergedAt ?? e.at;

function revertedWithin14Days(events: FactoryEvent[], mergedAt: number | null): boolean | null {
  if (mergedAt === null) return null;
  const merged = new Map<number, number>();
  for (const e of events) if (e.type === 'pr.merged' && !merged.has(e.payload.number)) merged.set(e.payload.number, mergeTime(e));
  let seen = false;
  for (const e of events) {
    if (e.type !== 'default_branch.pushed') continue;
    seen = true;
    const at = e.payload.pushedAt ?? e.at;
    for (const c of e.payload.commits) {
      const since = c.reverts === undefined ? undefined : merged.get(c.reverts);
      if (since !== undefined && at - since <= REVERT_WINDOW_MS) return true;
    }
  }
  return seen ? false : null;
}

/** The ticket's CI cost (ORC-278): each run attempt once, however many times it was journaled. */
function ciCost(events: FactoryEvent[]): CiCost | null {
  const runs = new Map<string, FactoryEvent<'ci.run_completed'>['payload']>();
  for (const e of events) if (e.type === 'ci.run_completed') runs.set(`${e.payload.runId}:${e.payload.attempt}`, e.payload);
  if (runs.size === 0) return null;
  const byPr = new Map<number | null, { number: number | null; durationMs: number; runs: number }>();
  for (const r of runs.values()) {
    const key = r.number ?? null;
    const pr = byPr.get(key) ?? { number: key, durationMs: 0, runs: 0 };
    pr.durationMs += r.durationMs;
    pr.runs += 1;
    byPr.set(key, pr);
  }
  const prs = [...byPr.values()];
  return { durationMs: prs.reduce((sum, p) => sum + p.durationMs, 0), runs: runs.size, byPr: prs };
}

type Message = FactoryEvent<MessageMeasure['type']>;

/** The kind of a human message, by its type; a reply (`session.prompted`) depends on its session. */
const KIND = { 'ticket.delegated': 'delegation', 'session.mentioned': 'question', command: 'command' } as const satisfies Record<string, MeasuredKind>;

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

function messageMeasure(m: Message, kind: MeasuredKind, outs: Output[], ack: number | undefined): MessageMeasure {
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

function redVerdicts(events: FactoryEvent[]): TicketMeasures['red'] {
  const out: TicketMeasures['red'] = [];
  for (const e of events) {
    // A check that could not run (`infra`) is no verdict on the tests.
    if ((e.type === 'verify.passed' || e.type === 'verify.failed') && e.payload.red && e.payload.red !== 'infra') out.push({ id: e.id, verified: e.type === 'verify.passed', cause: e.payload.red });
  }
  return out;
}

/** States a human sends a ticket back to dev from: its work had been handed over. */
const HANDED_OVER = new Set<LogicalState>(['human_review', 'ai_review', 'ready', 'done']);

/** The rework an event of the journal is, if any; `ticket` is the ticket once the event applied. */
function rework(e: FactoryEvent, ticket: TicketState): Rework | undefined {
  switch (e.type) {
    case 'verify.failed':
      return e.payload.red ? undefined : { cause: e.type, id: e.id };
    case 'pr.checks_failed':
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
  let firstMerge: FactoryEvent<'pr.merged'> | undefined;
  const reworks: Rework[] = [];
  const messages: { m: Message; kind: MeasuredKind }[] = [];
  for (const e of events) {
    ticket = reduce(ticket, e) ?? ticket;
    if (mergedAt === null) {
      if (e.type === 'pr.merged') {
        mergedAt = e.at;
        firstMerge = e;
      }
      const r = rework(e, ticket);
      if (r) reworks.push(r);
    }
    if (e.type === 'session.prompted') messages.push({ m: e, kind: e.payload.kind ?? (isQuestionSession(ticket, e.payload.linearSessionId) ? 'question' : 'instruction') });
    else if (e.type in KIND) messages.push({ m: e as Message, kind: (e as Message & { payload: { kind?: MessageKind } }).payload.kind ?? KIND[e.type as keyof typeof KIND] });
  }
  const outs = outputs(facts, events, ticket.linearSessionId);
  const withTokens = facts.runs.filter((r) => r.tokens !== undefined);
  return {
    projectId,
    ticketId,
    mergedAt,
    tokens: withTokens.length ? withTokens.reduce((sum, r) => addTokens(sum, r.tokens!), NO_TOKENS) : null,
    attempts: facts.runs.length,
    attemptsWithoutTokens: facts.runs.filter((r) => r.tokens === undefined && r.status !== 'running').length,
    usageLimitShare: null,
    firstTry: mergedAt === null ? null : reworks.length === 0,
    reworks: mergedAt === null ? [] : reworks,
    humanReviewMinutes: null,
    revertedWithin14Days: revertedWithin14Days(events, mergedAt),
    revertWindowEndsAt: firstMerge ? mergeTime(firstMerge) + REVERT_WINDOW_MS : null,
    ciCost: ciCost(events),
    messages: messages.map(({ m, kind }) => messageMeasure(m, kind, outs, facts.acks[m.id])),
    red: redVerdicts(events),
  };
}

/** The measures of a ticket, computed now from what the store holds (ORC-235): read by the dashboard (ORC-223). */
export async function measureTicket(store: Pick<Store, 'measureFacts'>, projectId: string, ticketId: string): Promise<TicketMeasures> {
  return ticketMeasures(projectId, ticketId, await store.measureFacts(projectId, ticketId));
}
