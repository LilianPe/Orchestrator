import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../store/sqlite-store.js';
import { FakeClock } from './clock.js';
import { TimerService } from './timers.js';
import type { FactoryEvent } from './types.js';

describe('TimerService', () => {
  it('emits debounce.fired once when due', async () => {
    const store = new SqliteStore(':memory:');
    const clock = new FakeClock(0);
    const events: FactoryEvent[] = [];
    const svc = new TimerService(store, clock, (e) => events.push(e));
    await store.putTimer({ key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 180_000 });
    await svc.tick();
    expect(events).toEqual([]);
    clock.set(180_000);
    await svc.tick();
    await svc.tick();
    expect(events).toEqual([
      { id: 'timer:REL-1:dev-feedback:180000', type: 'debounce.fired', at: 180_000, schemaVersion: 2, taint: 'trusted', projectId: 'p', ticketId: 'REL-1', payload: { job: 'dev-feedback' } },
    ]);
  });

  it('runs one pass at a time, so overlapping ticks fire a timer once', async () => {
    const store = new SqliteStore(':memory:');
    const clock = new FakeClock(500);
    const events: FactoryEvent[] = [];
    const svc = new TimerService(store, clock, (e) => events.push(e));
    await store.putTimer({ key: 'REL-1:x', projectId: 'p', ticketId: 'REL-1', job: 'x', fireAt: 100 });
    await Promise.all([svc.tick(), svc.tick()]);
    expect(events).toHaveLength(1);
  });
});
