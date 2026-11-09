import { describe, expect, it } from 'vitest';
import type { MessageMeasure, TicketMeasures } from './measures.js';
import { overview } from './overview.js';

const DAY = 24 * 60 * 60 * 1000;
const PERIOD = { since: 10 * DAY, until: 40 * DAY };
const tokens = (input: number) => ({ input, output: 0, cacheRead: 0, cacheCreation: 0 });

const measures = (ticketId: string, patch: Partial<TicketMeasures> = {}): TicketMeasures => ({
  projectId: 'p', ticketId, mergedAt: null, tokens: null, attempts: 1, attemptsWithoutTokens: 0, usageLimitShare: null, firstTry: null, reworks: [],
  humanReviewMinutes: null, revertedWithin14Days: null, revertWindowEndsAt: null, ciCost: null, messages: [], red: [], startedAt: null, leadTimeMs: null,
  workMs: 0, costUsd: 0, reviewRounds: { ai: 0, human: 0 }, runs: [], ...patch,
});
const merged = (ticketId: string, at: number, patch: Partial<TicketMeasures> = {}) =>
  measures(ticketId, { mergedAt: at, startedAt: at - DAY, leadTimeMs: DAY, firstTry: true, ...patch });
const message = (at: number, kind: MessageMeasure['kind'], signOfLifeMs: number | null, answerMs: number | null = null): MessageMeasure => ({
  eventId: `e${at}`, type: kind === 'question' ? 'session.mentioned' : 'session.prompted', kind, linearSessionId: 's', at, signOfLifeMs, answerMs,
});

describe('overview (ORC-299)', () => {
  it('counts the tickets merged in the period, their median lead time, tokens per merged ticket and the rate ready at the first try', () => {
    const o = overview(PERIOD, [
      merged('A', 11 * DAY, { leadTimeMs: 1 * DAY, tokens: tokens(1_000) }),
      merged('B', 20 * DAY, { leadTimeMs: 3 * DAY, tokens: tokens(3_000), firstTry: false, reworks: [{ cause: 'pr.checks_failed', id: 'c1' }, { cause: 'pr.checks_failed', id: 'c2' }] }),
      merged('C', 39 * DAY, { leadTimeMs: 2 * DAY, tokens: tokens(5_000) }),
      // Merged before the period, or after it: not delivered in it.
      merged('OLD', 9 * DAY),
      merged('LATE', 40 * DAY),
      measures('WIP'),
    ]);
    expect(o).toMatchObject({
      since: PERIOD.since, until: PERIOD.until, delivered: 3, medianLeadTimeMs: 2 * DAY, tokensPerMerged: { mean: 3_000, leftOut: 0 },
      firstTry: { yes: 2, of: 3, reworks: [{ cause: 'pr.checks_failed', tickets: 1 }] },
    });
  });

  it('leaves out of a mean the merged tickets without its source, and says how many', () => {
    const o = overview(PERIOD, [
      merged('A', 11 * DAY, { tokens: tokens(2_000), usageLimitShare: 0.5, ciCost: { durationMs: 60_000, runs: 1, byPr: [] } }),
      merged('B', 12 * DAY),
    ]);
    expect(o).toMatchObject({ tokensPerMerged: { mean: 2_000, leftOut: 1 }, usageLimitShare: { mean: 0.5, leftOut: 1 }, ciPerMerged: { meanMs: 60_000, leftOut: 1 } });
  });

  it('is empty without a ticket merged in the period, never a zero that reads as a measure', () => {
    expect(overview(PERIOD, [measures('WIP')])).toMatchObject({
      delivered: 0, medianLeadTimeMs: null, tokensPerMerged: { mean: null, leftOut: 0 }, usageLimitShare: { mean: null, leftOut: 0 },
      firstTry: { yes: 0, of: 0, reworks: [] }, ciPerMerged: { meanMs: null, leftOut: 0 }, reverted: { yes: 0, known: 0 },
      messages: { count: 0, medianSignOfLifeMs: null, withoutSignOfLife: 0, questions: 0, medianAnswerMs: null, unanswered: 0 },
    });
  });

  it('takes the delays to the first sign of life and to the answer over the human messages of the period', () => {
    const o = overview(PERIOD, [
      measures('A', { messages: [message(11 * DAY, 'delegation', 2_000), message(12 * DAY, 'question', 4_000, 60_000), message(13 * DAY, 'command', null)] }),
      measures('B', { messages: [message(14 * DAY, 'question', 30_000, 120_000), message(15 * DAY, 'instruction', 6_000)] }),
      // Before the period: left out.
      measures('C', { messages: [message(9 * DAY, 'question', 1, 1)] }),
    ]);
    expect(o.messages).toEqual({ count: 5, medianSignOfLifeMs: 5_000, withoutSignOfLife: 1, questions: 3, medianAnswerMs: 90_000, unanswered: 1 });
  });

  it('counts the reverts within 14 days, a `false` once its window ended, and the verdicts of the red check of the tickets delivered', () => {
    const o = overview(PERIOD, [
      merged('A', 11 * DAY, { revertedWithin14Days: true, red: [{ id: 'v1', verified: true, cause: 'assertion' }] }),
      merged('B', 12 * DAY, { revertedWithin14Days: false, revertWindowEndsAt: 26 * DAY, red: [{ id: 'v2', verified: false, cause: 'compile' }, { id: 'v3', verified: true, cause: 'assertion' }] }),
      merged('C', 13 * DAY),
      // Not reverted so far, but its 14 days run past the period: not known yet.
      merged('D', 30 * DAY, { revertedWithin14Days: false, revertWindowEndsAt: 44 * DAY }),
      measures('WIP', { red: [{ id: 'v4', verified: false, cause: 'compile' }] }),
    ]);
    expect(o).toMatchObject({ reverted: { yes: 1, known: 2 }, red: { verified: 2, wouldHaveBlocked: 1 } });
  });

  it('says how many tickets it could not measure, and has no baseline before ORC-230', () => {
    expect(overview(PERIOD, [merged('A', 11 * DAY)], 2)).toMatchObject({ tickets: 3, unmeasured: 2, baseline: null });
  });
});
