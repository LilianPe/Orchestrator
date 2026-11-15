import { describe, expect, it } from 'vitest';
import { MAX_GRAPHQL_PAGES } from '../graphql-pages.js';
import { BRANCHES_QUERY, OPEN_PRS_QUERY, openPullRequests, RECENT_BRANCHES_QUERY, recentRepoBranches, repoBranches } from './active-work.js';
import type { GraphQl } from './review-threads.js';

const conn = <N>(nodes: N[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const files = (totalCount: number, ...paths: string[]) => ({ totalCount, nodes: paths.map((path) => ({ path })) });
const pr = (number: number, fileList: unknown, extra: Record<string, unknown> = {}) => ({
  number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, headRefName: `feat/${number}`, isCrossRepository: false, files: fileList, ...extra,
});

/** A forge answering each query by `answer`, each answer checked as the forges check it; the calls kept. */
function forge(answer: (query: string, variables: Record<string, unknown>) => unknown) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const gql: GraphQl = async (query, variables, isData, what) => {
    calls.push({ query, variables });
    const data = answer(query, variables);
    if (!isData(data)) throw new Error(`unreadable, not ${what}`);
    return data;
  };
  return { gql, calls };
}

describe('openPullRequests (ORC-207)', () => {
  it('reads every page of open PRs, the most recently updated first, each with its first files and how many it changes', async () => {
    const f = forge((query, v) => {
      expect(query).toBe(OPEN_PRS_QUERY);
      return v.after === null
        ? { repository: { pullRequests: conn([pr(1, files(250, 'src/a.ts'))], 'p1') } }
        : { repository: { pullRequests: conn([pr(2, files(1, 'src/b.ts'), { isCrossRepository: true })]) } };
    });
    expect(await openPullRequests(f.gql, 'acme', 'app')).toEqual([
      { number: 1, url: 'https://github.com/acme/app/pull/1', title: 'PR 1', branch: 'feat/1', fork: false, files: ['src/a.ts'], filesTotal: 250 },
      { number: 2, url: 'https://github.com/acme/app/pull/2', title: 'PR 2', branch: 'feat/2', fork: true, files: ['src/b.ts'], filesTotal: 1 },
    ]);
    expect(f.calls.map((c) => c.variables.after)).toEqual([null, 'p1']);
    expect(OPEN_PRS_QUERY).toContain('orderBy: { field: UPDATED_AT, direction: DESC }');
  });

  it('keeps a PR whose files the forge does not list, without files', async () => {
    const f = forge(() => ({ repository: { pullRequests: conn([pr(1, null)]) } }));
    expect(await openPullRequests(f.gql, 'acme', 'app')).toEqual([expect.objectContaining({ number: 1, files: null, filesTotal: 0 })]);
  });

  it('never reads a list it cannot read to its end as complete: too many pages, a missing repository, an unreadable PR', async () => {
    const endless = forge(() => ({ repository: { pullRequests: conn([], 'more') } }));
    await expect(openPullRequests(endless.gql, 'acme', 'app')).rejects.toThrow(`more than ${MAX_GRAPHQL_PAGES} pages`);
    await expect(openPullRequests(forge(() => ({ repository: null })).gql, 'acme', 'app')).rejects.toThrow(/not found/);
    const noFork = forge(() => ({ repository: { pullRequests: conn([pr(1, files(0), { isCrossRepository: undefined })]) } }));
    await expect(openPullRequests(noFork.gql, 'acme', 'app')).rejects.toThrow(/unreadable/);
  });
});

describe('repoBranches (ORC-207)', () => {
  it('reads every page of the branches the forge matches, and keeps only the names that start with the prefix, each with its link', async () => {
    const f = forge((query, v) => {
      expect(query).toBe(BRANCHES_QUERY);
      const refs = v.after === null ? conn([{ name: 'factory/rel-1-a' }], 'b1') : conn([{ name: 'old/factory/rel-1-b' }, { name: 'factory/rel-1-c d' }]);
      return { repository: { url: 'https://github.com/acme/app', refs } };
    });
    expect(await repoBranches(f.gql, 'acme', 'app', 'factory/rel-1-')).toEqual([
      { name: 'factory/rel-1-a', url: 'https://github.com/acme/app/tree/factory/rel-1-a' },
      { name: 'factory/rel-1-c d', url: 'https://github.com/acme/app/tree/factory/rel-1-c%20d' },
    ]);
    expect(f.calls.map((c) => c.variables.filter)).toEqual(['factory/rel-1-', 'factory/rel-1-']);
  });

  it('an answer without its list of branches is unreadable', async () => {
    await expect(repoBranches(forge(() => ({ repository: { url: 'u' } })).gql, 'acme', 'app', 'x')).rejects.toThrow(/unreadable/);
  });
});

describe('recentRepoBranches (ORC-207)', () => {
  it('reads the most recently committed branches in one query, the default branch left out', async () => {
    const f = forge((query) => {
      expect(query).toBe(RECENT_BRANCHES_QUERY);
      return { repository: { url: 'https://github.com/acme/app', defaultBranchRef: { name: 'develop' }, refs: { nodes: [{ name: 'wip/pdf' }, { name: 'develop' }] } } };
    });
    expect(await recentRepoBranches(f.gql, 'acme', 'app')).toEqual([{ name: 'wip/pdf', url: 'https://github.com/acme/app/tree/wip/pdf' }]);
    expect(f.calls).toHaveLength(1);
  });

  it('an empty repository has no default branch; an answer without branches is unreadable', async () => {
    const empty = forge(() => ({ repository: { url: 'u', defaultBranchRef: null, refs: { nodes: [] } } }));
    expect(await recentRepoBranches(empty.gql, 'acme', 'app')).toEqual([]);
    await expect(recentRepoBranches(forge(() => ({ repository: { url: 'u', defaultBranchRef: null } })).gql, 'acme', 'app')).rejects.toThrow(/unreadable/);
  });
});
