import { describe, expect, it, vi } from 'vitest';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-148: a human with the merge right moves the ticket to Done, and the factory merges the PR, on the commit it
 * showed in Human Review. Anything else (no right, a push since, a red check) merges nothing and the ticket goes
 * back to Human Review with the reason.
 */
type Harness = ReturnType<typeof createHarness>;
const BRANCH = 'factory/rel-1-export-csv';
const PR = { number: 3, url: 'https://github.com/acme/app/pull/3' };

async function inHumanReview(opts: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = createHarness({ ...opts, authz: { githubLogins: { 'user-lilian': 'lilian-gh', 'user-armand': 'armand-gh' } } });
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

  it('merges nothing after a push since the review: the new commits go through the AI review, then the next Done merges them', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'y' }, { kind: 'text', text: 'Rien à redire.' }] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).some((c) => /push depuis la review.*repassent par la review IA/.test(c))).toBe(true);
    expect((await h.store.getRun(h.runner.requests.at(-1)!.runId))?.job).toBe('review');
    // The review done, the factory shows the pushed head in Human Review: that commit is now the reviewed one.
    expect(lastMove(h)).toBe('Human Review');
    expect((await h.ticket()).reviewSha).toBe('def456');
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([{ number: 3, sha: 'def456' }]);
  });

  it('a push between the factory\'s reading and its merge, refused by GitHub, also goes through the AI review', async () => {
    const h = await inHumanReview();
    const shown = await h.forge.findPr('', BRANCH);
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    // The factory still reads the reviewed head; GitHub, given that head, refuses the merge (409).
    vi.spyOn(h.forge, 'findPr').mockResolvedValueOnce(shown);
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect((await h.store.getRun(h.runner.requests.at(-1)!.runId))?.job).toBe('review');
    expect(comments(h).some((c) => /push depuis la review.*repassent par la review IA/.test(c))).toBe(true);
    expect((await h.ticket()).reviewSha).toBe('def456');
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

  it('a refusal is decided once: its effect replayed after the checks turned green still answers it, never merges', async () => {
    // The refusal's inbox write fails three times: the effect is retried (a replay), and by then the checks are green.
    let failures = 3;
    const h = await inHumanReview({
      effectRetry: { attempts: 6, baseMs: 1, capMs: 1 },
      wrapStore: (store) => {
        const append = store.appendInbox.bind(store);
        store.appendInbox = async (e) => {
          if (e.id.startsWith('merge-refused:') && failures > 0) {
            failures--;
            throw new Error('inbox unavailable');
          }
          return append(e);
        };
        return store;
      },
    });
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'pending', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'pass', failedChecks: [] });
    for (let i = 0; i < 6; i++) await h.advance(10);
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/checks du commit relu ne sont pas verts \(pending\)/);
    expect(lastMove(h)).toBe('Human Review');
  });

  it('a PR merged on GitHub meanwhile, on another head, is no refusal: the ticket stays in Done', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'MERGED', headSha: 'def456', checks: 'pass', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).some((c) => /pas mergé/.test(c))).toBe(false);
    expect((await h.ticket()).logical).toBe('done');
  });

  it('writes nothing on the forge when a human cancels the ticket: its PR stays open', async () => {
    // Two tickets may share one PR: the factory never closes nor merges a PR for a cancelled ticket.
    const h = await inHumanReview();
    const writes = (['ensurePr', 'mergePr', 'upsertCheckRun'] as const).map((m) => vi.spyOn(h.forge, m));
    await h.send('status.changed', { from: 'human_review', to: null, cancelled: true }, 'REL-1', { actor: 'user-lilian' });
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect((await h.forge.findPr('', BRANCH))?.state).toBe('OPEN');
  });
});
