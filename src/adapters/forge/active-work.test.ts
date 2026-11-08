import { describe, expect, it } from 'vitest';
import { MAX_GRAPHQL_PAGES } from '../graphql-pages.js';
import { BRANCHES_QUERY, OPEN_PRS_QUERY, openPullRequests, PR_FILES_QUERY, repoBranches } from './active-work.js';
import type { GraphQl } from './review-threads.js';

const conn = <N>(nodes: N[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const files = (...paths: string[]) => paths.map((path) => ({ path }));
const pr = (number: number, fileConn: unknown, extra: Record<string, unknown> = {}) => ({
  id: `PR_${number}`, number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, headRefName: `feat/${number}`, files: fileConn, ...extra,
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
  it('reads every page of open PRs, and the files of a PR past its first page', async () => {
    const f = forge((query, v) => {
      if (query === OPEN_PRS_QUERY) {
        return v.after === null
          ? { repository: { pullRequests: conn([pr(1, conn(files('src/a.ts'), 'f1'))], 'p1') } }
          : { repository: { pullRequests: conn([pr(2, conn(files('src/b.ts')))]) } };
      }
      if (query === PR_FILES_QUERY && v.id === 'PR_1' && v.after === 'f1') return { node: { files: conn(files('src/c.ts')) } };
      throw new Error(`unexpected ${JSON.stringify(v)}`);
    });
    expect(await openPullRequests(f.gql, 'acme', 'app')).toEqual([
      { number: 1, url: 'https://github.com/acme/app/pull/1', title: 'PR 1', branch: 'feat/1', files: ['src/a.ts', 'src/c.ts'] },
      { number: 2, url: 'https://github.com/acme/app/pull/2', title: 'PR 2', branch: 'feat/2', files: ['src/b.ts'] },
    ]);
    expect(f.calls.map((c) => c.variables.after)).toEqual([null, 'p1', 'f1']);
  });

  it('never reads a list it cannot read to its end as complete: too many pages, a missing repository, an unreadable PR', async () => {
    const endless = forge(() => ({ repository: { pullRequests: conn([], 'more') } }));
    await expect(openPullRequests(endless.gql, 'acme', 'app')).rejects.toThrow(`more than ${MAX_GRAPHQL_PAGES} pages`);
    await expect(openPullRequests(forge(() => ({ repository: null })).gql, 'acme', 'app')).rejects.toThrow(/not found/);
    const noFiles = forge(() => ({ repository: { pullRequests: conn([pr(1, undefined)]) } }));
    await expect(openPullRequests(noFiles.gql, 'acme', 'app')).rejects.toThrow(/unreadable/);
  });

  it('a PR gone while its files are read throws, never a PR without files', async () => {
    const f = forge((query) => (query === OPEN_PRS_QUERY ? { repository: { pullRequests: conn([pr(1, conn(files('a'), 'f1'))]) } } : { node: null }));
    await expect(openPullRequests(f.gql, 'acme', 'app')).rejects.toThrow(/PR acme\/app#1 not found/);
  });
});

describe('repoBranches (ORC-207)', () => {
  it('reads every page of branches, each with its link on the forge', async () => {
    const f = forge((query, v) => {
      expect(query).toBe(BRANCHES_QUERY);
      return { repository: { url: 'https://github.com/acme/app', refs: v.after === null ? conn([{ name: 'main' }], 'b1') : conn([{ name: 'feat/x y' }]) } };
    });
    expect(await repoBranches(f.gql, 'acme', 'app')).toEqual([
      { name: 'main', url: 'https://github.com/acme/app/tree/main' },
      { name: 'feat/x y', url: 'https://github.com/acme/app/tree/feat/x%20y' },
    ]);
    expect(f.calls[0]!.variables.filter).toBeNull();
  });

  it('with a prefix, asks the forge to filter and keeps only the names that start with it', async () => {
    const f = forge(() => ({ repository: { url: 'https://github.com/acme/app', refs: conn([{ name: 'factory/rel-1-a' }, { name: 'old/factory/rel-1-b' }]) } }));
    expect((await repoBranches(f.gql, 'acme', 'app', 'factory/rel-1-')).map((b) => b.name)).toEqual(['factory/rel-1-a']);
    expect(f.calls[0]!.variables.filter).toBe('factory/rel-1-');
  });

  it('an answer without its list of branches is unreadable', async () => {
    await expect(repoBranches(forge(() => ({ repository: { url: 'u' } })).gql, 'acme', 'app')).rejects.toThrow(/unreadable/);
  });
});
