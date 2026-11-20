import { describe, expect, it } from 'vitest';
import { defaultWorkflow, preset, presetWorkflow } from '../presets/workflow.js';
import { beforeInProgress } from './chain.js';
import { decide } from './engine.js';
import type { Workflow } from './workflow.js';
import { reduce } from './reduce.js';
import type { SpecVersion } from './spec.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = defaultWorkflow();

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload } as FactoryEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, linearSessionId: 's1', ...patch };
}
/** The ticket once the decision of `e` is applied. */
const after = (t: TicketState, e: FactoryEvent): TicketState => decide(t, e, workflow).events.reduce<TicketState | undefined>((s, x) => reduce(s, x), reduce(t, e))!;
const instruction = ev('session.prompted', { linearSessionId: 's1', body: 'Ajoute le tri par date', author: 'Lilian', ack: true, kind: 'instruction' });
const spec = (patch: Partial<SpecVersion> = {}): SpecVersion => ({ job: 'spec', version: 1, spec: {} as SpecVersion['spec'], at: 1, ...patch });
/** Whether the decision of an instruction regroups it for `dev-feedback` (ORC-180). */
const feedsDev = (t: TicketState): boolean => decide(t, instruction, workflow).timers.some((x) => x.kind === 'debounce' && x.slot === 'dev-feedback');

describe('the instruction reaction follows the active step, not the status (ORC-422)', () => {
  it('a ticket In Progress delegated again, told something during its intake and its spec, starts no dev-feedback (criterion 1)', () => {
    const taken = ticket({ delegated: false });
    const delegated = after(taken, ev('ticket.delegated', { linearSessionId: 's2', ack: true }));
    expect(delegated).toMatchObject({ logical: 'dev', delegated: true });
    const intake = reduce(delegated, { type: 'run.started', runId: 'r1', job: 'intake', queue: 'dev', claudeSessionId: 'c1' })!;
    expect(intake).toMatchObject({ logical: 'dev', activeJob: 'intake' });
    const out = decide(intake, instruction, workflow);
    expect(out.trace).toContain('no rule for session.prompted');
    expect(out.timers).toEqual([]);
    // Kept in the inbox for the step at work, as on a ticket in Todo.
    expect(out.events).toContainEqual(expect.objectContaining({ type: 'feedback.appended' }));
  });

  it('a spec waiting for its review, or redrafted on /changes, takes no dev-feedback either', () => {
    expect(feedsDev(ticket({ spec: spec() }))).toBe(false);
    expect(feedsDev(ticket({ spec: spec({ approval: { author: 'A', at: 2 }, drafting: true }), pendingJob: { job: 'spec' } }))).toBe(false);
  });

  it('nor does the wait for clarify answers or for the tickets it is blocked by, before the spec', () => {
    expect(feedsDev(ticket({ clarify: { job: 'intake', questions: [{ question: 'CSV ou XLSX ?', options: [] }, { question: 'Quel tri ?', options: [] }], at: 1, answered: 0 } }))).toBe(false);
    expect(feedsDev(ticket({ waitingOn: { blockers: ['REL-2'], start: { job: 'spec' } } }))).toBe(false);
  });

  it('nor does an intake the queue still holds: the delegation again cleared the last spec, none is drafted yet', () => {
    const approved = ticket({ delegated: false, spec: spec({ approval: { author: 'A', at: 2 } }) });
    const delegated = after(approved, ev('ticket.delegated', { linearSessionId: 's2', ack: true }));
    expect(delegated.spec).toBeNull();
    expect([delegated.activeJob, delegated.pendingJob, delegated.launching]).toEqual([undefined, undefined, undefined]);
    expect(feedsDev(delegated)).toBe(false);
  });

  it('a regrouping armed before the delegation again does not start dev-feedback at the spec review', () => {
    const timer = { ...ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback', inbox: true } }), at: 2000 } as FactoryEvent;
    const waiting = ticket({ spec: spec(), humanInbox: [{ author: 'L', body: 'Ajoute le tri', at: 1, source: 'session', kind: 'instruction' }] });
    const out = decide(waiting, timer, workflow);
    expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([]);
    expect(out.trace).toContain('timer.fired debounce: dev-feedback not started, the ticket is not at work on the code yet');
    expect(decide({ ...waiting, spec: spec({ approval: { author: 'A', at: 2 } }) }, timer, workflow).effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev-feedback' }));
  });

  it('a launch of the tests tells the step while its hold lasts, not once it has expired', () => {
    const launching = (until: number) => ticket({ spec: spec({ approval: { author: 'A', at: 2 } }), launching: { runId: 'r5', start: { job: 'tests' }, until } });
    expect(feedsDev(launching(5000))).toBe(false);
    expect(feedsDev(launching(500))).toBe(true);
  });

  it('nor do the tests written before the build, still out of In Progress for a ticket delegated from Todo', () => {
    expect(feedsDev(ticket({ activeRunId: 'r2', activeJob: 'tests', spec: spec({ approval: { author: 'A', at: 2 } }) }))).toBe(false);
  });

  it('decides as for the same ticket in Todo: the status a delegation again left behind does not count', () => {
    for (const patch of [{ activeRunId: 'r1', activeJob: 'intake' }, { spec: spec() }]) {
      expect(decide(ticket(patch), instruction, workflow)).toEqual(decide(ticket({ ...patch, logical: 'todo' }), instruction, workflow));
    }
  });

  it('from the build on, an instruction In Progress is regrouped for dev-feedback as before (ORC-180)', () => {
    const approved = spec({ approval: { author: 'A', at: 2 } });
    expect(feedsDev(ticket({ activeRunId: 'r3', activeJob: 'dev', spec: approved }))).toBe(true);
    expect(feedsDev(ticket({ activeRunId: 'r4', activeJob: 'dev-feedback', spec: approved }))).toBe(true);
    expect(feedsDev(ticket({ verifyingRunId: 'r3', spec: approved }))).toBe(true);
    // Nothing at work In Progress: the status alone tells, as it did.
    expect(feedsDev(ticket())).toBe(true);
    expect(feedsDev(ticket({ spec: approved }))).toBe(true);
  });

  it('the status still bounds it: a ticket in Todo or in AI Review gets no instruction reaction, whatever runs', () => {
    expect(feedsDev(ticket({ logical: 'todo', activeRunId: 'r3', activeJob: 'dev' }))).toBe(false);
    expect(feedsDev(ticket({ logical: 'ai_review', activeRunId: 'r4', activeJob: 'dev-feedback' }))).toBe(false);
  });
});

describe('beforeInProgress (ORC-422)', () => {
  it('the steps of the chain before the build, for factory/default', () => {
    for (const id of ['intake', 'clarify', 'spec_draft', 'spec_review', 'tests', 'freeze_tests']) expect(beforeInProgress(workflow, id)).toBe(true);
    for (const id of ['build', 'verify', 'review', 'human_review', 'fix', 'rebase']) expect(beforeInProgress(workflow, id)).toBe(false);
  });

  it('none in a chain whose entry is past the build', () => {
    expect(beforeInProgress(presetWorkflow(preset, {}, 'build'), 'build')).toBe(false);
    // Only the walk is read: an entry no preset builds, past the step that shows In Progress.
    const atReview: Workflow = { ...workflow, entry: 'review' };
    expect(beforeInProgress(atReview, 'review')).toBe(false);
    expect(beforeInProgress(atReview, 'human_review')).toBe(false);
  });
});
