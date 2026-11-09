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
const tile = (o: OverviewView, label: string) => overviewTiles(o).find((t) => t.label === label);

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

  it('compares each headline measure with the 90-day baseline, which has no source before ORC-230', () => {
    expect(overviewTiles(view()).filter((t) => t.headline).map((t) => t.label)).toEqual(['Delivered', 'Median lead time', 'Tokens per merged ticket', 'Ready at the first try']);
    expect(renderToStaticMarkup(createElement(Overview, { overview: view() }))).toContain('— (ORC-230)');
  });
});

describe('Overview (ORC-299)', () => {
  const page = (o: OverviewView) => renderToStaticMarkup(createElement(Overview, { overview: o }));

  it('shows the measures, the baseline as not built yet, and the period', () => {
    const html = page(view());
    expect(html).toContain('Ready at the first try');
    expect(html).toContain('67%');
    expect(html).toContain('ORC-230');
    expect(html).toContain('Last 90 days');
  });

  it('says plainly which measures have no source yet, and the ticket that brings each', () => {
    const html = page(view());
    for (const { label, ticket } of NO_SOURCE) {
      expect(html).toContain(label);
      expect(html).toContain(ticket);
    }
    expect(NO_SOURCE.map((n) => n.ticket)).toEqual(['ORC-190', 'ORC-230']);
  });

  it('says how many tickets it could not measure', () => {
    expect(page(view({ unmeasured: 2 }))).toContain('2 tickets whose measures could not be read');
  });
});
