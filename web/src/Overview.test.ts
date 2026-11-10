import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_SOURCE, Overview, overviewTiles } from './Overview.js';
import type { OverviewView } from './types.js';

const DAY = 24 * 60 * 60 * 1000;
const view = (patch: Partial<OverviewView> = {}): OverviewView => ({
  since: 0, until: 90 * DAY, unmeasured: 0, delivered: 3, medianLeadTimeMs: 2 * 60 * 60 * 1000, tokensPerMerged: { mean: 37_000, leftOut: 0 },
  usageLimitShare: { mean: 0.25, leftOut: 0 }, firstTry: { yes: 2, of: 3, reworks: [{ cause: 'pr.checks_failed', tickets: 1 }] }, reverted: { yes: 0, known: 2 },
  ciPerMerged: { mean: 90_000, leftOut: 1 }, red: { verified: 2, wouldHaveBlocked: 1 },
  messages: { count: 5, medianSignOfLifeMs: 4_000, withoutSignOfLife: 1, questions: 3, medianAnswerMs: 90_000, unanswered: 1 }, baseline: null, ...patch,
});
const BASELINE = {
  projectId: 'p', since: Date.UTC(2026, 7, 3), until: Date.UTC(2026, 10, 1), computedAt: 1,
  measures: {
    delivered: { value: 12, over: 20, leftOut: 8, noSource: false },
    lead_time: { value: 3 * 60 * 60 * 1000, over: 10, leftOut: 2, noSource: false },
    tokens_per_merged: { value: null, over: 0, leftOut: 12, noSource: true },
    first_try: { value: 0.75, over: 15, leftOut: 0, noSource: false },
  },
} satisfies OverviewView['baseline'];
const tile = (o: OverviewView, label: string) => overviewTiles(o).find((t) => t.label === label);

describe("the AI reviewers' miss rate (ORC-229)", () => {
  it('shows no figure while no definition of a serious defect is set, and says why', () => {
    const why = 'No definition of a serious defect is set (audit.serious_defect in factory.yml, ORC-153).';
    expect(tile(view({ aiReviewMisses: { counted: false, why } }), 'AI reviewers’ miss rate')).toMatchObject({ value: 'not counted', detail: why });
    expect(tile(view(), 'AI reviewers’ miss rate')).toBeUndefined();
  });

  it('shows the share of the human defects no AI finding saw, and what it is over', () => {
    const t = tile(view({ aiReviewMisses: { counted: true, definition: 'Loses data', defects: 4, missed: 1, rate: 0.25, leftOut: 2 } }), 'AI reviewers’ miss rate');
    expect(t).toMatchObject({ value: '25%', detail: expect.stringContaining('1 of 4 defects found in human review') });
    expect(t?.detail).toContain('2 entered under another definition');
    expect(tile(view({ aiReviewMisses: { counted: true, definition: 'Loses data', defects: 0, missed: 0, rate: null, leftOut: 0 } }), 'AI reviewers’ miss rate')?.value).toBe('—');
  });
});

describe('overviewTiles (ORC-299)', () => {
  it('gives delivered, lead time, tokens per merged ticket and the rate ready at the first try', () => {
    const o = view();
    expect(tile(o, 'Delivered')?.value).toBe('3');
    expect(tile(o, 'Median lead time')?.value).toBe('2 h 00 min');
    expect(tile(o, 'Tokens per merged ticket')).toMatchObject({ value: '37.0 k', detail: expect.stringContaining('code runs used 25% of the ticket budget') });
    expect(tile(view({ usageLimitShare: { mean: 0.25, leftOut: 2 } }), 'Tokens per merged ticket')?.detail).toContain('2 without a share');
    expect(tile(o, 'Ready at the first try')).toMatchObject({ value: '67%', detail: expect.stringContaining('2 of 3') });
    expect(tile(o, 'Ready at the first try')?.detail).toContain('CI checks failed');
  });

  it('gives the delays to the first sign of life and to the answer, with what they leave out', () => {
    const o = view();
    expect(tile(o, 'Median first sign of life')).toMatchObject({ value: '4 s', detail: expect.stringContaining('1 without') });
    expect(tile(o, 'Median answer')).toMatchObject({ value: '1 min 30 s', detail: expect.stringContaining('1 unanswered') });
  });

  it('shows a dash, never a zero, for a measure without a value, and says what a mean leaves out', () => {
    const o = view({ red: { verified: 0, wouldHaveBlocked: 0 }, delivered: 0, medianLeadTimeMs: null, tokensPerMerged: { mean: null, leftOut: 0 }, usageLimitShare: { mean: null, leftOut: 0 }, firstTry: { yes: 0, of: 0, reworks: [] }, ciPerMerged: { mean: null, leftOut: 0 } });
    for (const label of ['Median lead time', 'Tokens per merged ticket', 'Ready at the first try', 'CI per merged ticket', 'Red check']) expect(tile(o, label)?.value, label).toBe('—');
    expect(tile(view({ tokensPerMerged: { mean: 1_000, leftOut: 2 } }), 'Tokens per merged ticket')?.detail).toContain('2 merged without');
  });

  it('compares each headline measure with the 90-day baseline, and says when there is none (ORC-230)', () => {
    expect(overviewTiles(view()).filter((t) => t.headline).map((t) => t.label)).toEqual(['Delivered', 'Median lead time', 'Tokens per merged ticket', 'Ready at the first try']);
    expect(overviewTiles(view()).filter((t) => t.headline).map((t) => t.baseline)).toEqual(['no baseline', 'no baseline', 'no baseline', 'no baseline']);
    expect(overviewTiles(view()).filter((t) => !t.headline).every((t) => t.baseline === undefined)).toBe(true);
  });

  it('gives each headline measure its baseline value, tokens without a source, and a measure the baseline lacks as none (ORC-230)', () => {
    const o = view({ baseline: BASELINE });
    expect(tile(o, 'Delivered')).toMatchObject({ baseline: '12', baselineDetail: 'of 20 issues completed' });
    expect(tile(o, 'Median lead time')).toMatchObject({ baseline: '3 h 00 min', baselineDetail: '2 delivered without a start' });
    expect(tile(o, 'Tokens per merged ticket')).toMatchObject({ baseline: 'no source', baselineDetail: 'human work' });
    expect(tile(o, 'Ready at the first try')).toMatchObject({ baseline: '75%', baselineDetail: '15 merged PRs' });
    const without = view({ baseline: { ...BASELINE, measures: { delivered: BASELINE.measures.delivered } } });
    expect(tile(without, 'Median lead time')?.baseline).toBe('no baseline');
    expect(tile(view({ baseline: { ...BASELINE, measures: { ...BASELINE.measures, lead_time: { value: null, over: 0, leftOut: 0, noSource: false } } } }), 'Median lead time')?.baseline).toBe('—');
  });
});

describe('Overview (ORC-299)', () => {
  const page = (o: OverviewView) => renderToStaticMarkup(createElement(Overview, { overview: o }));

  it('shows the measures and the period, and how to compute the baseline while there is none', () => {
    const html = page(view());
    expect(html).toContain('Ready at the first try');
    expect(html).toContain('67%');
    expect(html).toContain('Last 90 days');
    expect(html).toContain('Baseline (90 days)');
    expect(html).toContain('no baseline');
    expect(html).toContain('factory baseline');
  });

  it('shows the baseline facing the measures, with its period and project (ORC-230)', () => {
    const html = page(view({ baseline: BASELINE }));
    expect(html).toContain('Baseline (2026-08-03 → 2026-11-01)');
    expect(html).toContain('75%');
    expect(html).toContain('no source');
    expect(html).toContain('computed for p from Linear and GitHub');
    expect(html).not.toContain('factory baseline');
  });

  it('says plainly which measures have no source yet, and the ticket that brings each', () => {
    const html = page(view());
    for (const { label, ticket } of NO_SOURCE) {
      expect(html).toContain(label);
      expect(html).toContain(ticket);
    }
    expect(NO_SOURCE.map((n) => n.ticket)).toEqual(['ORC-190']);
  });

  it('says how many tickets it could not measure', () => {
    expect(page(view({ unmeasured: 2 }))).toContain('2 tickets whose measures could not be read');
  });
});
