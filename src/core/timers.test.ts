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

  it('deletes only the firing it read, not a timer re-armed while the pass awaited the store', async () => {
    const inner = new SqliteStore(':memory:');
    const timer = { key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 100 };
    await inner.putTimer(timer);
    // The orchestrator re-arms the key between the read and the delete.
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      dueTimers: async (now: number) => {
        const due = await inner.dueTimers(now);
        await inner.putTimer({ ...timer, fireAt: 900 });
        return due;
      },
    });
    const events: FactoryEvent[] = [];
    await new TimerService(store, new FakeClock(500), (e) => events.push(e)).tick();
    expect(events.map((e) => e.id)).toEqual(['timer:REL-1:dev-feedback:100']);
    expect(await inner.dueTimers(1000)).toEqual([{ ...timer, fireAt: 900 }]);
  });

  it('fires again on the next pass a timer whose pass failed before deleting it', async () => {
    const inner = new SqliteStore(':memory:');
    await inner.putTimer({ key: 'REL-1:x', projectId: 'p', ticketId: 'REL-1', job: 'x', fireAt: 100 });
    let fail = true;
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      deleteTimer: async (key: string, fireAt?: number) => {
        if (fail) throw new Error('store down');
        return inner.deleteTimer(key, fireAt);
      },
    });
    const events: FactoryEvent[] = [];
    // The firing goes to the inbox, which dedups it by id (ORC-147).
    const svc = new TimerService(store, new FakeClock(500), (e) => (events.push(e), inner.appendInbox(e)));
    await expect(svc.tick()).rejects.toThrow('store down');
    fail = false;
    await svc.tick();
    expect(events.map((e) => e.id)).toEqual(['timer:REL-1:x:100', 'timer:REL-1:x:100']);
    expect((await inner.pendingInbox(10)).map((e) => e.id)).toEqual(['timer:REL-1:x:100']);
    expect(await inner.dueTimers(1000)).toEqual([]);
  });

  it('writes the firing to the inbox before deleting the timer, and keeps the timer when the write fails', async () => {
    const store = new SqliteStore(':memory:');
    await store.putTimer({ key: 'REL-1:x', projectId: 'p', ticketId: 'REL-1', job: 'x', fireAt: 100 });
    let down = true;
    const svc = new TimerService(store, new FakeClock(500), async (e) => {
      if (down) throw new Error('inbox down');
      return store.appendInbox(e);
    });
    await expect(svc.tick()).rejects.toThrow('inbox down');
    expect(await store.dueTimers(1000)).toHaveLength(1);
    down = false;
    await svc.tick();
    expect((await store.pendingInbox(10)).map((e) => e.id)).toEqual(['timer:REL-1:x:100']);
    expect(await store.dueTimers(1000)).toEqual([]);
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

  it('stop() resolves once the pass under way has finished', async () => {
    const inner = new SqliteStore(':memory:');
    await inner.putTimer({ key: 'REL-1:x', projectId: 'p', ticketId: 'REL-1', job: 'x', fireAt: 100 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      dueTimers: async (now: number) => {
        await gate;
        return inner.dueTimers(now);
      },
    });
    const events: FactoryEvent[] = [];
    const svc = new TimerService(store, new FakeClock(500), (e) => events.push(e));
    const pass = svc.tick();
    let stopped = false;
    const stop = svc.stop().then(() => (stopped = true));
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release();
    await Promise.all([pass, stop]);
    expect(events).toHaveLength(1);
    expect(await inner.dueTimers(1000)).toEqual([]);
  });
});
