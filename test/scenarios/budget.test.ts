import { describe, expect, it } from 'vitest';
import { causeOf } from '../../src/core/block-cause.js';
import { createHarness } from '../helpers/harness.js';

const MEMBER = 'user-lilian';
const HOUR = 60 * 60_000;

/** A member's harness: fake adapters, the simulated clock, factory.yml's budgets. */
function harness(budgets: { perTicketTokens?: number; onUsageLimit?: 'wait' }) {
  const h = createHarness({ authz: { githubLogins: { [MEMBER]: 'lilian-gh' } }, ...budgets });
  h.tracker.setTeamMembers('REL', [MEMBER]);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  return h;
}

describe('scenario « budget exhausted » (ORC-216)', () => {
  it('a step that spends the ticket budget ends Blocked, kind budget, with the standard comment; a reply does not buy more', async () => {
    const h = harness({ perTicketTokens: 1_000 });
    // The build spends past what the ticket has: the runner stops it at its cap, as the real one does.
    h.runner.enqueue({ tokens: { input: 400, output: 800, cacheRead: 50_000, cacheCreation: 0 } });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests[0]!.limits.tokens).toBe(1_000);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockKind: 'budget', blockedJob: 'dev' });
    expect(causeOf(t.blockKind)).toBe('limit');
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
    const comment = h.tracker.comments('REL-1').at(-1)!.split('\n');
    expect(comment.slice(0, 4)).toEqual([
      '🔴 Blocked at step build (attempt 1/1)',
      'Reason: The run dev spent its token budget (budgets.per_step_tokens, or what the ticket had left).',
      'What I tried:',
      '- Started the run dev: stopped at its token budget.',
    ]);
    expect(comment).toContainEqual(expect.stringMatching(/· code-run tokens 1200 ·/));

    // An hour later, a member says to go on: the ticket has nothing left, the launch is refused before any run.
    await h.advance(HOUR);
    await h.send('ticket.commented', { body: 'Continue.', author: 'Lilian', kind: 'instruction' }, 'REL-1', { actor: MEMBER });
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'budget' });
    expect((await h.ticket()).blockReason).toMatch(/^Token budget of the ticket reached: 1200 tokens spent of 1000 /);
  });

  it('a usage limit is no overrun: the run waits for the reset, then resumes, never Blocked', async () => {
    const h = harness({ perTicketTokens: 1_000_000, onUsageLimit: 'wait' });
    const resetAt = Date.UTC(2026, 9, 10, 11, 0);
    h.runner.enqueue({ outcome: 'limit', tokens: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 }, usageLimit: { resetAt } }, { hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: MEMBER });
    expect(await h.ticket()).toMatchObject({ blocked: false, usageWait: { job: 'dev' } });
    expect(h.tracker.comments('REL-1').filter((c) => c.startsWith('🔴'))).toEqual([]);
    await h.advance(2 * HOUR);
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ blocked: false, activeJob: 'dev' });
  });
});
