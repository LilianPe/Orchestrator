import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { PR_SECTIONS } from '../../src/publish/describe.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-195: the factory composes the PR's description in the reviewer's fixed order from the structured output, and posts the
 * recap as the ticket goes to Human Review, both through the `OutputPolicy`. On the whole chain, SQLite and Postgres.
 */
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const result: AgentOutput = {
  status: 'done',
  why: 'Auditors copy the list by hand.',
  summary: 'An Export button on the list of audits writes a CSV.',
  assumptions: ['the list holds at most 10,000 audits'],
  risks: ['large lists are slow'],
  untested: ['Safari download'],
  trusted: ['papaparse quotes fields as RFC 4180 says'],
  review_hints: [{ file: 'src/export.ts', reason: 'the quoting' }],
  tests_added: ['src/export.test.ts', 'src/list.test.ts'],
};
const base64 = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7919) % 251)).toString('base64');

function harness() {
  const h = createHarness();
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits to CSV from the list of audits.' });
  h.workspaces.heads.set(WORKTREE, 'abc123');
  return h;
}
const headings = (body: string) => [...body.matchAll(/^## (.+)$/gm)].map(([, title]) => title);
const responses = (h: ReturnType<typeof harness>) => h.tracker.activities('ls-1').filter((a) => a.type === 'response');

describe('the PR description and the recap on the chain (ORC-195)', () => {
  it("criteria 1 and 2: the draft PR's description is the factory's, in the reviewer's order, the trusted section included", async () => {
    const h = harness();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'RAW_LAST_TEXT: PR opened, all green.' }], output: result });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.forge.opened).toHaveLength(1);
    const { title, body, draft } = h.forge.opened[0]!;
    expect({ title, draft }).toEqual({ title: 'REL-1 Export CSV', draft: true });
    expect(headings(body)).toEqual([...PR_SECTIONS]);
    expect(body).toContain('## Why\n\nAuditors copy the list by hand.');
    expect(body).toContain('## Trusted without verification\n\n- papaparse quotes fields as RFC 4180 says');
    expect(body).toContain('## Where to look first\n\n- `src/export.ts`: the quoting');
    expect(body).not.toContain('RAW_LAST_TEXT');
  });

  it('criterion 4: a base64 blob in what the agent submitted: the OutputPolicy refuses the description, no PR, and the ticket is told why', async () => {
    const h = harness();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'done' }], output: { ...result, risks: [`see ${base64(120)}`] } });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.forge.opened).toEqual([]);
    expect(h.publisher.published).toEqual([]);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(t.blockReason).toMatch(/output policy.*pr\.body: a base64 blob/s);
    expect(t.logical).not.toBe('human_review');
  });

  it('criterion 5: at the move to Human Review, the recap: the summary, the tests added, the turns, the tokens and the duration', async () => {
    const h = harness();
    h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'RAW_LAST_TEXT' }], output: result, turns: 27, tokens: { input: 1_200, output: 3_400, cacheRead: 90_000, cacheCreation: 400 } });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    await h.advance(45_000);
    h.runner.release(runId);
    await h.advance(0);
    expect((await h.ticket()).logical).toBe('human_review');
    expect(h.forge.readied).toHaveLength(1);
    expect(responses(h).at(-1)).toEqual({
      type: 'response',
      body: 'An Export button on the list of audits writes a CSV.\n\n**Tests added**\n- `src/export.test.ts`\n- `src/list.test.ts`\n\n**Work**: 1 attempt, 27 turns, 5,000 tokens (cache reads apart), 45 s.',
    });
    expect(JSON.stringify(h.tracker.calls)).not.toContain('RAW_LAST_TEXT');
  });
});
