import { describe, expect, it } from 'vitest';
import { newTicketState, type FactoryEvent } from '../core/types.js';
import { SqliteStore } from './sqlite-store.js';
import type { QueueItem, RunRecord } from './types.js';

const store = () => new SqliteStore(':memory:');

function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running',
    claudeSessionId: 'c1', startedAt: 100, costUsd: 0, turns: 0, lastText: '', token: 't1', cwd: '/tmp', ...patch,
  };
}
function q(patch: Partial<QueueItem>): QueueItem {
  return { projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', priority: 0, enqueuedAt: 0, ...patch };
}

describe('SqliteStore', () => {
  it('round-trips tickets', async () => {
    const s = store();
    const t = { ...newTicketState('p', 'REL-1', 'T', 'todo', 1), pendingFeedback: [{ author: 'a', body: 'b', at: 2, source: 'session' as const }] };
    await s.putTicket(t);
    expect(await s.getTicket('p', 'REL-1')).toEqual(t);
    expect(await s.listTickets()).toHaveLength(1);
  });

  it('dedupes events by id and lists recent ones', async () => {
    const s = store();
    const e = { id: 'e1', type: 'control.pause', at: 5, projectId: 'p', payload: {} } as FactoryEvent;
    expect(await s.recordEvent(e)).toBe(true);
    expect(await s.recordEvent(e)).toBe(false);
    expect(await s.recentEvents(10)).toEqual([e]);
  });

  it('stores runs and finds them by token and status', async () => {
    const s = store();
    await s.putRun(run());
    await s.putRun(run({ id: 'r2', token: 't2', status: 'success', costUsd: 1.5, startedAt: 200 }));
    expect((await s.findRunByToken('t2'))!.id).toBe('r2');
    expect((await s.runsByStatus('running')).map((r) => r.id)).toEqual(['r1']);
    expect(await s.costSince(150)).toBe(1.5);
  });

  it('fires due timers', async () => {
    const s = store();
    await s.putTimer({ key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 500 });
    expect(await s.dueTimers(499)).toEqual([]);
    expect(await s.dueTimers(500)).toHaveLength(1);
    await s.deleteTimer('REL-1:dev-feedback');
    expect(await s.dueTimers(1000)).toEqual([]);
    await s.putTimer({ key: 'REL-2:x', projectId: 'p', ticketId: 'REL-2', job: 'x', fireAt: 9e12 });
    await s.deleteTimersFor('p', 'REL-2');
    expect(await s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('orders the queue by priority then age, dedupes by ticket+job', async () => {
    const s = store();
    await s.enqueue(q({ ticketId: 'A', priority: 0, enqueuedAt: 1 }));
    await s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 2 }));
    await s.enqueue(q({ ticketId: 'C', priority: 1, enqueuedAt: 3 }));
    await s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 9 }));
    expect(await s.listQueue()).toHaveLength(3);
    expect((await s.dequeue('dev'))!.ticketId).toBe('C');
    expect((await s.dequeue('dev'))!.ticketId).toBe('B');
    expect((await s.dequeue('dev'))!.ticketId).toBe('A');
    expect(await s.dequeue('dev')).toBeUndefined();
  });

  it('expires echoes and keeps meta', async () => {
    const s = store();
    await s.putEcho('state:REL-1:Done', 100);
    expect(await s.isEcho('state:REL-1:Done', 99)).toBe(true);
    expect(await s.isEcho('state:REL-1:Done', 101)).toBe(false);
    await s.setMeta('paused', '1');
    expect(await s.getMeta('paused')).toBe('1');
  });
});
