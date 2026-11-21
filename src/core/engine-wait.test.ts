import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../presets/workflow.js';
import type { AgentOutput } from './agent-output.js';
import { liftsOnWait, type Decision } from './decision.js';
import { decide } from './engine.js';
import { ticketMeasures } from './measures.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type PendingJob, type TicketState } from './types.js';

const workflow = defaultWorkflow();

const event = <T extends EventType>(type: T, payload: EventPayloads[T], id = `e-${type}`): FactoryEvent =>
  ({ id, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload }) as FactoryEvent;
const assessed: AgentOutput = {
  status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [],
  intake: { size: 'm', risk: 'medium', complete: true, missing: [], screen: false },
};
const intakeEnd = (extra: Partial<EventPayloads['run.finished']> = {}) =>
  event('run.finished', { runId: 'r1', job: 'intake', outcome: 'success', costUsd: 0.1, turns: 3, lastText: 'ok', attempt: 'succeeded', output: assessed, ...extra });
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), delegated: true, linearSessionId: 's1', ...patch };
}
const after = (t: TicketState, e: FactoryEvent) => decide(t, e, workflow).events.reduce<TicketState | undefined>((s, x) => reduce(s, x), reduce(t, e))!;
const waiting = (patch: Partial<TicketState> = {}) => ticket({ waitingOn: { blockers: ['REL-2'], start: { job: 'dev' } }, ...patch });
const starts = (t: TicketState, e: FactoryEvent) => decide(t, e, workflow).effects.filter((x) => x.kind === 'start_run');

describe('the wait on a « blocked by » ticket not done (ORC-363)', () => {
  const blockedBy = [{ identifier: 'REL-2', stateName: 'In Progress' }];

  it('at the end of intake, an open blocker is an input of the guard: nothing starts nor moves, the ticket waits, unblocked', () => {
    const e = intakeEnd({ blockedBy });
    const t = ticket({ activeRunId: 'r1', activeJob: 'intake' });
    const out = decide(t, e, workflow);
    expect(out.effects.some((x) => x.kind === 'start_run' || x.kind === 'move' || x.kind === 'block_comment')).toBe(false);
    expect(out.effects).toContainEqual({ kind: 'activity', type: 'thought', body: expect.stringContaining('REL-2 (In Progress)') });
    // What intake's end starts waits: the spec (ORC-395).
    expect(after(t, e)).toMatchObject({ blocked: false, size: 'm', waitingOn: { blockers: ['REL-2'], start: { job: 'spec' } } });
  });

  it('an incomplete ticket is asked its questions first (ORC-210): the human has something to answer, the wait comes after', () => {
    const t = ticket({ activeRunId: 'r1', activeJob: 'intake' });
    const out = after(t, intakeEnd({ blockedBy, output: { ...assessed, intake: { ...assessed.intake!, complete: false, missing: ['CSV or XLSX?'] } } }));
    expect(out).toMatchObject({ blocked: false, clarify: { job: 'intake', questions: [{ question: 'CSV or XLSX?' }] } });
    expect(out.waitingOn ?? undefined).toBeUndefined();
  });

  it('the blockers done, the start it waited for is made and the wait ends', () => {
    const e = event('blockers.done', { blockers: ['REL-2'] });
    const out = decide(waiting(), e, workflow);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev' }));
    // The wait's own start relaunches nothing (ORC-440).
    expect(starts(waiting(), e)[0]).not.toHaveProperty('relaunches');
    expect(out.effects).toContainEqual({ kind: 'activity', type: 'thought', body: expect.stringContaining('REL-2') });
    expect(after(waiting(), e).waitingOn ?? undefined).toBeUndefined();
  });

  it('keeps the restrictions of the start it waited for (I12)', () => {
    const t = waiting({ waitingOn: { blockers: ['REL-2'], start: { job: 'dev', sensitivePaths: ['.github/**'] } } });
    expect(starts(t, event('blockers.done', { blockers: ['REL-2'] }))).toEqual([expect.objectContaining({ job: 'dev', sensitivePaths: ['.github/**'] })]);
  });

  it.each([
    ['no longer waiting', ticket()],
    ['blocked since', waiting({ blocked: true, blockReason: 'Stopped.', blockKind: 'stopped' })],
    ['undelegated', waiting({ delegated: false })],
    ['with a run under way', waiting({ activeRunId: 'r9', activeJob: 'dev' })],
    ['a human moved to Human Review meanwhile', waiting({ logical: 'human_review' })],
  ])('the blockers done on a ticket %s start nothing', (_what, t) => {
    expect(starts(t, event('blockers.done', { blockers: ['REL-2'] }))).toEqual([]);
  });

  it('a reply while it waits starts no dev job, even where the rule would: kept in the inbox (I6)', () => {
    const t = waiting({ logical: 'dev' });
    const reply = event('session.prompted', { linearSessionId: 's1', body: 'semicolons', author: 'L', ack: true, kind: 'instruction' });
    const out = decide(t, reply, workflow);
    expect(out.effects.some((x) => x.kind === 'start_run')).toBe(false);
    expect(out.timers).toEqual([]);
    expect(after(t, reply)).toMatchObject({ humanInbox: [expect.objectContaining({ body: 'semicolons' })], waitingOn: { blockers: ['REL-2'] } });
  });

  it('a debounced reply armed before the wait began starts nothing when it fires', () => {
    const fired = event('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } } as EventPayloads['timer.fired']);
    expect(starts(waiting({ logical: 'dev' }), fired)).toEqual([]);
  });

  describe('on a ticket blocked meanwhile (ORC-432)', () => {
    const blocked = (patch: Partial<TicketState> = {}) =>
      waiting({ logical: 'dev', blocked: true, blockReason: 'Which separator?', blockKind: 'question', blockedJob: 'dev', ...patch });
    const reply = event('session.prompted', { linearSessionId: 's1', body: 'Semicolons', author: 'L', ack: true, kind: 'instruction' });
    const done = event('blockers.done', { blockers: ['REL-2'] });
    const mention = event('session.mentioned', { linearSessionId: 's-m', body: 'Semicolons', author: 'L', ack: true, kind: 'instruction' });
    const comment = { ...event('ticket.commented', { body: 'Semicolons', author: 'L', kind: 'instruction' }, 'c'), actor: 'u-member', roles: ['team_member'] } as FactoryEvent;

    it('a reply keeps the block and starts nothing: the step it resumes waits for the blockers, the reply in the inbox', () => {
      const out = decide(blocked(), reply, workflow);
      expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
      expect(out.effects.some((x) => x.kind === 'start_run' || x.kind === 'labels')).toBe(false);
      expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'ack', body: expect.stringContaining('REL-2') }));
      expect(after(blocked(), reply)).toMatchObject({
        blocked: true,
        humanInbox: [expect.objectContaining({ body: 'Semicolons' })],
        waitingOn: { blockers: ['REL-2'], start: { job: 'dev' }, lift: { job: 'dev', input: 'feedback' } },
      });
    });

    it('the blockers done, the block is lifted and the step the reply resumed starts, reading it', () => {
      const answered = after(blocked(), reply);
      const out = decide(answered, done, workflow);
      expect(out.events.map((e) => e.type)).toContain('ticket.unblocked');
      // The relaunch the wait kept is made: its start says so (ORC-440).
      expect(starts(answered, done)).toEqual([expect.objectContaining({ job: 'dev', input: 'feedback', relaunches: true })]);
      expect(after(answered, done)).toMatchObject({ blocked: false, humanInbox: [expect.objectContaining({ body: 'Semicolons' })] });
    });

    it('a mention that answers the block waits as a reply does (ORC-426)', () => {
      const out = decide(blocked(), mention, workflow);
      expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
      expect(after(blocked(), mention)).toMatchObject({ blocked: true, waitingOn: { lift: { job: 'dev', input: 'feedback' } } });
    });

    it.each([
      ['a mention that answers the block', mention],
      ['a comment', comment],
    ])('%s the wait keeps is traced as a relaunch, no run started with it (ORC-440)', (_what, e) => {
      expect(starts(blocked(), e)).toEqual([]);
      expect(liftsOnWait(decide(blocked(), e, workflow).trace)).toBe(true);
    });

    it('an instruction kept by the wait on a ticket not blocked is no relaunch the wait keeps (ORC-440)', () => {
      const t = waiting({ logical: 'dev' });
      expect(liftsOnWait(decide(t, mention, workflow).trace)).toBe(false);
    });

    it('acceptance (ORC-440): a comment that relaunches the step, at once or at the end of the wait, is a rework of the merged ticket', () => {
      const merged = event('pr.merged', { number: 1, url: 'u', branch: 'b' }, 'm');
      // The facts the store keeps of these decisions: the journal, the outbox rows by event, the relaunches the wait kept.
      const measured = (decided: [FactoryEvent, Decision][]) => {
        const rows = decided.flatMap(([e, d]) => d.effects.map((effect, i) => ({ id: `REL-1:${e.id}:${i}`, projectId: 'p', ticketId: 'REL-1', eventId: e.id, seq: 1, i, effect, status: 'done' as const, attempts: 1 })));
        const liftedOnWait = decided.flatMap(([e, d]) => (liftsOnWait(d.trace) ? [e.id] : []));
        return ticketMeasures('p', 'REL-1', { devSession: 's1', events: [...decided.map(([e]) => e), merged], runs: [], effects: rows, acks: {}, liftedOnWait }).reworks;
      };
      const kept = blocked();
      const answered = after(kept, comment);
      expect(measured([[comment, decide(kept, comment, workflow)], [done, decide(answered, done, workflow)]])).toEqual([{ cause: 'feedback', id: 'c' }]);
      // Moved on meanwhile, the end of the wait drops it: it never relaunched.
      const moved = { ...answered, logical: 'human_review' as const };
      expect(measured([[comment, decide(kept, comment, workflow)], [done, decide(moved, done, workflow)]])).toEqual([]);
      const free = blocked({ waitingOn: null });
      expect(measured([[comment, decide(free, comment, workflow)]])).toEqual([{ cause: 'feedback', id: 'c' }]);
    });

    it('the reply gives the bounds back as it would have lifting the block', () => {
      expect(decide(blocked({ leaseRelaunches: 1 }), reply, workflow).events).toContainEqual({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
    });

    it('moved on meanwhile, the blockers done start nothing and the human hears the resume will not come', () => {
      const answered = { ...after(blocked(), reply), logical: 'human_review' as const };
      const out = decide(answered, done, workflow);
      expect(starts(answered, done)).toEqual([]);
      expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
      expect(out.effects).toContainEqual({ kind: 'activity', type: 'thought', body: expect.stringContaining('stays blocked') });
    });

    it('with no reply, the blockers done leave the block and start nothing', () => {
      expect(starts(blocked(), done)).toEqual([]);
    });
  });

  describe('on a ticket blocked on a pending job no settle could start (ORC-435)', () => {
    const pendingJob: PendingJob = { job: 'dev-feedback', input: 'feedback', sensitivePaths: ['.github/**'] };
    const stranded = (patch: Partial<TicketState> = {}) =>
      waiting({ logical: 'dev', blocked: true, blockKind: 'stuck', blockReason: 'Error: the pending dev-feedback could not be started', blockedJob: 'dev-feedback', pendingJob, ...patch });
    const reply = event('session.prompted', { linearSessionId: 's1', body: 'Go on', author: 'L', ack: true, kind: 'instruction' });
    const fired = event('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } } as EventPayloads['timer.fired']);
    const done = event('blockers.done', { blockers: ['REL-2'] });

    it('a reply keeps the block and starts nothing: the pending job waits for the blockers, as the lift of the wait', () => {
      const out = decide(stranded(), reply, workflow);
      expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
      expect(out.effects.some((x) => x.kind === 'start_run')).toBe(false);
      expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'ack', body: expect.stringContaining('REL-2') }));
      expect(after(stranded(), reply)).toMatchObject({ blocked: true, pendingJob, waitingOn: { blockers: ['REL-2'], start: { job: 'dev' }, lift: pendingJob } });
    });

    it('the reply gives the bounds back as it would have starting the job', () => {
      expect(decide(stranded({ leaseRelaunches: 1 }), reply, workflow).events).toContainEqual({ type: 'ticket.patched', patch: { leaseRelaunches: 0 } });
    });

    it('a debounce armed before the block, fired, starts nothing either: the pending job waits as the lift', () => {
      const out = decide(stranded(), fired, workflow);
      expect(out.effects.some((x) => x.kind === 'start_run')).toBe(false);
      expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
      expect(after(stranded(), fired)).toMatchObject({ blocked: true, waitingOn: { lift: pendingJob } });
    });

    it.each([
      ['a reply', reply],
      ['a debounce', fired],
    ])('after %s, the blockers done lift the block and start the pending job as it was set, taken off the ticket', (_what, e) => {
      const held = after(stranded(), e);
      const out = decide(held, done, workflow);
      expect(out.events.map((x) => x.type)).toContain('ticket.unblocked');
      expect(out.events).toContainEqual({ type: 'pending.cleared', job: pendingJob });
      expect(starts(held, done)).toEqual([expect.objectContaining({ job: 'dev-feedback', input: 'feedback', sensitivePaths: ['.github/**'] })]);
      expect(after(held, done)).toMatchObject({ blocked: false, pendingJob: undefined });
    });

    it('on a merged ticket, a reply promises no resume and starts nothing, as it would not waiting', () => {
      const merged = stranded({ prState: 'MERGED' });
      const out = decide(merged, reply, workflow);
      expect(out.effects.some((x) => x.kind === 'start_run')).toBe(false);
      expect(after(merged, reply).waitingOn?.lift).toBeUndefined();
    });

    it('not waiting, a reply still starts the pending job at once (ORC-339)', () => {
      const out = decide(stranded({ waitingOn: null }), reply, workflow);
      expect(out.events.map((e) => e.type)).toContain('ticket.unblocked');
      expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev-feedback' }));
    });
  });

  it.each([
    ['a block', { type: 'ticket.blocked', reason: 'Stopped.', kind: 'stopped' }],
    ['an undelegation', event('ticket.undelegated', {})],
    ['a dev run started', { type: 'run.started', runId: 'r2', job: 'dev', queue: 'dev', claudeSessionId: 'c2' }],
  ] as const)('ends with %s', (_what, e) => {
    expect(reduce(waiting(), e as never)!.waitingOn ?? undefined).toBeUndefined();
  });

  it('a move by a human or a delegation again does not end it: the blockers still hold, and nothing starts', () => {
    const moved = event('status.changed', { from: 'todo', to: 'dev' });
    expect(reduce(waiting(), moved)!.waitingOn).toEqual({ blockers: ['REL-2'], start: { job: 'dev' } });
    const again = event('ticket.delegated', { linearSessionId: 's2' });
    expect(after(waiting(), again).waitingOn).toEqual({ blockers: ['REL-2'], start: { job: 'dev' } });
    expect(starts(waiting(), again)).toEqual([]);
  });
});

describe('the status of the step a wait or an intake starts (ORC-382)', () => {
  const spec = defaultWorkflow({ statuses: { spec_draft: 'Spec' } });
  const moves = (t: TicketState, e: FactoryEvent) => decide(t, e, spec).effects.filter((x) => x.kind === 'move');

  it('the blockers done, the spec it waited for starts in its status, which intake\'s end left to that start', () => {
    const t = ticket({ waitingOn: { blockers: ['REL-2'], start: { job: 'spec' } } });
    expect(moves(t, event('blockers.done', { blockers: ['REL-2'] }))).toEqual([{ kind: 'move', to: 'spec' }]);
    expect(moves(ticket({ activeRunId: 'r1', activeJob: 'intake' }), intakeEnd({ blockedBy: [{ identifier: 'REL-2', stateName: 'Todo' }] }))).toEqual([]);
  });

  it('intake\'s end moves a ticket in Todo to Spec, never one delegated again In Progress back to it (ORC-422)', () => {
    expect(moves(ticket({ activeRunId: 'r1', activeJob: 'intake' }), intakeEnd())).toEqual([{ kind: 'move', to: 'spec' }]);
    expect(moves(ticket({ activeRunId: 'r1', activeJob: 'intake', logical: 'dev' }), intakeEnd())).toEqual([]);
  });
});
