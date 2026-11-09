import { describe, expect, it } from 'vitest';
import type { CompletedIssue, MergedPr } from '../core/baseline.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { BASELINE_USAGE, parseStartDate, runBaseline, type BaselineOptions } from './baseline.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 1);
const NOW = START + DAY;

/** Linear and GitHub as fakes: the period each was asked, kept; no network. */
function withStore(issues: CompletedIssue[] = [], prs: MergedPr[] = []) {
  const store = new SqliteStore(':memory:');
  const lines: string[] = [];
  const asked: unknown[] = [];
  const sources: BaselineOptions['sources'] = {
    completedIssues: async (teamKey, since, until) => {
      asked.push({ teamKey, since, until });
      return issues;
    },
    mergedPrs: async (repoPath, since, until) => {
      asked.push({ repoPath, since, until });
      return prs;
    },
  };
  const baseline = (o: Partial<BaselineOptions> = {}) =>
    runBaseline({ store, sources, project: { id: 'p', repoPath: '/repo', teamKey: 'ORC' }, start: START, replace: false, now: NOW, print: (l) => void lines.push(l), ...o });
  return { store, lines, asked, baseline };
}

describe('factory baseline (ORC-230)', () => {
  it('reads Linear and GitHub over the 90 days before the start, for the project, and stores one frozen row per measure', async () => {
    const { store, lines, asked, baseline } = withStore(
      [{ identifier: 'ORC-1', startedAt: START - 10 * DAY, completedAt: START - 8 * DAY, links: [] }],
      [{ number: 1, url: 'https://github.com/acme/app/pull/1', title: 'ORC-1', branch: 'orc-1', mergedAt: START - 8 * DAY, changesRequested: false }],
    );
    expect(await baseline()).toBe(0);
    const period = { since: START - 90 * DAY, until: START };
    expect(asked).toEqual([{ teamKey: 'ORC', ...period }, { repoPath: '/repo', ...period }]);
    const rows = await store.latestBaseline();
    expect(rows.map((r) => [r.measure, r.value])).toEqual([['delivered', 1], ['lead_time', 2 * DAY], ['tokens_per_merged', null], ['first_try', 1]]);
    expect(rows.every((r) => r.projectId === 'p' && r.since === period.since && r.until === period.until && r.computedAt === NOW)).toBe(true);
    expect(lines).toEqual([
      'Baseline of p over 2026-08-03 → 2026-11-01 (90 days), from Linear ORC and GitHub:',
      '  Delivered: 1 (of 1 issue completed)',
      '  Median lead time: 2.0 days (over 1 delivered issue)',
      '  Tokens per merged ticket: no source (human work)',
      '  Ready at the first try: 100% (of 1 merged PR)',
      'Stored.',
    ]);
  });

  it('refuses the same period again, the stored rows kept, unless --replace', async () => {
    const { store, lines, baseline } = withStore();
    expect(await baseline()).toBe(0);
    const stored = await store.latestBaseline();
    lines.length = 0;
    expect(await baseline({ now: NOW + 1 })).toBe(1);
    // Only the refusal: figures that are not the stored ones are never printed.
    expect(lines).toEqual(['A baseline of p over 2026-08-03 → 2026-11-01 is already stored: --replace to compute it again.']);
    expect(await store.latestBaseline()).toEqual(stored);
    expect(await baseline({ now: NOW + 2, replace: true })).toBe(0);
    expect((await store.latestBaseline()).every((r) => r.computedAt === NOW + 2)).toBe(true);
  });

  it('refuses a start still to come, reading nothing: its 90 days have not all happened', async () => {
    const { store, lines, asked, baseline } = withStore();
    expect(await baseline({ now: START - 1 })).toBe(1);
    expect(lines).toEqual(['The start 2026-11-01 is still to come: the baseline is the 90 days before the factory started.']);
    expect(asked).toEqual([]);
    expect(await store.latestBaseline()).toEqual([]);
  });

  it('says when nothing was delivered, a dash rather than a zero for what has no value', async () => {
    const { lines, baseline } = withStore();
    await baseline();
    expect(lines.slice(1, 5)).toEqual([
      '  Delivered: 0 (of 0 issues completed)',
      '  Median lead time: — (over 0 delivered issues)',
      '  Tokens per merged ticket: no source (human work)',
      '  Ready at the first try: — (of 0 merged PRs)',
    ]);
  });
});

describe('parseStartDate (ORC-230)', () => {
  it('reads a calendar day as its UTC midnight, and nothing else', () => {
    expect(parseStartDate('2026-11-01')).toBe(START);
    for (const bad of ['2026-13-01', '2026-02-30', '01/11/2026', '2026-11-01T10:00', '']) expect(parseStartDate(bad), bad).toBeUndefined();
    expect(BASELINE_USAGE).toContain('--since <YYYY-MM-DD>');
  });
});
