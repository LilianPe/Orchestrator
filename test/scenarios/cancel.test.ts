import { describe, expect, it, vi } from 'vitest';
import { reconcileOnce } from '../../src/adapters/tracker/linear/reconcile.js';
import { BLOCKED_LABEL } from '../../src/core/engine.js';
import { createHarness } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';

type Harness = ReturnType<typeof createHarness>;

/** A human takes the ticket back from the agent in Linear; the reconciliation's pass is what the factory hears of it. */
async function withdraw(h: Harness, drain = true): Promise<void> {
  h.tracker.issues.get('REL-1')!.delegateId = undefined;
  await reconcileOnce({ tracker: h.tracker, store: h.store, projects: [h.project], submit: (e) => h.orch.accept(e), clock: h.clock, log: () => {} });
  if (drain) await h.orch.drained();
}

function addIssue(h: Harness): void {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', delegateId: 'app', description: 'Exporter les audits en CSV depuis la liste des audits.' });
}

/**
 * Mandatory harness scenario « Delegation withdrawn » (ORC-227, docs/tests.md): the run is cancelled and its attempt stopped,
 * and nothing of the ticket's work, a check in flight included, goes on or starts again.
 */
describe('delegation withdrawn (ORC-227)', () => {
  it('during a run: the sandboxed attempt is stopped, its sandbox gone, the work cancelled and nothing starts again', async () => {
    const h = createHarness({ sandboxed: true });
    addIssue(h);
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    expect(h.sandboxes.active()).toHaveLength(1);

    await withdraw(h);

    expect((await h.store.getRun(runId))!.status).toBe('stopped');
    expect(h.sandboxes.active()).toEqual([]);
    const t = await h.ticket();
    expect(t).toMatchObject({ delegated: false });
    expect(t.activeRunId).toBeUndefined();
    expect(t.pendingJob).toBeUndefined();
    expect(t.verifyingRunId).toBeUndefined();
    // The pass stops a run under way as Linear's Stop does (`session.stopped`, then the undelegation): the ticket keeps that block.
    expect(t).toMatchObject({ blocked: true, blockKind: 'stopped' });
    await h.advance(60 * 60_000);
    expect(h.runner.requests).toHaveLength(1);
    expect(h.checks.calls).toEqual([]);
    expect(h.publisher.published).toEqual([]);
  });

  it('during a check: the verdict that comes after is fenced, nothing is published and no step runs after it', async () => {
    const h = createHarness({ preset: testPreset() });
    addIssue(h);
    const release = h.checks.holdNext();
    const delegated = h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.checks.started(1);
    const before = await h.ticket();
    expect(before.verifyingRunId).toBeDefined();
    expect(before.activeRunId).toBeUndefined();

    // The pass sees no run under way: only the undelegation reaches the engine.
    // The check held, nothing drains: the undelegation is waited for in the store (10 s under load, ORC-290).
    await withdraw(h, false);
    await vi.waitFor(async () => expect(await h.ticket()).toMatchObject({ delegated: false }), { timeout: 10_000 });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();

    release();
    await delegated;
    await h.advance(60 * 60_000);
    expect(h.publisher.published).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t).toMatchObject({ delegated: false, blocked: false, logical: before.logical });
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
  });

  it('a ticket at rest (in human review, nothing in flight) is only let go: nothing said', async () => {
    const h = createHarness();
    addIssue(h);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review' });
    expect((await h.ticket()).activeRunId).toBeUndefined();
    const said = h.tracker.activities('ls-1').length;
    const comments = h.tracker.comments('REL-1').length;

    await withdraw(h);

    expect(await h.ticket()).toMatchObject({ delegated: false, blocked: false, logical: 'human_review' });
    expect(h.tracker.activities('ls-1')).toHaveLength(said);
    expect(h.tracker.comments('REL-1')).toHaveLength(comments);
  });

  it('while replies are regrouped: the grouping timer goes, no feedback run starts and nothing is said when it would have fired', async () => {
    const h = createHarness();
    addIssue(h);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'corrige le tri', author: 'Lilian', ack: true, kind: 'instruction' });
    expect((await h.ticket()).activeRunId).toBeUndefined();
    const timers = async () => (await h.store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.ticketId === 'REL-1');
    expect(await timers()).toHaveLength(1);
    const said = h.tracker.activities('ls-1').length;

    await withdraw(h);
    expect(await timers()).toEqual([]);
    await h.advance(60 * 60_000);

    expect(h.runner.requests).toHaveLength(1);
    expect(h.tracker.activities('ls-1')).toHaveLength(said);
    expect(await h.ticket()).toMatchObject({ delegated: false, blocked: false });
  });
});

/** The cancel of the doc's default reactions (ORC-170): a run under way stops, and nothing waits for a human any longer. */
describe('ticket cancelled by a human (ORC-170)', () => {
  it('during a run: the attempt is stopped, the work cancelled, no block, and nothing starts again', async () => {
    const h = createHarness();
    addIssue(h);
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;

    await h.send('status.changed', { from: 'dev', to: null, cancelled: true }, 'REL-1', { actor: 'user-1', taint: 'trusted' });

    expect((await h.store.getRun(runId))!.status).toBe('stopped');
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, humanInbox: [] });
    expect(t.activeRunId).toBeUndefined();
    expect(t.pendingJob).toBeUndefined();
    expect(h.tracker.issues.get('REL-1')!.labels).not.toContain(BLOCKED_LABEL);
    await h.advance(60 * 60_000);
    expect(h.runner.requests).toHaveLength(1);
    expect(h.publisher.published).toEqual([]);
  });
});
