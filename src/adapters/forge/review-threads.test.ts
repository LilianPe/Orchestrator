import { describe, expect, it } from 'vitest';
import { REVIEW_FEEDBACK_MAX, unresolvedReviewFeedback, type GraphQl } from './review-threads.js';

const conn = <N>(nodes: N[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const comment = (login: string, body: string, at: string, type = 'User') => ({ author: { __typename: type, login }, body, createdAt: at, path: 'src/a.ts', line: null });
const thread = (id: string, comments: unknown[]) => ({ id, isResolved: false, comments: conn(comments) });

/** A forge answering one page of threads, each answer checked as the forges check it. */
const forge = (threads: unknown[]): GraphQl => async (_query, _variables, isData, what) => {
  const data = { repository: { pullRequest: { reviewThreads: conn(threads) } } };
  if (!isData(data)) throw new Error(`unreadable, not ${what}`);
  return data;
};

const read = (threads: unknown[]) => unresolvedReviewFeedback(forge(threads), 'acme', 'app', 7);
const item = (author: string, body: string, at: string) => ({ author, body: `src/a.ts — ${body}`, at: Date.parse(at), source: 'review' });

describe('unresolvedReviewFeedback: bots (ORC-366)', () => {
  it("drops a bot's reply in a thread and keeps the human reply of the same thread", async () => {
    expect(
      await read([
        thread('T1', [
          comment('alice', 'gère null', '2026-10-10T10:00:00Z'),
          comment('github-actions', 'CI failed', '2026-10-10T10:05:00Z', 'Bot'),
          comment('bob', "d'accord avec alice", '2026-10-10T10:10:00Z'),
        ]),
        thread('T2', [comment('dependabot', 'bump lodash', '2026-10-10T11:00:00Z', 'Bot')]),
      ]),
    ).toEqual([item('alice', 'gère null', '2026-10-10T10:00:00Z'), item('bob', "d'accord avec alice", '2026-10-10T10:10:00Z')]);
  });

  it('keeps a comment whose author is gone, and reads an author without its type as unreadable', async () => {
    expect(await read([thread('T1', [{ ...comment('x', 'renomme', '2026-10-10T10:00:00Z'), author: null }])])).toEqual([
      item('inconnu', 'renomme', '2026-10-10T10:00:00Z'),
    ]);
    await expect(read([thread('T1', [{ ...comment('x', 'a', '2026-10-10T10:00:00Z'), author: { login: 'x' } }])])).rejects.toThrow(/unreadable/);
  });
});

describe('unresolvedReviewFeedback: the cap (ORC-366)', () => {
  // Bodies such that two threads fit under the cap and three do not.
  const long = (c: string) => c.repeat(Math.floor(REVIEW_FEEDBACK_MAX / 2) - 100);

  it('past the cap, keeps the newest threads in their order and tells the agent how many were cut', async () => {
    const items = await read([
      thread('T-old', [comment('alice', long('a'), '2026-10-10T10:00:00Z')]),
      thread('T-mid', [comment('bob', long('b'), '2026-10-10T11:00:00Z')]),
      thread('T-new', [comment('carol', long('c'), '2026-10-10T12:00:00Z')]),
    ]);
    expect(items.slice(0, 2)).toEqual([item('bob', long('b'), '2026-10-10T11:00:00Z'), item('carol', long('c'), '2026-10-10T12:00:00Z')]);
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ author: 'factory', source: 'review', at: Date.parse('2026-10-10T10:00:00Z') });
    expect(items[2]!.body).toBe(`Review feedback capped at ${REVIEW_FEEDBACK_MAX} characters, not shown: 1 older thread. All of it is still on acme/app#7.`);
  });

  it('dates a thread by its latest reply, and keeps none older than one it cuts, however short', async () => {
    const items = await read([
      thread('T-old', [comment('alice', long('a'), '2026-10-10T09:00:00Z'), comment('alice', 'toujours faux', '2026-10-10T13:00:00Z')]),
      thread('T-mid', [comment('bob', long('b'), '2026-10-10T11:00:00Z')]),
      thread('T-new', [comment('carol', 'x', '2026-10-10T12:00:00Z')]),
      thread('T-older', [comment('dave', 'y', '2026-10-10T08:00:00Z')]),
    ]);
    expect(items.map((i) => i.author)).toEqual(['alice', 'alice', 'carol', 'factory']);
    expect(items[3]!.body).toMatch(/not shown: 2 older threads\./);
  });

  it('under the cap, says nothing, and a bot comment counts for nothing in it', async () => {
    const items = await read([
      thread('T1', [comment('alice', long('a'), '2026-10-10T10:00:00Z'), comment('ci', long('z').repeat(4), '2026-10-10T10:01:00Z', 'Bot')]),
      thread('T2', [comment('bob', long('b'), '2026-10-10T11:00:00Z')]),
    ]);
    expect(items.map((i) => i.author)).toEqual(['alice', 'bob']);
  });

  it('counts each comment as the prompt writes it: many short comments are capped too', async () => {
    const threads = Array.from({ length: 1000 }, (_, n) => thread(`T${n}`, [comment('alice', 'ok', new Date(Date.parse('2026-10-10T00:00:00Z') + n * 60_000).toISOString())]));
    const items = await read(threads);
    expect(items.length).toBeLessThan(1000);
    expect(items.at(-1)!.author).toBe('factory');
    // The newest kept.
    expect(items.at(-2)!.at).toBe(Date.parse('2026-10-10T00:00:00Z') + 999 * 60_000);
  });

  it('keeps the latest comments of a newest thread over the cap alone, and says the earlier ones and the older threads were left out', async () => {
    const items = await read([
      thread('T-old', [comment('dave', 'y', '2026-10-10T08:00:00Z')]),
      thread('T-new', [comment('alice', 'a'.repeat(REVIEW_FEEDBACK_MAX), '2026-10-10T10:00:00Z'), comment('bob', long('b'), '2026-10-10T11:00:00Z'), comment('carol', 'fais-le', '2026-10-10T12:00:00Z')]),
    ]);
    expect(items.map((i) => i.author)).toEqual(['bob', 'carol', 'factory']);
    expect(items[2]).toMatchObject({ at: Date.parse('2026-10-10T10:00:00Z') });
    expect(items[2]!.body).toMatch(/not shown: the 1 earlier comment of the latest thread, 1 older thread\./);
  });

  it('cuts short the one comment of a thread over the cap alone, and says so', async () => {
    const items = await read([thread('T', [comment('alice', 'a'.repeat(REVIEW_FEEDBACK_MAX * 2), '2026-10-10T10:00:00Z')])]);
    expect(items).toHaveLength(2);
    expect(items[0]!.body.length).toBeLessThan(REVIEW_FEEDBACK_MAX);
    expect(items[0]!.body.length).toBeGreaterThan(REVIEW_FEEDBACK_MAX - 100);
    expect(items[1]!.body).toMatch(/not shown: the end of its last comment\./);
  });

  it('reads a comment whose date does not parse as unreadable, never dated at random', async () => {
    await expect(read([thread('T1', [comment('alice', 'a', 'yesterday')])])).rejects.toThrow(/unreadable/);
  });
});
