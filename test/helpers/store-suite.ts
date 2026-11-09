import { describe, expect, it } from 'vitest';
import type { AttemptLabels } from '../../src/core/attempt-labels.js';
import { newTicketState, TRUSTED, type FactoryEvent, type TicketState } from '../../src/core/types.js';
import type { Baseline, BaselineValue } from '../../src/core/baseline.js';
import { PAUSE_ACCEPTED, TicketHeldError, timerEvent, type Artifact, type ChangelogEntry,type DecisionPlan, type KnownFlakyTest, type DecisionRequest, type QueueItem, type RunRecord, type SecurityLog, type Store, type TimerRecord, type WorkflowVersion } from '../../src/store/types.js';

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
        timers: [{ key: `${event.ticketId}:dev`, projectId: 'p', ticketId: event.ticketId!, kind: 'debounce', payload: { job: 'dev' }, fireAt: 900, armedBy: event.id }],
        clearTimers: false,
        ...patch,
      };
    },
  };
}

/** A labelled attempt as the orchestrator would store it (ORC-226). */
export const LABELS: AttemptLabels = {
  task: 'dev',
  queue: 'dev',
  model: 'opus',
  factoryVersion: '0.1.0',
  factoryCommit: 'abc123',
  effort: null,
  image: null,
  risk: null,
  registryCommit: null,
  deliveredFactIds: null,
  fingerprints: {
    prompt: `sha256:${'1'.repeat(64)}`,
    promptTemplate: `sha256:${'5'.repeat(64)}`,
    skills: `sha256:${'2'.repeat(64)}`,
    workflow: `sha256:${'3'.repeat(64)}`,
    config: `sha256:${'4'.repeat(64)}`,
    knowledgeIndex: null,
  },
};

/** Decides one event of a ticket whose decision applies `patch` to it, at `at`, without an effect: the next one need not wait. */
async function decideTicket(s: Store, id: string, ticketId: string, at: number, patch: Partial<TicketState>): Promise<void> {
  const event = delegatedEvent(id, ticketId, at);
  await s.appendInbox(event);
  const out = await s.decide({
    event,
    workflow: WF,
    decide: (t) => ({ ticket: { ...(t ?? newTicketState('p', ticketId, 'T', 'todo', 1)), ...patch, updatedAt: at }, effects: [], timers: [], clearTimers: false, at }),
  });
  if (out.status !== 'committed') throw new Error(`expected ${id} committed`);
}

function q(patch: Partial<QueueItem>): QueueItem {
  return { projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', priority: 0, enqueuedAt: 1, ...patch };
}

/**
 * The `Store` contract both stores pass (ORC-132): the SQLite store cases, run on any
 * implementation. `store()` returns an empty store.
 */
export function storeContract(store: () => Store | Promise<Store>): void {
  it('round-trips tickets', async () => {
    const s = await store();
    const t = { ...newTicketState('p', 'REL-1', 'T', 'todo', 1), humanInbox: [{ author: 'a', body: 'b', at: 2, source: 'session' as const }] };
    await s.putTicket(t);
    expect(await s.getTicket('p', 'REL-1')).toEqual(t);
    expect(await s.getTicket('other', 'REL-1')).toBeUndefined();
    expect(await s.listTickets()).toHaveLength(1);
  });

  it('keeps the run boundary of a ticket as written: a risk and a visual proof set to null by a new run (ORC-365)', async () => {
    const s = await store();
    const assessed = { ...newTicketState('p', 'REL-1', 'T', 'todo', 1), risk: 'high' as const, visualProof: 'required' as const };
    await s.putTicket(assessed);
    expect(await s.getTicket('p', 'REL-1')).toEqual(assessed);
    const boundary = { ...assessed, risk: null, visualProof: null };
    await s.putTicket(boundary);
    expect(await s.getTicket('p', 'REL-1')).toEqual(boundary);
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

  it('renews the lease of a running attempt, and of no other (ORC-220)', async () => {
    const s = await store();
    await s.putRun(run({ leaseUntil: 1_000 }));
    await s.putRun(run({ id: 'r2', token: 't2', status: 'success', leaseUntil: 1_000 }));
    await s.renewRun('r1', 2_000);
    await s.renewRun('r2', 2_000);
    await s.renewRun('none', 2_000);
    expect((await s.getRun('r1'))!.leaseUntil).toBe(2_000);
    expect((await s.getRun('r2'))!.leaseUntil).toBe(1_000);
    // The record stays whole: the lease is a field of it.
    expect((await s.findRunByToken((await s.getRun('r1'))!.token))!.id).toBe('r1');
  });

  it('fences an attempt by its lease token: once taken over, the old holder can neither renew nor record it (ORC-344)', async () => {
    const s = await store();
    await s.putRun(run({ leaseToken: 1, leaseUntil: 1_000 }));
    expect(await s.renewRun('r1', 2_000, 1)).toBe(true);
    // Another daemon takes it over: the token goes up, once, whoever else tries with the same one.
    expect(await s.claimRun('r1', 1)).toBe(2);
    expect(await s.claimRun('r1', 1)).toBeUndefined();
    expect((await s.getRun('r1'))!.leaseToken).toBe(2);
    expect(await s.renewRun('r1', 3_000, 1)).toBe(false);
    expect(await s.putRun(run({ leaseToken: 1, status: 'success', lastText: 'late' }), 1)).toBe(false);
    expect(await s.getRun('r1')).toMatchObject({ status: 'running', leaseUntil: 2_000, leaseToken: 2, lastText: '' });
    // Its new holder writes as usual.
    expect(await s.renewRun('r1', 3_000, 2)).toBe(true);
    expect(await s.putRun(run({ leaseToken: 2, leaseUntil: 3_000, status: 'failure' }), 2)).toBe(true);
    expect(await s.getRun('r1')).toMatchObject({ status: 'failure', leaseToken: 2 });
    // An ended attempt is no longer taken over, nor renewed.
    expect(await s.claimRun('r1', 2)).toBeUndefined();
    expect(await s.renewRun('r1', 4_000, 2)).toBe(false);
  });

  it('takes a record written before the lease tokens for token 0 (ORC-344)', async () => {
    const s = await store();
    await s.putRun(run({ leaseUntil: 1_000 }));
    expect(await s.renewRun('r1', 2_000, 0)).toBe(true);
    expect(await s.claimRun('r1', 0)).toBe(1);
    expect(await s.putRun(run({ status: 'success' }), 0)).toBe(false);
    expect((await s.getRun('r1'))!.status).toBe('running');
  });

  it('stores runs and finds them by token and status', async () => {
    const s = await store();
    await s.putRun(run());
    await s.putRun(run({ id: 'r2', token: 't2', status: 'success', costUsd: 1.5, startedAt: 200 }));
    expect((await s.findRunByToken('t2'))!.id).toBe('r2');
    expect((await s.runsByStatus('running')).map((r) => r.id)).toEqual(['r1']);
    expect(await s.costSince(150)).toBe(1.5);
  });

  it('reads the runs of one ticket of one project, oldest first (ORC-196)', async () => {
    const s = await store();
    await s.putRun(run({ id: 'r2', token: 't2', startedAt: 200 }));
    await s.putRun(run());
    await s.putRun(run({ id: 'r3', token: 't3', ticketId: 'REL-2' }));
    await s.putRun(run({ id: 'r4', token: 't4', projectId: 'q' }));
    expect((await s.ticketRuns('p', 'REL-1')).map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('keeps every label of an attempt, as set when it was created (ORC-226)', async () => {
    const s = await store();
    await s.putRun(run({ labels: LABELS }));
    expect((await s.getRun('r1'))!.labels).toEqual(LABELS);

    const changed = { ...LABELS, model: 'other', fingerprints: { ...LABELS.fingerprints, prompt: 'sha256:changed' } };
    await s.putRun(run({ labels: changed, status: 'success', costUsd: 2, turns: 4 }));
    const after = (await s.getRun('r1'))!;
    expect(after).toMatchObject({ status: 'success', costUsd: 2, turns: 4 });
    expect(after.labels).toEqual(LABELS);
    expect((await s.findRunByToken('t1'))!.labels).toEqual(LABELS);
  });

  it('keeps the tokens an attempt reported (ORC-235)', async () => {
    const s = await store();
    const tokens = { input: 10, output: 20, cacheRead: 3_000_000_000, cacheCreation: 40 };
    await s.putRun(run());
    expect((await s.getRun('r1'))!.tokens).toBeUndefined();
    await s.putRun(run({ status: 'success', tokens }));
    expect((await s.getRun('r1'))!.tokens).toEqual(tokens);
  });

  it('tells whether the inbox holds an event id, processed or not (ORC-336)', async () => {
    const s = await store();
    expect(await s.inboxHas('e1')).toBe(false);
    await s.appendInbox(delegatedEvent('e1', 'REL-1', 10));
    expect(await s.inboxHas('e1')).toBe(true);
    await s.markInboxProcessed('e1');
    expect(await s.inboxHas('e1')).toBe(true);
    expect(await s.inboxHas('e2')).toBe(false);
  });

  it('records the last pause or resume written to the inbox, with its row (ORC-335)', async () => {
    const s = await store();
    const control = (id: string, type: 'control.pause' | 'control.resume') => ({ id, type, at: 10, projectId: '*', payload: {} }) as FactoryEvent;
    expect(await s.getMeta(PAUSE_ACCEPTED)).toBeUndefined();
    await s.appendInbox(control('g1', 'control.pause'));
    await s.appendInbox(delegatedEvent('e1'));
    expect(await s.getMeta(PAUSE_ACCEPTED)).toBe('1');
    await s.appendInbox(control('g2', 'control.resume'));
    expect(await s.getMeta(PAUSE_ACCEPTED)).toBe('0');
    // A pause written again is a duplicate: it changes nothing.
    expect(await s.appendInbox(control('g1', 'control.pause'))).toBe(false);
    expect(await s.getMeta(PAUSE_ACCEPTED)).toBe('0');
  });

  it('keeps a delivery answered before the inbox until it is deleted, once, in the order received (ORC-336)', async () => {
    const s = await store();
    expect(await s.pendingDeliveries()).toEqual([]);
    expect(await s.receiveDelivery('activity:b', '{"raw":"2"}')).toBe(true);
    expect(await s.receiveDelivery('activity:a', '{"raw":"1"}')).toBe(true);
    expect(await s.receiveDelivery('activity:b', '{"raw":"other"}')).toBe(false);
    expect(await s.pendingDeliveries()).toEqual([{ key: 'activity:b', value: '{"raw":"2"}' }, { key: 'activity:a', value: '{"raw":"1"}' }]);
    await s.deleteDelivery('activity:b');
    expect(await s.pendingDeliveries()).toEqual([{ key: 'activity:a', value: '{"raw":"1"}' }]);
    expect(await s.receiveDelivery('activity:b', '{"raw":"again"}')).toBe(true);
    // Set aside: no longer pending, its value kept for an operator; the key may be kept again.
    await s.asideDelivery('activity:a');
    expect(await s.pendingDeliveries()).toEqual([{ key: 'activity:b', value: '{"raw":"again"}' }]);
    expect(await s.getMeta('delivery-aside:activity:a')).toBe('{"raw":"1"}');
    expect(await s.receiveDelivery('activity:a', '{"raw":"new"}')).toBe(true);
    await s.asideDelivery('activity:a');
    expect(await s.getMeta('delivery-aside:activity:a')).toBe('{"raw":"new"}');
    // The same delivery, same value, kept again once set aside: kept, beside the row set aside.
    expect(await s.receiveDelivery('activity:a', '{"raw":"new"}')).toBe(true);
    expect(await s.pendingDeliveries()).toContainEqual({ key: 'activity:a', value: '{"raw":"new"}' });
    expect(await s.getMeta('delivery:activity:a')).toBe('{"raw":"new"}');
  });

  it("gathers a ticket's measure facts: journal in order, its attempts, its outbox, the first ack of its events (ORC-235)", async () => {
    const s = await store();
    expect(await s.measureFacts('p', 'REL-1')).toEqual({ devSession: undefined, events: [], runs: [], effects: [], acks: {} });
    await s.appendInbox(delegatedEvent('e1', 'REL-1', 10));
    await s.appendInbox(delegatedEvent('e2', 'REL-1', 5));
    await s.appendInbox(delegatedEvent('o1', 'REL-2'));
    await s.markAcked('e1', 1_700_000_000_250);
    await s.markAcked('e1', 1_700_000_009_000);
    await s.markAcked('o1', 1_700_000_000_100);
    await s.decide(request(delegatedEvent('e1', 'REL-1', 10)));
    for (let k = 0; k < 2; k++) {
      const row = await s.claimEffect('p', 'REL-1', 60_000);
      if (typeof row !== 'object') throw new Error('expected a claimed row');
      await s.completeEffect(row.id, row.lease, 20);
    }
    // e2 is decided after e1, then the results of e1's effects: the journal keeps that order, not the order of `at`.
    await s.decide(request(delegatedEvent('e2', 'REL-1', 5), { effects: [] }));
    for (const e of await s.pendingInbox(10)) {
      if (e.ticketId !== 'REL-1') continue;
      await s.decide({ event: e as FactoryEvent, workflow: WF, decide: (t) => ({ ticket: t, effects: [], timers: [], clearTimers: false }) });
    }
    await s.putRun(run({ id: 'r2', token: 't2', startedAt: 300 }));
    await s.putRun(run());
    await s.putRun(run({ id: 'r3', token: 't3', ticketId: 'REL-2' }));
    await s.putRun(run({ id: 'r4', token: 't4', projectId: 'other' }));

    const facts = await s.measureFacts('p', 'REL-1');
    expect(facts.devSession).toBeUndefined();
    expect(facts.events.map((e) => e.id)).toEqual(['e1', 'e2', 'effect:REL-1:1:1', 'effect:REL-1:1:2']);
    expect(facts.runs.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(facts.effects.map((r) => [r.id, r.status])).toEqual([
      ['REL-1:1:1', 'done'],
      ['REL-1:1:2', 'done'],
    ]);
    expect(facts.acks).toEqual({ e1: 1_700_000_000_250 });
  });

  it('finds the ticket and PR a merge or head commit belongs to, from the journaled merges of the project (ORC-278)', async () => {
    const s = await store();
    const merge = (id: string, ticketId: string, payload: object, projectId = 'p'): FactoryEvent =>
      ({ ...TRUSTED, id, type: 'pr.merged', at: 10, projectId, ticketId, payload: { url: 'u', branch: 'b', ...payload } }) as FactoryEvent;
    const record = async (e: FactoryEvent) => {
      await s.appendInbox(e);
      await s.decide({ event: e, workflow: WF, decide: (t) => ({ ticket: t ?? newTicketState(e.projectId, e.ticketId!, 'T', 'done', 0), effects: [], timers: [], clearTimers: false }) });
    };
    await record(merge('m1', 'REL-1', { number: 3, mergeSha: 'aaa', headSha: 'bbb' }));
    await record(merge('m2', 'REL-2', { number: 4, headSha: 'ccc' }));
    await record(merge('m3', 'REL-9', { number: 9, mergeSha: 'ddd' }, 'other'));
    // Still in the inbox: not a merge the journal holds.
    await s.appendInbox(merge('m4', 'REL-4', { number: 5, mergeSha: 'eee' }));
    expect(await s.mergedPrOf('p', 'aaa')).toEqual({ ticketId: 'REL-1', number: 3 });
    expect(await s.mergedPrOf('p', 'bbb')).toEqual({ ticketId: 'REL-1', number: 3 });
    expect(await s.mergedPrOf('p', 'ccc')).toEqual({ ticketId: 'REL-2', number: 4 });
    expect(await s.mergedPrOf('p', 'ddd')).toBeUndefined();
    expect(await s.mergedPrOf('p', 'eee')).toBeUndefined();
    expect(await s.mergedPrOf('p', 'zzz')).toBeUndefined();
  });

  it('keeps an artifact once by its id, listed by ticket oldest first, with its hash (ORC-176)', async () => {
    const s = await store();
    const a: Artifact = { id: 'visual:r1:after:1280', ticketId: 'REL-1', attemptId: 'r1', kind: 'visual-proof', path: '/home/artifacts/REL-1/aa.png', sha256: 'a'.repeat(64), createdAt: 1_700_000_000_000 };
    expect(await s.artifacts('REL-1')).toEqual([]);
    expect(await s.putArtifact(a)).toBe(true);
    expect(await s.putArtifact({ ...a, path: '/elsewhere.png' })).toBe(false);
    await s.putArtifact({ ...a, id: 'visual:r1:before:1280', sha256: 'b'.repeat(64), createdAt: 1_700_000_000_001 });
    await s.putArtifact({ ...a, id: 'other', ticketId: 'REL-2' });
    expect(await s.artifacts('REL-1')).toEqual([a, { ...a, id: 'visual:r1:before:1280', sha256: 'b'.repeat(64), createdAt: 1_700_000_000_001 }]);
  });

  it('appends a changelog entry once by its id, never changes one, and lists those of a period most recent first (ORC-197)', async () => {
    const s = await store();
    const capture = { artifactId: 'visual:r1:after:1280', side: 'after' as const, sha: 'c'.repeat(40), width: 1280, sha256: 'a'.repeat(64) };
    const e: ChangelogEntry = {
      id: 'REL-1:7:2', projectId: 'p', ticketId: 'REL-1', title: 'Export CSV', summary: 'Audits export to CSV.', prNumber: 3, prUrl: 'https://gh/pr/3',
      mergeSha: 'm'.repeat(40), page: '/audits', paths: ['app/audits.tsx'], visualProof: { status: 'taken', captures: [capture] }, at: 1_700_000_000_000,
    };
    expect(await s.changelog(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await s.appendChangelog(e)).toBe(true);
    // Replayed, or the same id with other words: nothing written, the entry as it was.
    expect(await s.appendChangelog({ ...e, summary: 'rewritten', visualProof: { status: 'not_applicable' } })).toBe(false);
    const later: ChangelogEntry = { ...e, id: 'REL-2:4:1', ticketId: 'REL-2', prNumber: 4, paths: [], visualProof: { status: 'unavailable', reason: 'no browser' }, at: 1_700_000_000_005 };
    // No merge commit nor page: kept without them.
    const old: ChangelogEntry = { id: 'REL-3:1:1', projectId: 'q', ticketId: 'REL-3', title: 'Old', summary: 'Old', prNumber: 1, prUrl: 'https://gh/pr/1', paths: [], visualProof: { status: 'not_applicable' }, at: 1_600_000_000_000 };
    expect(await s.appendChangelog(later)).toBe(true);
    expect(await s.appendChangelog(old)).toBe(true);
    expect(await s.changelog(1_700_000_000_000, 1_800_000_000_000)).toEqual([later, e]);
    expect(await s.changelog(0, 1_700_000_000_000)).toEqual([old]);
    expect(await s.changelog(0, 1_800_000_000_000, 'q')).toEqual([old]);
    expect(await s.changelog(0, 1_800_000_000_000, 'p')).toEqual([later, e]);
  });

  it("keeps a project's known flaky tests, a human's list: replaced by test, listed oldest first, taken off (ORC-164)", async () => {
    const s = await store();
    const t: KnownFlakyTest = { projectId: 'p', test: 'src/a.test.ts > cart total', coversFrozen: false, reason: 'times out under load', addedBy: 'armand', addedAt: 1_700_000_000_000 };
    expect(await s.knownFlakyTests('p')).toEqual([]);
    await s.putKnownFlakyTest(t);
    await s.putKnownFlakyTest({ ...t, test: 'tests/t.py::test_it', addedAt: 1_700_000_000_002 });
    await s.putKnownFlakyTest({ ...t, projectId: 'other' });
    await s.putKnownFlakyTest({ ...t, coversFrozen: true, reason: 'still', addedAt: 1_700_000_000_001 });
    expect(await s.knownFlakyTests('p')).toEqual([{ ...t, coversFrozen: true, reason: 'still', addedAt: 1_700_000_000_001 }, { ...t, test: 'tests/t.py::test_it', addedAt: 1_700_000_000_002 }]);
    expect(await s.deleteKnownFlakyTest('p', t.test)).toBe(true);
    expect(await s.deleteKnownFlakyTest('p', t.test)).toBe(false);
    expect((await s.knownFlakyTests('p')).map((k) => k.test)).toEqual(['tests/t.py::test_it']);
    expect(await s.knownFlakyTests('other')).toEqual([{ ...t, projectId: 'other' }]);
  });

  it('keeps a baseline frozen, its rows all or none: the same period again only on replace, the last computed read back (ORC-230)', async () => {
    const s = await store();
    const v = (value: number | null, patch: Partial<BaselineValue> = {}): BaselineValue => ({ value, over: 4, leftOut: 1, noSource: false, ...patch });
    const first: Baseline = {
      projectId: 'p', since: 1_700_000_000_000, until: 1_707_776_000_000, computedAt: 1_710_000_000_000,
      measures: { delivered: v(3), lead_time: v(129_600_000.5), tokens_per_merged: v(null, { over: 0, leftOut: 3, noSource: true }), first_try: v(2 / 3) },
    };
    expect(await s.latestBaseline()).toBeNull();
    expect(await s.putBaseline(first, false)).toBe(true);
    expect(await s.latestBaseline()).toEqual(first);
    const again: Baseline = { ...first, computedAt: 1_710_000_000_001, measures: { delivered: v(1), lead_time: v(1) } };
    expect(await s.putBaseline(again, false)).toBe(false);
    expect(await s.latestBaseline()).toEqual(first);
    expect(await s.putBaseline(again, true)).toBe(true);
    expect(await s.latestBaseline()).toEqual(again);
    const other: Baseline = { ...first, since: 1_600_000_000_000, until: 1_607_776_000_000, computedAt: 1_710_000_000_002, measures: { delivered: v(5) } };
    expect(await s.putBaseline(other, false)).toBe(true);
    expect(await s.latestBaseline()).toEqual(other);
  });

  it("keeps a run's security log once, and counts hosts and rules over a period (ORC-296)", async () => {
    const s = await store();
    const egress = (at: number, host: string, ok = true) => ({ at, method: 'GET', host, ok, up: 1, down: 2 });
    const log: SecurityLog = {
      runId: 'r1', projectId: 'p', ticketId: 'REL-1', at: 500,
      egress: [egress(100, 'b.example'), egress(110, 'a.example', false), { at: 120, method: 'CONNECT', host: 'a.example', port: 22, ok: false, up: 0, down: 0 }, egress(130, 'b.example')],
      refusals: [{ at: 140, tool: 'Bash', rule: 'push-trunk' }],
      skipped: { egress: 1, refusals: 2 },
    };
    expect(await s.securityLog('r1')).toBeUndefined();
    expect(await s.putSecurityLog(log)).toBe(true);
    expect(await s.putSecurityLog({ ...log, egress: [], refusals: [] })).toBe(false);
    expect(await s.securityLog('r1')).toEqual(log);
    await s.putSecurityLog({
      runId: 'r2', projectId: 'p', ticketId: 'REL-2', at: 900, egress: [egress(800, 'a.example')],
      refusals: [{ at: 200, tool: 'Bash', rule: 'force-push' }, { at: 210, tool: 'WebSearch', rule: 'web-search' }, { at: 900, tool: 'Bash', rule: 'force-push' }],
      skipped: { egress: 0, refusals: 0 },
    });
    expect(await s.securityStats(0, 900)).toEqual({
      hosts: [
        { host: 'a.example', requests: 3, refused: 2 },
        { host: 'b.example', requests: 2, refused: 0 },
      ],
      rules: [
        { rule: 'force-push', refusals: 1 },
        { rule: 'push-trunk', refusals: 1 },
        { rule: 'web-search', refusals: 1 },
      ],
      runs: [
        { runId: 'r1', projectId: 'p', ticketId: 'REL-1', requests: 4, refused: 2, refusals: 1 },
        { runId: 'r2', projectId: 'p', ticketId: 'REL-2', requests: 1, refused: 0, refusals: 2 },
      ],
    });
    expect(await s.securityStats(115, 205)).toEqual({
      hosts: [{ host: 'a.example', requests: 1, refused: 1 }, { host: 'b.example', requests: 1, refused: 0 }],
      rules: [{ rule: 'force-push', refusals: 1 }, { rule: 'push-trunk', refusals: 1 }],
      runs: [
        { runId: 'r1', projectId: 'p', ticketId: 'REL-1', requests: 2, refused: 1, refusals: 1 },
        { runId: 'r2', projectId: 'p', ticketId: 'REL-2', requests: 0, refused: 0, refusals: 1 },
      ],
    });
  });

  it('counts each run of a period by what its log holds in it, the most refused first (ORC-300)', async () => {
    const s = await store();
    const egress = (at: number, host: string, ok = true) => ({ at, method: 'GET', host, ok, up: 0, down: 0 });
    const refusal = (at: number, rule: string) => ({ at, tool: 'Bash', rule, command: 'secret' });
    await s.putSecurityLog({ runId: 'quiet', projectId: 'p', ticketId: 'REL-1', at: 500, egress: [egress(100, 'a.example'), egress(110, 'a.example')], refusals: [], skipped: { egress: 0, refusals: 0 } });
    await s.putSecurityLog({ runId: 'loud', projectId: 'p', ticketId: 'REL-2', at: 500, egress: [egress(100, 'b.example', false), egress(900, 'b.example', false)], refusals: [refusal(120, 'force-push'), refusal(130, 'push')], skipped: { egress: 0, refusals: 0 } });
    await s.putSecurityLog({ runId: 'later', projectId: 'q', ticketId: 'REL-3', at: 2000, egress: [egress(1500, 'c.example', false)], refusals: [], skipped: { egress: 0, refusals: 0 } });
    expect((await s.securityStats(0, 900)).runs).toEqual([
      { runId: 'loud', projectId: 'p', ticketId: 'REL-2', requests: 1, refused: 1, refusals: 2 },
      { runId: 'quiet', projectId: 'p', ticketId: 'REL-1', requests: 2, refused: 0, refusals: 0 },
    ]);
    expect((await s.securityStats(900, 2000)).runs).toEqual([
      { runId: 'later', projectId: 'q', ticketId: 'REL-3', requests: 1, refused: 1, refusals: 0 },
      { runId: 'loud', projectId: 'p', ticketId: 'REL-2', requests: 1, refused: 1, refusals: 0 },
    ]);
    expect((await s.securityStats(3000, 4000)).runs).toEqual([]);
  });

  it('lists the moves into Blocked of a period, with their kind, not a block kept nor one outside it (ORC-300)', async () => {
    const s = await store();
    const decideAs = (id: string, ticketId: string, at: number, patch: Partial<TicketState>) => decideTicket(s, id, ticketId, at, patch);
    // Blocked at its first decision: a move into Blocked too.
    await decideAs('a1', 'REL-1', 100, { blocked: true, blockKind: 'red', blockReason: 'red' });
    // Still blocked: no new move.
    await decideAs('a2', 'REL-1', 150, { blocked: true, blockKind: 'red', blockReason: 'red again' });
    await decideAs('b1', 'REL-2', 110, {});
    await decideAs('b2', 'REL-2', 200, { blocked: true, blockKind: 'budget', blockReason: 'tokens' });
    await decideAs('b3', 'REL-2', 300, { blocked: false, blockKind: undefined });
    // Blocked again: a second move, and one without a kind (written before ORC-345): its kind got back from its reason.
    await decideAs('b4', 'REL-2', 400, { blocked: true, blockReason: 'Red not verified after 3 attempts' });
    await decideAs('c1', 'REL-3', 900, { blocked: true, blockKind: 'loop', blockReason: 'loop' });
    expect(await s.blocksEntered(0, 900)).toEqual([
      { projectId: 'p', ticketId: 'REL-1', at: 100, kind: 'red' },
      { projectId: 'p', ticketId: 'REL-2', at: 200, kind: 'budget' },
      { projectId: 'p', ticketId: 'REL-2', at: 400, kind: 'red' },
    ]);
    expect(await s.blocksEntered(150, 1000)).toEqual([
      { projectId: 'p', ticketId: 'REL-2', at: 200, kind: 'budget' },
      { projectId: 'p', ticketId: 'REL-2', at: 400, kind: 'red' },
      { projectId: 'p', ticketId: 'REL-3', at: 900, kind: 'loop' },
    ]);
  });

  it('lists the moves into Blocked made outside a decision too: a launch error, a refused pickup (ORC-300)', async () => {
    const s = await store();
    const blockOutside = (ticketId: string, at: number, kind: TicketState['blockKind']) =>
      s.updateTicket('p', ticketId, (t) => ({ ...t, blocked: true, blockKind: kind, blockReason: 'outside', updatedAt: at }));
    // Blocked between two decisions: the second one finds it blocked, the first left it free.
    await decideTicket(s, 'd1', 'REL-4', 100, {});
    await blockOutside('REL-4', 150, 'repo_config');
    await decideTicket(s, 'd2', 'REL-4', 200, {});
    // Blocked after its last decision, and still: the projection holds the move.
    await decideTicket(s, 'e1', 'REL-6', 100, {});
    await blockOutside('REL-6', 350, 'infra');
    // Never decided, blocked from the start (a pickup refused before any decision).
    await s.putTicket({ ...newTicketState('p', 'REL-5', 'T', 'todo', 300), blocked: true, blockKind: 'pickup', blockReason: 'refused' });
    // Blocked by a decision, then kept blocked: once, at its decision.
    await decideTicket(s, 'f1', 'REL-7', 120, { blocked: true, blockKind: 'loop', blockReason: 'loop' });
    expect(await s.blocksEntered(0, 1000)).toEqual([
      { projectId: 'p', ticketId: 'REL-7', at: 120, kind: 'loop' },
      { projectId: 'p', ticketId: 'REL-4', at: 150, kind: 'repo_config' },
      { projectId: 'p', ticketId: 'REL-5', at: 300, kind: 'pickup' },
      { projectId: 'p', ticketId: 'REL-6', at: 350, kind: 'infra' },
    ]);
    expect(await s.blocksEntered(160, 340)).toEqual([{ projectId: 'p', ticketId: 'REL-5', at: 300, kind: 'pickup' }]);
  });

  it("keeps no command, request path nor proxy's reason in a security log, even one handed them: the rule and the host only (ORC-296)", async () => {
    const s = await store();
    const log = {
      runId: 'r1', projectId: 'p', ticketId: 'REL-1', at: 500,
      egress: [{ at: 100, method: 'POST', host: 'api.example', path: '/bot1:s3cret/send', ok: false, reason: 'POST api.example/bot1:s3cret/send refused', up: 0, down: 0 }],
      refusals: [{ at: 140, tool: 'Bash', rule: 'push', command: 'git push https://x:ghp_s3cret@github.com/o/r' }],
      skipped: { egress: 0, refusals: 0 },
    };
    expect(await s.putSecurityLog(log)).toBe(true);
    const kept = await s.securityLog('r1');
    expect(kept).toEqual({
      ...log,
      egress: [{ at: 100, method: 'POST', host: 'api.example', ok: false, up: 0, down: 0 }],
      refusals: [{ at: 140, tool: 'Bash', rule: 'push' }],
    });
    expect(JSON.stringify(kept)).not.toContain('s3cret');
  });

  it("keeps each review lens's findings on a ticket's commit, the last run of a lens replacing its earlier one (ORC-183)", async () => {
    const s = await store();
    const f = (file: string, severity: 'blocking' | 'minor' | 'out_of_scope', patch: object = {}) => ({ file, line: 3, severity, explanation: `${file} e`, suggestion: '', ...patch });
    expect(await s.findingsOf('p', 'REL-1', 'sha1')).toEqual([]);
    await s.putFindings({ projectId: 'p', ticketId: 'REL-1', sha: 'sha1', lens: 'security', runId: 'r2', at: 200, findings: [f('b.ts', 'blocking', { fact: 'F-1' }), f('a.ts', 'minor', { suggestion: 'do x' })] });
    await s.putFindings({ projectId: 'p', ticketId: 'REL-1', sha: 'sha1', lens: 'correctness', runId: 'r1', at: 100, findings: [f('c.ts', 'out_of_scope')] });
    // Another commit, another ticket: not mixed in.
    await s.putFindings({ projectId: 'p', ticketId: 'REL-1', sha: 'sha0', lens: 'correctness', runId: 'r0', at: 50, findings: [f('old.ts', 'blocking')] });
    await s.putFindings({ projectId: 'p', ticketId: 'REL-2', sha: 'sha1', lens: 'correctness', runId: 'r9', at: 50, findings: [f('other.ts', 'blocking')] });
    // By lens, then in the order the lens gave them.
    expect(await s.findingsOf('p', 'REL-1', 'sha1')).toEqual([
      { ...f('c.ts', 'out_of_scope'), lens: 'correctness', runId: 'r1' },
      { ...f('b.ts', 'blocking', { fact: 'F-1' }), lens: 'security', runId: 'r2' },
      { ...f('a.ts', 'minor', { suggestion: 'do x' }), lens: 'security', runId: 'r2' },
    ]);
    // The lens run again on the same commit (a replay of its effect, a review asked again): its findings now, the other lens's kept.
    await s.putFindings({ projectId: 'p', ticketId: 'REL-1', sha: 'sha1', lens: 'security', runId: 'r3', at: 300, findings: [] });
    expect(await s.findingsOf('p', 'REL-1', 'sha1')).toEqual([{ ...f('c.ts', 'out_of_scope'), lens: 'correctness', runId: 'r1' }]);
    expect(await s.findingsOf('p', 'REL-1', 'sha0')).toHaveLength(1);
  });

  it('still reads a run stored without labels', async () => {
    const s = await store();
    await s.putRun(run());
    await s.putRun(run({ status: 'success' }));
    const r = (await s.getRun('r1'))!;
    expect(r.status).toBe('success');
    expect(r.labels).toBeUndefined();
  });

  it('fires due timers', async () => {
    const s = await store();
    const timer = { key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', kind: 'debounce' as const, payload: { job: 'dev-feedback' }, fireAt: 500 };
    await s.putTimer(timer);
    expect(await s.dueTimers(499)).toEqual([]);
    expect(await s.dueTimers(500)).toEqual([timer]);
    expect(await s.fireTimer(timer, 500)).toBe(true);
    expect(await s.dueTimers(1000)).toEqual([]);
    await s.putTimer({ key: 'REL-2:x', projectId: 'p', ticketId: 'REL-2', kind: 'debounce', payload: { job: 'x' }, fireAt: 9e12 });
    await s.deleteTimersFor('p', 'REL-2');
    expect(await s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('fires a timer in one go: its event in the inbox, the timer gone, and nothing on a second firing (ORC-161)', async () => {
    const s = await store();
    const timer = { key: 'REL-1:clarify', projectId: 'p', ticketId: 'REL-1', kind: 'clarify.remind' as const, payload: { linearSessionId: 'ls-2' }, fireAt: 500 };
    await s.putTimer(timer);
    // Read twice: reading changes nothing, the timer stays due until it is fired.
    expect(await s.dueTimers(600)).toEqual([timer]);
    expect(await s.dueTimers(600)).toEqual([timer]);
    const event = timerEvent(timer, 600);
    expect(event).toMatchObject({ id: 'timer:REL-1:clarify:500', type: 'timer.fired', at: 600, payload: { kind: 'clarify.remind', payload: { linearSessionId: 'ls-2' } } });
    expect(await s.fireTimer(timer, 600)).toBe(true);
    expect(await s.pendingInbox(10)).toEqual([event]);
    expect(await s.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
    // A pass that read the timer before it fired fires nothing more.
    expect(await s.fireTimer(timer, 600)).toBe(false);
    expect(await s.pendingInbox(10)).toEqual([event]);
  });

  it('fires only the timer as read: one pushed back or cleared meanwhile writes nothing (ORC-161)', async () => {
    const s = await store();
    const timer = { key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', kind: 'debounce' as const, payload: { job: 'dev-feedback' }, fireAt: 500 };
    await s.putTimer(timer);
    const [read] = await s.dueTimers(600);
    // Another reply pushes the debounce back between the read and the firing.
    await s.putTimer({ ...timer, fireAt: 900 });
    expect(await s.fireTimer(read!, 600)).toBe(false);
    expect(await s.pendingInbox(10)).toEqual([]);
    expect(await s.dueTimers(1000)).toEqual([{ ...timer, fireAt: 900 }]);
    // A stop clears it between the read and the firing.
    const [again] = await s.dueTimers(1000);
    await s.deleteTimersFor('p', 'REL-1');
    expect(await s.fireTimer(again!, 1000)).toBe(false);
    expect(await s.pendingInbox(10)).toEqual([]);
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

  it("gives a ticket's queued items, handed-out ones included, which the line no longer lists (ORC-339)", async () => {
    const s = await store();
    await s.enqueue(q({ ticketId: 'A', job: 'dev-feedback', queue: 'dev', input: 'feedback', resume: true }));
    await s.enqueue(q({ ticketId: 'B', job: 'dev', queue: 'dev' }));
    const claim = await s.claimQueued('dev', 60_000);
    expect(claim?.item.ticketId).toBe('A');
    expect((await s.listQueue()).map((i) => i.ticketId)).toEqual(['B']);
    expect(await s.queuedItems('p', 'A')).toEqual([expect.objectContaining({ job: 'dev-feedback', input: 'feedback', resume: true })]);
    expect(await s.queuedItems('other', 'A')).toEqual([]);
    await s.finishQueued(claim!);
    expect(await s.queuedItems('p', 'A')).toEqual([]);
  });

  it('keeps the failed starts of an item put back in line on the item, and hands it out again only from its time on (ORC-339)', async () => {
    const s = await store();
    await s.enqueue(q({ ticketId: 'A' }));
    expect(await s.releaseQueued((await s.claimQueued('dev', 60_000))!, { failedStarts: 2, notBefore: Date.now() - 1 })).toBe(true);
    const again = await s.claimQueued('dev', 60_000);
    expect(again?.item.failedStarts).toBe(2);
    // Put back without a count: the one it has stays.
    expect(await s.releaseQueued(again!)).toBe(true);
    const third = await s.claimQueued('dev', 60_000);
    expect(third?.item.failedStarts).toBe(2);
    // Not before its time: no drain hands it out, and it is still the ticket's.
    expect(await s.releaseQueued(third!, { failedStarts: 3, notBefore: Date.now() + 60_000 })).toBe(true);
    expect(await s.claimQueued('dev', 60_000)).toBeUndefined();
    expect(await s.queuedItems('p', 'A')).toEqual([expect.objectContaining({ failedStarts: 3 })]);
  });

  it('keeps the order of arrival of items of one priority enqueued at the same instant (ORC-228)', async () => {
    const s = await store();
    // Ids that sort the other way as text.
    for (const ticketId of ['Z', 'M', 'A']) await s.enqueue(q({ ticketId, job: 'ask', queue: 'questions', enqueuedAt: 5 }));
    expect((await s.listQueue()).map((i) => i.ticketId)).toEqual(['Z', 'M', 'A']);
    const handed = [];
    for (let i = 0; i < 3; i++) handed.push((await s.claimQueued('questions', 60_000))!.item.ticketId);
    expect(handed).toEqual(['Z', 'M', 'A']);
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
    expect(await s.dueTimers(1000)).toEqual([{ key: 'REL-1:dev', projectId: 'p', ticketId: 'REL-1', kind: 'debounce', payload: { job: 'dev' }, fireAt: 900, armedBy: 'e1' }]);
    const second = request(delegatedEvent('e2'));
    expect(await s.decide(second)).toMatchObject({ status: 'committed', seq: 2, effectIds: ['REL-1:2:1', 'REL-1:2:2'] });
    expect(second.seen.ticket).toMatchObject({ title: 'T+' });
    // A row already processed is not decided again.
    expect(await s.decide(request(delegatedEvent('e2')))).toEqual({ status: 'processed' });
  });

  it('records each decision with its journal row, in its transaction: inputs and outputs, for replay (ORC-174)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.appendInbox(delegatedEvent('e2'));
    const first = await s.decide(request(delegatedEvent('e1'), { effects: [{ kind: 'comment', body: 'x' }], at: 500, trace: ['why'] }));
    if (first.status !== 'committed') throw new Error('expected a commit');
    // Journaled outside a decision (a legacy path): no decision to replay.
    expect(await s.recordEvent(delegatedEvent('legacy'))).toBe(true);
    const claimed = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof claimed !== 'object') throw new Error('expected a claimed row');
    await s.completeEffect(claimed.id, claimed.lease);
    const second = await s.decide(request(delegatedEvent('e2'), { effects: [], clearTimers: true }));
    if (second.status !== 'committed') throw new Error('expected a commit');
    // Another ticket's journal stays out.
    await s.appendInbox(delegatedEvent('o1', 'REL-2'));
    await s.decide(request(delegatedEvent('o1', 'REL-2')));

    const journal = await s.ticketJournal('p', 'REL-1');
    expect(journal.map((e) => [e.event.id, e.decision?.seq])).toEqual([['e1', 1], ['legacy', undefined], ['e2', second.seq]]);
    expect(journal[0]!.event).toEqual(delegatedEvent('e1'));
    expect(journal[0]!.decision).toEqual({
      eventId: 'e1',
      projectId: 'p',
      ticketId: 'REL-1',
      seq: 1,
      at: 500,
      workflowHash: 'h1',
      ticket: first.plan.ticket,
      effects: [{ kind: 'comment', body: 'x' }],
      timers: first.plan.timers,
      clearTimers: false,
      trace: ['why'],
    });
    expect(journal[2]!.decision).toMatchObject({ before: first.plan.ticket, ticket: second.plan.ticket, effects: [], clearTimers: true });
    expect(await s.ticketJournal('p', 'REL-9')).toEqual([]);
    expect(await s.ticketJournal('other', 'REL-1')).toEqual([]);
  });

  it('records the version a decision ran on even without a projection, and none for an unknown project (ORC-174)', async () => {
    const s = await store();
    // An event ignored before the ticket is tracked: its version is kept, its replay needs it.
    const h3: WorkflowVersion = { hash: 'h3', definition: { version: 1, name: 'v3' } };
    await s.appendInbox(delegatedEvent('n1', 'REL-3'));
    await s.decide(request(delegatedEvent('n1', 'REL-3'), { ticket: undefined, effects: [], timers: [] }, h3));
    expect(await s.getWorkflowVersion('h3')).toEqual(h3);
    expect((await s.ticketJournal('p', 'REL-3'))[0]!.decision).toMatchObject({ workflowHash: 'h3' });
    // A tracked ticket whose project is gone: the orchestrator decides nothing, on no workflow.
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1'), { effects: [] }));
    await s.appendInbox(delegatedEvent('e2'));
    await s.decide({ event: delegatedEvent('e2'), workflow: { hash: '', definition: null }, decide: () => ({ effects: [], timers: [], clearTimers: false }) });
    expect((await s.ticketJournal('p', 'REL-1'))[1]!.decision).toMatchObject({ eventId: 'e2', workflowHash: '' });
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
    await s.putTimer({ key: 'REL-1:a', projectId: 'p', ticketId: 'REL-1', kind: 'debounce', payload: { job: 'a' }, fireAt: 1, armedBy: 'e1' });
    await s.putTimer({ key: 'REL-1:b', projectId: 'p', ticketId: 'REL-1', kind: 'debounce', payload: { job: 'b' }, fireAt: 1, armedBy: 'e2' });
    await s.putTimer({ key: 'REL-2:c', projectId: 'p', ticketId: 'REL-2', kind: 'debounce', payload: { job: 'c' }, fireAt: 1 });
    await s.deleteTimersArmedBy('e1');
    expect((await s.dueTimers(10)).map((t) => t.key)).toEqual(['REL-1:b', 'REL-2:c']);
    await s.deleteTimersFor('p', 'REL-1');
    expect((await s.dueTimers(10)).map((t) => t.key)).toEqual(['REL-2:c']);
  });

  it('clears the ticket timers before arming the decision ones when asked (a stop, ORC-149)', async () => {
    const s = await store();
    await s.putTimer({ key: 'REL-1:old', projectId: 'p', ticketId: 'REL-1', kind: 'debounce', payload: { job: 'old' }, fireAt: 500 });
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
        id: 'effect:REL-1:1:1', type: 'effect.done', at: expect.any(Number), schemaVersion: 3, taint: 'trusted', projectId: 'p', ticketId: 'REL-1',
        payload: { effectId: 'REL-1:1:1', kind: 'comment', eventId: 'e1', attempts: 1 },
      },
    ]);
    // Settled once: no second result.
    expect(await s.completeEffect(row.id, row.lease)).toBe(false);
    expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['effect:REL-1:1:1']);
  });

  it('carries in the result of a replayed effect that it found the effect already made (ORC-162)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.decide(request(delegatedEvent('e1')));
    const row = await s.claimEffect('p', 'REL-1', 60_000);
    if (typeof row !== 'object') throw new Error('expected a claimed row');
    expect(await s.completeEffect(row.id, row.lease, 1_000, { deduplicated: true, ref: 'comment-1' })).toBe(true);
    expect((await s.pendingInbox(10))[0]!.payload).toEqual({
      effectId: 'REL-1:1:1', kind: 'comment', eventId: 'e1', attempts: 1, deduplicated: true, ref: 'comment-1',
    });
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
  it('sets a row whose decision threw aside in one transaction: dead letter, inbox mark, the blocking event (ORC-175)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.appendInbox(delegatedEvent('e2'));
    expect(await s.deadLetter(delegatedEvent('e1'), 'boom', 50)).toBe(true);
    // Once only: the row is no longer pending.
    expect(await s.deadLetter(delegatedEvent('e1'), 'boom', 50)).toBe(false);
    expect(await s.deadLetters('REL-1')).toEqual([
      { eventId: 'e1', projectId: 'p', ticketId: 'REL-1', event: delegatedEvent('e1'), error: 'boom', failures: 1, status: 'open' },
    ]);
    expect(await s.deadLetters('REL-2')).toEqual([]);
    expect((await s.deadLetters()).map((d) => d.eventId)).toEqual(['e1']);
    // Not journaled, not pending: the row behind it is next, then the event that blocks the ticket.
    expect(await s.recentEvents(10)).toEqual([]);
    expect(await s.pendingInbox(10)).toEqual([
      delegatedEvent('e2'),
      { ...TRUSTED, id: 'dead-letter:e1:1', type: 'dead_letter.added', at: 50, projectId: 'p', ticketId: 'REL-1', payload: { eventId: 'e1', eventType: 'ticket.delegated', error: 'boom', failures: 1 } },
    ]);
  });

  it('keeps a timer per project under one key: arming or firing a copy\'s leaves the other\'s (ORC-316)', async () => {
    const s = await store();
    const timer = (projectId: string, fireAt: number): TimerRecord => ({ key: 'REL-1:dev-feedback', projectId, ticketId: 'REL-1', kind: 'debounce', payload: { job: 'dev-feedback' }, fireAt });
    await s.putTimer(timer('api', 100));
    await s.putTimer(timer('p', 200));
    await s.putTimer(timer('p', 300));
    expect((await s.dueTimers(1000)).map((t) => [t.projectId, t.key, t.fireAt])).toEqual([['api', 'REL-1:dev-feedback', 100], ['p', 'REL-1:dev-feedback', 300]]);
    // Fired as read: a stale read of p's is left alone, api's goes.
    expect(await s.fireTimer(timer('p', 200), 400)).toBe(false);
    expect(await s.fireTimer(timer('api', 100), 400)).toBe(true);
    expect((await s.dueTimers(1000)).map((t) => t.projectId)).toEqual(['p']);
    expect((await s.pendingInbox(10)).map((e) => [e.id, e.projectId])).toEqual([['timer:REL-1:dev-feedback:100', 'api']]);
  });

  it('keeps a copy of a ticket per project: writing one leaves the other whole (ORC-316)', async () => {
    const s = await store();
    const api = { ...newTicketState('api', 'REL-1', 'T', 'dev', 1), delegated: true, branch: 'factory/rel-1', prNumber: 7 };
    const web = newTicketState('web', 'REL-1', 'T', 'dev', 1);
    await s.putTicket(api);
    await s.putTicket(web);
    await s.putTicket({ ...web, title: 'renamed' });
    expect(await s.getTicket('api', 'REL-1')).toEqual(api);
    expect(await s.getTicket('web', 'REL-1')).toEqual({ ...web, title: 'renamed' });
    expect((await s.listTickets()).map((t) => t.projectId).sort()).toEqual(['api', 'web']);
    expect(await s.updateTicket('web', 'REL-1', (t) => ({ ...t, blocked: true }))).toMatchObject({ projectId: 'web', blocked: true });
    expect(await s.getTicket('api', 'REL-1')).toEqual(api);
  });

  describe('a decision another project of the ticket\'s team holds the ticket against (ORC-316)', () => {
    const plan = (ticket: TicketState): DecisionPlan => ({ ticket, effects: [], timers: [], clearTimers: false });
    const held = { ...newTicketState('api', 'REL-1', 'T', 'dev', 1), delegated: true };
    const wait = { ...newTicketState('p', 'REL-1', 'T', 'dev', 1), delegated: true, blocked: true, blockKind: 'pickup' as const, awaitingRepo: ['p', 'api'] };
    const on = async (...copies: TicketState[]) => {
      const s = await store();
      for (const c of copies) await s.putTicket(c);
      await s.appendInbox(delegatedEvent('e1'));
      return s;
    };

    it('is refused when it would create a copy: nothing written, the row still pending', async () => {
      const s = await on(held);
      const req = { event: delegatedEvent('e1'), workflow: WF, peers: ['api'], decide: () => plan(newTicketState('p', 'REL-1', 'T', 'dev', 1)) };
      await expect(s.decide(req)).rejects.toBeInstanceOf(TicketHeldError);
      expect(await s.getTicket('api', 'REL-1')).toEqual(held);
      expect(await s.getTicket('p', 'REL-1')).toBeUndefined();
      expect(await s.recentEvents(10)).toEqual([]);
      expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['e1']);
    });

    it('is refused when the copy that waited here would come to hold it, and goes on when it only stops waiting', async () => {
      const s = await on(held, wait);
      await expect(s.decide({ event: delegatedEvent('e1'), workflow: WF, peers: ['api'], decide: () => plan({ ...wait, blocked: false, awaitingRepo: null }) })).rejects.toBeInstanceOf(TicketHeldError);
      expect(await s.getTicket('p', 'REL-1')).toEqual(wait);
      const ended = { ...wait, delegated: false, blocked: false, awaitingRepo: null };
      expect(await s.decide({ event: delegatedEvent('e1'), workflow: WF, peers: ['api'], decide: () => plan(ended) })).toMatchObject({ status: 'committed' });
      expect(await s.getTicket('p', 'REL-1')).toEqual(ended);
    });

    it('goes on when the other copy does not hold it, or is no longer a peer (a project renamed)', async () => {
      const s = await on(wait, { ...held, projectId: 'old-name' });
      const created = newTicketState('web', 'REL-1', 'T', 'dev', 1);
      await expect(s.decide({ event: { ...delegatedEvent('e1'), projectId: 'web' }, workflow: WF, peers: ['p'], decide: () => plan(created) })).resolves.toMatchObject({ status: 'committed' });
      expect(await s.getTicket('web', 'REL-1')).toEqual(created);
    });
  });

  it('a refused event\'s notice goes to the project holding the ticket, with the project refused and its session (ORC-316)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    expect(await s.deadLetter(delegatedEvent('e1'), 'held', 50, 'api')).toBe(true);
    expect(await s.getDeadLetter('e1')).toMatchObject({ projectId: 'p', status: 'open' });
    expect(await s.pendingInbox(10)).toEqual([
      {
        ...TRUSTED, id: 'refused:e1:1', type: 'dead_letter.added', at: 50, projectId: 'api', ticketId: 'REL-1',
        payload: { eventId: 'e1', eventType: 'ticket.delegated', error: 'held', failures: 1, refused: { projectId: 'p', linearSessionId: 'ls-1' } },
      },
    ]);
  });

  it('repairs an open dead letter once: its status, and the repair event in the inbox (ORC-175)', async () => {
    const s = await store();
    await s.appendInbox(delegatedEvent('e1'));
    await s.deadLetter(delegatedEvent('e1'), 'boom', 50);
    await s.markInboxProcessed('dead-letter:e1:1');
    const repaired = await s.repairDeadLetter('e1', 'replay', 'armand', 60);
    expect(repaired).toMatchObject({ eventId: 'e1', status: 'replayed', resolvedBy: 'armand', failures: 1 });
    expect(await s.repairDeadLetter('e1', 'skip', 'armand', 61)).toBeUndefined();
    expect(await s.repairDeadLetter('nope', 'skip', 'armand', 61)).toBeUndefined();
    const [repair] = await s.pendingInbox(10);
    expect(repair).toMatchObject({
      id: 'repair:e1:1',
      type: 'dead_letter.repaired',
      at: 60,
      ticketId: 'REL-1',
      payload: { eventId: 'e1', action: 'replay', by: 'armand', event: { id: 'e1', type: 'ticket.delegated' } },
    });
    // The replay throws again: the same dead letter reopens, one failure more, with a new blocking event.
    expect(await s.deadLetter(repair!, 'boom again', 70)).toBe(true);
    expect(await s.deadLetters('REL-1')).toMatchObject([{ eventId: 'e1', status: 'open', failures: 2, error: 'boom again' }]);
    expect((await s.pendingInbox(10)).map((e) => e.id)).toEqual(['dead-letter:e1:2']);
    // A skip carries the event too: a skip whose decision throws reopens the same dead letter, not a new one.
    expect(await s.repairDeadLetter('e1', 'skip', 'lilian', 80)).toMatchObject({ status: 'skipped', resolvedBy: 'lilian', failures: 2 });
    const skip = (await s.pendingInbox(10))[1]!;
    expect(skip).toMatchObject({ id: 'repair:e1:2', payload: { eventId: 'e1', action: 'skip', by: 'lilian', event: delegatedEvent('e1') } });
    expect(await s.deadLetter(skip, 'corrupt', 90)).toBe(true);
    expect(await s.deadLetters()).toMatchObject([{ eventId: 'e1', status: 'open', failures: 3 }]);
    expect(await s.getDeadLetter('e1')).toMatchObject({ eventId: 'e1', failures: 3, error: 'corrupt' });
    expect(await s.getDeadLetter('nope')).toBeUndefined();
  });
}
