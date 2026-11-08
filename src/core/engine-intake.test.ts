import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Workflow } from '../config/workflow-schema.js';
import type { AgentOutput } from './agent-output.js';
import { causeOf } from './block-cause.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type FactoryEvent, type TicketState } from './types.js';
import { normalizeTicket } from './upcast.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

function finished(output: AgentOutput | undefined, extra: Partial<EventPayloads['run.finished']> = {}): FactoryEvent {
  const payload: EventPayloads['run.finished'] = { runId: 'r1', job: 'intake', outcome: 'success', costUsd: 0.1, turns: 3, lastText: 'ok', attempt: output ? 'succeeded' : 'failed', ...(output ? { output } : {}), ...extra };
  return { id: 'e-finished', type: 'run.finished', at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload } as FactoryEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), delegated: true, activeRunId: 'r1', activeJob: 'intake', linearSessionId: 's1', ...patch };
}
const output = (intake: AgentOutput['intake']): AgentOutput => ({ status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...(intake ? { intake } : {}) });
const assessed = (patch: Partial<NonNullable<AgentOutput['intake']>> = {}) => output({ size: 'm', risk: 'medium', complete: true, missing: [], screen: false, ...patch });
/** The ticket once the decision is applied. */
const after = (t: TicketState, e: FactoryEvent) => decide(t, e, workflow).events.reduce<TicketState | undefined>((s, x) => reduce(s, x), reduce(t, e))!;

describe('intake (ORC-206)', () => {
  it('is an agent step of factory/default at effort low, that writes nothing and does not move the ticket', () => {
    const job = workflow.jobs['intake']!;
    expect(job).toMatchObject({ step: 'intake', queue: 'dev', effort: 'low', structuredOutput: true, pickup: false, onStart: {} });
    expect(job.onSuccess).toEqual({ run: 'dev' });
  });

  it('records the size and the risk it estimated, then the guard lets a complete ticket start dev', () => {
    const e = finished(assessed());
    const out = decide(ticket(), e, workflow);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { size: 'm', risk: 'medium' } });
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'dev' })]);
    expect(after(ticket(), e)).toMatchObject({ size: 'm', risk: 'medium', blocked: false });
  });

  it('plans the visual proof required for a ticket that speaks of a screen', () => {
    expect(after(ticket(), finished(assessed({ screen: true }))).visualProof).toBe('required');
  });

  it('never lifts a visual proof already required', () => {
    expect(after(ticket({ visualProof: 'required' }), finished(assessed({ screen: false }))).visualProof).toBe('required');
  });

  it('never lowers the risk: a lower proposal leaves it as it was, the size follows the last assessment', () => {
    const t = after(ticket({ risk: 'high', size: 'l' }), finished(assessed({ risk: 'low', size: 's' })));
    expect(t).toMatchObject({ risk: 'high', size: 's' });
  });

  it('an incomplete ticket does not start: clarify asks its questions, nothing moves (ORC-210)', () => {
    const e = finished(assessed({ complete: false, missing: ['Which export format: CSV or XLSX?'] }));
    const out = decide(ticket(), e, workflow);
    expect(out.effects.some((x) => x.kind === 'start_run' || x.kind === 'move')).toBe(false);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'elicitation', body: expect.stringContaining('CSV or XLSX') })]);
    expect(after(ticket(), e)).toMatchObject({ blocked: false, risk: 'medium', clarify: { job: 'intake', answered: 0 } });
  });

  it('the deterministic checks of its launch are inputs of the guard: a failed one keeps the ticket from starting, even judged complete', () => {
    const e = finished(assessed(), { pickup: ['The description has no acceptance criteria.'] });
    const out = decide(ticket(), e, workflow);
    expect(out.effects.some((x) => x.kind === 'start_run')).toBe(false);
    const t = after(ticket(), e);
    expect(t).toMatchObject({ blocked: false, size: 'm' });
    // A failed check is a fact, not a question: the ticket's to complete, answered freely.
    expect(t.clarify?.questions).toEqual([{ question: 'The description has no acceptance criteria. Can you complete the ticket, then reply here?', options: [] }]);
  });

  it('a reply to the guard relaunches intake, which reads the ticket again', () => {
    const asked = after(ticket(), finished(assessed({ complete: false, missing: ['CSV or XLSX?'] })));
    const reply = { id: 'e-reply', type: 'session.prompted', at: 2000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { linearSessionId: 's1', body: 'CSV', author: 'L', ack: true, kind: 'instruction' } } as FactoryEvent;
    const out = decide({ ...asked, activeRunId: undefined, activeJob: undefined }, reply, workflow);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'intake' }));
  });

  it('an intake that submits no assessment does not start the ticket', () => {
    const t = after(ticket(), finished(output(undefined)));
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake' });
    expect(t.size).toBeUndefined();
    expect(causeOf(t.blockKind)).toBe('failed');
  });
});

describe('the run boundary of the risk (ORC-365)', () => {
  // Delegation starts with intake, as a repository turns it on.
  const withIntake: Workflow = { ...workflow, on: { ...workflow.on, 'ticket.delegated': workflow.on['ticket.delegated']!.map((r) => ({ ...r, run: 'intake' })) } };
  const delegation = (extra: Partial<FactoryEvent> = {}) =>
    ({ id: 'e-delegated', type: 'ticket.delegated', at: 5000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { linearSessionId: 's2', ack: true }, ...extra }) as FactoryEvent;
  /** A ticket whose last run was assessed `high` with a screen, then taken back: undelegated, no run. */
  const takenBack = (patch: Partial<TicketState> = {}) => ticket({ delegated: false, activeRunId: undefined, activeJob: undefined, risk: 'high', size: 'l', visualProof: 'required', ...patch });
  /** The ticket once `e` is decided under `wf`. */
  const decided = (t: TicketState, e: FactoryEvent, wf = withIntake) => decide(t, e, wf).events.reduce<TicketState | undefined>((s, x) => reduce(s, x), reduce(t, e))!;
  /** The run's intake, started by the delegation. */
  const intakeOf = (t: TicketState) => ({ ...t, activeRunId: 'r1', activeJob: 'intake' });
  const marks = (t: TicketState, e: FactoryEvent, wf = withIntake) => decide(t, e, wf).events.some((x) => x.type === 'ticket.patched' && 'risk' in x.patch && x.patch.risk === null);

  it('within a run, a later intake proposing low leaves a high risk high (criterion 1)', () => {
    const first = after(ticket(), finished(assessed({ risk: 'high', screen: true, complete: false, missing: ['CSV or XLSX?'] })));
    // The answer relaunches intake in the same run: no delegation in between.
    const again = after(intakeOf({ ...first, clarify: null }), finished(assessed({ risk: 'low', screen: false })));
    expect(again).toMatchObject({ risk: 'high', visualProof: 'required' });
  });

  it('a ticket delegated again takes the risk its new intake proposes, low after high, and the visual proof it plans (criterion 2)', () => {
    const delegated = decided(takenBack(), delegation());
    expect(decide(takenBack(), delegation(), withIntake).effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'intake' }));
    // The boundary: the last run's assessment does not carry over, the new run has none yet.
    expect(delegated).toMatchObject({ risk: null, visualProof: null });
    const t = after(intakeOf(delegated), finished(assessed({ risk: 'low', size: 's', screen: false })));
    expect(t).toMatchObject({ risk: 'low', size: 's' });
    expect(t.visualProof ?? undefined).toBeUndefined();
    // Within the new run, the risk goes up again and never down.
    const raised = after(intakeOf(t), finished(assessed({ risk: 'high' })));
    expect(raised.risk).toBe('high');
    expect(after(intakeOf(raised), finished(assessed({ risk: 'low' }))).risk).toBe('high');
  });

  it('a new run whose intake sees a screen requires the visual proof again', () => {
    expect(after(intakeOf(decided(takenBack(), delegation())), finished(assessed({ risk: 'low', screen: true }))).visualProof).toBe('required');
  });

  it('a delegation straight to dev starts a new run too, with no risk until an intake assesses it', () => {
    expect(decided(takenBack(), delegation(), workflow)).toMatchObject({ risk: null, visualProof: null });
  });

  it('a delegation that starts no run leaves the run as it is: refused, a run active, a blocked ticket, a wait on blockers', () => {
    expect(marks(takenBack({ delegated: true, activeRunId: 'r0', activeJob: 'dev' }), delegation())).toBe(false);
    expect(marks(takenBack(), delegation({ actor: 'u-guest', roles: [] }))).toBe(false);
    expect(marks(takenBack({ blocked: true, blockReason: 'Question', blockKind: 'question', blockedJob: 'intake' }), delegation())).toBe(false);
    expect(marks(takenBack({ delegated: true, waitingOn: { blockers: ['REL-2'], start: { job: 'dev' } } }), delegation())).toBe(false);
  });

  it('a first delegation, with nothing assessed yet, patches nothing: the journals of a single run stay as they were', () => {
    expect(decide(undefined, delegation(), withIntake).events.some((x) => x.type === 'ticket.patched' && 'risk' in x.patch)).toBe(false);
  });

  it('a stored ticket from before ORC-365 has no boundary marked: it stays in its run and decides as before (upcast)', () => {
    const stored: Record<string, unknown> = JSON.parse(JSON.stringify(ticket({ risk: 'high', visualProof: 'required' })));
    const old = normalizeTicket(stored as unknown as TicketState);
    expect(old).toMatchObject({ risk: 'high', visualProof: 'required' });
    const e = finished(assessed({ risk: 'low' }));
    expect(decide(old, e, workflow).events).toContainEqual({ type: 'ticket.patched', patch: { size: 'm', risk: 'high' } });
  });
});
