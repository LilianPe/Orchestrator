import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../store/sqlite-store.js';
import { FakeClock } from './clock.js';
import { TimerService } from './timers.js';
import type { FactoryEvent } from './types.js';

describe('TimerService', () => {
  it('emits debounce.fired once when due', () => {
    const store = new SqliteStore(':memory:');
    const clock = new FakeClock(0);
    const events: FactoryEvent[] = [];
    const svc = new TimerService(store, clock, (e) => events.push(e));
    store.putTimer({ key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 180_000 });
    svc.tick();
    expect(events).toEqual([]);
    clock.set(180_000);
    svc.tick();
    svc.tick();
    expect(events).toEqual([
      { id: 'timer:REL-1:dev-feedback:180000', type: 'debounce.fired', at: 180_000, schemaVersion: 2, taint: 'trusted', projectId: 'p', ticketId: 'REL-1', payload: { job: 'dev-feedback' } },
    ]);
  });
});
