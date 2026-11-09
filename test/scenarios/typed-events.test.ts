import { describe, expect, it } from 'vitest';
import { createHarness } from '../helpers/harness.js';
import { ISSUE_UPDATE_CTX, linearIngest, signedIssueUpdate } from '../helpers/linear-webhook.js';

/**
 * A default reaction of the preset (ORC-160, ORC-227): what a human does to a ticket in Linear comes in as typed events, never as
 * text an agent reads. The human push on the agent's branch is its GitHub twin: `github-webhook.test.ts`, criterion 2.
 */
describe('statuses and labels come in as typed events (ORC-160)', () => {
  it('a move and a label added in Linear: status.changed and label.changed in the journal, nothing in the inbox, and the move decides', async () => {
    const h = createHarness({ authz: { githubLogins: { 'user-lilian': 'lilian' } } });
    h.tracker.setTeamMembers('REL', ['user-lilian']);
    h.forge.setRepoPermission('lilian', 'write');
    // The worktree's head, which verify finds green and the factory publishes: what the AI review reads (ORC-183).
    h.workspaces.heads.set('/tmp/factory-fake/p/REL-1', 'abc123');
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', delegateId: 'app', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-lilian', taint: 'trusted' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
    const runs = h.runner.requests.length;

    const { raw, headers } = signedIssueUpdate(h.clock.now());
    const ingest = linearIngest((e) => h.orch.accept(e), { now: () => h.clock.now(), ctx: ISSUE_UPDATE_CTX });
    expect(await ingest(raw, headers)).toEqual({ status: 200 });
    await h.orch.drained();

    const journal = (await h.store.recentEvents(100, 'REL-1')).filter((e) => e.type === 'status.changed' || e.type === 'label.changed');
    expect(journal).toHaveLength(2);
    expect(journal.map((e) => [e.type, e.payload, e.actor, e.taint])).toEqual(expect.arrayContaining([
      ['status.changed', { from: 'human_review', to: 'ai_review' }, 'user-lilian', 'trusted'],
      ['label.changed', { label: 'agent:reprendre', change: 'added' }, 'user-lilian', 'trusted'],
    ]));
    // No free text: nothing waits for an agent to read it.
    expect((await h.ticket()).humanInbox).toEqual([]);
    // The move to AI Review is decided as a move: the review runs, its two lenses (ORC-183).
    expect(h.runner.requests).toHaveLength(runs + 2);
    const jobs = await Promise.all(h.runner.requests.slice(runs).map(async (r) => (await h.store.getRun(r.runId))!.job));
    expect(jobs).toEqual(['review', 'review-security']);
  });
});
