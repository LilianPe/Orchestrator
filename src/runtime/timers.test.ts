import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../core/clock.js';
import { newTicketState, TRUSTED, type FactoryEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import type { TimerRecord } from '../store/types.js';
import { TimerService } from './timers.js';

const HOUR = 3_600_000;
const timer = { key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', kind: 'debounce' as const, payload: { job: 'dev-feedback' }, fireAt: 100 };
const ids = async (store: SqliteStore) => (await store.pendingInbox(100)).map((e) => e.id);

/** Makes every inbox write of the store fail until `restore()`: the firing's transaction aborts. */
function inboxDown(store: SqliteStore): { restore(): void } {
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TRIGGER inbox_down BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'inbox down'); END");
  return { restore: () => db.exec('DROP TRIGGER inbox_down') };
}

describe('TimerService (ORC-161)', () => {
  it('fires a due timer once through the inbox, even after a second tick', async () => {
    const store = new SqliteStore(':memory:');
    const clock = new FakeClock(0);
    let woken = 0;
    const svc = new TimerService(store, clock, () => woken++);
    await store.putTimer({ ...timer, fireAt: 180_000 });
    await svc.tick();
    expect(await store.pendingInbox(10)).toEqual([]);
    clock.set(180_000);
    await svc.tick();
    await svc.tick();
    const event = {
      id: 'timer:REL-1:dev-feedback:180000', type: 'timer.fired', at: 180_000, ...TRUSTED, projectId: 'p', ticketId: 'REL-1',
      payload: { kind: 'debounce', payload: { job: 'dev-feedback' } },
    };
    expect(await store.pendingInbox(10)).toEqual([event]);
    expect(woken).toBe(1);
    expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('fires nothing for a timer pushed back while the pass read it, and keeps it for its new time', async () => {
    const inner = new SqliteStore(':memory:');
    await inner.putTimer(timer);
    // A reply pushes the debounce back between the read and the firing.
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      dueTimers: async (now: number) => {
        const due = await inner.dueTimers(now);
        await inner.putTimer({ ...timer, fireAt: 900 });
        return due;
      },
    });
    await new TimerService(store, new FakeClock(500)).tick();
    expect(await ids(inner)).toEqual([]);
    expect(await inner.dueTimers(1000)).toEqual([{ ...timer, fireAt: 900 }]);
  });

  it('loses nothing when the firing fails: no inbox row, the timer kept, fired on the next pass', async () => {
    const store = new SqliteStore(':memory:');
    await store.putTimer(timer);
    const svc = new TimerService(store, new FakeClock(500));
    const down = inboxDown(store);
    await expect(svc.tick()).rejects.toThrow('inbox down');
    // The delete and the insert are one transaction: the timer is still there.
    expect(await store.dueTimers(1000)).toEqual([timer]);
    down.restore();
    await svc.tick();
    expect(await ids(store)).toEqual(['timer:REL-1:dev-feedback:100']);
    expect(await store.dueTimers(1000)).toEqual([]);
  });

  it('fires the other due timers when one firing fails, and reports the failure', async () => {
    const inner = new SqliteStore(':memory:');
    const other = { ...timer, key: 'REL-2:dev-feedback', ticketId: 'REL-2', fireAt: 200 };
    await inner.putTimer(timer);
    await inner.putTimer(other);
    let down = true;
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      fireTimer: async (t: TimerRecord, e: FactoryEvent) => {
        if (down && t.key === timer.key) throw new Error('lock timeout');
        return inner.fireTimer(t, e);
      },
    });
    const svc = new TimerService(store, new FakeClock(500));
    await expect(svc.tick()).rejects.toThrow('lock timeout');
    expect(await ids(inner)).toEqual(['timer:REL-2:dev-feedback:200']);
    expect(await inner.dueTimers(1000)).toEqual([timer]);
    down = false;
    await svc.tick();
    expect(await ids(inner)).toEqual(['timer:REL-2:dev-feedback:200', 'timer:REL-1:dev-feedback:100']);
  });

  it('runs one pass at a time, so overlapping ticks fire a timer once', async () => {
    const store = new SqliteStore(':memory:');
    let woken = 0;
    const svc = new TimerService(store, new FakeClock(500), () => woken++);
    await store.putTimer(timer);
    await Promise.all([svc.tick(), svc.tick()]);
    expect(woken).toBe(1);
    expect(await ids(store)).toHaveLength(1);
  });

  it('stop() resolves once the pass under way has finished', async () => {
    const inner = new SqliteStore(':memory:');
    await inner.putTimer(timer);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      dueTimers: async (now: number) => {
        await gate;
        return inner.dueTimers(now);
      },
    });
    const svc = new TimerService(store, new FakeClock(500));
    const pass = svc.tick();
    let stopped = false;
    const stop = svc.stop().then(() => (stopped = true));
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release();
    await Promise.all([pass, stop]);
    expect(await ids(inner)).toHaveLength(1);
    expect(await inner.dueTimers(1000)).toEqual([]);
  });

  it('fires a timer at +24 h and another at +72 h, armed by a decision, each once through the inbox', async () => {
    const clock = new FakeClock(1_000_000);
    const store = new SqliteStore(':memory:', () => clock.now());
    const start = clock.now();
    const delegated = { ...TRUSTED, id: 'e1', type: 'ticket.delegated', at: start, projectId: 'p', ticketId: 'REL-1', payload: {} } as FactoryEvent;
    const armed: TimerRecord[] = [
      { key: 'REL-1:clarify.remind', projectId: 'p', ticketId: 'REL-1', kind: 'clarify.remind', payload: { linearSessionId: 'ls-2' }, fireAt: start + 24 * HOUR, armedBy: 'e1' },
      { key: 'REL-1:clarify.expire', projectId: 'p', ticketId: 'REL-1', kind: 'clarify.expire', payload: { linearSessionId: 'ls-2' }, fireAt: start + 72 * HOUR, armedBy: 'e1' },
    ];
    await store.appendInbox(delegated);
    // Written by the decision transaction, with its journal row and its projection.
    const outcome = await store.decide({
      event: delegated,
      workflow: { hash: 'h', definition: {} },
      decide: () => ({ ticket: newTicketState('p', 'REL-1', 'T', 'todo', start), effects: [], timers: armed, clearTimers: false }),
    });
    expect(outcome.status).toBe('committed');
    expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual(armed);

    const svc = new TimerService(store, clock);
    const firedAt = new Map<string, number>();
    for (let h = 1; h <= 100; h++) {
      clock.advance(HOUR);
      await svc.tick();
      for (const id of await ids(store)) if (!firedAt.has(id)) firedAt.set(id, (clock.now() - start) / HOUR);
    }
    expect([...firedAt]).toEqual([
      [`timer:REL-1:clarify.remind:${start + 24 * HOUR}`, 24],
      [`timer:REL-1:clarify.expire:${start + 72 * HOUR}`, 72],
    ]);
    expect((await store.pendingInbox(100)).map((e) => e.payload)).toEqual([
      { kind: 'clarify.remind', payload: { linearSessionId: 'ls-2' } },
      { kind: 'clarify.expire', payload: { linearSessionId: 'ls-2' } },
    ]);
    expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  describe('restart', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('fires a timer armed before a restart of the daemon once its deadline comes', async () => {
      dir = mkdtempSync(join(tmpdir(), 'factory-timers-'));
      const file = join(dir, 'factory.db');
      const clock = new FakeClock(0);
      const before = new SqliteStore(file);
      await before.putTimer({ ...timer, fireAt: 72 * HOUR });
      await new TimerService(before, clock).tick();
      await before.close();

      // A new process: a new store on the same file, a new service, nothing carried over in memory.
      const after = new SqliteStore(file);
      const svc = new TimerService(after, clock);
      clock.set(72 * HOUR - 1);
      await svc.tick();
      expect(await ids(after)).toEqual([]);
      clock.set(72 * HOUR);
      await svc.tick();
      await svc.tick();
      expect(await ids(after)).toEqual([`timer:REL-1:dev-feedback:${72 * HOUR}`]);
      await after.close();
    });
  });
});
