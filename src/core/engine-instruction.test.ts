import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../presets/workflow.js';
import { decide } from './engine.js';
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
    expect(feedsDev({ ...intake, activeJob: 'spec' })).toBe(false);
  });

  it('a spec waiting for its review, or redrafted on /changes, takes no dev-feedback either', () => {
    expect(feedsDev(ticket({ spec: spec() }))).toBe(false);
    expect(feedsDev(ticket({ spec: spec({ approval: { author: 'A', at: 2 }, drafting: true }), pendingJob: { job: 'spec' } }))).toBe(false);
  });

  it('nor does the wait for clarify answers or for the tickets it is blocked by, before the spec', () => {
    expect(feedsDev(ticket({ clarify: { job: 'intake', questions: [{ question: 'CSV ou XLSX ?', options: [] }, { question: 'Quel tri ?', options: [] }], at: 1, answered: 0 } }))).toBe(false);
    expect(feedsDev(ticket({ waitingOn: { blockers: ['REL-2'], start: { job: 'spec' } } }))).toBe(false);
  });

  it('nor do the tests written before the build, still out of In Progress for a ticket delegated from Todo', () => {
    expect(feedsDev(ticket({ activeRunId: 'r2', activeJob: 'tests', spec: spec({ approval: { author: 'A', at: 2 } }) }))).toBe(false);
  });

  it('decides as for the same ticket in Todo: the status a delegation again left behind does not count', () => {
    for (const patch of [{ activeRunId: 'r1', activeJob: 'intake' }, { spec: spec() }]) {
      const strip = ({ timers, trace, ...d }: ReturnType<typeof decide>) => ({ ...d, timers, trace });
      expect(strip(decide(ticket(patch), instruction, workflow))).toEqual(strip(decide(ticket({ ...patch, logical: 'todo' }), instruction, workflow)));
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
