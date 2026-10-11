import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../config/load-workflow.js';
import { FakeClock } from '../../core/clock.js';
import { newTicketState, type RelaisEvent } from '../../core/types.js';
import { SqliteStore } from '../../store/sqlite-store.js';
import { FakeForge } from './fake.js';
import { PrPoller } from './pr-poller.js';

describe('PrPoller', () => {
  it('emits opened, checks transitions and merged', async () => {
    const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../../packs/standard') });
    const store = new SqliteStore(':memory:');
    const forge = new FakeForge();
    const events: RelaisEvent[] = [];
    const clock = new FakeClock(100);
    store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b' });
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
});
