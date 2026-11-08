import type { FeedbackItem } from '../../core/types.js';
import { allNodes, isConnection, isRecord, type Connection } from '../graphql-pages.js';

const PAGE = 'pageInfo { hasNextPage endCursor }';
const COMMENT = 'author { __typename login } body createdAt path line';

/**
 * Characters of review feedback the agent is given, its comments' bodies together (ORC-366): past it, the newest
 * threads are kept and the agent told how many older ones were cut. Proposal: settled with the prompt budget (ORC-254).
 */
export const REVIEW_FEEDBACK_MAX = 16000;

/** A PR's review threads, a page at a time, each with its first 100 comments. */
export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { ${PAGE} nodes {
    id isResolved comments(first: 100) { ${PAGE} nodes { ${COMMENT} } } } } } } }`;

/** The comments of one thread past its first page. */
export const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread {
  comments(first: 100, after: $after) { ${PAGE} nodes { ${COMMENT} } } } } }`;

interface CommentNode {
  author: { __typename: string; login: string } | null;
  body: string;
  createdAt: string;
  path: string;
  line: number | null;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  comments: Connection<CommentNode>;
}

/**
 * One GraphQL query, by either forge: its `data` once `isData` accepts it. GraphQL errors, and an answer `isData`
 * rejects (`what` names what it should be), throw.
 */
export type GraphQl = <T>(query: string, variables: Record<string, unknown>, isData: (d: unknown) => d is T, what: string) => Promise<T>;

const isComment = (c: unknown): boolean =>
  isRecord(c) &&
  (c.author === null || (isRecord(c.author) && typeof c.author.__typename === 'string' && typeof c.author.login === 'string')) &&
  typeof c.body === 'string' &&
  typeof c.createdAt === 'string' &&
  typeof c.path === 'string' &&
  (c.line === null || typeof c.line === 'number');

const isThread = (t: unknown): boolean => isRecord(t) && typeof t.id === 'string' && typeof t.isResolved === 'boolean' && isConnection(t.comments, isComment);

/** A repository and a PR each `null` (not found) or carrying a page of threads. */
const isThreadsData = (d: unknown): d is { repository: { pullRequest: { reviewThreads: Connection<ThreadNode> } | null } | null } => {
  if (!isRecord(d)) return false;
  const repo = d.repository;
  if (repo === null) return true;
  if (!isRecord(repo)) return false;
  const pr = repo.pullRequest;
  return pr === null || (isRecord(pr) && isConnection(pr.reviewThreads, isThread));
};

/** A thread `null` (gone) or carrying a page of its comments. */
const isCommentsData = (d: unknown): d is { node: { comments: Connection<CommentNode> } | null } =>
  isRecord(d) && (d.node === null || (isRecord(d.node) && isConnection(d.node.comments, isComment)));

const toFeedback = (c: CommentNode): FeedbackItem => ({
  author: c.author?.login ?? 'inconnu',
  body: `${c.path}${c.line ? `:${c.line}` : ''} — ${c.body}`,
  at: Date.parse(c.createdAt),
  source: 'review',
});

/** A GitHub App, the CI, Dependabot: GitHub types their accounts `Bot` (ORC-366). The factory's own reviewer, ORC-183's, will be let through. */
const byBot = (c: CommentNode): boolean => c.author?.__typename === 'Bot';

/**
 * The newest threads whose comments fit in `REVIEW_FEEDBACK_MAX` together, a thread dated by its latest comment, kept in
 * their order: none older than one cut, however short. Past the cap, an item last tells the agent how many were cut.
 */
function capped(threads: FeedbackItem[][], pr: string): FeedbackItem[] {
  const latest = (t: FeedbackItem[]) => Math.max(...t.map((i) => i.at));
  const newestFirst = [...threads].sort((a, b) => latest(b) - latest(a));
  let size = 0;
  const fits = newestFirst.findIndex((t) => (size += t.reduce((n, i) => n + i.body.length, 0)) > REVIEW_FEEDBACK_MAX);
  if (fits === -1) return threads.flat();
  const cut = new Set(newestFirst.slice(fits));
  const n = cut.size;
  return [
    ...threads.filter((t) => !cut.has(t)).flat(),
    {
      author: 'factory',
      body: `${n} older review thread${n === 1 ? '' : 's'} not shown: the review feedback given here is capped at ${REVIEW_FEEDBACK_MAX} characters. ${n === 1 ? 'It is' : 'They are'} still open on ${pr}.`,
      at: latest(newestFirst[fits]!),
      source: 'review',
    },
  ];
}

/**
 * The unresolved review threads of a PR, every comment of each as one item, in order: a reviewer's reply in a thread
 * reaches the agent as the thread's first comment does (ORC-347). Every page of threads is read, and of an unresolved
 * thread's comments; a list `allNodes` cannot read to its end throws, never reads as complete. A bot's comments are
 * dropped, and the feedback is capped (`capped`, ORC-366).
 */
export async function unresolvedReviewFeedback(gql: GraphQl, owner: string, name: string, number: number): Promise<FeedbackItem[]> {
  const pr = `${owner}/${name}#${number}`;
  const threads = await allNodes<ThreadNode>(`the review threads of ${pr}`, async (after) => {
    const data = await gql(THREADS_QUERY, { owner, name, number, after }, isThreadsData, 'a GraphQL answer with review threads');
    const found = data.repository?.pullRequest;
    if (!found) throw new Error(`GitHub GraphQL: PR ${pr} not found`);
    // A resolved thread is dropped with its page: its comments are never read.
    return { ...found.reviewThreads, nodes: found.reviewThreads.nodes.filter((t) => !t.isResolved) };
  });
  const kept: FeedbackItem[][] = [];
  for (const t of threads) {
    const comments = await allNodes<CommentNode>(`the comments of review thread ${t.id}`, async (after) => {
      if (after === null) return t.comments;
      const data = await gql(THREAD_COMMENTS_QUERY, { id: t.id, after }, isCommentsData, "a GraphQL answer with a review thread's comments");
      if (!data.node) throw new Error(`GitHub GraphQL: review thread ${t.id} not found`);
      return data.node.comments;
    });
    const human = comments.filter((c) => !byBot(c));
    if (human.length) kept.push(human.map(toFeedback));
  }
  return capped(kept, pr);
}
