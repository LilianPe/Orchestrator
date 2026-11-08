import { allNodes, isConnection, isRecord, type Connection } from '../graphql-pages.js';
import type { GraphQl } from './review-threads.js';
import type { ForgeBranch, OpenPr } from './types.js';

const PAGE = 'pageInfo { hasNextPage endCursor }';

/** The open PRs of a repository, a page at a time, each with its first 100 files. */
export const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 50, after: $after) { ${PAGE} nodes {
    id number url title headRefName files(first: 100) { ${PAGE} nodes { path } } } } } }`;

/** The files of one PR past its first page. */
export const PR_FILES_QUERY = `query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest {
  files(first: 100, after: $after) { ${PAGE} nodes { path } } } } }`;

/** The branches of a repository, a page at a time; `$filter` filters them by name on the forge (named so: `gh api graphql` takes `query` for the document). */
export const BRANCHES_QUERY = `query($owner: String!, $name: String!, $after: String, $filter: String) {
  repository(owner: $owner, name: $name) { url refs(refPrefix: "refs/heads/", first: 100, after: $after, query: $filter) { ${PAGE} nodes { name } } } }`;

interface PrNode {
  id: string;
  number: number;
  url: string;
  title: string;
  headRefName: string;
  files: Connection<{ path: string }>;
}

const isFile = (f: unknown): boolean => isRecord(f) && typeof f.path === 'string';

const isPrNode = (p: unknown): boolean =>
  isRecord(p) &&
  typeof p.id === 'string' &&
  typeof p.number === 'number' &&
  typeof p.url === 'string' &&
  typeof p.title === 'string' &&
  typeof p.headRefName === 'string' &&
  isConnection(p.files, isFile);

/** A repository `null` (not found) or carrying a page of open PRs. */
const isPrsData = (d: unknown): d is { repository: { pullRequests: Connection<PrNode> } | null } =>
  isRecord(d) && (d.repository === null || (isRecord(d.repository) && isConnection(d.repository.pullRequests, isPrNode)));

/** A PR `null` (gone) or carrying a page of its files. */
const isFilesData = (d: unknown): d is { node: { files: Connection<{ path: string }> } | null } =>
  isRecord(d) && (d.node === null || (isRecord(d.node) && isConnection(d.node.files, isFile)));

const isBranch = (b: unknown): boolean => isRecord(b) && typeof b.name === 'string';

/** A repository `null` (not found) or carrying its url and a page of branches. */
const isBranchesData = (d: unknown): d is { repository: { url: string; refs: Connection<{ name: string }> } | null } =>
  isRecord(d) && (d.repository === null || (isRecord(d.repository) && typeof d.repository.url === 'string' && isConnection(d.repository.refs, isBranch)));

/**
 * Every open PR of the repository with every file it changes (ORC-207), by either forge: every page of PRs, and of a
 * PR's files past its first 100. A list `allNodes` cannot read to its end throws (ORC-347): a duplicate search that read
 * part of the PRs would let a duplicate through as none.
 */
export async function openPullRequests(gql: GraphQl, owner: string, name: string): Promise<OpenPr[]> {
  const repo = `${owner}/${name}`;
  const prs = await allNodes<PrNode>(`the open PRs of ${repo}`, async (after) => {
    const data = await gql(OPEN_PRS_QUERY, { owner, name, after }, isPrsData, 'a GraphQL answer with pull requests');
    if (!data.repository) throw new Error(`GitHub GraphQL: repository ${repo} not found`);
    return data.repository.pullRequests;
  });
  const out: OpenPr[] = [];
  for (const pr of prs) {
    const files = await allNodes<{ path: string }>(`the files of ${repo}#${pr.number}`, async (after) => {
      if (after === null) return pr.files;
      const data = await gql(PR_FILES_QUERY, { id: pr.id, after }, isFilesData, "a GraphQL answer with a pull request's files");
      if (!data.node) throw new Error(`GitHub GraphQL: PR ${repo}#${pr.number} not found`);
      return data.node.files;
    });
    out.push({ number: pr.number, url: pr.url, title: pr.title, branch: pr.headRefName, files: files.map((f) => f.path) });
  }
  return out;
}

/**
 * Every branch of the repository (ORC-207), or those whose name starts with `prefix`: the forge filters by name, the
 * prefix is checked here again, as its filter is no prefix match. Every page read, as `openPullRequests`.
 */
export async function repoBranches(gql: GraphQl, owner: string, name: string, prefix?: string): Promise<ForgeBranch[]> {
  const repo = `${owner}/${name}`;
  let web = '';
  const refs = await allNodes<{ name: string }>(`the branches of ${repo}`, async (after) => {
    const data = await gql(BRANCHES_QUERY, { owner, name, after, filter: prefix ?? null }, isBranchesData, 'a GraphQL answer with branches');
    if (!data.repository) throw new Error(`GitHub GraphQL: repository ${repo} not found`);
    web = data.repository.url;
    return data.repository.refs;
  });
  return refs.filter((r) => !prefix || r.name.startsWith(prefix)).map((r) => ({ name: r.name, url: `${web}/tree/${encodeURI(r.name)}` }));
}
