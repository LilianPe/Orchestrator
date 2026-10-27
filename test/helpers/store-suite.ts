import { expect, it } from 'vitest';
import { newTicketState, type FactoryEvent, type TicketState } from '../../src/core/types.js';
import type { DecisionPlan, DecisionRequest, QueueItem, RunRecord, Store, WorkflowVersion } from '../../src/store/types.js';

function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'running',
    claudeSessionId: 'c1', startedAt: 100, costUsd: 0, turns: 0, lastText: '', token: 't1', cwd: '/tmp', ...patch,
  };
}

const WF: WorkflowVersion = { hash: 'h1', definition: { version: 1, name: 'v1' } };

const delegatedEvent = (id: string, ticketId = 'REL-1', at = 10): FactoryEvent =>
  ({ id, type: 'ticket.delegated', at, projectId: 'p', ticketId, payload: { linearSessionId: 'ls-1' } }) as FactoryEvent;

type Seen = { ticket?: TicketState; workflow?: WorkflowVersion };

/** A decision that creates or touches the ticket, with two effects and a timer. */
function request(event: FactoryEvent, patch: Partial<DecisionPlan> = {}, workflow = WF): DecisionRequest & { seen: Seen } {
  const seen: Seen = {};
  return {
    event,
    workflow,
    seen,
    decide: (ticket, wf) => {
      seen.ticket = ticket;
      seen.workflow = wf;
      const base = ticket ?? newTicketState('p', event.ticketId!, 'T', 'todo', 1);
      return {
        ticket: { ...base, title: `${base.title}+`, workflowHash: wf.hash },
        effects: [
          { kind: 'comment', body: `on ${event.id}` },
          { kind: 'labels', add: ['x'], remove: [] },
        ],
        timers: [{ key: `${event.ticketId}:dev`, projectId: 'p', ticketId: event.ticketId!, job: 'dev', fireAt: 900, armedBy: event.id }],
        clearTimers: false,
        ...patch,
      };
    },
  };
}

function q(patch: Partial<QueueItem>): QueueItem {
  return { projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', priority: 0, enqueuedAt: 1, ...patch };
}

/**
 * The `Store` contract both stores pass (ORC-132): the six SQLite store cases, run on any
 * implementation. `store()` returns an empty store.
 */
export function storeContract(store: () => Store | Promise<Store>): void {
  it('round-trips tickets', async () => {
    const s = await store();
    const t = { ...newTicketState('p', 'REL-1', 'T', 'todo', 1), pendingFeedback: [{ author: 'a', body: 'b', at: 2, source: 'session' as const }] };
    await s.putTicket(t);
    expect(await s.getTicket('p', 'REL-1')).toEqual(t);
    expect(await s.getTicket('other', 'REL-1')).toBeUndefined();
    expect(await s.listTickets()).toHaveLength(1);
  });

  it('dedupes events by id and lists recent ones, newest first', async () => {
    const s = await store();
    const e = { id: 'e1', type: 'control.pause', at: 5, projectId: 'p', payload: {} } as FactoryEvent;
    const later = { id: 'e2', type: 'control.resume', at: 6, projectId: 'p', payload: {} } as FactoryEvent;
    expect(await s.recordEvent(e)).toBe(true);
    expect(await s.recordEvent(e)).toBe(false);
    expect(await s.recordEvent(later)).toBe(true);
    expect(await s.recentEvents(10)).toEqual([later, e]);
  });

  it('stores runs and finds them by token and status', async () => {
    const s = await store();
    await s.putRun(run());
    await s.putRun(run({ id: 'r2', token: 't2', status: 'success', costUsd: 1.5, startedAt: 200 }));
    expect((await s.findRunByToken('t2'))!.id).toBe('r2');
    expect((await s.runsByStatus('running')).map((r) => r.id)).toEqual(['r1']);
    expect(await s.costSince(150)).toBe(1.5);
  });

  it('fires due timers', async () => {
    const s = await store();
    await s.putTimer({ key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 500 });
    expect(await s.dueTimers(499)).toEqual([]);
    expect(await s.dueTimers(500)).toHaveLength(1);
    await s.deleteTimer('REL-1:dev-feedback');
    expect(await s.dueTimers(1000)).toEqual([]);
    await s.putTimer({ key: 'REL-2:x', projectId: 'p', ticketId: 'REL-2', job: 'x', fireAt: 9e12 });
    await s.deleteTimersFor('p', 'REL-2');
    expect(await s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('keeps a due timer until it is deleted, and a re-armed timer when deleting the old firing', async () => {
    const s = await store();
    const timer = { key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 500 };
    await s.putTimer(timer);
    expect(await s.dueTimers(600)).toEqual([timer]);
    expect(await s.dueTimers(600)).toEqual([timer]);
    await s.putTimer({ ...timer, fireAt: 900 });
    await s.deleteTimer(timer.key, 500);
    expect(await s.dueTimers(1000)).toEqual([{ ...timer, fireAt: 900 }]);
    await s.deleteTimer(timer.key, 900);
    expect(await s.dueTimers(1000)).toEqual([]);
  });

  it("removes a ticket's queued runs, of one queue or of all (ORC-268)", async () => {
    const s = await store();
    await s.enqueue(q({ ticketId: 'A', job: 'dev', queue: 'dev' }));
    await s.enqueue(q({ ticketId: 'A', job: 'ask', queue: 'questions' }));
    await s.enqueue(q({ ticketId: 'B', job: 'dev', queue: 'dev' }));
    await s.removeFromQueue('p', 'A', 'dev');
    expect((await s.listQueue()).map((i) => `${i.ticketId}:${i.job}`).sort()).toEqual(['A:ask', 'B:dev']);
    await s.removeFromQueue('p', 'A');
    expect((await s.listQueue()).map((i) => `${i.ticketId}:${i.job}`)).toEqual(['B:dev']);
  });

  it('orders the queue by priority then age, dedupes by ticket+job, and hands an item out once', async () => {
    const s = await store();
    await s.enqueue(q({ ticketId: 'A', priority: 0, enqueuedAt: 1 }));
    await s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 2 }));
    await s.enqueue(q({ ticketId: 'C', priority: 1, enqueuedAt: 3 }));
    await s.enqueue(q({ ticketId: 'D', priority: 3, enqueuedAt: 4 }));
    await s.enqueue(q({ ticketId: 'B', priority: 3, enqueuedAt: 9 }));
    expect((await s.listQueue()).map((i) => i.ticketId)).toEqual(['C', 'B', 'D', 'A']);
    const claims = [];
    for (const expected of ['C', 'B', 'D', 'A']) {
      const claim = (await s.claimQueued('dev', 60_000))!;
      expect(claim.item.ticketId).toBe(expected);
      claims.push(claim);
    }
    expect(await s.claimQueued('dev', 60_000)).toBeUndefined();
    expect(await s.claimQueued('questions', 60_000)).toBeUndefined();
    expect(await s.listQueue()).toEqual([]);
    // Released, an item is back at its place; finished, it is gone.
    expect(await s.releaseQueued(claims[1]!)).toBe(true);
    expect((await s.listQueue()).map((i) => i.ticketId)).toEqual(['B']);
    for (const c of [claims[0]!, claims[2]!, claims[3]!]) expect(await s.finishQueued(c)).toBe(true);
    expect(await s.finishQueued(claims[0]!)).toBe(false);
    expect((await s.claimQueued('dev', 60_000))!.item.ticketId).toBe('B');
  });

  it('keeps a request queued while the same ticket+job is handed out: finishing the claim leaves it (ORC-150)', async () => {
    const s = await store();
    await s.enqueue(q({ ticketId: 'A', enqueuedAt: 1 }));
    const claim = (await s.claimQueued('dev', 60_000))!;
    await s.enqueue(q({ ticketId: 'A', enqueuedAt: 5, inputText: 'newer' }));
    await s.finishQueued(claim);
    expect((await s.listQueue()).map((i) => [i.ticketId, i.inputText])).toEqual([['A', 'newer']]);
  });

  it('keeps inbox events in arrival order until processed, and dedups them by id (ORC-147)', async () => {
    const s = await store();
    const ev = (id: string, type = 'control.pause') => ({ id, type, at: 5, projectId: '*', payload: {} }) as FactoryEvent;
    // Same millisecond, ids out of alphabetical order: the arrival order still wins.
    expect(await s.appendInbox(ev('b'))).toBe(true);
    expect(await s.appendInbox(ev('a', 'control.resume'))).toBe(true);
    expect(await s.appendInbox(ev('c'))).toBe(true);
    expect(await s.appendInbox(ev('b'))).toBe(false);
    expect(await s.pendingInbox(10)).toEqual([ev('b'), ev('a', 'control.resume'), ev('c')]);
    expect((await s.pendingInbox(1)).map((e) => e.id)).toEqual(['b']);
    expect((await s.pendingInbox(10, ['a'])).map((e) => e.id)).toEqual(['b', 'c']);
    expect((await s.pendingInbox(1, ['b'])).map((e) => e.id)).toEqual(['a']);
    await s.markInboxProcessed('b');
    expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['a', 'c']);
    // Processed is still known: a replay of the same id is a duplicate.
    expect(await s.appendInbox(ev('b'))).toBe(false);
    expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('journals an event already in the inbox once, and leaves its inbox row to markInboxProcessed', async () => {
    const s = await store();
    const e = { id: 'e1', type: 'control.pause', at: 5, projectId: 'p', payload: {} } as FactoryEvent;
    expect(await s.appendInbox(e)).toBe(true);
    expect(await s.recordEvent(e)).toBe(true);
    expect(await s.recordEvent(e)).toBe(false);
    expect(await s.recentEvents(10)).toEqual([e]);
    expect((await s.pendingInbox(10)).map((x) => x.id)).toEqual(['e1']);
    await s.markInboxProcessed('e1');
    expect(await s.pendingInbox(10)).toEqual([]);
  });

  it('expires echoes and keeps meta', async () => {
    const s = await store();
    await s.putEcho('state:REL-1:Done', 100);
    expect(await s.isEcho('state:REL-1:Done', 99)).toBe(true);
    expect(await s.isEcho('state:REL-1:Done', 101)).toBe(false);
    await s.setMeta('paused', '1');
    expect(await s.getMeta('paused')).toBe('1');
  });

  it('decides an inbox row in one transaction: journal, projection, timers, outbox ticket:seq:i, inbox mark (ORC-149)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    const outcome = await s.decide(request(delegatedEvent('e1')));
    expect(outcome).toMatchObject({ status: 'committed', seq: 1, effectIds: ['REL-1:1:1', 'REL-1:1:2'], known: undefined });
    expect(await s.recentEvents(10, 'REL-1')).toEqual([delegatedEvent('e1')]);
    expect(await s.getTicket('p', 'REL-1')).toMatchObject({ title: 'T+', workflowHash: 'h1' });
    // Armed, but not due before the effects of its decision have run.
    expect(await s.dueTimers(1000)).toEqual([]);
    expect((await s.listEffects('p', 'REL-1')).map((r) => [r.id, r.seq, r.i, r.effect.kind, r.status, r.eventId])).toEqual([
      ['REL-1:1:1', 1, 1, 'comment', 'pending', 'e1'],
      ['REL-1:1:2', 1, 2, 'labels', 'pending', 'e1'],
    ]);
    expect(await s.pendingInbox(10)).toEqual([]);
    expect(await s.getWorkflowVersion('h1')).toEqual(WF);

    // The next event of the ticket waits for the effects of this one.
    await s.appendInbox(delegatedEvent('e2'));
    expect(await s.decide(request(delegatedEvent('e2')))).toMatchObject({ status: 'waiting' });
    for (let k = 0; k < 2; k++) {
      const row = await s.claimEffect('p', 'REL-1', 60_000);
      if (typeof row !== 'object') throw new Error('expected a claimed row');
      expect(await s.completeEffect(row.id, row.lease)).toBe(true);
    }
    expect(await s.dueTimers(1000)).toEqual([{ key: 'REL-1:dev', projectId: 'p', ticketId: 'REL-1', job: 'dev', fireAt: 900, armedBy: 'e1' }]);
    const second = request(delegatedEvent('e2'));
    expect(await s.decide(second)).toMatchObject({ status: 'committed', seq: 2, effectIds: ['REL-1:2:1', 'REL-1:2:2'] });
    expect(second.seen.ticket).toMatchObject({ title: 'T+' });
    // A row already processed is not decided again.
    expect(await s.decide(request(delegatedEvent('e2')))).toEqual({ status: 'processed' });
  });

  it('writes nothing when the decision throws before the commit (ORC-149)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    const boom: DecisionRequest = {
      ...request(delegatedEvent('e1')),
      decide: () => {
        throw new Error('decide failed');
      },
    };
    await expect(s.decide(boom)).rejects.toThrow('decide failed');
    expect(await s.recentEvents(10)).toEqual([]);
    expect(await s.getTicket('p', 'REL-1')).toBeUndefined();
    expect(await s.listEffects('p', 'REL-1')).toEqual([]);
    expect(await s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['e1']);
    // A later try commits all of it.
    expect(await s.decide(request(delegatedEvent('e1')))).toMatchObject({ status: 'committed', seq: 1 });
  });

  it('decides the rows of a ticket in arrival order, other tickets aside, and marks a journaled one as a duplicate (ORC-149)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('a1', 'REL-1'));
    await s.appendInbox(delegatedEvent('b1', 'REL-2'));
    await s.appendInbox(delegatedEvent('a2', 'REL-1'));
    expect(await s.decide(request(delegatedEvent('a2', 'REL-1'), { effects: [] }))).toEqual({ status: 'waiting', reason: 'a1 comes first' });
    expect(await s.decide(request(delegatedEvent('b1', 'REL-2'), { effects: [] }))).toMatchObject({ status: 'committed', seq: 1 });
    expect(await s.recordEvent(delegatedEvent('a1', 'REL-1'))).toBe(true);
    expect(await s.decide(request(delegatedEvent('a1', 'REL-1')))).toEqual({ status: 'duplicate' });
    expect(await s.listEffects('p', 'REL-1')).toEqual([]);
    expect(await s.decide(request(delegatedEvent('a2', 'REL-1'), { effects: [] }))).toMatchObject({ status: 'committed', seq: 2 });
    expect(await s.pendingInbox(10)).toEqual([]);
  });

  it('keeps a ticket on the workflow version of its first decision (ORC-149)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1'), { effects: [] }));
    const v2: WorkflowVersion = { hash: 'h2', definition: { version: 1, name: 'v2' } };
    await s.appendInbox(delegatedEvent('e2'));
    const next = request(delegatedEvent('e2'), { effects: [] }, v2);
    await s.decide(next);
    expect(next.seen.workflow).toEqual(WF);
    expect(await s.getTicket('p', 'REL-1')).toMatchObject({ workflowHash: 'h1' });
    // A new ticket starts on the version of now.
    await s.appendInbox(delegatedEvent('f1', 'REL-2'));
    const fresh = request(delegatedEvent('f1', 'REL-2'), { effects: [] }, v2);
    await s.decide(fresh);
    expect(fresh.seen.workflow).toEqual(v2);
    expect(await s.getWorkflowVersion('h2')).toEqual(v2);
  });

  it('deletes the timers armed by an event, and those of a ticket (ORC-149)', async () => {
    const s = await store();
    await s.putTimer({ key: 'REL-1:a', projectId: 'p', ticketId: 'REL-1', job: 'a', fireAt: 1, armedBy: 'e1' });
    await s.putTimer({ key: 'REL-1:b', projectId: 'p', ticketId: 'REL-1', job: 'b', fireAt: 1, armedBy: 'e2' });
    await s.putTimer({ key: 'REL-2:c', projectId: 'p', ticketId: 'REL-2', job: 'c', fireAt: 1 });
    await s.deleteTimersArmedBy('e1');
    expect((await s.dueTimers(10)).map((t) => t.key)).toEqual(['REL-1:b', 'REL-2:c']);
    await s.deleteTimersFor('p', 'REL-1');
    expect((await s.dueTimers(10)).map((t) => t.key)).toEqual(['REL-2:c']);
  });

  it('clears the ticket timers before arming the decision ones when asked (a stop, ORC-149)', async () => {
    const s = await store();
    await s.putTimer({ key: 'REL-1:old', projectId: 'p', ticketId: 'REL-1', job: 'old', fireAt: 500 });
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1'), { effects: [], clearTimers: true }));
    expect((await s.dueTimers(Number.MAX_SAFE_INTEGER)).map((t) => t.key)).toEqual(['REL-1:dev']);
  });

  it('hands out the effects of a ticket in order, one at a time, under a lease (ORC-149)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1')));
    expect(await s.effectTickets()).toEqual([{ projectId: 'p', ticketId: 'REL-1' }]);
    const first = await s.claimEffect('p', 'REL-1', 60_000);
    expect(first).toMatchObject({ id: 'REL-1:1:1', status: 'running', effect: { kind: 'comment', body: 'on e1' }, lease: expect.any(String) });
    // The first row runs under a live lease: nobody else takes the ticket's effects.
    expect(await s.claimEffect('p', 'REL-1', 60_000)).toBe('busy');
    expect(await s.effectTickets()).toEqual([]);
    expect(await s.completeEffect('REL-1:1:1', (first as { lease: string }).lease)).toBe(true);
    const lost = await s.claimEffect('p', 'REL-1', -1_000);
    expect(lost).toMatchObject({ id: 'REL-1:1:2' });
    // Its lease is already over: the row is claimable again, by anyone (its worker died).
    expect(await s.effectTickets()).toEqual([{ projectId: 'p', ticketId: 'REL-1' }]);
    const taken = await s.claimEffect('p', 'REL-1', 60_000);
    expect(taken).toMatchObject({ id: 'REL-1:1:2' });
    const [oldLease, newLease] = [(lost as { lease: string }).lease, (taken as { lease: string }).lease];
    expect(newLease).not.toBe(oldLease);
    // The worker that lost the lease can neither renew nor settle the row its new holder runs.
    expect(await s.renewEffect('REL-1:1:2', oldLease, 60_000)).toBe(false);
    expect(await s.completeEffect('REL-1:1:2', oldLease)).toBe(false);
    expect(await s.failEffect('REL-1:1:2', oldLease, 'boom')).toBe(false);
    expect(await s.retryEffect('REL-1:1:2', oldLease, 'boom', 0)).toBe(false);
    expect((await s.listEffects('p', 'REL-1')).map((r) => r.status)).toEqual(['done', 'running']);
    expect(await s.renewEffect('REL-1:1:2', newLease, 60_000)).toBe(true);
    expect(await s.failEffect('REL-1:1:2', newLease, 'boom')).toBe(true);
    // A settled row is settled once.
    expect(await s.completeEffect('REL-1:1:2', newLease)).toBe(false);
    expect(await s.claimEffect('p', 'REL-1', 60_000)).toBeUndefined();
    expect((await s.listEffects('p', 'REL-1')).map((r) => [r.status, r.attempts])).toEqual([
      ['done', 1],
      ['dead', 2],
    ]);
  });

  it('lists a handed-out queue item again once its lease expired, and removes handed-out items of a stopped ticket (ORC-150)', async () => {
    const s = await store();
    await s.enqueue(q({ ticketId: 'A' }));
    await s.enqueue(q({ ticketId: 'B', enqueuedAt: 2 }));
    // A's holder died: its lease is over, the item is in line again.
    expect(await s.claimQueued('dev', -1)).toMatchObject({ item: { ticketId: 'A' } });
    expect((await s.listQueue()).map((i) => i.ticketId)).toEqual(['A', 'B']);
    expect((await s.listQueue())[0]).not.toHaveProperty('lease');
    // B is being started when its ticket is stopped: gone, and its claim cannot put it back.
    const a = (await s.claimQueued('dev', 60_000))!;
    const b = (await s.claimQueued('dev', 60_000))!;
    expect([a.item.ticketId, b.item.ticketId]).toEqual(['A', 'B']);
    await s.removeFromQueue('p', 'B');
    expect(await s.releaseQueued(b)).toBe(false);
    expect(await s.releaseQueued(a)).toBe(true);
    expect((await s.listQueue()).map((i) => i.ticketId)).toEqual(['A']);
  });

  it('lets a stop of the ticket\'s work pass effects held back by their backoff, and cancels them (ORC-150)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1')));
    const row = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof row !== 'object') throw new Error('expected a claimed row');
    expect(await s.retryEffect(row.id, row.lease!, 'Linear down', 60_000)).toBe(true);
    await s.appendInbox(delegatedEvent('e2'));
    // Not a stop: it waits for the retry.
    expect(await s.decide(request(delegatedEvent('e2'), { effects: [] }))).toMatchObject({ status: 'waiting' });
    // A stop goes first: the held rows are cancelled, with no result to decide.
    expect(await s.decide(request(delegatedEvent('e2'), { effects: [{ kind: 'stop_run' }], clearTimers: true }))).toMatchObject({
      status: 'committed',
      preempted: ['REL-1:1:1', 'REL-1:1:2'],
    });
    expect((await s.listEffects('p', 'REL-1')).map((r) => [r.id, r.status])).toEqual([
      ['REL-1:1:1', 'failed'],
      ['REL-1:1:2', 'failed'],
      ['REL-1:2:1', 'pending'],
    ]);
    expect(await s.pendingInbox(10)).toEqual([]);
    // A running effect still holds a stop: it ends on its own.
    const stop = await s.claimEffect('p', 'REL-1', 60_000);
    expect(stop).toMatchObject({ id: 'REL-1:2:1' });
    await s.appendInbox(delegatedEvent('e3'));
    expect(await s.decide(request(delegatedEvent('e3'), { effects: [{ kind: 'stop_run' }], clearTimers: true }))).toMatchObject({ status: 'waiting' });
  });

  it('lets a stop pass the results of the earlier effects of a decision held by a backoff (ORC-150)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1')));
    const done = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof done !== 'object') throw new Error('expected a claimed row');
    expect(await s.completeEffect(done.id, done.lease)).toBe(true);
    const held = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof held !== 'object') throw new Error('expected a claimed row');
    expect(await s.retryEffect(held.id, held.lease!, 'Linear down', 60_000)).toBe(true);
    // effect:REL-1:1:1 is in the inbox ahead of the stop, and waits for the retry like any event.
    await s.appendInbox(delegatedEvent('e2'));
    expect(await s.decide(request(delegatedEvent('e2'), { effects: [] }))).toMatchObject({ status: 'waiting' });
    expect(await s.decide(request(delegatedEvent('e2'), { effects: [{ kind: 'stop_run' }], clearTimers: true }))).toMatchObject({
      status: 'committed',
      preempted: ['REL-1:1:2'],
    });
    expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['effect:REL-1:1:1']);
  });

  it('writes the result of a done effect to the inbox as effect:<id>, with its row, in one transaction (ORC-150)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1')));
    const row = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof row !== 'object') throw new Error('expected a claimed row');
    expect(row.attempts).toBe(1);
    expect(await s.completeEffect(row.id, row.lease)).toBe(true);
    expect(await s.pendingInbox(10)).toEqual([
      {
        id: 'effect:REL-1:1:1', type: 'effect.done', at: expect.any(Number), schemaVersion: 2, taint: 'trusted', projectId: 'p', ticketId: 'REL-1',
        payload: { effectId: 'REL-1:1:1', kind: 'comment', eventId: 'e1', attempts: 1 },
      },
    ]);
    // Settled once: no second result.
    expect(await s.completeEffect(row.id, row.lease)).toBe(false);
    expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['effect:REL-1:1:1']);
  });

  it("puts a failed effect back after its backoff, and the ticket's later rows behind it (ORC-150)", async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1')));
    const first = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof first !== 'object') throw new Error('expected a claimed row');
    // Due at once (a delay already over): claimable again, the attempt counted.
    expect(await s.retryEffect(first.id, first.lease!, 'Linear down', -1)).toBe(true);
    expect((await s.listEffects('p', 'REL-1'))[0]).toMatchObject({ status: 'pending', attempts: 1, error: 'Linear down' });
    expect(await s.effectTickets()).toEqual([{ projectId: 'p', ticketId: 'REL-1' }]);
    const again = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof again !== 'object') throw new Error('expected a claimed row');
    expect(again).toMatchObject({ id: 'REL-1:1:1', attempts: 2 });
    // Pending, but not before its retry: nobody claims it, nor the row behind it.
    expect(await s.retryEffect(again.id, again.lease!, 'Linear down', 60_000)).toBe(true);
    expect(await s.claimEffect('p', 'REL-1', 60_000)).toBe('busy');
    expect(await s.effectTickets()).toEqual([]);
    // A retry is no result: nothing in the inbox.
    expect(await s.pendingInbox(10)).toEqual([]);
  });

  it('lets a failed effect die in one transaction: rest of its decision skipped, its timers gone, effect:<id> in the inbox (ORC-150)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1'), {
      effects: [
        { kind: 'comment', body: 'a' },
        { kind: 'labels', add: ['x'], remove: [] },
        { kind: 'settle' },
      ],
    }));
    const row = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof row !== 'object') throw new Error('expected a claimed row');
    expect(await s.failEffect(row.id, row.lease!, 'Linear down')).toBe(true);
    expect((await s.listEffects('p', 'REL-1')).map((r) => [r.id, r.status])).toEqual([
      ['REL-1:1:1', 'dead'],
      ['REL-1:1:2', 'failed'],
      ['REL-1:1:3', 'pending'],
    ]);
    expect(await s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await s.pendingInbox(10)).toEqual([
      expect.objectContaining({
        id: 'effect:REL-1:1:1',
        type: 'effect.failed',
        payload: { effectId: 'REL-1:1:1', kind: 'comment', eventId: 'e1', attempts: 1, error: 'Linear down' },
      }),
    ]);
    // The settle row still runs.
    expect(await s.claimEffect('p', 'REL-1', 60_000)).toMatchObject({ id: 'REL-1:1:3' });
  });

  it('updates a ticket from its stored state, and leaves a missing one alone (ORC-149)', async () => {
    const s = await store();
    expect(await s.updateTicket('p', 'REL-1', (t) => ({ ...t, blocked: true }))).toBeUndefined();
    expect(await s.getTicket('p', 'REL-1')).toBeUndefined();
    await s.putTicket(newTicketState('p', 'REL-1', 'T', 'todo', 1));
    expect(await s.updateTicket('p', 'REL-1', (t) => ({ ...t, blocked: true }))).toMatchObject({ blocked: true });
    expect(await s.getTicket('p', 'REL-1')).toMatchObject({ blocked: true });
  });
}
