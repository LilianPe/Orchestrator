import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-148: a human with the merge right moves the ticket to Done, and the factory merges the PR, on the commit it
 * showed in Human Review. Anything else (no right, a push since, a red check) merges nothing and the ticket goes
 * back to Human Review with the reason.
 */
type Harness = ReturnType<typeof createHarness>;
const BRANCH = 'factory/rel-1-export-csv';
const PR = { number: 3, url: 'https://github.com/acme/app/pull/3' };

async function inHumanReview(): Promise<Harness> {
  const h = createHarness({ authz: { githubLogins: { 'user-lilian': 'lilian-gh', 'user-armand': 'armand-gh' } } });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.tracker.setTeamMembers('REL', ['user-lilian', 'user-armand']);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.forge.setRepoPermission('armand-gh', 'read');
  // The agent's PR, green, on its head: the commit the factory shows when it moves the ticket to Human Review.
  h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'pass', failedChecks: [] });
  h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'x' }, { kind: 'text', text: 'PR ouverte.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
  await h.send('pr.opened', { ...PR, branch: BRANCH });
  expect(await h.ticket()).toMatchObject({ logical: 'human_review', reviewSha: 'abc123' });
  return h;
}

const comments = (h: Harness) => h.tracker.calls.filter((c) => c.method === 'comment').map((c) => String(c.args[1]));
const lastMove = (h: Harness) => h.tracker.calls.filter((c) => c.method === 'moveTo').at(-1)?.args[1];

describe('Done by a human, merge by the factory (ORC-148)', () => {
  it('merges the PR on the reviewed commit when a human with the merge right moves the ticket to Done', async () => {
    const h = await inHumanReview();
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([{ number: 3, sha: 'abc123' }]);
  });

  it('merges nothing for a human without the merge right: refusal answered, back to Human Review', async () => {
    const h = await inHumanReview();
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-armand' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/^Refusé : passer le ticket en Done/);
    expect(lastMove(h)).toBe('Human Review');
  });

  it('merges nothing after a push since the review: GitHub refuses, back to Human Review with the reason', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/push depuis la review/);
    expect(lastMove(h)).toBe('Human Review');
    // Moved back, the reviewed commit stays the one shown: the pushed head is never taken as reviewed, so a second Done
    // is refused the same way until the factory's own work moves the ticket to Human Review again.
    expect((await h.ticket()).reviewSha).toBe('abc123');
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
  });

  it('refuses to merge another PR than the ticket\'s, found on its branch', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { number: 5, url: 'https://github.com/acme/app/pull/5', state: 'OPEN', headSha: 'abc123', checks: 'pass', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/la PR de la branche \(#5\) n'est pas celle du ticket \(#3\)/);
  });

  it('merges nothing on a red check, and says why', async () => {
    const h = await inHumanReview();
    // Read on the forge at the merge, on the reviewed commit itself: never a stale green from an older one.
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'fail', failedChecks: ['test'] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/checks du commit relu ne sont pas verts \(test\)/);
    expect(lastMove(h)).toBe('Human Review');
  });
});
