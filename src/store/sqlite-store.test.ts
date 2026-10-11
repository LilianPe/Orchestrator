import { describe, expect, it } from 'vitest';
import { newTicketState, type RelaisEvent } from '../core/types.js';
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
  it('round-trips tickets', () => {
    const s = store();
    const t = { ...newTicketState('p', 'REL-1', 'T', 'todo', 1), pendingFeedback: [{ author: 'a', body: 'b', at: 2, source: 'session' as const }] };
    s.putTicket(t);
    expect(s.getTicket('p', 'REL-1')).toEqual(t);
    expect(s.listTickets()).toHaveLength(1);
  });

  it('dedupes events by id and lists recent ones', () => {
    const s = store();
    const e = { id: 'e1', type: 'control.pause', at: 5, projectId: 'p', payload: {} } as RelaisEvent;
    expect(s.recordEvent(e)).toBe(true);
    expect(s.recordEvent(e)).toBe(false);
    expect(s.recentEvents(10)).toEqual([e]);
  });

  it('stores runs and finds them by token and status', () => {
    const s = store();
    s.putRun(run());
    s.putRun(run({ id: 'r2', token: 't2', status: 'success', costUsd: 1.5, startedAt: 200 }));
    expect(s.findRunByToken('t2')!.id).toBe('r2');
    expect(s.runsByStatus('running').map((r) => r.id)).toEqual(['r1']);
    expect(s.costSince(150)).toBe(1.5);
  });

  it('fires due timers', () => {
    const s = store();
    s.putTimer({ key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 500 });
    expect(s.dueTimers(499)).toEqual([]);
    expect(s.dueTimers(500)).toHaveLength(1);
    s.deleteTimer('REL-1:dev-feedback');
    expect(s.dueTimers(1000)).toEqual([]);
    s.putTimer({ key: 'REL-2:x', projectId: 'p', ticketId: 'REL-2', job: 'x', fireAt: 9e12 });
    s.deleteTimersFor('p', 'REL-2');
    expect(s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('orders the queue by priority then age, dedupes by ticket+job', () => {
    const s = store();
    s.enqueue(q({ ticketId: 'A', priority: 0, enqueuedAt: 1 }));
    s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 2 }));
    s.enqueue(q({ ticketId: 'C', priority: 1, enqueuedAt: 3 }));
    s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 9 }));
    expect(s.listQueue()).toHaveLength(3);
    expect(s.dequeue('dev')!.ticketId).toBe('C');
    expect(s.dequeue('dev')!.ticketId).toBe('B');
    expect(s.dequeue('dev')!.ticketId).toBe('A');
    expect(s.dequeue('dev')).toBeUndefined();
  });

  it('expires echoes and keeps meta', () => {
    const s = store();
    s.putEcho('state:REL-1:Done', 100);
    expect(s.isEcho('state:REL-1:Done', 99)).toBe(true);
    expect(s.isEcho('state:REL-1:Done', 101)).toBe(false);
    s.setMeta('paused', '1');
    expect(s.getMeta('paused')).toBe('1');
  });
});
