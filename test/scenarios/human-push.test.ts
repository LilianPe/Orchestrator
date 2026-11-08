import { describe, expect, it } from 'vitest';
import { FREEZE_CHECK } from '../../src/checks/freeze.js';
import { HUMAN_COMMITS_CHECK, type CleanVerifyRequest } from '../../src/core/clean-verify.js';
import type { VerifyFailure } from '../../src/core/types.js';
import { createHarness } from '../helpers/harness.js';
import { BRANCH, githubDelivery, githubIngest, pushBody, sha } from '../helpers/github-webhook.js';

/**
 * ORC-159: a human pushes to the agent's branch. The GitHub webhook brings `push.human`; the agent's work pauses, `verify`
 * starts again from the pushed commit in a fresh clone, the factory never publishes over it, and an approval from before
 * the push merges nothing.
 */
type Harness = ReturnType<typeof createHarness>;
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const AGENT = sha('a');
const HUMAN = sha('c');
const PR = { number: 3, url: 'https://github.com/acme/app/pull/3' };

/**
 * A sandboxed instance whose clean check is a fake that reads what it is asked (ORC-151 proves the real one, and
 * clean-verify.test.ts its human push): the commit it checks, the frozen tests it is given, the human head it must carry.
 */
function harness(opts: Parameters<typeof createHarness>[0] = {}) {
  const asked: CleanVerifyRequest[] = [];
  /** The commits that carry the human's push: theirs, and the agent's once rebased on it. */
  const carrying = new Set([HUMAN]);
  /** The commits that change a frozen test. */
  const breaksFreeze = new Set<string>();
  const h: Harness = createHarness({
    ...opts,
    sandboxed: true,
    cleanVerify: async (req) => {
      asked.push(req);
      const checked = req.head ?? (await h.workspaces.head(req.worktree)) ?? 'head';
      const failures: VerifyFailure[] = [];
      if (req.humanHead && !carrying.has(checked)) failures.push({ command: HUMAN_COMMITS_CHECK, exitCode: 1, output: `git rebase origin/${req.branch}` });
      if (req.frozen && breaksFreeze.has(checked)) failures.push({ command: FREEZE_CHECK, exitCode: 1, output: 'src/export.test.ts changed' });
      return { ok: !failures.length, failures, sha: checked, tree: `tree-${checked}`, commands: [] };
    },
  });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.workspaces.heads.set(WORKTREE, AGENT);
  return { h, asked, carrying, breaksFreeze };
}

/** A signed push delivery to the daemon's GitHub ingestion, by a human account. */
async function humanPushes(h: Harness, after = HUMAN): Promise<void> {
  const { raw, headers } = githubDelivery('push', pushBody({ login: 'lilian', type: 'User' }, after));
  expect(await githubIngest(h.store, (e) => h.orch.accept(e), h.forge, () => h.clock.now())(raw, headers)).toEqual({ status: 200 });
  await h.orch.drained();
}

const comments = (h: Harness) => h.tracker.calls.filter((c) => c.method === 'comment').map((c) => String(c.args[1]));
const finished = async (h: Harness) => (await h.store.recentEvents(100, 'REL-1')).filter((e) => e.type === 'run.finished');

describe('a human push on the agent branch (ORC-159)', () => {
  it('criteria 1 and 2: the agent pauses, the pushed commit is checked in a fresh clone, and its work goes out only on top of the push', async () => {
    const { h, asked, carrying } = harness();
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const first = h.runner.requests[0]!.runId;

    await humanPushes(h);
    // Paused: the run in flight is stopped, and the check of the push is the commit as the forge holds it.
    expect((await finished(h)).map((e) => e.payload)).toEqual([expect.objectContaining({ runId: first, outcome: 'stopped' })]);
    expect(asked.map((r) => r.head)).toEqual([HUMAN]);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'human_push', blockedJob: 'dev', verifiedSha: HUMAN, humanPushes: [{ after: HUMAN }] });
    expect(comments(h).at(-1)).toMatch(/verify passed on it, in a fresh clone/);
    expect(h.publisher.asked).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);

    // A reply resumes the paused job; the agent first commits without the push: refused before anything is published.
    h.runner.enqueue({ hold: true }, { hold: true });
    await h.send('ticket.commented', { body: 'vas-y, reprends', author: 'Lilian', kind: 'instruction' });
    expect(h.runner.requests).toHaveLength(2);
    h.workspaces.heads.set(WORKTREE, sha('d'));
    h.runner.release(h.runner.requests[1]!.runId);
    await h.orch.drained();
    expect(asked.at(-1)).toMatchObject({ humanHead: HUMAN });
    expect(h.publisher.asked).toEqual([]);
    expect(h.runner.requests).toHaveLength(3);
    expect(h.runner.requests[2]!.prompt).toContain(HUMAN_COMMITS_CHECK);

    // Rebased on the push: verified, then published fast-forward on top of it.
    const rebased = sha('e');
    carrying.add(rebased);
    h.workspaces.heads.set(WORKTREE, rebased);
    h.runner.release(h.runner.requests[2]!.runId);
    await h.orch.drained();
    expect(h.publisher.published.map((p) => p.sha)).toEqual([rebased]);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, verifiedSha: rebased });
  });

  it("the factory's own publication is never taken for a human push, whatever account the forge names", async () => {
    const { h, asked } = harness();
    h.runner.enqueue({});
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', verifiedSha: AGENT });
    await humanPushes(h, AGENT);
    expect(await h.ticket()).toMatchObject({ blocked: false, logical: 'human_review' });
    expect((await h.ticket()).humanPushes).toBeUndefined();
    expect(asked.filter((r) => r.head)).toEqual([]);
  });

  it('criterion 3: a human commit that changes a frozen test fails its check, and the ticket stays paused', async () => {
    const { h, asked, breaksFreeze } = harness();
    h.runner.enqueue({});
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const frozenTests = { sha: AGENT, files: { 'src/export.test.ts': 'f'.repeat(64) } };
    await h.store.updateTicket('p', 'REL-1', (t) => ({ ...t, frozenTests }));
    breaksFreeze.add(HUMAN);
    await humanPushes(h);
    expect(asked.at(-1)).toMatchObject({ head: HUMAN, frozen: frozenTests });
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockKind: 'human_push', verifiedSha: AGENT });
    expect(comments(h).at(-1)).toContain(FREEZE_CHECK);
    expect(comments(h).at(-1)).toContain('/refreeze');
  });

  it('criterion 4: an approval from before the push merges nothing', async () => {
    const { h } = harness({ authz: { githubLogins: { 'user-lilian': 'lilian-gh' } } });
    h.tracker.setTeamMembers('REL', ['user-lilian']);
    h.forge.setRepoPermission('lilian-gh', 'write');
    h.forge.setPr(BRANCH, { ...PR, state: 'OPEN', headSha: AGENT, checks: 'pass', failedChecks: [] });
    h.runner.enqueue({});
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian' });
    await h.send('pr.opened', { ...PR, branch: BRANCH });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', reviewSha: AGENT });

    await humanPushes(h);
    expect((await h.ticket()).reviewSha).toBeUndefined();
    await h.send('status.changed', { from: 'human_review', to: 'done' }, 'REL-1', { actor: 'user-lilian' });
    expect(h.forge.merges).toEqual([]);
    expect(comments(h).at(-1)).toMatch(/no reviewed commit/);
  });
});
