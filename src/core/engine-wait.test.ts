import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../presets/workflow.js';
import type { AgentOutput } from './agent-output.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

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
      expect(starts(answered, done)).toEqual([expect.objectContaining({ job: 'dev', input: 'feedback' })]);
      expect(after(answered, done)).toMatchObject({ blocked: false, humanInbox: [expect.objectContaining({ body: 'Semicolons' })] });
    });

    it('a mention that answers the block waits as a reply does (ORC-426)', () => {
      const mention = event('session.mentioned', { linearSessionId: 's-m', body: 'Semicolons', author: 'L', ack: true, kind: 'instruction' });
      const out = decide(blocked(), mention, workflow);
      expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
      expect(after(blocked(), mention)).toMatchObject({ blocked: true, waitingOn: { lift: { job: 'dev', input: 'feedback' } } });
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
