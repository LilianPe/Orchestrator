import { allNodes, isConnection, isRecord, type Connection } from '../graphql-pages.js';
import type { GraphQl } from './review-threads.js';
import type { ForgeBranch, OpenPr } from './types.js';

const PAGE = 'pageInfo { hasNextPage endCursor }';

/** Files read of one PR: past them, the PR says how many it changes. */
export const PR_FILES = 100;
/** Branches read for intake: the most recently committed. */
export const RECENT_BRANCHES = 100;

/** The open PRs of a repository, the most recently updated first, a page at a time, each with its first files and their count. */
export const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { ${PAGE} nodes {
    number url title headRefName isCrossRepository files(first: ${PR_FILES}) { totalCount nodes { path } } } } } }`;

/** The branches whose name matches `$filter`, a page at a time (named so: `gh api graphql` takes `query` for the document). */
export const BRANCHES_QUERY = `query($owner: String!, $name: String!, $after: String, $filter: String!) {
  repository(owner: $owner, name: $name) { url refs(refPrefix: "refs/heads/", first: 100, after: $after, query: $filter) { ${PAGE} nodes { name } } } }`;

/** The most recently committed branches, and the default one, which they leave out. */
export const RECENT_BRANCHES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { url defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: ${RECENT_BRANCHES}, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } } } }`;

interface PrNode {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  isCrossRepository: boolean;
  files: { totalCount: number; nodes: { path: string }[] } | null;
}

const isFile = (f: unknown): boolean => isRecord(f) && typeof f.path === 'string';

/** `files` may be `null`: GitHub lists no files for a PR whose diff it cannot compute. */
const isPrNode = (p: unknown): boolean =>
  isRecord(p) &&
  typeof p.number === 'number' &&
  typeof p.url === 'string' &&
  typeof p.title === 'string' &&
  typeof p.headRefName === 'string' &&
  typeof p.isCrossRepository === 'boolean' &&
  (p.files === null || (isRecord(p.files) && typeof p.files.totalCount === 'number' && Array.isArray(p.files.nodes) && p.files.nodes.every(isFile)));

/** A repository `null` (not found) or carrying a page of open PRs. */
const isPrsData = (d: unknown): d is { repository: { pullRequests: Connection<PrNode> } | null } =>
  isRecord(d) && (d.repository === null || (isRecord(d.repository) && isConnection(d.repository.pullRequests, isPrNode)));

const isBranch = (b: unknown): boolean => isRecord(b) && typeof b.name === 'string';

/** A repository `null` (not found) or carrying its url and a page of branches. */
const isBranchesData = (d: unknown): d is { repository: { url: string; refs: Connection<{ name: string }> } | null } =>
  isRecord(d) && (d.repository === null || (isRecord(d.repository) && typeof d.repository.url === 'string' && isConnection(d.repository.refs, isBranch)));

/** A repository `null` (not found) or carrying its url, its default branch (`null` in an empty one) and its recent branches. */
const isRecentData = (d: unknown): d is { repository: { url: string; defaultBranchRef: { name: string } | null; refs: { nodes: { name: string }[] } } | null } =>
  isRecord(d) &&
  (d.repository === null ||
    (isRecord(d.repository) &&
      typeof d.repository.url === 'string' &&
      (d.repository.defaultBranchRef === null || (isRecord(d.repository.defaultBranchRef) && typeof d.repository.defaultBranchRef.name === 'string')) &&
      isRecord(d.repository.refs) &&
      Array.isArray(d.repository.refs.nodes) &&
      d.repository.refs.nodes.every(isBranch)));

const branchOf = (web: string, name: string): ForgeBranch => ({ name, url: `${web}/tree/${encodeURI(name)}` });

/**
 * Every open PR of the repository (ORC-207), the most recently updated first, by either forge: every page of PRs, a list
 * `allNodes` cannot read to its end throws (ORC-347), as a search that read part of them would let a duplicate through.
 * Of each PR, its first `PR_FILES` files and how many it changes (`filesTotal`): a deliberate cut, said, that never hides
 * the PR itself; `files: null` when the forge lists none.
 */
export async function openPullRequests(gql: GraphQl, owner: string, name: string): Promise<OpenPr[]> {
  const repo = `${owner}/${name}`;
  const prs = await allNodes<PrNode>(`the open PRs of ${repo}`, async (after) => {
    const data = await gql(OPEN_PRS_QUERY, { owner, name, after }, isPrsData, 'a GraphQL answer with pull requests');
    if (!data.repository) throw new Error(`GitHub GraphQL: repository ${repo} not found`);
    return data.repository.pullRequests;
  });
  return prs.map((pr) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    branch: pr.headRefName,
    fork: pr.isCrossRepository,
    files: pr.files ? pr.files.nodes.map((f) => f.path) : null,
    filesTotal: pr.files?.totalCount ?? 0,
  }));
}

/**
 * The branches whose name starts with `prefix` (ORC-207): the forge filters by name, the prefix is checked here again, as
 * its filter is no prefix match. Every page read, as `openPullRequests`.
 */
export async function repoBranches(gql: GraphQl, owner: string, name: string, prefix: string): Promise<ForgeBranch[]> {
  const repo = `${owner}/${name}`;
  let web = '';
  const refs = await allNodes<{ name: string }>(`the branches of ${repo}`, async (after) => {
    const data = await gql(BRANCHES_QUERY, { owner, name, after, filter: prefix }, isBranchesData, 'a GraphQL answer with branches');
    if (!data.repository) throw new Error(`GitHub GraphQL: repository ${repo} not found`);
    web = data.repository.url;
    return data.repository.refs;
  });
  return refs.filter((r) => r.name.startsWith(prefix)).map((r) => branchOf(web, r.name));
}

/**
 * The `RECENT_BRANCHES` most recently committed branches but the default one (ORC-207): the active ones intake reads as
 * candidates. A selection, said as one, not a list read as complete: an old branch is not work in progress.
 */
export async function recentRepoBranches(gql: GraphQl, owner: string, name: string): Promise<ForgeBranch[]> {
  const data = await gql(RECENT_BRANCHES_QUERY, { owner, name }, isRecentData, 'a GraphQL answer with branches');
  if (!data.repository) throw new Error(`GitHub GraphQL: repository ${owner}/${name} not found`);
  const { url, defaultBranchRef, refs } = data.repository;
  return refs.nodes.filter((r) => r.name !== defaultBranchRef?.name).map((r) => branchOf(url, r.name));
}
