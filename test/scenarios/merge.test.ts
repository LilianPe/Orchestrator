import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/store/types.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-148: a human with the merge right moves the ticket to Done, and the factory merges the PR, on the commit it
 * showed in Human Review. Anything else (no right, a push since, a red check) merges nothing and the ticket goes
 * back to Human Review with the reason.
 */
type Harness = ReturnType<typeof createHarness>;
const BRANCH = 'factory/rel-1-export-csv';
const PR = { number: 3, url: 'https://github.com/acme/app/pull/3' };
const WORKTREE = '/tmp/factory-fake/p/REL-1';

async function inHumanReview(opts: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = createHarness({ ...opts, authz: { githubLogins: { 'user-lilian': 'lilian-gh', 'user-armand': 'armand-gh' } } });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.tracker.setTeamMembers('REL', ['user-lilian', 'user-armand']);
  h.forge.setRepoPermission('lilian-gh', 'write');
  h.forge.setRepoPermission('armand-gh', 'read');
  // The agent's PR, green, on its head: the commit the factory shows when it moves the ticket to Human Review.
  h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'pass', failedChecks: [] });
  // The agent's worktree ends its run on that head too: the forge's head is recorded only when it is the run's.
  h.workspaces.heads.set(WORKTREE, 'abc123');
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
    expect(comments(h).at(-1)).toMatch(/^Refused: moving the ticket to Done/);
    expect(lastMove(h)).toBe('Human Review');
  });

  it('merges nothing after a push since the review: the agent takes it in, the AI review reads it once published, then the next Done merges it (ORC-183)', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    // The AI review reads only what the factory published: the push goes back to the human, with the way to a merge.
    expect(comments(h).at(-1)).toMatch(/push since the review.*reads only the commits the factory published/);
    expect(lastMove(h)).toBe('Human Review');
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.ticket()).reviewSha).toBe('abc123');
    // A reply: the agent takes the push in (its feedback skill), its worktree ends on def456, which the factory verifies and publishes.
    h.workspaces.heads.set(WORKTREE, 'def456');
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'prends mon push', author: 'Lilian' }, 'REL-1', { actor: 'user-lilian' });
    await h.advance(180_000);
    expect((await h.ticket()).verifiedSha).toBe('def456');
    // Then the move to AI Review: the review reads the published def456, and shows it in Human Review.
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.workspaces.prepared.filter((w) => w.kind === 'published').map((w) => w.sha)).toEqual(['def456', 'def456']);
    expect(lastMove(h)).toBe('Human Review');
    expect((await h.ticket()).reviewSha).toBe('def456');
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([{ number: 3, sha: 'def456' }]);
  });

  it('the late webhook of the factory\'s move to AI Review (after its 60 s echo) starts no second review', async () => {
    // The factory moves the ticket to AI Review at the end of `dev` (ORC-183); its first lens is at work.
    const h = createHarness({ aiReview: true, authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    h.tracker.setTeamMembers('REL', ['user-lilian']);
    h.forge.setRepoPermission('lilian-gh', 'write');
    h.workspaces.heads.set(WORKTREE, 'abc123');
    h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'x' }] }, { hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
    expect(lastMove(h)).toBe('AI Review');
    const runs = h.runner.requests.length;
    expect(runs).toBe(2);
    await h.advance(61_000);
    await h.send('status.changed', { from: 'dev', to: 'ai_review' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.runner.requests).toHaveLength(runs);
    expect(await h.store.listQueue()).toEqual([]);
    expect((await h.ticket()).pendingJob).toBeUndefined();
  });

  it('a push between the factory\'s reading and its merge, refused by GitHub, is a push since the review too', async () => {
    const h = await inHumanReview();
    const shown = await h.forge.findPr('', BRANCH);
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    // The factory still reads the reviewed head; GitHub, given that head, refuses the merge (409).
    vi.spyOn(h.forge, 'findPr').mockResolvedValueOnce(shown);
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).some((c) => /push since the review.*reads only the commits the factory published/.test(c))).toBe(true);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.ticket()).reviewSha).toBe('abc123');
  });

  it('an AI review publishes nothing, and a head pushed since it is never recorded as reviewed (ORC-183, ORC-125)', async () => {
    const h = await inHumanReview();
    const asked = h.publisher.asked.length;
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' }, 'REL-1', { actor: 'user-lilian' });
    // It read the published abc123, in a clone of its own: nothing of it goes to the branch.
    expect(h.workspaces.prepared.filter((w) => w.kind === 'published').map((w) => w.sha)).toEqual(['abc123', 'abc123']);
    expect(h.publisher.asked).toHaveLength(asked);
    expect(lastMove(h)).toBe('Human Review');
    expect((await h.ticket()).reviewSha).not.toBe('def456');
    expect((await h.forge.findPr('', BRANCH))?.headSha).toBe('def456');
  });

  it('refuses to merge another PR than the ticket\'s, found on its branch', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { number: 5, url: 'https://github.com/acme/app/pull/5', state: 'OPEN', headSha: 'abc123', checks: 'pass', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/the branch's PR \(#5\) is not the ticket's \(#3\)/);
  });

  it('merges nothing on a red check, and says why', async () => {
    const h = await inHumanReview();
    // Read on the forge at the merge, on the reviewed commit itself: never a stale green from an older one.
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'fail', failedChecks: ['test'] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/checks of the reviewed commit are not green \(test\)/);
    expect(lastMove(h)).toBe('Human Review');
  });

  it('merges nothing on a check in a state the forge does not know, and names it (ORC-304)', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'pending', failedChecks: [], unknownChecks: ['deploy'] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/checks of the reviewed commit are not green \(deploy: a state the forge does not know\)/);
    expect(lastMove(h)).toBe('Human Review');
  });

  it('a refusal is decided once: its effect replayed after the checks turned green still answers it, never merges', async () => {
    // The refusal's inbox write fails three times: the effect is retried (a replay), and by then the checks are green.
    let failures = 3;
    const h = await inHumanReview({
      effectRetry: { attempts: 6, baseMs: 1, capMs: 1 },
      // A new object, not an assignment: the Postgres harness's store is a proxy, which would ignore one.
      wrapStore: (inner) =>
        Object.assign(Object.create(inner) as Store, {
          appendInbox: async (e: Parameters<Store['appendInbox']>[0]) => {
            if (e.id.startsWith('merge-refused:') && failures > 0) {
              failures--;
              throw new Error('inbox unavailable');
            }
            return inner.appendInbox(e);
          },
        }),
    });
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'pending', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    // Replays are still owed when the checks turn green, and every one of them happens after.
    expect(failures).toBeGreaterThan(0);
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'pass', failedChecks: [] });
    for (let i = 0; i < 6; i++) await h.advance(10);
    expect(failures).toBe(0);
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/checks of the reviewed commit are not green \(pending\)/);
    expect(lastMove(h)).toBe('Human Review');
  });

  it('a push-since-review refusal saved before ORC-331, in French, replays as a moved head: a push since the review', async () => {
    let failures = 1;
    const h = await inHumanReview({
      effectRetry: { attempts: 6, baseMs: 1, capMs: 1 },
      wrapStore: (inner) =>
        Object.assign(Object.create(inner) as Store, {
          appendInbox: async (e: Parameters<Store['appendInbox']>[0]) => {
            if (e.id.startsWith('merge-refused:') && failures > 0) {
              failures--;
              throw new Error('inbox unavailable');
            }
            return inner.appendInbox(e);
          },
          // The refusal as the factory saved it before its messages moved to English.
          getMeta: async (key: string) => (key.endsWith(':refused') ? 'la branche a reçu un push depuis la review' : inner.getMeta(key)),
        }),
    });
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    h.workspaces.heads.set(WORKTREE, 'def456');
    h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'y' }, { kind: 'text', text: 'Rien à redire.' }] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    for (let i = 0; i < 6; i++) await h.advance(10);
    expect(failures).toBe(0);
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).some((c) => /reads only the commits the factory published/.test(c))).toBe(true);
  });

  it('a refusal saved since ORC-345 replays by its flag, whatever its sentence says: a reworded moved head is a push since the review', async () => {
    let failures = 1;
    const saved: Record<string, string> = {};
    const h = await inHumanReview({
      effectRetry: { attempts: 6, baseMs: 1, capMs: 1 },
      wrapStore: (inner) =>
        Object.assign(Object.create(inner) as Store, {
          appendInbox: async (e: Parameters<Store['appendInbox']>[0]) => {
            if (e.id.startsWith('merge-refused:') && failures > 0) {
              failures--;
              throw new Error('inbox unavailable');
            }
            return inner.appendInbox(e);
          },
          setMeta: async (key: string, value: string) => {
            if (key.endsWith(':refused')) saved[key] = value;
            return inner.setMeta(key, value);
          },
          // The refusal as saved, its sentence reworded since: the flag decides.
          getMeta: async (key: string) => (key.endsWith(':refused') ? JSON.stringify({ reason: 'Someone pushed after the review.', headMoved: true }) : inner.getMeta(key)),
        }),
    });
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'def456', checks: 'pass', failedChecks: [] });
    h.workspaces.heads.set(WORKTREE, 'def456');
    h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'y' }, { kind: 'text', text: 'Rien à redire.' }] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    for (let i = 0; i < 6; i++) await h.advance(10);
    expect(failures).toBe(0);
    // Saved with the flag the shell saw, not a sentence to compare.
    expect(Object.values(saved).map((v) => JSON.parse(v) as unknown)).toEqual([{ reason: 'the branch received a push since the review', headMoved: true }]);
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).some((c) => /reads only the commits the factory published/.test(c))).toBe(true);
  });

  it('a PR merged on GitHub meanwhile, on another head, is no refusal: the ticket stays in Done', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'MERGED', headSha: 'def456', checks: 'pass', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).some((c) => /did not merge/.test(c))).toBe(false);
    expect((await h.ticket()).logical).toBe('done');
  });

  it('merges a PR with no check in a repository with no CI: its base has none either', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'none', failedChecks: [] });
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([{ number: 3, sha: 'abc123' }]);
  });

  it('merges nothing on a PR with no check when the repository has CI: it has not run yet', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'none', failedChecks: [] });
    h.forge.baseChecks = 'pass';
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/no check ran on the reviewed commit/);
    expect(lastMove(h)).toBe('Human Review');
  });

  it('merges nothing on a PR with no check in a repository whose Actions CI runs on pull requests only', async () => {
    const h = await inHumanReview();
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: 'abc123', checks: 'none', failedChecks: [] });
    h.forge.ciWorkflows = 1;
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/no check ran on the reviewed commit, while the repository has a CI or the factory cannot check that it has none/);
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
