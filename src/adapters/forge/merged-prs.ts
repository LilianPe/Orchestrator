import type { MergedPr } from '../../core/baseline.js';
import { allNodes, isConnection, isRecord, PAGE_INFO, type Connection } from '../graphql-pages.js';
import type { GraphQl } from './review-threads.js';

/** The PRs a search finds, a page at a time, each with how many reviews asked changes of it (named `q`: `gh api graphql` takes `query` for the document). */
export const MERGED_PRS_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) { issueCount ${PAGE_INFO} nodes {
    ... on PullRequest { number url title headRefName mergedAt reviews(states: CHANGES_REQUESTED) { totalCount } } } } }`;

interface PrNode {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  mergedAt: string;
  reviews: { totalCount: number };
}

const isPrNode = (p: unknown): boolean =>
  isRecord(p) &&
  typeof p.number === 'number' &&
  typeof p.url === 'string' &&
  typeof p.title === 'string' &&
  typeof p.headRefName === 'string' &&
  typeof p.mergedAt === 'string' &&
  Number.isFinite(Date.parse(p.mergedAt)) &&
  isRecord(p.reviews) &&
  typeof p.reviews.totalCount === 'number';

type Search = Connection<PrNode> & { issueCount: number };
const isSearch = (d: unknown): d is { search: Search } => isRecord(d) && isRecord(d.search) && typeof d.search.issueCount === 'number' && isConnection(d.search, isPrNode);

/** A date as GitHub's search reads it, to the second. */
const searchDate = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * The PRs of the repository merged in `[since, until)`, by either forge (ORC-230): what `factory baseline` reads of the 90
 * days before the factory. GitHub's search finds 1000 at most and its range takes both ends in: a search that found more
 * than it read throws, never read as complete (ORC-347), and a PR merged at `until` is left out here.
 */
export async function mergedPullRequests(gql: GraphQl, owner: string, name: string, since: number, until: number): Promise<MergedPr[]> {
  const q = `repo:${owner}/${name} is:pr is:merged merged:${searchDate(since)}..${searchDate(until)}`;
  let found = 0;
  const prs = await allNodes<PrNode>(`the PRs of ${owner}/${name} merged in the period`, async (after) => {
    const { search } = await gql(MERGED_PRS_QUERY, { q, after }, isSearch, 'a GraphQL answer with a search of merged PRs');
    found = search.issueCount;
    return search;
  });
  if (found > prs.length) throw new Error(`the PRs of ${owner}/${name} merged in the period: ${found} merged PRs, ${prs.length} read: never read as complete`);
  return prs
    .map((pr) => ({ number: pr.number, url: pr.url, title: pr.title, branch: pr.headRefName, mergedAt: Date.parse(pr.mergedAt), changesRequested: pr.reviews.totalCount > 0 }))
    .filter((pr) => pr.mergedAt >= since && pr.mergedAt < until);
}
