import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../../config/load-workflow.js';
import { FakeClock } from '../../../core/clock.js';
import { newTicketState, type FactoryEvent } from '../../../core/types.js';
import { SqliteStore } from '../../../store/sqlite-store.js';
import { FakeTracker } from '../fake.js';
import { Reconciler, reconcileOnce } from './reconcile.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../../packs/standard') });

describe('reconcileOnce', () => {
  it('emits delegation, moves and undelegation', async () => {
    const tracker = new FakeTracker();
    const store = new SqliteStore(':memory:');
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app' });
    tracker.addIssue({ identifier: 'REL-2', delegateId: 'app', stateName: 'AI Review' });
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
});

describe('Reconciler', () => {
  it('stop() resolves once the pass under way has finished, and starts none after', async () => {
    const tracker = new FakeTracker();
    tracker.addIssue({ identifier: 'REL-1', delegateId: 'app' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let passes = 0;
    const events: FactoryEvent[] = [];
    const reconciler = new Reconciler({
      tracker: { listDelegated: async (k) => (passes++, await gate, tracker.listDelegated(k)) },
      store: new SqliteStore(':memory:'), projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }],
      submit: (e) => events.push(e), clock: new FakeClock(100), log: () => {},
    });
    reconciler.start(5);
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
