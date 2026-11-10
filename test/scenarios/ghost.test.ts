import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KEPT_PR } from '../../src/store/types.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-231: a project without effects (the replay of closed tickets, a prompt tried out) runs its ticket as any other, and nothing of it
 * reaches Linear or GitHub: the outbox keeps each such effect as an artifact of the run, the PR the factory would have opened included.
 */
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const SHA = 'abc123';
const DIFF = 'diff --git a/src/export.ts b/src/export.ts\n+export const csv = 1;';
/** What Linear and GitHub would have been asked to write: the fakes record each call. */
const TRACKER_WRITES = ['moveTo', 'setLabels', 'comment', 'activity', 'addExternalUrl', 'setSessionPlan', 'ensureSession'];

function verified(opts: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness({ noEffect: true, ...opts });
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.workspaces.heads.set(WORKTREE, SHA);
  h.workspaces.ticketDiffs.set(WORKTREE, DIFF);
  h.runner.enqueue({ output: { status: 'done', summary: 'Audits export to CSV from their list.', tests_added: [], why: '', assumptions: ['the list holds at most 10,000 audits'], risks: [], untested: [], review_hints: [] } });
  return h;
}

describe('a project without effects (ORC-231)', () => {
  it('runs a ticket to its PR with no write call to the tracker or the forge, the PR kept as an artifact of the run', async () => {
    const h = verified();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.tracker.calls.filter((c) => TRACKER_WRITES.includes(c.method))).toEqual([]);
    expect(h.publisher.asked).toEqual([]);
    expect(h.forge.opened).toEqual([]);
    expect(h.forge.checkRuns).toEqual([]);
    const artifacts = await h.store.artifacts('REL-1');
    const pr = artifacts.find((a) => a.kind === KEPT_PR);
    expect(pr).toMatchObject({ ticketId: 'REL-1', attemptId: expect.any(String) });
    const kept = JSON.parse(readFileSync(pr!.path, 'utf8')) as { pr: { title: string; body: string; sha: string } };
    expect(kept.pr).toMatchObject({ title: 'REL-1 Export CSV', sha: SHA, diff: DIFF, body: expect.stringContaining('the list holds at most 10,000 audits') });
    // The rest of what it would have written is kept too: the move and the summary, at least.
    expect(artifacts.map((a) => a.kind)).toEqual(expect.arrayContaining(['kept:move', 'kept:post_output']));
    // The run ended as after a publication: nothing left verifying, nothing blocked.
    expect(await h.ticket()).toMatchObject({ blocked: false, verifiedSha: SHA });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();
  });

  it('a delegation without a Linear session opens none: the run gets a local one, and its PR is kept', async () => {
    const h = verified();
    await h.send('ticket.delegated', {});
    expect(h.tracker.calls.filter((c) => TRACKER_WRITES.includes(c.method))).toEqual([]);
    expect((await h.ticket()).linearSessionId).toBe('kept:REL-1');
    expect((await h.store.artifacts('REL-1')).some((a) => a.kind === KEPT_PR)).toBe(true);
  });

  it('a run that committed nothing keeps no PR, as a publication would open none', async () => {
    const h = verified();
    h.workspaces.ticketDiffs.delete(WORKTREE);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h.store.artifacts('REL-1')).some((a) => a.kind === KEPT_PR)).toBe(false);
    expect(await h.ticket()).toMatchObject({ blocked: false });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();
  });

  it('nowhere to keep its effects: the ticket is blocked, and still nothing goes out', async () => {
    const h = verified({ noEffect: { keptEffectsDir: false } });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.tracker.calls.filter((c) => TRACKER_WRITES.includes(c.method))).toEqual([]);
    expect(h.publisher.asked).toEqual([]);
    expect(h.forge.opened).toEqual([]);
    expect((await h.ticket()).blocked).toBe(true);
  });
});
