import { afterEach, describe, expect, it, vi } from 'vitest';
import { newTicketState, SCHEMA_VERSION, type FactoryEvent } from '../core/types.js';
import type { StoredEvent } from '../core/upcast.js';
import { SqliteStore } from '../store/sqlite-store.js';
import type { DecisionRequest, OutboxRow } from '../store/types.js';
import { effectBackoff } from './outbox.js';
import { Worker, type WorkerDeps } from './worker.js';

const event = (id: string): FactoryEvent =>
  ({ id, type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } }) as FactoryEvent;

/** Each event decides two comments. */
const twoComments = (e: FactoryEvent): DecisionRequest => ({
  event: e,
  workflow: { hash: 'h', definition: {} },
  decide: (ticket) => ({
    ticket: ticket ?? newTicketState('p', 'REL-1', 'T', 'todo', 1),
    // The result of an effect (ORC-150) decides nothing more.
    effects: e.type.startsWith('effect.')
      ? []
      : [
          { kind: 'comment', body: `${e.id}/1` },
          { kind: 'comment', body: `${e.id}/2` },
        ],
    timers: [],
    clearTimers: false,
  }),
});

/** A worker over an in-memory SQLite store: each event decides two comments. */
function setup(patch: Partial<WorkerDeps> = {}) {
  const store = new SqliteStore(':memory:');
  const logs: string[] = [];
  const executed: string[] = [];
  const worker = new Worker({
    store,
    log: (_level, message) => void logs.push(message),
    prepare: async (e) => e,
    request: twoComments,
    committed: async () => {},
    execute: async (row: OutboxRow) => void executed.push(row.id),
    ...patch,
  });
  return { store, worker, logs, executed };
}

async function settled(worker: Worker): Promise<void> {
  do await worker.settle();
  while ((await worker.kick()) > 0);
  await worker.settle();
}

/** The rows decided, oldest first, without the results of their effects. */
const decidedRows = async (store: SqliteStore) => (await store.recentEvents(50, 'REL-1')).map((e) => e.id).reverse().filter((id) => /^e\d$/.test(id));

describe('Worker', () => {
  it('still runs the effects of a committed decision, and the next rows, when its follow-up throws', async () => {
    const { store, worker, logs, executed } = setup({
      committed: async () => {
        throw new Error('bus down');
      },
    });
    await store.appendInbox(event('e1'));
    await store.appendInbox(event('e2'));
    await worker.kick();
    await settled(worker);
    expect(executed).toEqual(['REL-1:1:1', 'REL-1:1:2', 'REL-1:2:1', 'REL-1:2:2']);
    expect(await store.pendingInbox(10)).toEqual([]);
    // Two events and the four results of their effects (ORC-150).
    expect(logs.filter((m) => m.includes('decided, but its follow-up failed: bus down'))).toHaveLength(6);
  });

  it('leaves a row whose lease it lost to its new holder: neither done nor failed by the old one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // An already expired lease: another worker can claim the row while this one runs it.
    const { store, worker, logs } = setup({
      leaseMs: -1_000,
      execute: async (row) => {
        if (row.id === 'REL-1:1:1') await gate;
      },
    });
    await store.appendInbox(event('e1'));
    const running = worker.kick();
    for (let i = 0; i < 200 && (await store.listEffects('p', 'REL-1'))[0]?.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 2));
    const other = await store.claimEffect('p', 'REL-1', 60_000);
    expect(other).toMatchObject({ id: 'REL-1:1:1' });
    release();
    await running;
    await worker.settle();
    worker.stop();
    expect(logs.some((m) => m.includes('effect REL-1:1:1 done, but its lease went to another worker'))).toBe(true);
    expect((await store.listEffects('p', 'REL-1'))[0]).toMatchObject({ status: 'running', lease: (other as OutboxRow).lease });
  });
});

describe('Worker: rows held by another worker', () => {
  it('asks the store for the oldest row only, poll after poll: the rows behind it wait with it (ORC-290)', async () => {
    const prepared: string[] = [];
    const { store, worker } = setup({
      prepare: async (e) => {
        prepared.push(e.id);
        return e;
      },
    });
    await store.appendInbox(event('e1'));
    await store.decide(twoComments(event('e1')));
    // Another worker runs the first effect of e1, under its lease.
    expect(await store.claimEffect('p', 'REL-1', 60_000)).toMatchObject({ id: 'REL-1:1:1' });
    await store.appendInbox(event('e2'));
    await store.appendInbox(event('e3'));
    await worker.kick();
    await worker.settle();
    await worker.poll();
    await worker.settle();
    expect(prepared).toEqual(['e2', 'e2']);
    worker.stop();
  });
});

describe('Worker: a younger row that fails while an older one is parked (ORC-314)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * e2 is parked behind the effect another worker runs for e1. e3 fails in its preparation and takes
   * the hold, its retry 1 s away on the fake clock; the next poll asks for e2 all the same (ORC-315).
   * `retrying` runs in e3's next preparation.
   */
  async function olderBeforeYounger(retrying: () => Promise<void> = async () => {}) {
    vi.useFakeTimers({ now: 1_000_000 });
    const prepared: string[] = [];
    let failing = true;
    const { store, worker } = setup({
      retry: { attempts: 5, baseMs: 1_000 },
      prepare: async (e) => {
        prepared.push(e.id);
        if (e.id !== 'e3') return e;
        if (failing) {
          failing = false;
          throw new Error('Linear unreachable');
        }
        await retrying();
        return e;
      },
    });
    await store.appendInbox(event('e1'));
    await store.decide(twoComments(event('e1')));
    const other = (await store.claimEffect('p', 'REL-1', 60_000)) as OutboxRow;
    await store.appendInbox(event('e2'));
    await worker.kick();
    await worker.settle();
    await store.appendInbox(event('e3'));
    await worker.kick();
    await worker.settle();
    await worker.poll();
    await worker.settle();
    expect(prepared).toEqual(['e2', 'e3', 'e2']);
    return { store, worker, other, prepared };
  }

  it('gives the hold up when its retry finds the older row first: all are decided, oldest first', async () => {
    const { store, worker, other, prepared } = await olderBeforeYounger();
    await store.appendInbox(event('e4'));
    await worker.kick();
    await worker.settle();
    expect(prepared).not.toContain('e4');
    await vi.advanceTimersByTimeAsync(1_000);
    await worker.settle();
    // The other worker finishes: nothing is left but this worker's own polls, with no restart.
    await store.completeEffect(other.id, other.lease, Date.now());
    for (let polls = 0; polls < 4; polls++) {
      await worker.poll();
      await settled(worker);
    }
    expect(await store.pendingInbox(10)).toEqual([]);
    expect(await decidedRows(store)).toEqual(['e1', 'e2', 'e3', 'e4']);
    worker.stop();
  });

  it('leaves the rows behind it for the next start when its retry is answered during a shutdown', async () => {
    let open!: () => void;
    const answer = new Promise<void>((r) => (open = r));
    let reached!: () => void;
    const retrying = new Promise<void>((r) => (reached = r));
    const { store, worker, prepared } = await olderBeforeYounger(async () => {
      reached();
      await answer;
    });
    await store.appendInbox(event('e4'));
    await worker.kick();
    await worker.settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await retrying;
    worker.stop();
    const reads = vi.spyOn(store, 'pendingInbox');
    open();
    await worker.settle();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(prepared).toEqual(['e2', 'e3', 'e2', 'e3']);
    expect((await store.pendingInbox(10)).map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
  });
});

describe('Worker: a hold keeps back only the rows younger than the failed one (ORC-315)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for an older row past a younger one out of retries; failing too, the older takes the hold, and the younger ones go after it', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const prepared: string[] = [];
    const failing = new Set(['e3']);
    const { store, worker } = setup({
      retry: { attempts: 2, baseMs: 1_000 },
      prepare: async (e) => {
        prepared.push(e.id);
        if (failing.has(e.id)) throw new Error('Linear unreachable');
        return e;
      },
    });
    // Nothing can be set aside (ORC-320): out of retries, e3 keeps its hold.
    store.deadLetter = async () => {
      throw new Error('database down');
    };
    await store.appendInbox(event('e1'));
    await store.decide(twoComments(event('e1')));
    const other = (await store.claimEffect('p', 'REL-1', 60_000)) as OutboxRow;
    await store.appendInbox(event('e2'));
    await worker.kick();
    await worker.settle();
    await store.appendInbox(event('e3'));
    await store.appendInbox(event('e4'));
    await worker.kick();
    await worker.settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await worker.settle();
    // e3 is out of retries, e4 was never asked for. e2 is older: the poll asks for it, and it fails.
    expect(prepared).toEqual(['e2', 'e3', 'e3']);
    failing.add('e2');
    await worker.poll();
    await worker.settle();
    expect(prepared).toEqual(['e2', 'e3', 'e3', 'e2']);

    failing.clear();
    await store.completeEffect(other.id, other.lease, Date.now());
    await vi.advanceTimersByTimeAsync(1_000);
    for (let polls = 0; polls < 4; polls++) {
      await worker.poll();
      await settled(worker);
    }
    expect(await store.pendingInbox(10)).toEqual([]);
    expect(await decidedRows(store)).toEqual(['e1', 'e2', 'e3', 'e4']);
    worker.stop();
  });

  it('drops the retry a row had pending when an older row took the hold: taken up again, it is not tried twice', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const prepared: string[] = [];
    const failing = new Set(['e3']);
    const { store, worker } = setup({
      retry: { attempts: 3, baseMs: 1_000 },
      prepare: async (e) => {
        prepared.push(e.id);
        if (failing.has(e.id)) throw new Error('Linear unreachable');
        return e;
      },
    });
    await store.appendInbox(event('e1'));
    await store.decide(twoComments(event('e1')));
    const other = (await store.claimEffect('p', 'REL-1', 60_000)) as OutboxRow;
    await store.appendInbox(event('e2'));
    await worker.kick();
    await worker.settle();
    await store.appendInbox(event('e3'));
    await worker.kick();
    await worker.settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await worker.settle();
    // e3's last retry is 3 s away. e2 takes the hold, its own retry 1 s away.
    failing.add('e2');
    await worker.poll();
    await worker.settle();
    failing.delete('e2');
    await store.completeEffect(other.id, other.lease, Date.now());
    await vi.advanceTimersByTimeAsync(1_000);
    await worker.settle();
    expect(await decidedRows(store)).toEqual(['e1', 'e2']);
    await worker.poll();
    await worker.settle();
    // e2 passed, and e3, taken up again, failed its last attempt.
    expect(prepared.filter((id) => id === 'e3')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3_000);
    await worker.settle();
    expect(prepared.filter((id) => id === 'e3')).toHaveLength(3);
    worker.stop();
  });
});

describe('Worker: effects through the outbox executor (ORC-150)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a failed effect after 1 s, then 2 s, on a fake clock: never before', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const tries: number[] = [];
    const { store, worker } = setup({
      execute: async (row) => {
        if (row.id !== 'REL-1:1:1') return;
        tries.push(Date.now());
        if (tries.length <= 2) throw new Error('Linear unreachable');
      },
    });
    await store.appendInbox(event('e1'));
    await worker.kick();
    await settled(worker);
    expect(tries).toEqual([1_000_000]);
    // Not due yet: a pass (a poll) finds nothing to claim.
    await vi.advanceTimersByTimeAsync(990);
    expect(await worker.kick()).toBe(0);
    expect(tries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    await settled(worker);
    expect(tries).toHaveLength(2);
    expect(tries[1]! - tries[0]!).toBeGreaterThanOrEqual(1_000);
    expect(tries[1]! - tries[0]!).toBeLessThan(1_020);
    await vi.advanceTimersByTimeAsync(1_990 - (tries[1]! - tries[0]! - 1_000));
    expect(tries).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30);
    await settled(worker);
    expect(tries).toHaveLength(3);
    expect(tries[2]! - tries[1]!).toBeGreaterThanOrEqual(2_000);
    // The row behind it waited, then ran; every result is decided.
    expect((await store.listEffects('p', 'REL-1')).map((r) => [r.id, r.status, r.attempts])).toEqual([
      ['REL-1:1:1', 'done', 3],
      ['REL-1:1:2', 'done', 1],
    ]);
    expect(await store.pendingInbox(10)).toEqual([]);
    expect((await store.recentEvents(10, 'REL-1')).map((e) => e.id).reverse()).toEqual(['e1', 'effect:REL-1:1:1', 'effect:REL-1:1:2']);
    worker.stop();
  });

  it('lets an effect die after its last attempt, skips the rest of its decision, and decides its effect.failed', async () => {
    const { store, worker, logs } = setup({
      effectRetry: { attempts: 2, baseMs: 1, capMs: 1 },
      execute: async (row) => {
        if (row.id === 'REL-1:1:1') throw new Error('Linear down');
      },
    });
    await store.appendInbox(event('e1'));
    await worker.kick();
    for (let i = 0; i < 50 && (await store.listEffects('p', 'REL-1'))[0]?.status !== 'dead'; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await settled(worker);
    }
    await settled(worker);
    expect((await store.listEffects('p', 'REL-1')).map((r) => [r.status, r.attempts])).toEqual([
      ['dead', 2],
      ['failed', 0],
    ]);
    const failed = (await store.recentEvents(10, 'REL-1')).find((e) => e.id === 'effect:REL-1:1:1');
    expect(failed).toMatchObject({ type: 'effect.failed', payload: { error: 'Linear down', attempts: 2, kind: 'comment', eventId: 'e1' } });
    expect(await store.pendingInbox(10)).toEqual([]);
    expect(logs.some((m) => m.includes('effect REL-1:1:1 (comment): Linear down (attempt 1 of 2, retried in 1 ms)'))).toBe(true);
    expect(logs.some((m) => m.includes('effect REL-1:1:1 (comment): Linear down (dead after 2 attempts'))).toBe(true);
    worker.stop();
  });
});

describe('effectBackoff', () => {
  it('doubles from 1 s and stops at 5 min (ORC-129)', () => {
    expect([1, 2, 3, 4, 7, 9, 12].map((n) => effectBackoff(n))).toEqual([1_000, 2_000, 4_000, 8_000, 64_000, 256_000, 300_000]);
  });
});

describe('Worker.start: rows and effects (ORC-150)', () => {
  it('retries a failed effect in process once started, besides a failed row', async () => {
    let failures = 2;
    const { store, worker, executed } = setup({
      retry: { attempts: 5, baseMs: 5 },
      effectRetry: { attempts: 3, baseMs: 5, capMs: 5 },
      prepare: async (e) => {
        if (failures-- > 0) throw new Error('Linear unreachable');
        return e;
      },
      execute: async (row) => {
        if (row.id === 'REL-1:1:1' && !executed.includes('failed-once')) {
          executed.push('failed-once');
          throw new Error('Linear unreachable');
        }
        executed.push(row.id);
      },
    });
    worker.start(60_000);
    await store.appendInbox(event('e1'));
    await worker.kick();
    for (let i = 0; i < 200 && !executed.includes('REL-1:1:2'); i++) await new Promise((r) => setTimeout(r, 5));
    worker.stop();
    await worker.settle();
    expect(executed).toEqual(['failed-once', 'REL-1:1:1', 'REL-1:1:2']);
  });
});

describe('Worker.start', () => {
  it('retries a failed row in process once started as the daemon does (start() no longer leaves it stopped)', async () => {
    let failures = 2;
    const { store, worker, executed } = setup({
      retry: { attempts: 5, baseMs: 5 },
      prepare: async (e) => {
        if (failures-- > 0) throw new Error('Linear unreachable');
        return e;
      },
    });
    worker.start(60_000);
    await store.appendInbox(event('e1'));
    await worker.kick();
    for (let i = 0; i < 200 && executed.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    worker.stop();
    await worker.settle();
    expect(executed).toEqual(['REL-1:1:1', 'REL-1:1:2']);
  });

  it('lets the rows behind a decision go once its retry finds it committed (the answer to its COMMIT lost, ORC-163)', async () => {
    let lost = 1;
    const { store, worker, executed } = setup({ retry: { attempts: 5, baseMs: 1 } });
    const decide = store.decide.bind(store);
    store.decide = async (req) => {
      const outcome = await decide(req);
      // Committed, but the connection drops before the answer: the worker sees an error.
      if (lost-- > 0) throw new Error('Connection terminated unexpectedly');
      return outcome;
    };
    await store.appendInbox(event('e1'));
    await store.appendInbox(event('e2'));
    worker.start(60_000);
    await worker.kick();
    for (let i = 0; i < 200 && (await store.pendingInbox(10)).length > 0; i++) await new Promise((r) => setTimeout(r, 5));
    worker.stop();
    await worker.settle();
    expect(await store.pendingInbox(10)).toEqual([]);
    expect(executed).toEqual(['REL-1:1:1', 'REL-1:1:2', 'REL-1:2:1', 'REL-1:2:2']);
  });
});

describe('Worker: a decision that throws is dead-lettered (ORC-175)', () => {
  /** `decide` throws on the event `poison`, every time. */
  const poisoned = (patch: Partial<WorkerDeps> = {}) =>
    setup({
      request: (e) => {
        const req = twoComments(e);
        if (e.id !== 'poison') return req;
        return {
          ...req,
          decide: () => {
            throw new TypeError('rule.when.every is not a function');
          },
        };
      },
      ...patch,
    });

  it('sets the row aside at once, without retrying it, and lets the rows behind it go on', async () => {
    const deadLettered: string[] = [];
    const { store, worker, logs, executed } = poisoned({ retry: { attempts: 5, baseMs: 1 }, deadLettered: (row) => void deadLettered.push(row.id) });
    await store.appendInbox(event('poison'));
    await store.appendInbox(event('e2'));
    await worker.kick();
    await settled(worker);
    expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'poison', failures: 1, status: 'open', error: 'rule.when.every is not a function' }]);
    expect(deadLettered).toEqual(['poison']);
    // e2 decided, then the event that blocks the ticket (its decision here: two comments, as any event).
    expect(executed).toEqual(['REL-1:1:1', 'REL-1:1:2', 'REL-1:2:1', 'REL-1:2:2']);
    expect((await store.recentEvents(10, 'REL-1')).map((e) => e.id).reverse().filter((id) => !id.startsWith('effect:'))).toEqual(['e2', 'dead-letter:poison:1']);
    expect(await store.pendingInbox(10)).toEqual([]);
    expect(logs.filter((m) => m.includes('retried'))).toEqual([]);
    expect(logs).toContain('event poison (ticket.delegated) dead-lettered, its decision threw: rule.when.every is not a function (repair: factory run repair REL-1)');
  });

  it('dead-letters an event its upcast refuses', async () => {
    const { store, worker } = setup();
    const future: StoredEvent = { ...event('future'), schemaVersion: 99 };
    await store.appendInbox(future);
    await worker.kick();
    await settled(worker);
    expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'future', error: `event future: schema version 99 is newer than ${SCHEMA_VERSION}` }]);
  });

  it('keeps the row and retries it when the dead letter cannot be written: nothing is lost', async () => {
    let down = 1;
    const { store, worker, logs } = poisoned({ retry: { attempts: 3, baseMs: 1 } });
    const write = store.deadLetter.bind(store);
    store.deadLetter = async (...args) => {
      if (down-- > 0) throw new Error('database down');
      return write(...args);
    };
    await store.appendInbox(event('poison'));
    worker.start(60_000);
    await worker.kick();
    for (let i = 0; i < 200 && (await store.deadLetters()).length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    worker.stop();
    await worker.settle();
    expect(logs.some((m) => m.includes('rule.when.every is not a function; not dead-lettered: database down (attempt 1 of 3'))).toBe(true);
    expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'poison', failures: 1 }]);
  });

  it('still retries a row whose store transaction throws: the database, not the event', async () => {
    let failures = 1;
    const { store, worker } = setup({ retry: { attempts: 3, baseMs: 1 } });
    const decide = store.decide.bind(store);
    store.decide = async (req) => {
      if (failures-- > 0) throw new Error('database hiccup');
      return decide(req);
    };
    await store.appendInbox(event('e1'));
    worker.start(60_000);
    await worker.kick();
    for (let i = 0; i < 200 && (await store.pendingInbox(10)).length > 0; i++) await new Promise((r) => setTimeout(r, 5));
    worker.stop();
    await worker.settle();
    expect(await store.deadLetters()).toEqual([]);
    expect((await store.recentEvents(10, 'REL-1')).map((e) => e.id)).toContain('e1');
  });
});

describe('Worker: a row out of attempts (ORC-320)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** REL-1 is tracked, and e2 fails in its preparation until `up`, with e3 behind it. */
  async function failingE2() {
    vi.useFakeTimers({ now: 1_000_000 });
    const state = { up: false, tries: 0 };
    const left: string[] = [];
    const deadLettered: string[] = [];
    const scenario = setup({
      retry: { attempts: 2, baseMs: 1_000 },
      left: (row) => void left.push(row.id),
      deadLettered: (row) => void deadLettered.push(row.id),
      prepare: async (e) => {
        if (e.id === 'e2' && !state.up) {
          state.tries++;
          throw new Error('Linear unreachable');
        }
        return e;
      },
    });
    await scenario.store.appendInbox(event('e1'));
    await scenario.worker.kick();
    await settled(scenario.worker);
    await scenario.store.appendInbox(event('e2'));
    await scenario.store.appendInbox(event('e3'));
    await scenario.worker.kick();
    await settled(scenario.worker);
    return { ...scenario, state, left, deadLettered };
  }

  it('sets it aside, unprepared, and lets the row behind it go: it is not left waiting', async () => {
    const { store, worker, logs, state, left, deadLettered } = await failingE2();
    await vi.advanceTimersByTimeAsync(1_000);
    await settled(worker);

    expect(state.tries).toBe(2);
    expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'e2', status: 'open', failures: 1, error: 'Linear unreachable' }]);
    expect(deadLettered).toEqual(['e2']);
    expect(left).toEqual([]);
    expect(await decidedRows(store)).toEqual(['e1', 'e3']);
    expect(logs).toContain('event e2 (ticket.delegated) dead-lettered, out of attempts after 2: Linear unreachable (repair: factory run repair REL-1)');
    worker.stop();
  });

  it('tells a row left once, however long it is retried, when the store cannot set it aside; and it passes when the store is back', async () => {
    const { store, worker, logs, state, left, deadLettered } = await failingE2();
    const write = store.deadLetter.bind(store);
    store.deadLetter = async () => {
      throw new Error('database down');
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await settled(worker);
    for (const tries of [3, 4]) {
      await vi.advanceTimersByTimeAsync(3_000);
      await settled(worker);
      expect(state.tries).toBe(tries);
    }
    expect(left).toEqual(['e2', 'e3']);
    expect(deadLettered).toEqual([]);
    expect(logs).toContain('event e2 (ticket.delegated): Linear unreachable; not dead-lettered: database down (kept in the inbox after 4 attempts, retried in 3 s)');
    expect(await decidedRows(store)).toEqual(['e1']);

    store.deadLetter = write;
    state.up = true;
    await vi.advanceTimersByTimeAsync(3_000);
    await settled(worker);
    expect(await decidedRows(store)).toEqual(['e1', 'e2', 'e3']);
    expect(await store.deadLetters()).toEqual([]);
    worker.stop();
  });

  it('sets nothing aside, and retries nothing, once stopped', async () => {
    const { store, worker, state, left } = await failingE2();
    worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await worker.settle();
    expect(state.tries).toBe(1);
    expect(left).toEqual([]);
    expect(await store.deadLetters()).toEqual([]);
    expect((await store.pendingInbox(10)).map((e) => e.id)).toEqual(['e2', 'e3']);
  });
});

describe('Worker: what a dead letter keeps (ORC-175)', () => {
  it('keeps the event as prepared (its snapshot filled), so that a replay decides the same event', async () => {
    const issue = { title: 'T', logical: 'todo' as const, priority: 0 };
    const { store, worker } = setup({
      prepare: async (e) => ({ ...e, payload: { ...e.payload, issue } }) as FactoryEvent,
      request: (e) =>
        e.id !== 'e1'
          ? twoComments(e)
          : {
              ...twoComments(e),
              decide: () => {
                throw new Error('boom');
              },
            },
    });
    await store.appendInbox(event('e1'));
    await worker.kick();
    await settled(worker);
    expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'e1', event: { id: 'e1', payload: { issue } } }]);
  });
});
