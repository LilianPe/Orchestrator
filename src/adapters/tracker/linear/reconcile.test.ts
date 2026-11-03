import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../../config/load-workflow.js';
import { FakeClock } from '../../../core/clock.js';
import { decide } from '../../../core/engine.js';
import { newTicketState, type FactoryEvent } from '../../../core/types.js';
import { SqliteStore } from '../../../store/sqlite-store.js';
import { FakeTracker, STANDARD_STATES } from '../fake.js';
import { knownLabels, recordLabels } from './labels.js';
import { Reconciler, reconcileOnce } from './reconcile.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../../packs/standard') });

describe('reconcileOnce', () => {
  it('emits delegation, moves and undelegation', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app' });
    tracker.addIssue({ identifier: 'REL-2', delegateId: 'app', stateName: 'AI Review' });
    tracker.addIssue({ identifier: 'REL-3', stateName: 'In Progress' });
    await store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'human_review', 7), delegated: true });
    await store.putTicket({ ...newTicketState('p', 'REL-3', 'T', 'dev', 8), delegated: true, activeRunId: 'r3' });
    const events: FactoryEvent[] = [];
    await reconcileOnce({
      tracker, store, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }],
      submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {},
    });
    expect(events.map((e) => [e.id, e.type, e.payload])).toEqual([
      ['reconcile:delegated:REL-1', 'ticket.delegated', { issue: { title: 'Ticket', logical: 'todo', priority: 0 } }],
      ['reconcile:moved:REL-2:AI Review:7', 'status.changed', { from: 'human_review', to: 'ai_review' }],
      ['reconcile:undelegated:REL-3:r3', 'session.stopped', {}],
      ['reconcile:undelegated-flag:REL-3:8', 'ticket.undelegated', {}],
    ]);
    // Nobody signed the delegation or the move it finds: untrusted, without an actor (ORC-160).
    expect(events.map((e) => [e.type, e.taint, e.actor])).toEqual([
      ['ticket.delegated', 'untrusted', undefined],
      ['status.changed', 'untrusted', undefined],
      ['session.stopped', 'trusted', undefined],
      ['ticket.undelegated', 'trusted', undefined],
    ]);
  });

  it('re-emits delegation for a known but non-delegated ticket, and clears delegation when it is withdrawn', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-4', delegateId: 'app' });
    tracker.addIssue({ identifier: 'REL-5', stateName: 'Human Review' });
    await store.putTicket({ ...newTicketState('p', 'REL-4', 'T', 'todo', 4) });
    await store.putTicket({ ...newTicketState('p', 'REL-5', 'T', 'human_review', 5), delegated: true });
    const events: FactoryEvent[] = [];
    await reconcileOnce({
      tracker, store, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }],
      submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {},
    });
    expect(events.map((e) => [e.id, e.type])).toEqual([
      ['reconcile:delegated:REL-4:4', 'ticket.delegated'],
      ['reconcile:undelegated-flag:REL-5:5', 'ticket.undelegated'],
    ]);
  });

  it('gives each ticket of a team with several repos to the repo its label names, the others to the first with the choice (ORC-291)', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', labels: ['repo:api'] });
    tracker.addIssue({ identifier: 'REL-2', delegateId: 'app' });
    // Blocked in the first repo before its label was put: it is no longer that repo's.
    await store.putTicket({ ...newTicketState('web', 'REL-1', 'T', 'todo', 3), delegated: true, blocked: true });
    const events: FactoryEvent[] = [];
    const projects = ['web', 'api'].map((id) => ({ id, repoPath: `/${id}`, teamKey: 'REL', workflow }));
    await reconcileOnce({ tracker, store, projects, submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {} });
    expect(events.map((e) => [e.projectId, e.id, (e.payload as { repos?: string[] }).repos])).toEqual([
      ['web', 'reconcile:unrouted:REL-2', ['web', 'api']],
      ['web', 'reconcile:undelegated-flag:REL-1:3', undefined],
      ['api', 'reconcile:delegated:REL-1', undefined],
    ]);
    // One project's pass (the reconciliation timer's) still routes among all of them.
    events.length = 0;
    await reconcileOnce({ tracker, store, projects, only: 'api', submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {} });
    expect(events.map((e) => e.id)).toEqual(['reconcile:delegated:REL-1']);
  });
});

describe('reconcileOnce — done and cancelled (ORC-185)', () => {
  const projects = [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }];
  async function pass(tracker: FakeTracker, store: SqliteStore, log: (m: string) => void = () => {}) {
    const events: FactoryEvent[] = [];
    await reconcileOnce({ tracker, store, projects, submit: (e) => events.push(e), clock: new FakeClock(100), log });
    return events;
  }

  it('catches up a ticket moved to Done whose webhook was lost, unsigned, and never undelegates it', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-6', delegateId: 'app', stateName: 'Done', stateType: 'completed' });
    await store.putTicket({ ...newTicketState('p', 'REL-6', 'T', 'human_review', 6), delegated: true });
    const events = await pass(tracker, store);
    expect(events.map((e) => [e.id, e.type, e.payload, e.taint, e.actor])).toEqual([
      ['reconcile:moved:REL-6:Done:6', 'status.changed', { from: 'human_review', to: 'done' }, 'untrusted', undefined],
    ]);
  });

  it('catches up a cancelled ticket: its work is stopped, then its delegation cleared', async () => {
    const tracker = new FakeTracker();
    tracker.setStates('REL', [...STANDARD_STATES, 'Canceled']);
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-7', delegateId: 'app', stateName: 'Canceled', stateType: 'canceled' });
    await store.putTicket({ ...newTicketState('p', 'REL-7', 'T', 'dev', 7), delegated: true, activeRunId: 'r7' });
    const events = await pass(tracker, store);
    expect(events.map((e) => [e.id, e.type, e.payload, e.taint])).toEqual([
      ['reconcile:cancelled:REL-7:Canceled:7', 'status.changed', { from: 'dev', to: null, cancelled: true }, 'untrusted'],
      ['reconcile:undelegated-flag:REL-7:7', 'ticket.undelegated', {}, 'trusted'],
    ]);
  });

  it('a Done stops the run under way, and a delegation withdrawn with it is cleared', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-6', stateName: 'Done', stateType: 'completed' });
    await store.putTicket({ ...newTicketState('p', 'REL-6', 'T', 'dev', 6), delegated: true, activeRunId: 'r6' });
    expect((await pass(tracker, store)).map((e) => [e.id, e.type])).toEqual([
      ['reconcile:moved:REL-6:Done:6', 'status.changed'],
      ['reconcile:undelegated:REL-6:r6', 'session.stopped'],
      ['reconcile:undelegated-flag:REL-6:6', 'ticket.undelegated'],
    ]);
  });

  it('a completed status the workflow does not map to done clears the delegation, as before, so the ticket is not read again each pass', async () => {
    const tracker = new FakeTracker();
    tracker.setStates('REL', [...STANDARD_STATES, 'Released']);
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-6', delegateId: 'app', stateName: 'Released', stateType: 'completed' });
    await store.putTicket({ ...newTicketState('p', 'REL-6', 'T', 'human_review', 6), delegated: true });
    expect((await pass(tracker, store)).map((e) => [e.id, e.type])).toEqual([['reconcile:undelegated-flag:REL-6:6', 'ticket.undelegated']]);
  });

  it('a Done already received still stops a run left under way, as before', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-6', delegateId: 'app', stateName: 'Done', stateType: 'completed' });
    await store.putTicket({ ...newTicketState('p', 'REL-6', 'T', 'done', 6), delegated: true, activeRunId: 'r6' });
    expect((await pass(tracker, store)).map((e) => [e.id, e.type])).toEqual([['reconcile:undelegated:REL-6:r6', 'session.stopped']]);
  });

  it('a cancel on a ticket the factory no longer counts as delegated only stops its run', async () => {
    const tracker = new FakeTracker();
    tracker.setStates('REL', [...STANDARD_STATES, 'Canceled']);
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-7', delegateId: 'app', stateName: 'Canceled', stateType: 'canceled' });
    await store.putTicket({ ...newTicketState('p', 'REL-7', 'T', 'dev', 7), delegated: false, activeRunId: 'r7' });
    expect((await pass(tracker, store)).map((e) => [e.id, e.type])).toEqual([['reconcile:undelegated:REL-7:r7', 'session.stopped']]);
  });

  it('a Done already received (done in the store) is not caught up again, nor read from Linear', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-8', delegateId: 'app', stateName: 'Done', stateType: 'completed' });
    await store.putTicket({ ...newTicketState('p', 'REL-8', 'T', 'done', 8), delegated: true });
    expect(await pass(tracker, store)).toEqual([]);
    expect(tracker.calls.filter((c) => c.method === 'getIssue')).toEqual([]);
  });

  it('a ticket Linear does not answer for is left as it is this pass, not undelegated', async () => {
    const tracker = new FakeTracker();
    // A read error (network, Linear down) says nothing of the ticket.
    tracker.getIssue = () => Promise.reject(new Error('fetch failed'));
    const store = new SqliteStore(':memory:');
    await store.putTicket({ ...newTicketState('p', 'REL-9', 'T', 'dev', 9), delegated: true, activeRunId: 'r9' });
    const logs: string[] = [];
    expect(await pass(tracker, store, (m) => logs.push(m))).toEqual([]);
    expect(logs.join()).toContain('REL-9');
  });

  it('a ticket deleted in Linear is undelegated and its run stopped, as before', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    await store.putTicket({ ...newTicketState('p', 'REL-9', 'T', 'dev', 9), delegated: true, activeRunId: 'r9' });
    expect((await pass(tracker, store)).map((e) => [e.id, e.type])).toEqual([
      ['reconcile:undelegated:REL-9:r9', 'session.stopped'],
      ['reconcile:undelegated-flag:REL-9:9', 'ticket.undelegated'],
    ]);
  });

  it('a Done or a cancel it catches up never asks for a merge nor any write on the forge', async () => {
    const tracker = new FakeTracker();
    tracker.setStates('REL', [...STANDARD_STATES, 'Canceled']);
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-6', delegateId: 'app', stateName: 'Done', stateType: 'completed' });
    tracker.addIssue({ identifier: 'REL-7', delegateId: 'app', stateName: 'Canceled', stateType: 'canceled' });
    const reviewed = { ...newTicketState('p', 'REL-6', 'T', 'human_review', 6), delegated: true, branch: 'b6', prNumber: 6, prUrl: 'u', prState: 'OPEN' as const };
    const working = { ...newTicketState('p', 'REL-7', 'T', 'dev', 7), delegated: true, branch: 'b7', prNumber: 7, prUrl: 'u', prState: 'OPEN' as const, activeRunId: 'r7' };
    await store.putTicket(reviewed);
    await store.putTicket(working);
    const events = await pass(tracker, store);
    expect(events.map((e) => [e.ticketId, e.type])).toEqual([['REL-6', 'status.changed'], ['REL-7', 'status.changed'], ['REL-7', 'ticket.undelegated']]);
    const effects = events.flatMap((e) => decide(e.ticketId === 'REL-6' ? reviewed : working, e, workflow).effects.map((f) => f.kind));
    // A stop and the Linear labels only: nothing the forge is asked to write, no run started.
    expect(effects.filter((k) => k !== 'stop_run' && k !== 'labels')).toEqual([]);
  });
});

describe('reconcileOnce — labels (ORC-185)', () => {
  const projects = [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }];
  async function pass(tracker: FakeTracker, store: SqliteStore) {
    const events: FactoryEvent[] = [];
    await reconcileOnce({ tracker, store, projects, submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {} });
    return events;
  }
  async function setup() {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app', stateName: 'In Progress', labels: ['bug'] });
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'dev', 3), delegated: true });
    return { tracker, store };
  }

  it('first records the labels it reads, without reporting any of them', async () => {
    const { tracker, store } = await setup();
    expect(await pass(tracker, store)).toEqual([]);
    expect(await knownLabels(store, 'p', 'REL-1')).toEqual({ labels: ['bug'], at: 0 });
  });

  it('then catches up a label added or taken off whose webhook was lost, once, unsigned', async () => {
    const { tracker, store } = await setup();
    await pass(tracker, store);
    tracker.issues.get('REL-1')!.labels = ['agent:reprendre'];
    const events = await pass(tracker, store);
    expect(events.map((e) => [e.id, e.type, e.payload, e.taint, e.actor])).toEqual([
      ['reconcile:label:REL-1:agent:reprendre:added:3', 'label.changed', { label: 'agent:reprendre', change: 'added' }, 'untrusted', undefined],
      ['reconcile:label:REL-1:bug:removed:3', 'label.changed', { label: 'bug', change: 'removed' }, 'untrusted', undefined],
    ]);
    expect(await pass(tracker, store)).toEqual([]);
  });

  it('a label taken off and put back with no change of the ticket in the factory gets a new id each time Linear changes', async () => {
    const { tracker, store } = await setup();
    const issue = tracker.issues.get('REL-1')!;
    issue.updatedAt = 10;
    await pass(tracker, store);
    const ids: string[] = [];
    for (const [labels, at] of [[['bug', 'x'], 20], [['bug'], 30], [['bug', 'x'], 40]] as const) {
      issue.labels = [...labels];
      issue.updatedAt = at;
      ids.push(...(await pass(tracker, store)).map((e) => e.id));
    }
    expect(ids).toEqual(['reconcile:label:REL-1:x:added:20', 'reconcile:label:REL-1:x:removed:30', 'reconcile:label:REL-1:x:added:40']);
  });

  it('labels a webhook recorded after Linear was read are newer: nothing is reported, nothing overwritten', async () => {
    const { tracker, store } = await setup();
    tracker.issues.get('REL-1')!.updatedAt = 100;
    await pass(tracker, store);
    // The webhook of an addition, made after the pass read Linear, came in between.
    await recordLabels(store, 'p', 'REL-1', ['agent:reprendre', 'bug'], 200);
    expect(await pass(tracker, store)).toEqual([]);
    expect(await knownLabels(store, 'p', 'REL-1')).toEqual({ labels: ['agent:reprendre', 'bug'], at: 200 });
  });

  it('a label the factory itself just wrote is not reported as a human change', async () => {
    const { tracker, store } = await setup();
    await pass(tracker, store);
    tracker.issues.get('REL-1')!.labels = ['bug', 'Bloqué'];
    await store.putEcho('label:REL-1:Bloqué', 1_000);
    expect(await pass(tracker, store)).toEqual([]);
    expect((await knownLabels(store, 'p', 'REL-1'))?.labels).toEqual(['Bloqué', 'bug']);
  });
});

describe('Reconciler', () => {
  it('stop() resolves once the pass under way has finished; a pass asked meanwhile joins it', async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let passes = 0;
    const events: FactoryEvent[] = [];
    const reconciler = new Reconciler({
      tracker: { listDelegated: async (k) => (passes++, await gate, tracker.listDelegated(k)), getIssue: (id) => tracker.getIssue(id) },
      store: new SqliteStore(':memory:'), projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }],
      submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {},
    });
    void reconciler.once();
    // A second pass asked while one runs joins it: one pass, not two.
    void reconciler.once();
    await new Promise((r) => setTimeout(r, 30));
    let stopped = false;
    const stop = reconciler.stop().then(() => (stopped = true));
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(passes).toBe(1);
    expect(events.map((e) => e.id)).toEqual(['reconcile:delegated:REL-1']);
  });
});
