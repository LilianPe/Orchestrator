import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput } from './agent-output.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

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
    expect(after(t, e)).toMatchObject({ blocked: false, size: 'm', waitingOn: { blockers: ['REL-2'], start: { job: 'dev' } } });
  });

  it('an incomplete ticket is blocked on its questions first: the human has something to answer, the wait comes after', () => {
    const t = ticket({ activeRunId: 'r1', activeJob: 'intake' });
    const out = after(t, intakeEnd({ blockedBy, output: { ...assessed, intake: { ...assessed.intake!, complete: false, missing: ['CSV or XLSX?'] } } }));
    expect(out).toMatchObject({ blocked: true, blockedJob: 'intake' });
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
    ['blocked since', waiting({ blocked: true, blockReason: 'Stopped.' })],
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

  it.each([
    ['a block', { type: 'ticket.blocked', reason: 'Stopped.' }],
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
