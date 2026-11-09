import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../store/sqlite-store.js';
import type { OutboxRow } from '../store/types.js';
import { newTicketState, type FactoryEvent } from './types.js';
import { ticketDiagnoses, type HeldRow } from './diagnosis.js';

const SECRET = 'ghs_s3cretvalue';
const mask = (s: string) => s.split(SECRET).join('***');

const event = (id: string, ticketId = 'REL-1'): FactoryEvent =>
  ({ id, type: 'ticket.delegated', at: 1, projectId: 'p', ticketId, payload: { linearSessionId: 'ls-1' } }) as FactoryEvent;

describe('ticketDiagnoses (ORC-350)', () => {
  it('tells why a ticket is stuck: its block, the row the worker holds, its last failed effect, its dead letters and its place in the queue, secrets masked', async () => {
    const store = new SqliteStore(':memory:');
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'Export', 'dev', 1), blocked: true, blockKind: 'infra', blockReason: `push refused for https://x-access-token:${SECRET}@github.com` });
    // A decided comment whose effect died.
    await store.appendInbox(event('e1'));
    await store.decide({
      event: event('e1'),
      workflow: { hash: 'h', definition: {} },
      decide: (t) => ({ ticket: t!, effects: [{ kind: 'comment', body: 'hello' }], timers: [], clearTimers: false }),
    });
    const claimed = (await store.claimEffect('p', 'REL-1', 60_000)) as OutboxRow;
    await store.failEffect(claimed.id, claimed.lease!, `Linear refused ${SECRET}`, 5);
    // A row set aside.
    await store.appendInbox(event('e2'));
    const [row] = (await store.pendingInbox(10)).filter((r) => r.id === 'e2');
    await store.deadLetter(row!, `decide threw on ${SECRET}`, 6);
    // Two tickets queued for dev, REL-1 behind REL-0.
    await store.enqueue({ projectId: 'p', ticketId: 'REL-0', job: 'dev', queue: 'dev', priority: 1, enqueuedAt: 1 });
    await store.enqueue({ projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', priority: 1, enqueuedAt: 2 });
    const held: HeldRow = { projectId: 'p', eventId: 'e3', type: 'ticket.delegated', error: `fetch ${SECRET} failed`, attempts: 2, retryAt: 9, behind: 1 };

    const [d, ...others] = await ticketDiagnoses({ store, held: () => [held], mask }, 'REL-1');
    expect(others).toEqual([]);
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(d).toMatchObject({
      projectId: 'p',
      ticketId: 'REL-1',
      tracked: true,
      state: { logical: 'dev', blocked: true, blockKind: 'infra', blockReason: 'push refused for https://x-access-token:***@github.com' },
      heldRow: { eventId: 'e3', error: 'fetch *** failed', attempts: 2, retryAt: 9, behind: 1 },
      lastFailedEffect: { id: claimed.id, kind: 'comment', status: 'dead', attempts: 1, error: 'Linear refused ***' },
      deadLetters: [{ eventId: 'e2', type: 'ticket.delegated', error: 'decide threw on ***', failures: 1 }],
      queue: [{ queue: 'dev', job: 'dev', position: 2 }],
    });
    expect(d!.reasons).toEqual([
      'blocked (infra): push refused for https://x-access-token:***@github.com',
      'event e3 (ticket.delegated) failed 2 times, its ticket held behind it: fetch *** failed',
      `effect ${claimed.id} (comment) dead after 1 attempt: Linear refused ***`,
      'event e2 (ticket.delegated) set aside: decide threw on *** (repair: factory run repair REL-1)',
      'queued for dev (dev), position 2',
    ]);
    await store.close();
  });

  it('tells no effect that failed once and then went through', async () => {
    const store = new SqliteStore(':memory:');
    await store.putTicket(newTicketState('p', 'REL-1', 'Export', 'dev', 1));
    await store.appendInbox(event('e1'));
    await store.decide({
      event: event('e1'),
      workflow: { hash: 'h', definition: {} },
      decide: (t) => ({ ticket: t!, effects: [{ kind: 'comment', body: 'hello' }], timers: [], clearTimers: false }),
    });
    const first = (await store.claimEffect('p', 'REL-1', 60_000)) as OutboxRow;
    await store.retryEffect(first.id, first.lease!, 'HTTP 502', 0);
    const second = (await store.claimEffect('p', 'REL-1', 60_000)) as OutboxRow;
    await store.completeEffect(second.id, second.lease, 7);
    const [d] = await ticketDiagnoses({ store, mask }, 'REL-1');
    expect(d!.lastFailedEffect).toBeUndefined();
    expect(d!.reasons).toEqual([]);
    await store.close();
  });

  it('finds a ticket the store does not track yet by the row the worker holds, and none it knows nothing of', async () => {
    const store = new SqliteStore(':memory:');
    const held: HeldRow = { projectId: 'p', eventId: 'e1', type: 'ticket.delegated', error: 'Linear unreachable', attempts: 1, behind: 0 };
    const [d] = await ticketDiagnoses({ store, held: (id) => (id === 'REL-9' ? [held] : []), mask }, 'REL-9');
    expect(d).toMatchObject({ projectId: 'p', ticketId: 'REL-9', tracked: false, heldRow: { eventId: 'e1' }, deadLetters: [], queue: [] });
    expect(d!.state).toBeUndefined();
    expect(await ticketDiagnoses({ store, held: () => [], mask }, 'REL-404')).toEqual([]);
    await store.close();
  });

  it('keeps to the project asked for when the same identifier is tracked in two', async () => {
    const store = new SqliteStore(':memory:');
    await store.putTicket(newTicketState('p', 'REL-1', 'Export', 'dev', 1));
    await store.putTicket(newTicketState('q', 'REL-1', 'Export', 'todo', 1));
    expect((await ticketDiagnoses({ store, mask }, 'REL-1')).map((d) => d.projectId).sort()).toEqual(['p', 'q']);
    expect((await ticketDiagnoses({ store, mask }, 'REL-1', 'q')).map((d) => d.projectId)).toEqual(['q']);
    await store.close();
  });
});
