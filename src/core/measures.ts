import type { RedCause } from '../checks/red.js';
import type { MeasureFacts, OutboxRow, RunRecord, SessionRole, Store } from '../store/types.js';
import { allowed, DEFAULT_MATRIX } from './authz.js';
import { isQuestionSession } from './engine.js';
import { reduce } from './reduce.js';
import { addTokens, newTicketState, NO_TOKENS, spentTokens, type FactoryEvent, type LogicalState, type MessageKind, type TicketState, type TokenUsage } from './types.js';
import { upcast, type StoredEvent } from './upcast.js';

/** What a human message asks for: the class journaled with it (ORC-180), else, on a row written before, from its event type and its Linear session. */
export type MeasuredKind = 'delegation' | MessageKind;

/** A human message and how fast the factory reacted to it. */
export interface MessageMeasure {
  eventId: string;
  type: 'ticket.delegated' | 'session.mentioned' | 'session.prompted' | 'ticket.commented' | 'command';
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
  /**
   * Share of the ticket's token budget its code runs spent (ORC-216): `codeRunTokens` over `budgets.per_ticket_tokens`, the
   * figure the launch refuses at 1. Null without a cap, or while no code run reported its tokens.
   */
  usageLimitShare: number | null;
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
  /** When the ticket's work began (ORC-223): the earlier of its first delegation in the journal and its first attempt's start; null with neither. */
  startedAt: number | null;
  /** From `startedAt` to the first merge of the journal (`mergedAt`); null while not merged. */
  leadTimeMs: number | null;
  /** Sum of the durations of the attempts that ended (`runs[].durationMs`). */
  workMs: number;
  /** Sum of the dollars the runner reported per attempt: what exists before the token budgets (ORC-216). */
  costUsd: number;
  /**
   * Review rounds of the ticket (ORC-223). `ai`: its attempts in the reviewer role (ORC-217) that ran to their end (`success`
   * or `failure`, not an infrastructure failure): one stopped, cut by a limit, interrupted or still running is no round, its
   * relaunch is. A record older than that role is left out; the rounds a review skill makes inside its one session are not the
   * factory's to count. `human`: the moves to
   * Human Review the factory carried out (`move` effects done), each one a handover to a human reviewer; a human moving the
   * ticket there by hand is not counted. The single counter of the preset's loops comes with ORC-184 and ORC-190.
   */
  reviewRounds: { ai: number; human: number };
  /** The ticket's attempts, oldest first: what each cost and how long it ran (ORC-223). */
  runs: RunMeasure[];
}

/** One attempt as measured from its record (ORC-223): never its text. */
export interface RunMeasure {
  id: string;
  job: string;
  role: SessionRole | null;
  status: RunRecord['status'];
  startedAt: number;
  endedAt: number | null;
  /**
   * `endedAt - startedAt`; null while running, for an attempt cut without an end, and for one ended after its lease ran out
   * (ORC-220): a restart settles a cut attempt at the restart's time, and the downtime is no work.
   */
  durationMs: number | null;
  /** What the runner reported at the end; null while running and when it reported none. */
  tokens: TokenUsage | null;
  costUsd: number;
  turns: number;
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
    // A block's comment is written on the ticket, and answers in the dev session as its elicitation did (ORC-196).
    if (c.kind === 'block_comment') {
      out.push({ session: devSession, at, answer: true });
      continue;
    }
    if (c.kind !== 'activity' && c.kind !== 'post_output') continue;
    const run = c.runId ? runs.get(c.runId) : undefined;
    const session = (c.kind === 'activity' ? c.linearSessionId : undefined) ?? run?.linearSessionId ?? devSession;
    out.push({ session, at, answer: c.kind === 'post_output' || c.type !== 'thought', runStartedAt: run?.startedAt });
  }
  return out.sort((a, b) => a.at - b.at);
}

function messageMeasure(m: Message, kind: MeasuredKind, outs: Output[], ack: number | undefined, devSession: string | undefined): MessageMeasure {
  // A comment has no session of its own: its sign of life is in the dev session, as a block's comment answers there.
  const session = m.type === 'ticket.commented' ? devSession : m.payload.linearSessionId;
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

/** An attempt's measure, also the work the recap of Human Review sums (ORC-195). */
export const runMeasure = (r: RunRecord): RunMeasure => ({
  id: r.id,
  job: r.job,
  role: r.sessionRole ?? null,
  status: r.status,
  startedAt: r.startedAt,
  endedAt: r.endedAt ?? null,
  durationMs: r.endedAt === undefined || (r.leaseUntil !== undefined && r.endedAt > r.leaseUntil) ? null : r.endedAt - r.startedAt,
  tokens: r.tokens ?? null,
  costUsd: r.costUsd,
  turns: r.turns,
});

/** A review round: a reviewer attempt that ran to its end. */
const reviewed = (r: RunRecord): boolean => r.sessionRole === 'reviewer' && (r.status === 'success' || r.status === 'failure') && !r.infra;

/** A handover to a human reviewer: a move to Human Review the factory carried out. */
const handedToHuman = (row: OutboxRow): boolean => row.status === 'done' && row.effect.kind === 'move' && row.effect.to === 'human_review';

/** States a human sends a ticket back to dev from: its work had been handed over. */
const HANDED_OVER = new Set<LogicalState>(['human_review', 'ai_review', 'ready', 'done']);

/**
 * A comment `decide` read (ORC-196), told from what it left: one it ignored left no effect, one it refused only its
 * refusal, under the matrix `decide` checks.
 */
function readComment(e: FactoryEvent<'ticket.commented'>, ticket: TicketState, answered: ReadonlySet<string>): boolean {
  return answered.has(e.id) && (e.roles === undefined || allowed({ action: 'relaunch_blocked', channel: 'linear' }, e.actor, ticket, DEFAULT_MATRIX, e.roles).ok);
}

/** The rework an event of the journal is, if any; `ticket` is the ticket once the event applied. */
function rework(e: FactoryEvent, ticket: TicketState, relaunched: ReadonlySet<string>): Rework | undefined {
  switch (e.type) {
    case 'verify.failed':
      return e.payload.red ? undefined : { cause: e.type, id: e.id };
    case 'pr.checks_failed':
    case 'push.human':
      return { cause: e.type, id: e.id };
    case 'session.prompted':
      return isQuestionSession(ticket, e.payload.linearSessionId) ? undefined : { cause: 'feedback', id: e.id };
    // A comment is a reply only if it relaunched the ticket: the fold of the journal does not see its blocks (ORC-196).
    case 'ticket.commented':
      return relaunched.has(e.id) ? { cause: 'feedback', id: e.id } : undefined;
    case 'pr.reviewed':
      return e.payload.kind === 'review' && e.payload.state?.toLowerCase() === 'changes_requested' ? { cause: 'changes_requested', id: e.id } : undefined;
    case 'status.changed':
      return e.payload.to === 'dev' && e.payload.from !== null && HANDED_OVER.has(e.payload.from) ? { cause: 'sent_back', id: e.id } : undefined;
    default:
      return undefined;
  }
}

/** Tokens the ticket's code runs spent (`dev` queue, cache reads left out); undefined when none reported any. The budget's figure and the block comment's (ORC-340). */
export function codeRunTokens(runs: readonly RunRecord[]): number | undefined {
  const reported = runs.filter((r) => r.queue === 'dev' && r.tokens !== undefined);
  return reported.length ? reported.reduce((n, r) => n + spentTokens(r.tokens!), 0) : undefined;
}

/**
 * The measures of a ticket from its facts (ORC-235). Pure: the same facts always give the same
 * measures, whenever they are computed. The journal is read as `decide` reads it: upcast, and folded
 * by `reduce` to tell a question session from the dev session as the engine does. The agent's text
 * (`lastText`, `run.finished.lastText`) is never read.
 */
export function ticketMeasures(projectId: string, ticketId: string, facts: MeasureFacts, perTicketTokens?: number): TicketMeasures {
  const events = facts.events.map((e) => upcast(e as StoredEvent));
  // The fold starts from a tracked ticket (a journal row may lack the issue snapshot), with the dev session the
  // projection knows.
  let ticket: TicketState = { ...newTicketState(projectId, ticketId, '', 'todo', 0), linearSessionId: facts.devSession };
  let mergedAt: number | null = null;
  let firstMerge: FactoryEvent<'pr.merged'> | undefined;
  const reworks: Rework[] = [];
  const relaunched = new Set(facts.effects.filter((r) => r.effect.kind === 'start_run').map((r) => r.eventId));
  const answered = new Set(facts.effects.map((r) => r.eventId));
  const messages: { m: Message; kind: MeasuredKind }[] = [];
  for (const e of events) {
    ticket = reduce(ticket, e) ?? ticket;
    if (mergedAt === null) {
      if (e.type === 'pr.merged') {
        mergedAt = e.at;
        firstMerge = e;
      }
      const r = rework(e, ticket, relaunched);
      if (r) reworks.push(r);
    }
    if (e.type === 'ticket.commented') {
      if (readComment(e, ticket, answered)) messages.push({ m: e, kind: e.payload.kind });
    } else if (e.type === 'session.prompted') messages.push({ m: e, kind: e.payload.kind ?? (isQuestionSession(ticket, e.payload.linearSessionId) ? 'question' : 'instruction') });
    else if (e.type in KIND) messages.push({ m: e as Message, kind: (e as Message & { payload: { kind?: MessageKind } }).payload.kind ?? KIND[e.type as keyof typeof KIND] });
  }
  const outs = outputs(facts, events, ticket.linearSessionId);
  const withTokens = facts.runs.filter((r) => r.tokens !== undefined);
  const codeTokens = perTicketTokens === undefined ? undefined : codeRunTokens(facts.runs);
  const runs = facts.runs.map(runMeasure);
  const delegatedAt = events.find((e) => e.type === 'ticket.delegated')?.at;
  const starts = [delegatedAt, facts.runs[0]?.startedAt].filter((t): t is number => t !== undefined);
  const startedAt = starts.length ? Math.min(...starts) : null;
  return {
    projectId,
    ticketId,
    mergedAt,
    tokens: withTokens.length ? withTokens.reduce((sum, r) => addTokens(sum, r.tokens!), NO_TOKENS) : null,
    attempts: facts.runs.length,
    attemptsWithoutTokens: facts.runs.filter((r) => r.tokens === undefined && r.status !== 'running').length,
    usageLimitShare: codeTokens === undefined ? null : codeTokens / perTicketTokens!,
    firstTry: mergedAt === null ? null : reworks.length === 0,
    reworks: mergedAt === null ? [] : reworks,
    humanReviewMinutes: null,
    revertedWithin14Days: revertedWithin14Days(events, mergedAt),
    revertWindowEndsAt: firstMerge ? mergeTime(firstMerge) + REVERT_WINDOW_MS : null,
    ciCost: ciCost(events),
    messages: messages.map(({ m, kind }) => messageMeasure(m, kind, outs, facts.acks[m.id], ticket.linearSessionId)),
    red: redVerdicts(events),
    startedAt,
    leadTimeMs: mergedAt === null || startedAt === null ? null : mergedAt - startedAt,
    workMs: runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
    costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
    reviewRounds: { ai: facts.runs.filter(reviewed).length, human: facts.effects.filter(handedToHuman).length },
    runs,
  };
}

/** The measures of a ticket, computed now from what the store holds (ORC-235): read by the dashboard (ORC-223). `perTicketTokens`: factory.yml's cap. */
export async function measureTicket(store: Pick<Store, 'measureFacts'>, projectId: string, ticketId: string, perTicketTokens?: number): Promise<TicketMeasures> {
  return ticketMeasures(projectId, ticketId, await store.measureFacts(projectId, ticketId), perTicketTokens);
}
