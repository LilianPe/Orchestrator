import type { Rework, TicketMeasures } from './measures.js';
import { totalTokens } from './types.js';

/**
 * The reduced overview of the dashboard (ORC-299): what the factory delivered over `[since, until)` and at what price,
 * from the tickets' measures (ORC-235), never from what an agent wrote. A ticket is delivered in the period when its
 * first merge is in it; a human message counts when the factory received it in it. A mean or a median without a value
 * is null, never a zero that reads as a measure, and each mean says how many delivered tickets it leaves out.
 */
export interface Overview {
  since: number;
  until: number;
  /** Tickets whose measures could not be read: left out of everything below. */
  unmeasured: number;
  delivered: number;
  medianLeadTimeMs: number | null;
  /** Mean of the delivered tickets' tokens, all four kinds as the dashboard counts them; `leftOut` reported none. */
  tokensPerMerged: { mean: number | null; leftOut: number };
  /** Mean share of the ticket's token budget (ORC-216); `leftOut` without a cap or without a code run that reported. */
  usageLimitShare: { mean: number | null; leftOut: number };
  /** Delivered tickets ready at the first try, and per cause of rework how many delivered tickets had one. */
  firstTry: { yes: number; of: number; reworks: { cause: Rework['cause']; tickets: number }[] };
  /** Delivered tickets reverted within 14 days, of those for which it is known (ORC-278): a `false` only once its window ended by `until`. */
  reverted: { yes: number; known: number };
  /** Mean CI time of the delivered tickets; `leftOut` had no CI run in the journal. */
  ciPerMerged: { mean: number | null; leftOut: number };
  /** Verdicts of the `red` check (ORC-123) of the delivered tickets: verified, and what it would have blocked. */
  red: { verified: number; wouldHaveBlocked: number };
  /** The human messages of the period: sign of life over all, answer over the questions and commands. */
  messages: { count: number; medianSignOfLifeMs: number | null; withoutSignOfLife: number; questions: number; medianAnswerMs: number | null; unanswered: number };
  /** The state of reference over 90 days: nothing computes it before ORC-230. */
  baseline: null;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The mean of what `value` gives, over the tickets it gives one for; how many it leaves out. */
function meanOf(tickets: readonly TicketMeasures[], value: (m: TicketMeasures) => number | null): { mean: number | null; leftOut: number } {
  const values = tickets.flatMap((m) => {
    const v = value(m);
    return v === null ? [] : [v];
  });
  return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, leftOut: tickets.length - values.length };
}

/** The overview of `measured` over the period; `unmeasured` tickets were read but their measures could not be. Pure. */
export function overview(period: { since: number; until: number }, measured: readonly TicketMeasures[], unmeasured = 0): Overview {
  const within = (at: number) => at >= period.since && at < period.until;
  const delivered = measured.filter((m) => m.mergedAt !== null && within(m.mergedAt));
  const causes = new Map<Rework['cause'], number>();
  for (const m of delivered) for (const cause of new Set(m.reworks.map((r) => r.cause))) causes.set(cause, (causes.get(cause) ?? 0) + 1);
  const messages = measured.flatMap((m) => m.messages.filter((msg) => within(msg.at)));
  const questions = messages.filter((m) => m.kind === 'question' || m.kind === 'command');
  const signs = messages.flatMap((m) => (m.signOfLifeMs === null ? [] : [m.signOfLifeMs]));
  const answers = questions.flatMap((m) => (m.answerMs === null ? [] : [m.answerMs]));
  const red = delivered.flatMap((m) => m.red);
  const reverted = delivered.filter((m) => m.revertedWithin14Days === true);
  return {
    ...period,
    unmeasured,
    delivered: delivered.length,
    medianLeadTimeMs: median(delivered.flatMap((m) => (m.leadTimeMs === null ? [] : [m.leadTimeMs]))),
    tokensPerMerged: meanOf(delivered, (m) => (m.tokens ? totalTokens(m.tokens) : null)),
    usageLimitShare: meanOf(delivered, (m) => m.usageLimitShare),
    firstTry: { yes: delivered.filter((m) => m.firstTry === true).length, of: delivered.length, reworks: [...causes].map(([cause, tickets]) => ({ cause, tickets })) },
    reverted: { yes: reverted.length, known: reverted.length + delivered.filter((m) => m.revertedWithin14Days === false && m.revertWindowEndsAt !== null && m.revertWindowEndsAt <= period.until).length },
    ciPerMerged: meanOf(delivered, (m) => m.ciCost?.durationMs ?? null),
    red: { verified: red.filter((r) => r.verified).length, wouldHaveBlocked: red.filter((r) => !r.verified).length },
    messages: {
      count: messages.length,
      medianSignOfLifeMs: median(signs),
      withoutSignOfLife: messages.length - signs.length,
      questions: questions.length,
      medianAnswerMs: median(answers),
      unanswered: questions.length - answers.length,
    },
    baseline: null,
  };
}
