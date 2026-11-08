import { describe, expect, it } from 'vitest';
import { reduce } from './reduce.js';
import { newTicketState, normalizeTicket, type EventPayloads, type EventType, type FeedbackItem, type InternalEvent, type FactoryEvent, type TicketState } from './types.js';

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload } as FactoryEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), ...patch };
}
const fold = (t: TicketState, ...events: (FactoryEvent | InternalEvent)[]) => events.reduce<TicketState | undefined>((s, e) => reduce(s, e), t);

describe('reduce — facts carried by external events', () => {
  it('delegation marks the ticket delegated and keeps the first dev session', () => {
    expect(reduce(ticket(), ev('ticket.delegated', { linearSessionId: 's1' }))).toMatchObject({ delegated: true, linearSessionId: 's1' });
    expect(reduce(ticket({ linearSessionId: 's0' }), ev('ticket.delegated', { linearSessionId: 's1' }))!.linearSessionId).toBe('s0');
  });

  it('undelegation clears the flag', () => {
    expect(reduce(ticket({ delegated: true }), ev('ticket.undelegated', {}))!.delegated).toBe(false);
  });

  it('a mention or a command in another session records it as a question session, most recent last', () => {
    const t = ticket({ linearSessionId: 's1', questionSessionIds: ['s2', 's3'] });
    expect(reduce(t, ev('session.mentioned', { linearSessionId: 's2', body: '?', author: 'L' }))!.questionSessionIds).toEqual(['s3', 's2']);
    expect(reduce(t, ev('command', { name: 'retiens', body: 'x', linearSessionId: 's1', author: 'L' }))!.questionSessionIds).toEqual(['s2', 's3']);
  });

  it('keeps at most 50 question sessions', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `q${i}`);
    const out = reduce(ticket({ questionSessionIds: ids }), ev('session.mentioned', { linearSessionId: 'new', body: '?', author: 'L' }))!;
    expect(out.questionSessionIds).toHaveLength(50);
    expect(out.questionSessionIds.at(-1)).toBe('new');
    expect(out.questionSessionIds[0]).toBe('q1');
  });

  it('a status change to a known state records it; to an unknown state changes nothing', () => {
    expect(reduce(ticket(), ev('status.changed', { from: 'todo', to: 'dev' }))!.logical).toBe('dev');
    expect(reduce(ticket({ logical: 'dev' }), ev('status.changed', { from: 'dev', to: null }))!.logical).toBe('dev');
  });

  it('a finished run adds its cost and frees the ticket only if it was the active run', () => {
    const finished = ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1.5, turns: 3, lastText: '' });
    expect(reduce(ticket({ activeRunId: 'r1', activeJob: 'dev', costUsd: 1 }), finished)).toMatchObject({ activeRunId: undefined, activeJob: undefined, costUsd: 2.5 });
    expect(reduce(ticket({ activeRunId: 'r2', activeJob: 'review' }), finished)).toMatchObject({ activeRunId: 'r2', activeJob: 'review' });
  });

  it('a verification result ends the verification it answers, and only that one', () => {
    expect(reduce(ticket({ verifyingRunId: 'r1' }), ev('verify.passed', { runId: 'r1', job: 'dev' }))!.verifyingRunId).toBeUndefined();
    expect(reduce(ticket({ verifyingRunId: 'r2' }), ev('verify.failed', { runId: 'r1', job: 'dev', failures: [] }))!.verifyingRunId).toBe('r2');
  });

  it('events that carry no ticket fact leave the state as it was', () => {
    const t = ticket({ logical: 'dev' });
    expect(reduce(t, ev('pr.closed', { number: 1, url: 'u', branch: 'b' }))).toEqual(t);
  });

  it('a merge records the PR as merged, the fact decide reads to start no dev work any more (ORC-268)', () => {
    expect(reduce(ticket({ logical: 'ready' }), ev('pr.merged', { number: 1, url: 'u', branch: 'b' }))).toEqual(
      ticket({ logical: 'ready', prState: 'MERGED', prNumber: 1, prUrl: 'u' }),
    );
  });

  it('a human who takes a merged ticket out of done, or delegates it again, reopens it (ORC-268)', () => {
    const merged = ticket({ logical: 'done', delegated: true, prState: 'MERGED', prNumber: 1 });
    expect(reduce(merged, ev('status.changed', { from: 'done', to: 'dev' }))).toMatchObject({ logical: 'dev', prState: undefined, prNumber: 1 });
    expect(reduce(merged, ev('ticket.delegated', {}))!.prState).toBeUndefined();
    expect(reduce(merged, ev('status.changed', { from: 'done', to: 'done' }))!.prState).toBe('MERGED');
  });

  it('a human status change reopens a merged ticket whose move to done failed (ORC-268)', () => {
    const merged = ticket({ logical: 'ready', prState: 'MERGED' });
    expect(reduce(merged, ev('status.changed', { from: 'ready', to: 'dev' }))).toMatchObject({ logical: 'dev', prState: undefined });
    expect(reduce(merged, ev('status.changed', { from: 'ready', to: 'done' }))!.prState).toBe('MERGED');
  });

  it('without a ticket, there is nothing to reduce', () => {
    expect(reduce(undefined, ev('control.pause', {}))).toBeUndefined();
    expect(reduce(undefined, ev('ticket.delegated', {}))).toBeUndefined();
  });

  it('an event that brings the ticket snapshot starts tracking the ticket from it', () => {
    const issue = { title: 'Export CSV', logical: 'dev' as const, priority: 2 };
    expect(reduce(undefined, ev('ticket.delegated', { linearSessionId: 's1', issue }))).toEqual({
      ...newTicketState('p', 'REL-1', 'Export CSV', 'dev', 1000, 2),
      delegated: true,
      linearSessionId: 's1',
    });
    expect(reduce(undefined, ev('session.mentioned', { linearSessionId: 's2', body: '?', author: 'L', issue }))).toMatchObject({ delegated: false, questionSessionIds: ['s2'] });
  });
});

describe('reduce — decided events', () => {
  it('blocks and unblocks', () => {
    const blocked = reduce(ticket(), { type: 'ticket.blocked', reason: 'Arrêté' })!;
    expect(blocked).toMatchObject({ blocked: true, blockReason: 'Arrêté' });
    expect(reduce(blocked, { type: 'ticket.unblocked' })).toMatchObject({ blocked: false, blockReason: undefined });
  });

  it('patches the allowed fields', () => {
    expect(reduce(ticket(), { type: 'ticket.patched', patch: { prNumber: 7, prUrl: 'u', verifyAttempts: 1, ciFixAttempts: 2 } })).toMatchObject({ prNumber: 7, prUrl: 'u', verifyAttempts: 1, ciFixAttempts: 2 });
  });

  it('a ticket persisted before ORC-270 reads a red-CI count of 0', () => {
    const { ciFixAttempts: _, ...older } = ticket();
    expect(normalizeTicket(older as TicketState).ciFixAttempts).toBe(0);
    expect(normalizeTicket(ticket({ ciFixAttempts: 2 })).ciFixAttempts).toBe(2);
  });

  it('appends feedback in order', () => {
    const item = (body: string) => ({ author: 'L', body, at: 1, source: 'session' as const });
    const out = fold(ticket(), { type: 'feedback.appended', item: item('a') }, { type: 'feedback.appended', item: item('b') })!;
    expect(out.humanInbox.map((f) => f.body)).toEqual(['a', 'b']);
  });

  it('cancelling the work drops the pending job and the awaited verification', () => {
    const t = ticket({ pendingJob: { job: 'dev-feedback' }, verifyingRunId: 'r1', activeRunId: 'r1' });
    expect(reduce(t, { type: 'work.cancelled' })).toMatchObject({ pendingJob: undefined, verifyingRunId: undefined, activeRunId: 'r1' });
  });

  it('starting a verification records the run it checks', () => {
    expect(reduce(ticket(), { type: 'verify.started', runId: 'r1' })!.verifyingRunId).toBe('r1');
  });
});

describe('reduce — facts recorded by the orchestrator', () => {
  it('records a move made by the factory, a linked session and the pending job', () => {
    const out = fold(ticket(), { type: 'status.recorded', to: 'human_review' }, { type: 'session.linked', linearSessionId: 's1' }, { type: 'pending.set', job: { job: 'dev' } })!;
    expect(out).toMatchObject({ logical: 'human_review', linearSessionId: 's1', pendingJob: { job: 'dev' } });
    expect(reduce(out, { type: 'pending.cleared' })!.pendingJob).toBeUndefined();
  });

  it('prepares and releases the workspace', () => {
    const ready = reduce(ticket({ branch: 'old' }), { type: 'workspace.prepared', path: '/w', port: 4200 })!;
    expect(ready).toMatchObject({ worktreePath: '/w', port: 4200, branch: 'old' });
    expect(reduce(ready, { type: 'workspace.prepared', path: '/w', branch: 'factory/rel-1' })!.branch).toBe('factory/rel-1');
    expect(reduce(ready, { type: 'workspace.released' })).toMatchObject({ worktreePath: undefined, port: undefined });
  });

  it('a dev run becomes the active run and keeps the first claude session; a question run changes neither', () => {
    const started = (queue: 'dev' | 'questions', claudeSessionId: string) =>
      ({ type: 'run.started', runId: 'r1', job: queue === 'dev' ? 'dev' : 'ask', queue, claudeSessionId }) as const;
    expect(reduce(ticket(), started('dev', 'c1'))).toMatchObject({ activeRunId: 'r1', activeJob: 'dev', claudeSessionId: 'c1' });
    expect(reduce(ticket({ claudeSessionId: 'c0' }), started('dev', 'c1'))!.claudeSessionId).toBe('c0');
    expect(reduce(ticket(), started('questions', 'c1'))).toEqual(ticket());
  });

  it('the first untrusted run in the worktree marks the branch for good, whatever the ticket says of its path (ORC-338)', () => {
    const untrusted = (head: string) => ({ type: 'run.started', runId: 'r1', job: 'dev-feedback', queue: 'dev', claudeSessionId: 'c', untrusted: { head } }) as const;
    // Released meanwhile: the worktree's path is gone from the ticket, not the run's place in it.
    const marked = reduce(ticket({ worktreePath: undefined, untrustedSince: null }), untrusted('h1'))!;
    expect(marked.untrustedSince).toBe('h1');
    // Never read (a ticket from before the mark, which the launch reads first): its whole branch, not a head that would trust what came before.
    expect(reduce(ticket(), untrusted('h1'))!.untrustedSince).toBe('');
    expect(reduce(ticket({ untrustedSince: '' }), untrusted('h1'))!.untrustedSince).toBe('');
    expect(reduce(marked, untrusted('h2'))!.untrustedSince).toBe('h1');
    expect(reduce(marked, { type: 'run.started', runId: 'r2', job: 'dev', queue: 'dev', claudeSessionId: 'c' })!.untrustedSince).toBe('h1');
    expect(reduce(ticket(), { type: 'run.started', runId: 'r2', job: 'dev', queue: 'dev', claudeSessionId: 'c' })!.untrustedSince).toBeUndefined();
  });

  it('keeps the pushes humans made to the branch, once each, the newest last (ORC-338)', () => {
    const push = (sha: string, before?: string) => ev('push.human', { branch: 'factory/rel-1', sha, author: 'mate', ...(before ? { before } : {}) });
    const t = [push('a', 'z'), push('b', 'a'), push('a')].reduce((s, e) => reduce(s, e)!, ticket());
    expect(t.humanPushes).toEqual([{ before: 'a', after: 'b' }, { after: 'a' }]);
  });

  it('the read of a ticket the mark has not seen is kept once, and never over a mark; a later untrusted run still marks (ORC-338)', () => {
    const read = (since: '' | null) => ({ type: 'untrusted.read', since }) as const;
    const none = reduce(ticket(), read(null))!;
    expect(none.untrustedSince).toBeNull();
    expect(reduce(none, read(''))!.untrustedSince).toBeNull();
    expect(reduce(ticket({ untrustedSince: 'h1' }), read(null))!.untrustedSince).toBe('h1');
    expect(reduce(none, { type: 'run.started', runId: 'r1', job: 'dev-feedback', queue: 'dev', claudeSessionId: 'c', untrusted: { head: 'h2' } })!.untrustedSince).toBe('h2');
  });

  it('a run that consumes the feedback empties it', () => {
    const t = ticket({ humanInbox: [{ author: 'L', body: 'x', at: 1, source: 'session' }] });
    // Kept until the run that read it is written (ORC-220): a launch cut before reads it again.
    expect(reduce(t, { type: 'run.started', runId: 'r1', job: 'dev-feedback', queue: 'dev', claudeSessionId: 'c' })!.humanInbox).toHaveLength(t.humanInbox.length);
    expect(reduce(t, { type: 'feedback.consumed' })!.humanInbox).toEqual([]);
  });

  it('a cleared run frees the ticket, and keeps the verification', () => {
    const t = ticket({ activeRunId: 'r1', activeJob: 'dev', verifyingRunId: 'r0' });
    expect(reduce(t, { type: 'run.cleared' })).toMatchObject({ activeRunId: undefined, activeJob: undefined, verifyingRunId: 'r0' });
  });
});

describe('reduce — purity', () => {
  it('never mutates the state it is given', () => {
    const t = ticket({ activeRunId: 'r1', questionSessionIds: ['a'], humanInbox: [] });
    const snapshot = structuredClone(t);
    reduce(t, ev('session.mentioned', { linearSessionId: 'b', body: '?', author: 'L' }));
    reduce(t, { type: 'feedback.appended', item: { author: 'L', body: 'x', at: 1, source: 'session' } });
    reduce(t, { type: 'ticket.patched', patch: { prNumber: 1 } });
    expect(t).toEqual(snapshot);
  });
});

describe('the human inbox stays within its bound (ORC-180)', () => {
  const said = (at: number, patch: Partial<FeedbackItem>): FeedbackItem => ({ author: 'L', body: String(at), at, source: 'session', ...patch });

  it('drops the oldest of what had its answer, never what waits for the agent', () => {
    let t: TicketState | undefined = newTicketState('p', 'REL-1', 'T', 'dev', 0);
    t = reduce(t, { type: 'feedback.appended', item: said(0, { kind: 'instruction' }) });
    for (let i = 1; i <= 60; i++) t = reduce(t, { type: 'feedback.appended', item: said(i, i % 2 ? { kind: 'question', source: 'thread' } : { kind: 'command' }) });
    t = reduce(t, { type: 'feedback.appended', item: said(61, {}) });
    expect(t!.humanInbox).toHaveLength(52);
    expect(t!.humanInbox.map((f) => f.at).slice(0, 2)).toEqual([0, 11]);
    expect(t!.humanInbox.at(-1)!.at).toBe(61);
  });
});
