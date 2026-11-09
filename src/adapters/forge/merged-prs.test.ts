import { describe, expect, it } from 'vitest';
import { MERGED_PRS_QUERY, mergedPullRequests } from './merged-prs.js';
import type { GraphQl } from './review-threads.js';

const conn = <N>(nodes: N[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const pr = (number: number, mergedAt: string | null, changes = 0, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, headRefName: `feat/${number}`, mergedAt, reviews: { totalCount: changes }, ...extra,
});
const SINCE = Date.parse('2026-08-03T00:00:00.000Z');
const UNTIL = Date.parse('2026-11-01T00:00:00.000Z');

/** A forge answering each query by `answer`, each answer checked as the forges check it; the calls kept. */
function forge(answer: (variables: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const gql: GraphQl = async (query, variables, isData, what) => {
    expect(query).toBe(MERGED_PRS_QUERY);
    calls.push(variables);
    const data = answer(variables);
    if (!isData(data)) throw new Error(`unreadable, not ${what}`);
    return data;
  };
  return { gql, calls };
}

describe('mergedPullRequests (ORC-230)', () => {
  it('reads every page of the PRs of the repository merged in the period, each with whether a review asked changes', async () => {
    const f = forge((v) => ({
      search: v.after === null
        ? { issueCount: 3, ...conn([pr(1, '2026-09-01T10:00:00Z', 2)], 'p1') }
        : { issueCount: 3, ...conn([pr(2, '2026-10-01T10:00:00Z'), pr(3, '2026-11-01T00:00:00Z')]) },
    }));
    expect(await mergedPullRequests(f.gql, 'acme', 'app', SINCE, UNTIL)).toEqual([
      { url: 'https://github.com/acme/app/pull/1', title: 'PR 1', branch: 'feat/1', mergedAt: Date.parse('2026-09-01T10:00:00Z'), changesRequested: true },
      { url: 'https://github.com/acme/app/pull/2', title: 'PR 2', branch: 'feat/2', mergedAt: Date.parse('2026-10-01T10:00:00Z'), changesRequested: false },
      // Merged at the end of the period: GitHub's range takes it in, `computeBaseline` leaves it out.
      { url: 'https://github.com/acme/app/pull/3', title: 'PR 3', branch: 'feat/3', mergedAt: UNTIL, changesRequested: false },
    ]);
    expect(f.calls).toEqual([
      { q: 'repo:acme/app is:pr is:merged merged:2026-08-03T00:00:00Z..2026-11-01T00:00:00Z', after: null },
      { q: 'repo:acme/app is:pr is:merged merged:2026-08-03T00:00:00Z..2026-11-01T00:00:00Z', after: 'p1' },
    ]);
  });

  it('never reads as complete a search GitHub cuts short, nor an unreadable PR', async () => {
    const capped = forge(() => ({ search: { issueCount: 1500, ...conn([pr(1, '2026-09-01T10:00:00Z')], 'p1') } }));
    await expect(mergedPullRequests(capped.gql, 'acme', 'app', SINCE, UNTIL)).rejects.toThrow(/1500 found, GitHub gives 1000 at most/);
    // On its first page: no page more is read.
    expect(capped.calls).toHaveLength(1);
    const unmerged = forge(() => ({ search: { issueCount: 1, ...conn([pr(1, null)]) } }));
    await expect(mergedPullRequests(unmerged.gql, 'acme', 'app', SINCE, UNTIL)).rejects.toThrow(/unreadable/);
  });
});
