import { describe, expect, it } from 'vitest';
import { newTicketState, type FactoryEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import type { DecisionRequest, OutboxRow } from '../store/types.js';
import { Worker, type WorkerDeps } from './worker.js';

const event = (id: string): FactoryEvent =>
  ({ id, type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } }) as FactoryEvent;

/** A worker over an in-memory SQLite store: each event decides two comments. */
function setup(patch: Partial<WorkerDeps> = {}) {
  const store = new SqliteStore(':memory:');
  const logs: string[] = [];
  const executed: string[] = [];
  const worker = new Worker({
    store,
    log: (_level, message) => void logs.push(message),
    prepare: async (e) => e,
    request: (e): DecisionRequest => ({
      event: e,
      workflow: { hash: 'h', definition: {} },
      decide: (ticket) => ({
        ticket: ticket ?? newTicketState('p', 'REL-1', 'T', 'todo', 1),
        effects: [
          { kind: 'comment', body: `${e.id}/1` },
          { kind: 'comment', body: `${e.id}/2` },
        ],
        timers: [],
        clearTimers: false,
      }),
    }),
    committed: async () => {},
    execute: async (row: OutboxRow) => void executed.push(row.id),
    effectFailed: async () => {},
    ...patch,
  });
  return { store, worker, logs, executed };
}

async function settled(worker: Worker): Promise<void> {
  do await worker.settle();
  while ((await worker.kick()) > 0);
  await worker.settle();
}

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
    expect(logs.filter((m) => m.includes('decided, but its follow-up failed: bus down'))).toHaveLength(2);
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
