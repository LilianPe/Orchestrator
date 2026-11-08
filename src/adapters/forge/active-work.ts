import { allNodes, isConnection, isRecord, PAGE_INFO, type Connection } from '../graphql-pages.js';
import type { GraphQl } from './review-threads.js';
import type { ForgeBranch, OpenPr } from './types.js';

/** Files read of one PR, as many as intake is shown (`formatActiveWork`): past them, the PR says how many it changes. */
const PR_FILES = 30;
/** Branches read for intake: the most recently committed. */
const RECENT_BRANCHES = 100;

/** The open PRs of a repository, the most recently updated first, a page at a time, each with its first files and their count. */
export const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { ${PAGE_INFO} nodes {
    number url title headRefName isCrossRepository files(first: ${PR_FILES}) { totalCount nodes { path } } } } } }`;

/** The branches whose name matches `$filter`, a page at a time (named so: `gh api graphql` takes `query` for the document). */
export const BRANCHES_QUERY = `query($owner: String!, $name: String!, $after: String, $filter: String!) {
  repository(owner: $owner, name: $name) { url refs(refPrefix: "refs/heads/", first: 100, after: $after, query: $filter) { ${PAGE_INFO} nodes { name } } } }`;

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
const isBranch = (b: unknown): boolean => isRecord(b) && typeof b.name === 'string';

/** `files` may be `null`: GitHub lists no files for a PR whose diff it cannot compute. */
const isPrNode = (p: unknown): boolean =>
  isRecord(p) &&
  typeof p.number === 'number' &&
  typeof p.url === 'string' &&
  typeof p.title === 'string' &&
  typeof p.headRefName === 'string' &&
  typeof p.isCrossRepository === 'boolean' &&
  (p.files === null || (isRecord(p.files) && typeof p.files.totalCount === 'number' && Array.isArray(p.files.nodes) && p.files.nodes.every(isFile)));

const hasPrs = (r: Record<string, unknown>): boolean => isConnection(r.pullRequests, isPrNode);
const hasBranches = (r: Record<string, unknown>): boolean => typeof r.url === 'string' && isConnection(r.refs, isBranch);
/** Its default branch is `null` in an empty repository. */
const hasRecent = (r: Record<string, unknown>): boolean =>
  typeof r.url === 'string' &&
  (r.defaultBranchRef === null || (isRecord(r.defaultBranchRef) && typeof r.defaultBranchRef.name === 'string')) &&
  isRecord(r.refs) &&
  Array.isArray(r.refs.nodes) &&
  r.refs.nodes.every(isBranch);

/**
 * The repository of one query, once `has` accepts its fields: an answer of another shape is unreadable, and a repository
 * GitHub answers `null` for (not found, or out of the token's reach) throws.
 */
async function repository<R>(gql: GraphQl, query: string, variables: Record<string, unknown>, has: (r: Record<string, unknown>) => boolean, what: string): Promise<R> {
  const isData = (d: unknown): d is { repository: R | null } => isRecord(d) && (d.repository === null || (isRecord(d.repository) && has(d.repository)));
  const data = await gql(query, variables, isData, `a GraphQL answer with ${what}`);
  if (!data.repository) throw new Error(`GitHub GraphQL: repository ${String(variables.owner)}/${String(variables.name)} not found`);
  return data.repository;
}

/** A branch with its page on the forge: the link a duplicate's block gives. */
export const branchOf = (web: string, name: string): ForgeBranch => ({ name, url: `${web}/tree/${encodeURI(name)}` });

/**
 * Every open PR of the repository (ORC-207), the most recently updated first, by either forge: every page of PRs, a list
 * `allNodes` cannot read to its end throws (ORC-347), as a search that read part of them would let a duplicate through.
 * Of each PR, its first `PR_FILES` files and how many it changes (`filesTotal`): a deliberate cut, said, that never hides
 * the PR itself; `files: null` when the forge lists none.
 */
export async function openPullRequests(gql: GraphQl, owner: string, name: string): Promise<OpenPr[]> {
  const prs = await allNodes<PrNode>(`the open PRs of ${owner}/${name}`, async (after) => {
    const repo = await repository<{ pullRequests: Connection<PrNode> }>(gql, OPEN_PRS_QUERY, { owner, name, after }, hasPrs, 'pull requests');
    return repo.pullRequests;
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
  let web = '';
  const refs = await allNodes<{ name: string }>(`the branches of ${owner}/${name}`, async (after) => {
    const repo = await repository<{ url: string; refs: Connection<{ name: string }> }>(gql, BRANCHES_QUERY, { owner, name, after, filter: prefix }, hasBranches, 'branches');
    web = repo.url;
    return repo.refs;
  });
  return refs.filter((r) => r.name.startsWith(prefix)).map((r) => branchOf(web, r.name));
}

/**
 * The `RECENT_BRANCHES` most recently committed branches but the default one (ORC-207): the active ones intake reads as
 * candidates. A selection, said as one, not a list read as complete: an old branch is not work in progress.
 */
export async function recentRepoBranches(gql: GraphQl, owner: string, name: string): Promise<ForgeBranch[]> {
  type Recent = { url: string; defaultBranchRef: { name: string } | null; refs: { nodes: { name: string }[] } };
  const { url, defaultBranchRef, refs } = await repository<Recent>(gql, RECENT_BRANCHES_QUERY, { owner, name }, hasRecent, 'branches');
  return refs.nodes.filter((r) => r.name !== defaultBranchRef?.name).map((r) => branchOf(url, r.name));
}
