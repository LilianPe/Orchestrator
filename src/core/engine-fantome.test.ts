import { describe, expect, it } from 'vitest';
import { defaultWorkflow, presetWorkflow } from '../presets/workflow.js';
import { fantome, FANTOME_APPROVER } from '../presets/fantome.js';
import type { AgentOutput } from './agent-output.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import type { Spec } from './spec.js';
import { newTicketState, type EventPayloads, type FactoryEvent, type TicketState } from './types.js';

/**
 * The Rapide level of `factory/fantome` (ORC-231): a closed ticket has nobody to answer. What `clarify` would ask is assumed,
 * written in the spec and counted; the spec that passes `spec_check` is approved by the preset, and the tests start.
 */
const workflow = presetWorkflow(fantome);

const SPEC: Spec = { goal: 'Export the audits as CSV.', out_of_scope: [], criteria: ['Given 2 audits, when I click CSV, then 3 lines.'], files: ['src/export.ts'], architecture: 'None.', risks: [], assumed: ['the CSV library escapes quotes'] };
const output = (extra: Partial<AgentOutput>): AgentOutput => ({ status: 'done', summary: 'Done.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...extra });

let seq = 0;
function finished(job: string, out: AgentOutput, extra: Partial<EventPayloads['run.finished']> = {}): FactoryEvent {
  const payload: EventPayloads['run.finished'] = { runId: 'r1', job, outcome: 'success', costUsd: 0.1, turns: 3, lastText: 'ok', attempt: 'succeeded', output: out, ...extra };
  return { id: `e-${++seq}`, type: 'run.finished', at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload } as FactoryEvent;
}
const ev = <T extends keyof EventPayloads>(type: T, payload: EventPayloads[T]): FactoryEvent =>
  ({ id: `e-${++seq}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload }) as FactoryEvent;
const ticket = (job: string, patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), delegated: true, activeRunId: 'r1', activeJob: job, linearSessionId: 's1', ...patch });
const after = (t: TicketState, e: FactoryEvent) => decide(t, e, workflow).events.reduce<TicketState | undefined>((s, x) => reduce(s, x), reduce(t, e))!;
const incomplete = output({ intake: { size: 'm', risk: 'medium', complete: false, missing: [{ question: 'Which format: CSV or XLSX?', options: ['CSV', 'XLSX'] }, 'Who may export?'], screen: false } });

describe('the Rapide level of factory/fantome (ORC-231)', () => {
  it('an incomplete ticket asks nothing: its questions are assumed, and the spec is drafted', () => {
    const out = decide(ticket('intake'), finished('intake', incomplete), workflow);
    expect(out.effects.some((x) => x.kind === 'activity')).toBe(false);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'spec' })]);
    const t = after(ticket('intake'), finished('intake', incomplete));
    expect(t.clarify ?? null).toBeNull();
    expect(t.assumed).toEqual(['Unasked: Which format: CSV or XLSX? (options: CSV, XLSX)', 'Unasked: Who may export?']);
  });

  it('a failed pickup check is assumed too, as a question nobody answers', () => {
    const t = after(ticket('intake'), finished('intake', output({ intake: { size: 's', risk: 'low', complete: true, missing: [], screen: false } }), { pickup: ['The description is too short.'] }));
    expect(t.assumed).toEqual(['Unasked: The description is too short.']);
  });

  it('a spec that passes spec_check is approved by the preset, its assumptions written in it, and the tests start', () => {
    const t0 = ticket('spec', { assumed: ['Unasked: Who may export?'] });
    const out = decide(t0, finished('spec', output({ spec: SPEC })), workflow);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'tests' })]);
    const t = after(t0, finished('spec', output({ spec: SPEC })));
    expect(t.spec).toMatchObject({ version: 1, approval: { author: FANTOME_APPROVER } });
    expect(t.spec!.spec.assumed).toEqual(['the CSV library escapes quotes', 'Unasked: Who may export?']);
  });

  it('a spec that fails spec_check still goes back to spec_draft, as at any level', () => {
    const out = decide(ticket('spec'), finished('spec', output({ spec: { ...SPEC, criteria: [] } })), workflow);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'spec', input: 'spec_check' })]);
  });

  it('reacts to its delegation alone, whatever the state of the closed ticket: a human on the real one starts nothing (ORC-392)', () => {
    const delegated = (logical: TicketState['logical']) => decide(ticket('intake', { logical, activeRunId: undefined, activeJob: undefined }), ev('ticket.delegated', {}), workflow);
    for (const logical of ['todo', 'human_review', 'done'] as const) expect(delegated(logical).effects, logical).toEqual([expect.objectContaining({ kind: 'start_run', job: 'intake' })]);
    const idle = ticket('dev', { logical: 'human_review', activeRunId: undefined, activeJob: undefined, prNumber: 3, prState: 'OPEN' });
    const events: FactoryEvent[] = [
      ev('session.prompted', { linearSessionId: 's1', body: 'encore', author: 'L' }),
      ev('session.mentioned', { linearSessionId: 's2', body: 'pourquoi ?', author: 'L' }),
      ev('status.changed', { from: 'human_review', to: 'ai_review' }),
      ev('label.changed', { label: 'bug', change: 'added' }),
      ev('session.stopped', { linearSessionId: 's1' }),
      ev('pr.checks_failed', { number: 3, url: 'u', branch: 'b', failures: ['test'] }),
      ev('pr.conflicted', { number: 3, url: 'u', branch: 'b', headSha: 'h', baseRef: 'main' }),
    ];
    for (const e of events) expect(decide(idle, e, workflow).trace, e.type).toContain(`no rule for ${e.type}`);
    const blocked = { ...idle, blocked: true };
    expect(decide(blocked, ev('ticket.commented', { body: 'reprends', author: 'L', kind: 'instruction' }), workflow).trace).toContain('no rule for ticket.commented');
    // A merge records the delivery, with no move nor step after it.
    expect(decide(idle, ev('pr.merged', { number: 3, url: 'u', branch: 'b' }), workflow).effects).toEqual([{ kind: 'stop_run' }]);
  });

  it('factory/default asks its questions as before', () => {
    const standard = defaultWorkflow();
    const out = decide(ticket('intake'), finished('intake', incomplete), standard);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'elicitation' })]);
  });
});
