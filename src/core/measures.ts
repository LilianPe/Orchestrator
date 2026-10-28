import type { MeasureFacts, OutboxRow, RunRecord, Store } from '../store/types.js';
import type { FactoryEvent, LogicalState } from './types.js';

/**
 * Tokens of a run as `claude -p` reports them in its `result` line (`usage`), never as the agent
 * writes them (ORC-235). `cacheRead` and `cacheCreation` are input tokens read from or written to
 * the prompt cache, apart from `input`.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
}

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

/** Why a merged ticket was not ready at the first try: a fact of the journal or of an attempt, never the agent's text. */
export interface Rework {
  cause: 'pr.checks_failed' | 'verify.failed' | 'push.human' | 'feedback' | 'sent_back' | 'run.failure' | 'run.limit';
  /** Id of the journal event or of the attempt. */
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
  /** Attempts without a usage report (a launch failure, a runner that reports none): `tokens` leaves them out. */
  attemptsWithoutTokens: number;
  /** Share of the usage limit consumed: no limit in tokens yet (ORC-216). */
  usageLimitShare: null;
  /**
   * PR mergeable at the first try: merged, with no rework before the merge (`reworks` empty). Null
   * while not merged.
   */
  firstTry: boolean | null;
  reworks: Rework[];
  /** Minutes of human review: no GitHub review event reaches the journal yet (ORC-134, ORC-190). */
  humanReviewMinutes: null;
  /** Reverted within 14 days of the merge: no push or revert event of the default branch yet (ORC-134). */
  revertedWithin14Days: null;
  /** CI cost of the ticket: no workflow run (duration, minutes) reaches the journal yet (ORC-134). */
  ciCostUsd: null;
  messages: MessageMeasure[];
}

const MESSAGE_TYPES = new Set<string>(['ticket.delegated', 'session.mentioned', 'session.prompted', 'command']);
type Message = FactoryEvent<MessageMeasure['type']>;

/** A factory output carried out on a Linear session: what a human sees there, and when. */
interface Output {
  session: string | undefined;
  at: number;
  /** An answer: a posted output of a run started at `runStartedAt`, or a response, error or elicitation activity. */
  answer: boolean;
  runStartedAt?: number;
}

function outputs(facts: MeasureFacts, devSession: string | undefined, runs: Map<string, RunRecord>): Output[] {
  const doneAt = new Map<string, number>();
  for (const e of facts.events) if (e.type === 'effect.done') doneAt.set(e.payload.effectId, e.at);
  const out: Output[] = [];
  const add = (row: OutboxRow, at: number) => {
    const c = row.effect;
    if (c.kind === 'activity') {
      const run = c.runId ? runs.get(c.runId) : undefined;
      out.push({ session: c.linearSessionId ?? run?.linearSessionId ?? devSession, at, answer: c.type !== 'thought' });
    } else if (c.kind === 'post_output') {
      const run = runs.get(c.runId);
      out.push({ session: run?.linearSessionId ?? devSession, at, answer: true, runStartedAt: run?.startedAt });
    }
  };
  for (const row of facts.effects) {
    const at = doneAt.get(row.id);
    if (row.status === 'done' && at !== undefined) add(row, at);
  }
  return out.sort((a, b) => a.at - b.at);
}

function messageMeasures(facts: MeasureFacts, devSession: string | undefined, runs: Map<string, RunRecord>): MessageMeasure[] {
  const outs = outputs(facts, devSession, runs);
  const questionSessions = new Set<string>();
  const measures: MessageMeasure[] = [];
  for (const e of facts.events) {
    if (!MESSAGE_TYPES.has(e.type)) continue;
    const m = e as Message;
    const session = m.payload.linearSessionId;
    let kind: MessageKind;
    if (m.type === 'ticket.delegated') kind = 'delegation';
    else if (m.type === 'session.prompted') kind = session !== undefined && questionSessions.has(session) ? 'question' : 'instruction';
    else {
      // As `reduce` does: a mention or a command opens a question session, unless it is the dev session.
      if (session !== undefined && session !== devSession) questionSessions.add(session);
      kind = m.type === 'command' ? 'command' : 'question';
    }
    const after = outs.filter((o) => o.session === session && o.at >= m.at);
    const ack = facts.acks[m.id];
    const firstOutput = after[0]?.at;
    const signs = [ack, firstOutput].filter((t): t is number => t !== undefined);
    const answered = kind === 'question' || kind === 'command' ? after.find((o) => o.answer && (o.runStartedAt === undefined || o.runStartedAt >= m.at)) : undefined;
    measures.push({
      eventId: m.id,
      type: m.type,
      kind,
      linearSessionId: session,
      at: m.at,
      signOfLifeMs: signs.length ? Math.min(...signs) - m.at : null,
      answerMs: answered ? answered.at - m.at : null,
    });
  }
  return measures;
}

/** States a human sends a ticket back to dev from: its work had been handed over. */
const HANDED_OVER = new Set<LogicalState>(['human_review', 'ai_review', 'ready', 'done']);

function reworks(facts: MeasureFacts, devSession: string | undefined, mergedAt: number, runs: RunRecord[]): Rework[] {
  const found: Rework[] = [];
  const questionSessions = new Set<string>();
  for (const e of facts.events) {
    if (e.at > mergedAt) continue;
    if (e.type === 'session.mentioned' || e.type === 'command') {
      if (e.payload.linearSessionId !== devSession) questionSessions.add(e.payload.linearSessionId);
    } else if (e.type === 'pr.checks_failed' || e.type === 'verify.failed' || e.type === 'push.human') {
      found.push({ cause: e.type, id: e.id });
    } else if (e.type === 'session.prompted' && !questionSessions.has(e.payload.linearSessionId)) {
      found.push({ cause: 'feedback', id: e.id });
    } else if (e.type === 'status.changed' && e.payload.to === 'dev' && e.payload.from !== null && HANDED_OVER.has(e.payload.from)) {
      found.push({ cause: 'sent_back', id: e.id });
    }
  }
  for (const r of runs) {
    if (r.queue === 'dev' && r.startedAt <= mergedAt && (r.status === 'failure' || r.status === 'limit')) found.push({ cause: `run.${r.status}`, id: r.id });
  }
  return found;
}

/**
 * The measures of a ticket from its facts (ORC-235). Pure: the same facts always give the same
 * measures, whenever they are computed. The agent's text (`lastText`, `run.finished.lastText`) is
 * never read.
 */
export function ticketMeasures(projectId: string, ticketId: string, facts: MeasureFacts): TicketMeasures {
  const delegation = facts.events.find((e): e is FactoryEvent<'ticket.delegated'> => e.type === 'ticket.delegated');
  const devSession = facts.ticket?.linearSessionId ?? delegation?.payload.linearSessionId;
  const runs = new Map(facts.runs.map((r) => [r.id, r]));
  const merged = facts.events.find((e) => e.type === 'pr.merged');
  const withTokens = facts.runs.filter((r) => r.tokens !== undefined);
  const rework = merged ? reworks(facts, devSession, merged.at, facts.runs) : [];
  return {
    projectId,
    ticketId,
    mergedAt: merged?.at ?? null,
    tokens: withTokens.length ? withTokens.reduce((sum, r) => addTokens(sum, r.tokens!), NO_TOKENS) : null,
    attempts: facts.runs.length,
    attemptsWithoutTokens: facts.runs.length - withTokens.length,
    usageLimitShare: null,
    firstTry: merged ? rework.length === 0 : null,
    reworks: rework,
    humanReviewMinutes: null,
    revertedWithin14Days: null,
    ciCostUsd: null,
    messages: messageMeasures(facts, devSession, runs),
  };
}

/** The measures of a ticket, computed now from what the store holds (ORC-235): read by the dashboard (ORC-223). */
export async function measureTicket(store: Pick<Store, 'measureFacts'>, projectId: string, ticketId: string): Promise<TicketMeasures> {
  return ticketMeasures(projectId, ticketId, await store.measureFacts(projectId, ticketId));
}
