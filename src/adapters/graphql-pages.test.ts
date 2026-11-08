import { describe, expect, it } from 'vitest';
import { allNodes, MAX_GRAPHQL_PAGES } from './graphql-pages.js';

const page = (nodes: number[], next: string | null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });

describe('allNodes (ORC-347)', () => {
  it('reads every page, each after the cursor of the one before', async () => {
    const cursors: (string | null)[] = [];
    const pages: Record<string, unknown> = { start: page([1, 2], 'c1'), c1: page([3], 'c2'), c2: page([4], null) };
    const nodes = await allNodes('a list', async (after) => (cursors.push(after), pages[after ?? 'start']));
    expect(nodes).toEqual([1, 2, 3, 4]);
    expect(cursors).toEqual([null, 'c1', 'c2']);
  });

  it('never reads a list as complete when a page says more follow but gives no cursor', async () => {
    await expect(allNodes('the labels', async () => ({ nodes: [1], pageInfo: { hasNextPage: true, endCursor: null } }))).rejects.toThrow(
      /the labels: more pages, but no cursor to read them: never read as complete/,
    );
  });

  it.each([
    ['without pageInfo', { nodes: [1] }],
    ['with nodes that are no list', { nodes: {}, pageInfo: { hasNextPage: false, endCursor: null } }],
    ['with a hasNextPage that is no boolean', { nodes: [], pageInfo: { endCursor: null } }],
    ['null', null],
  ])('rejects a page %s, never reads it as the last one', async (_case, answer) => {
    await expect(allNodes('the threads', async () => answer)).rejects.toThrow(/the threads: unreadable page, not a list with its pageInfo/);
  });

  it(`throws past ${MAX_GRAPHQL_PAGES} pages: a server that keeps answering a next page never loops forever`, async () => {
    let reads = 0;
    const err = await allNodes('the tickets', async () => (reads++, page([reads], `c${reads}`))).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(new RegExp(`the tickets: more than ${MAX_GRAPHQL_PAGES} pages, never read as complete`));
    expect(reads).toBe(MAX_GRAPHQL_PAGES);
  });
});
