import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkflow } from '../../config/load-workflow.js';
import { FakeClock } from '../../core/clock.js';
import { newTicketState, type FactoryEvent } from '../../core/types.js';
import { SqliteStore } from '../../store/sqlite-store.js';
import { FakeForge } from './fake.js';
import { PrPoller } from './pr-poller.js';

describe('PrPoller', () => {
  it('emits opened, checks transitions and merged', async () => {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../packs/standard') });
    const store = new SqliteStore(':memory:');
    const forge = new FakeForge();
    const events: FactoryEvent[] = [];
    const clock = new FakeClock(100);
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b' });
    const poller = new PrPoller({ store, forge, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: (e) => events.push(e), clock, log: () => {} });

    await poller.pollOnce();
    expect(events).toEqual([]);

    forge.setPr('b', { number: 7, url: 'u7', state: 'OPEN', checks: 'fail', failedChecks: ['test'] });
    await poller.pollOnce();
    expect(events.map((e) => [e.id, e.type])).toEqual([
      ['pr:REL-1:7:opened', 'pr.opened'],
      ['pr:REL-1:7:checks:fail:100', 'pr.checks_failed'],
    ]);
    expect(events[1]!.payload).toEqual({ number: 7, url: 'u7', branch: 'b', failures: ['test'] });

    await poller.pollOnce();
    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe('pr.opened');

    forge.setPr('b', { number: 7, url: 'u7', state: 'MERGED', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(events.at(-1)!.id).toBe('pr:REL-1:7:merged');
  });
  function setup(submit?: (e: FactoryEvent) => void, log: (m: string) => void = () => {}) {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../packs/standard') });
    const store = new SqliteStore(':memory:');
    const forge = new FakeForge();
    const events: FactoryEvent[] = [];
    const clock = new FakeClock(100);
    const poller = new PrPoller({ store, forge, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: submit ?? ((e) => events.push(e)), clock, log });
    return { store, forge, events, poller };
  }

  it('re-emits checks_failed after fail -> pending -> fail', async () => {
    const { store, forge, events, poller } = setup();
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7 });
    for (const checks of ['fail', 'pending', 'fail'] as const) {
      forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', checks, failedChecks: checks === 'fail' ? ['t'] : [] });
      await poller.pollOnce();
    }
    expect(events.map((e) => e.type)).toEqual(['pr.checks_failed', 'pr.checks_failed']);
  });

  it('isolates a failing ticket and logs', async () => {
    const logs: string[] = [];
    const events: FactoryEvent[] = [];
    const { store, forge, poller } = setup((e) => {
      if (e.ticketId === 'REL-1') throw new Error('boom');
      events.push(e);
    }, (m) => logs.push(m));
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b1' });
    await store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'human_review', 1), branch: 'b2' });
    forge.setPr('b1', { number: 1, url: 'u', state: 'OPEN', checks: 'none', failedChecks: [] });
    forge.setPr('b2', { number: 2, url: 'u', state: 'OPEN', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(events.map((e) => e.id)).toEqual(['pr:REL-2:2:opened']);
    expect(logs.some((m) => m.includes('boom'))).toBe(true);
  });

  it('watches a ticket moved to done before the merge was seen, until its PR is merged or closed (ORC-268)', async () => {
    const { store, forge, events, poller } = setup();
    const findPr = vi.spyOn(forge, 'findPr');
    store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'done', 1), branch: 'b', prNumber: 7 });
    forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', checks: 'fail', failedChecks: ['t'] });
    await poller.pollOnce();
    expect(events).toEqual([]);
    forge.setPr('b', { number: 7, url: 'u', state: 'MERGED', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(events.map((e) => e.id)).toEqual(['pr:REL-1:7:merged']);
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(2);
    // Done again with the same PR: nothing new to watch. With a new PR: watched again.
    store.putTicket({ ...store.getTicket('p', 'REL-1')!, logical: 'done' });
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(2);
    store.putTicket({ ...store.getTicket('p', 'REL-1')!, prNumber: 8 });
    forge.setPr('b', { number: 8, url: 'u8', state: 'OPEN', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(3);
    // A done ticket whose PR was never seen has nothing to wait for.
    store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'done', 1), branch: 'b2' });
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(4);
    expect(findPr.mock.calls.map((c) => c[1])).toEqual(['b', 'b', 'b', 'b']);
  });

  it('start() survives a rejecting pollOnce', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const { poller } = setup(undefined, (m) => logs.push(m));
      vi.spyOn(poller, 'pollOnce').mockRejectedValue(new Error('nope'));
      poller.start(10);
      await vi.advanceTimersByTimeAsync(15);
      poller.stop();
      expect(logs.some((m) => m.includes('nope'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
