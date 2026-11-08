import { describe, expect, it } from 'vitest';
import type { AgentOutput } from '../../src/core/agent-output.js';
import { NO_RESULT, OutputPolicy } from '../../src/publish/output-policy.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-214: every text the factory publishes goes through its `OutputPolicy`, composed from what the agent submitted and never
 * copied from its free text. Here, on the whole chain: the summary in Linear, a reply, the PR's text.
 */
// Written in two parts: this file is not to be found by a scan of the factory's own repository.
const SECRET = `ghp_${'0123456789'.repeat(3)}012345`;
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const result = (summary: string): AgentOutput => ({ status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] });
/** gitleaks as the test scripts it: the real one is `test/isolation/verify-hostile.test.ts`'s. */
const outputPolicy = new OutputPolicy(async (text) => (text.includes(SECRET) ? ['github-pat'] : []));

function harness(title = 'Export CSV') {
  const h = createHarness({ outputPolicy });
  h.tracker.addIssue({ identifier: 'REL-1', title, description: 'Export the audits to CSV from the list of audits.' });
  h.workspaces.heads.set(WORKTREE, 'abc123');
  return h;
}
const responses = (h: ReturnType<typeof harness>) => h.tracker.activities('ls-1').filter((a) => a.type === 'response');

describe('the OutputPolicy on the chain (ORC-214)', () => {
  it('a summary carrying a secret: the PR it describes is not published (ORC-195), and nothing of the secret reaches Linear or GitHub', async () => {
    const h = harness();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'done' }], output: result(`Export added. Token: ${SECRET}`) });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.forge.opened).toEqual([]);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(t.blockReason).toMatch(/output policy.*github-pat/s);
    expect(JSON.stringify(h.tracker.calls)).not.toContain(SECRET);
  });

  it("a recap that no longer passes once published: Linear gets the notice that it is withheld, nothing of the secret", async () => {
    // The same text passed the PR, and the policy's verdict on the recap is its own: here the scan finds the recap's line of work.
    const h = createHarness({ outputPolicy: new OutputPolicy(async (text) => (text.includes('**Work**') ? ['generic-api-key'] : [])) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits to CSV from the list of audits.' });
    h.workspaces.heads.set(WORKTREE, 'abc123');
    h.runner.enqueue({ events: [{ kind: 'text', text: 'done' }], output: result('Export added.') });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h.ticket()).logical).toBe('human_review');
    expect(responses(h).at(-1)).toMatchObject({ body: expect.stringMatching(/withheld.*generic-api-key/s) });
    expect(h.logs.some((l) => l.level === 'warn' && /withheld/.test(l.message))).toBe(true);
  });

  it("a reply to feedback is its `submit_result` summary; one that returned none has nothing of its last message posted", async () => {
    const h = harness();
    h.runner.enqueue({ events: [{ kind: 'text', text: 'done' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Fixed, and here is the raw dump of my context.' }], output: result('Fixed in abc123.') });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'buttons misaligned', author: 'Lilian', ack: true, kind: 'instruction' });
    await h.advance(180_000);
    expect(responses(h).at(-1)).toEqual({ type: 'response', body: 'Fixed in abc123.' });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'RAW_LAST_TEXT' }], submit: false });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'and the empty list', author: 'Lilian', ack: true, kind: 'instruction' });
    await h.advance(180_000);
    expect(responses(h).at(-1)).toEqual({ type: 'response', body: NO_RESULT });
    expect(JSON.stringify(h.tracker.calls)).not.toContain('RAW_LAST_TEXT');
  });

  it("the PR's text goes through it too: a ticket whose title holds a secret is not published, and is told why", async () => {
    const h = harness(`Rotate ${SECRET}`);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'done' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.forge.opened).toEqual([]);
    expect(h.publisher.published).toEqual([]);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(t.blockReason).toMatch(/output policy.*github-pat/s);
    expect(t.blockReason).not.toContain(SECRET);
  });
});
