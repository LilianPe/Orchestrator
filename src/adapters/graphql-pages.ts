/** A page of a GraphQL connection, as GitHub and Linear both spell it. */
export interface Connection<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Pages read from one connection, at most: a bound against a server that keeps answering a next page, not an API limit. */
export const MAX_GRAPHQL_PAGES = 10;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A page `allNodes` can read: its `nodes` a list, each `isNode` when given, its `pageInfo` saying whether more follow. */
export const isConnection = (c: unknown, isNode?: (n: unknown) => boolean): c is Connection<unknown> =>
  isRecord(c) && Array.isArray(c.nodes) && (!isNode || c.nodes.every(isNode)) && isRecord(c.pageInfo) && typeof c.pageInfo.hasNextPage === 'boolean';

/**
 * Every node of a GraphQL connection, `page(after)` reading the page after the cursor (`null`: the first one). The
 * cursor-paged twin of `GitHubAppAuth.allPages` (ORC-273), with its rule (ORC-347): a list is never read as complete
 * unless its last page says so. A page without its `pageInfo`, one that says more follow without a cursor, and a
 * list longer than `MAX_GRAPHQL_PAGES` pages throw. `what` names the list in the error. The nodes are the caller's to check.
 */
export async function allNodes<N>(what: string, page: (after: string | null) => Promise<unknown>): Promise<N[]> {
  const all: N[] = [];
  let after: string | null = null;
  for (let n = 1; ; n++) {
    const c = await page(after);
    if (!isConnection(c)) throw new Error(`${what}: unreadable page, not a list with its pageInfo`);
    all.push(...(c.nodes as N[]));
    if (!c.pageInfo.hasNextPage) return all;
    if (!c.pageInfo.endCursor) throw new Error(`${what}: more pages, but no cursor to read them: never read as complete`);
    if (n >= MAX_GRAPHQL_PAGES) throw new Error(`${what}: more than ${MAX_GRAPHQL_PAGES} pages, never read as complete`);
    after = c.pageInfo.endCursor;
  }
}
