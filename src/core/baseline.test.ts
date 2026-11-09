import { describe, expect, it } from 'vitest';
import { BASELINE_DAYS, baselineOf, baselinePeriod, baselineRows, type CompletedIssue, type MergedPr } from './baseline.js';

const DAY = 24 * 60 * 60 * 1000;
const START = 100 * DAY;
const PERIOD = baselinePeriod(START);
const issue = (identifier: string, completedAt: number, patch: Partial<CompletedIssue> = {}): CompletedIssue => ({ identifier, startedAt: completedAt - 2 * DAY, completedAt, links: [], ...patch });
const pr = (number: number, mergedAt: number, patch: Partial<MergedPr> = {}): MergedPr => ({
  number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, branch: `feat/${number}`, mergedAt, changesRequested: false, ...patch,
});
const measure = (rows: ReturnType<typeof baselineRows>, name: string) => rows.find((r) => r.measure === name);

describe('baselinePeriod (ORC-230)', () => {
  it('covers the 90 days before the start, the start left out', () => {
    expect(BASELINE_DAYS).toBe(90);
    expect(PERIOD).toEqual({ since: START - 90 * DAY, until: START });
    expect(PERIOD.until - PERIOD.since).toBe(90 * DAY);
  });
});

describe('baselineRows (ORC-230)', () => {
  it('counts as delivered the issues completed in the period that have a merged PR, linked by the issue, its branch or its title', () => {
    const rows = baselineRows('p', PERIOD, [
      issue('ORC-1', 20 * DAY, { links: ['https://github.com/acme/app/pull/1'] }),
      issue('ORC-2', 30 * DAY),
      issue('ORC-3', 40 * DAY),
      // Completed without a merged PR: not delivered.
      issue('ORC-4', 50 * DAY),
      // Completed before the period: not in it.
      issue('ORC-5', 5 * DAY, { links: ['https://github.com/acme/app/pull/5'] }),
    ], [
      pr(1, 19 * DAY),
      pr(2, 29 * DAY, { branch: 'armand/orc-2-export' }),
      pr(3, 39 * DAY, { title: 'fix(core): import (ORC-3)' }),
      // ORC-30 is not ORC-3, nor ORC-4.
      pr(4, 49 * DAY, { title: 'ORC-30', branch: 'orc-40' }),
      pr(5, 4 * DAY),
    ], 7);
    expect(measure(rows, 'delivered')).toEqual({ projectId: 'p', measure: 'delivered', ...PERIOD, value: 3, over: 4, leftOut: 1, noSource: false, computedAt: 7 });
  });

  it("takes the median lead time from each delivered issue's start to its first merged PR, and leaves out an issue never started", () => {
    const rows = baselineRows('p', PERIOD, [
      issue('ORC-1', 20 * DAY, { startedAt: 18 * DAY }),
      issue('ORC-2', 30 * DAY, { startedAt: 22 * DAY }),
      issue('ORC-3', 40 * DAY, { startedAt: null }),
    ], [pr(1, 20 * DAY, { branch: 'orc-1' }), pr(11, 25 * DAY, { branch: 'orc-1-more' }), pr(2, 26 * DAY, { branch: 'orc-2' }), pr(3, 40 * DAY, { branch: 'orc-3' })], 7);
    expect(measure(rows, 'lead_time')).toMatchObject({ value: 3 * DAY, over: 2, leftOut: 1, noSource: false });
  });

  it("gives the share of the delivered issues' merged PRs that no review asked changes of", () => {
    const rows = baselineRows('p', PERIOD, [issue('ORC-1', 20 * DAY), issue('ORC-2', 30 * DAY)], [
      pr(1, 20 * DAY, { branch: 'orc-1' }),
      pr(2, 21 * DAY, { branch: 'orc-1-fix', changesRequested: true }),
      pr(3, 30 * DAY, { branch: 'orc-2' }),
      pr(4, 30 * DAY, { changesRequested: true, title: 'chore: deps' }),
    ], 7);
    expect(measure(rows, 'first_try')).toMatchObject({ value: 2 / 3, over: 3, leftOut: 0 });
  });

  it('stores tokens per merged ticket without a value: human work has no source for them, never an invented one', () => {
    const rows = baselineRows('p', PERIOD, [issue('ORC-1', 20 * DAY)], [pr(1, 20 * DAY, { branch: 'orc-1' })], 7);
    expect(measure(rows, 'tokens_per_merged')).toMatchObject({ value: null, over: 0, leftOut: 1, noSource: true });
    expect(rows.map((r) => r.measure)).toEqual(['delivered', 'lead_time', 'tokens_per_merged', 'first_try']);
  });

  it('gives no value, never a zero that reads as a measure, when nothing was delivered', () => {
    const rows = baselineRows('p', PERIOD, [issue('ORC-1', 20 * DAY)], [], 7);
    expect(measure(rows, 'delivered')).toMatchObject({ value: 0, over: 1, leftOut: 1 });
    expect(measure(rows, 'lead_time')).toMatchObject({ value: null, over: 0, leftOut: 0 });
    expect(measure(rows, 'first_try')).toMatchObject({ value: null, over: 0 });
  });

  it('leaves out a PR merged outside the period', () => {
    const rows = baselineRows('p', PERIOD, [issue('ORC-1', 20 * DAY)], [pr(1, START, { branch: 'orc-1' })], 7);
    expect(measure(rows, 'delivered')?.value).toBe(0);
  });
});

describe('baselineOf (ORC-230)', () => {
  it('gathers the rows of one baseline by measure, with its project and period; none without rows', () => {
    const rows = baselineRows('p', PERIOD, [issue('ORC-1', 20 * DAY)], [pr(1, 20 * DAY, { branch: 'orc-1' })], 7);
    expect(baselineOf(rows)).toEqual({
      projectId: 'p', ...PERIOD, computedAt: 7,
      measures: {
        delivered: { value: 1, over: 1, leftOut: 0, noSource: false },
        lead_time: { value: 2 * DAY, over: 1, leftOut: 0, noSource: false },
        tokens_per_merged: { value: null, over: 0, leftOut: 1, noSource: true },
        first_try: { value: 1, over: 1, leftOut: 0, noSource: false },
      },
    });
    expect(baselineOf([])).toBeNull();
    expect(baselineOf(rows.filter((r) => r.measure === 'delivered'))?.measures).toEqual({ delivered: { value: 1, over: 1, leftOut: 0, noSource: false } });
  });
});
