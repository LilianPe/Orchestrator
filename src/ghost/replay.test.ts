import { describe, expect, it } from 'vitest';
import { blindPairs, ghostReport, parseThreshold, type GhostJudgment, type GhostReplay, type GhostTicket } from './replay.js';

const replay: GhostReplay = { id: 'g1', projectId: 'p', threshold: 0.5, asIsThreshold: 0.25, memory: true, seed: 'seed-1', tickets: [], startedAt: 1000, startedBy: 'armand' };
let n = 0;
const ticket = (ticketId: string, over: Partial<GhostTicket> = {}): GhostTicket => ({
  replayId: 'g1', ticketId, humanPr: { number: ++n, url: `https://github.test/pr/${n}`, author: 'lilian' }, mergeSha: `m${n}`, start: `s${n}`,
  env: 'unchecked', outcome: 'pr', factoryPr: `kept:${ticketId}`, costUsd: 1.25, assumptions: 2, at: 2000, ...over,
});
const judged = (ticketId: string, side: 'factory' | 'human', grade: GhostJudgment['grade']): GhostJudgment => ({ replayId: 'g1', ticketId, side, grade, judge: 'armand', at: 3000 });

describe('the blind judging of a replay (ORC-231)', () => {
  const tickets = Array.from({ length: 12 }, (_, i) => ticket(`REL-${i + 1}`));

  it('criterion 5: pairs in an order drawn at random, each with its two PRs in a random order, the same for the same replay', () => {
    const pairs = blindPairs(replay, tickets, 'armand');
    expect(pairs).toHaveLength(12);
    expect(new Set(pairs.map((p) => p.ticketId))).toEqual(new Set(tickets.map((t) => t.ticketId)));
    expect(pairs.map((p) => p.ticketId)).not.toEqual(tickets.map((t) => t.ticketId));
    // Both sides come first somewhere: the factory's PR is not always A.
    expect(new Set(pairs.map((p) => p.a))).toEqual(new Set(['factory', 'human']));
    for (const p of pairs) expect(new Set([p.a, p.b])).toEqual(new Set(['factory', 'human']));
    expect(blindPairs(replay, tickets, 'armand')).toEqual(pairs);
    expect(blindPairs({ ...replay, seed: 'seed-2' }, tickets, 'armand').map((p) => p.ticketId)).not.toEqual(pairs.map((p) => p.ticketId));
    expect(pairs.map((p) => p.position)).toEqual(pairs.map((_, i) => i + 1));
  });

  it('leaves out the tickets with nothing to compare, and those whose human PR the judge wrote', () => {
    const some = [ticket('REL-1'), ticket('REL-2', { env: 'failed', envReason: 'npm ci failed' }), ticket('REL-3', { outcome: 'blocked', factoryPr: undefined }), ticket('REL-4', { humanPr: { number: 9, url: 'u', author: 'armand' } })];
    expect(blindPairs(replay, some, 'armand').map((p) => p.ticketId)).toEqual(['REL-1']);
  });
});

describe('the report of a replay (ORC-231)', () => {
  it('ticket by ticket, environment failures apart, the total cost, and the verdict against the threshold set before', () => {
    const tickets = [ticket('REL-1'), ticket('REL-2'), ticket('REL-3', { outcome: 'blocked', factoryPr: undefined }), ticket('REL-4', { env: 'failed', envReason: 'npm ci failed', costUsd: 0 })];
    const judgments = [judged('REL-1', 'factory', 'as_is'), judged('REL-1', 'human', 'as_is'), judged('REL-2', 'factory', 'reject'), judged('REL-2', 'human', 'after_edits')];
    const r = ghostReport(replay, tickets, judgments);
    expect(r.rows.map((x) => [x.ticketId, x.factory, x.human])).toEqual([
      ['REL-1', 'as_is', 'as_is'],
      ['REL-2', 'reject', 'after_edits'],
      ['REL-3', 'no_pr', null],
    ]);
    expect(r.envFailures).toEqual([expect.objectContaining({ ticketId: 'REL-4', envReason: 'npm ci failed' })]);
    // The factory's PR counts mergeable as is or after edits; no PR is not mergeable. 1 of 3 compared.
    expect(r).toMatchObject({ compared: 3, mergeable: 1, asIs: 1, unjudged: 0, threshold: 0.5, verdict: 'below', totalCostUsd: 3.75, assumptions: 6 });
    expect(r.share).toBeCloseTo(1 / 3);
    expect(r.asIsShare).toBeCloseTo(1 / 3);
  });

  /** Ten tickets compared: the factory's PR graded `as_is` on the first `asIs`, `after_edits` on the next ones up to `mergeable`, `reject` after. */
  function graded(mergeable: number, asIs: number) {
    const tickets = Array.from({ length: 10 }, (_, i) => ticket(`REL-${i + 1}`));
    const judgments = tickets.flatMap((t, i) => [judged(t.ticketId, 'factory', i < asIs ? 'as_is' : i < mergeable ? 'after_edits' : 'reject'), judged(t.ticketId, 'human', 'as_is')]);
    return { tickets, judgments };
  }
  const decided = { ...replay, threshold: 0.6, asIsThreshold: 0.3 };

  it('ORC-385 criterion 2: 60% mergeable but 20% as is is below: met only when both shares reach their thresholds', () => {
    const below = graded(6, 2);
    const r = ghostReport(decided, below.tickets, below.judgments);
    expect(r).toMatchObject({ compared: 10, mergeable: 6, asIs: 2, threshold: 0.6, verdict: 'below' });
    expect(r.share).toBeCloseTo(0.6);
    expect(r.asIsShare).toBeCloseTo(0.2);
    const met = graded(6, 3);
    expect(ghostReport(decided, met.tickets, met.judgments).verdict).toBe('met');
    // Enough as is, not enough mergeable: below too.
    const few = graded(5, 5);
    expect(ghostReport(decided, few.tickets, few.judgments).verdict).toBe('below');
  });

  it('a replay recorded with one threshold stays readable: its as-is threshold not set, its verdict on the threshold it was given', () => {
    const { asIsThreshold: _, ...legacy } = decided;
    const g = graded(6, 0);
    const r = ghostReport(legacy, g.tickets, g.judgments);
    expect(r).toMatchObject({ asIs: 0, threshold: 0.6, verdict: 'met' });
  });

  it('a verdict waits for every judgment: incomplete until then', () => {
    expect(ghostReport(replay, [ticket('REL-1')], []).verdict).toBe('incomplete');
    expect(ghostReport(replay, [ticket('REL-1')], [judged('REL-1', 'factory', 'as_is'), judged('REL-1', 'human', 'reject')]).verdict).toBe('met');
  });

  it('a ticket not run or not collected yet leaves the replay without a verdict, never below the threshold', () => {
    const r = ghostReport(replay, [ticket('REL-1', { outcome: 'pending', factoryPr: undefined })], []);
    expect(r).toMatchObject({ pending: 1, verdict: 'incomplete' });
    expect(r.rows[0]!.factory).toBe('pending');
  });

  it('the environment is unchecked until the dry run exists (ORC-208): said, not counted as a failure', () => {
    expect(ghostReport(replay, [ticket('REL-1')], []).envUnchecked).toBe(1);
  });
});

describe('the threshold, written before the replay (ORC-143)', () => {
  it('is required, a share between 0 and 1, or a percentage', () => {
    expect(parseThreshold(undefined)).toBeUndefined();
    expect(parseThreshold('')).toBeUndefined();
    expect(parseThreshold('0.6')).toBe(0.6);
    expect(parseThreshold('60%')).toBe(0.6);
    expect(parseThreshold('1.5')).toBeUndefined();
    expect(parseThreshold('abc')).toBeUndefined();
  });
});
