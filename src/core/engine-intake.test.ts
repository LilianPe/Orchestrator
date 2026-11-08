import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput } from './agent-output.js';
import { blockCause } from './block-cause.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type FactoryEvent, type TicketState } from './types.js';

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

  it('an incomplete ticket does not start: blocked on intake with its questions, until clarify exists (ORC-210)', () => {
    const e = finished(assessed({ complete: false, missing: ['Which export format: CSV or XLSX?'] }));
    const out = decide(ticket(), e, workflow);
    expect(out.effects.some((x) => x.kind === 'start_run' || x.kind === 'move')).toBe(false);
    const t = after(ticket(), e);
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake', risk: 'medium' });
    expect(t.blockReason).toContain('Which export format: CSV or XLSX?');
    expect(blockCause(t.blockReason)).toBe('pickup');
    const comment = out.effects.find((x) => x.kind === 'block_comment');
    expect(comment).toMatchObject({ block: { step: 'intake', question: expect.stringContaining('CSV or XLSX') } });
  });

  it('the deterministic checks of its launch are inputs of the guard: a failed one keeps the ticket from starting, even judged complete', () => {
    const e = finished(assessed(), { pickup: ['The description has no acceptance criteria.'] });
    const out = decide(ticket(), e, workflow);
    expect(out.effects.some((x) => x.kind === 'start_run')).toBe(false);
    const t = after(ticket(), e);
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake', size: 'm' });
    expect(t.blockReason).toContain('The description has no acceptance criteria.');
  });

  it('a reply to the guard relaunches intake, which reads the ticket again', () => {
    const blocked = after(ticket(), finished(assessed({ complete: false, missing: ['CSV or XLSX?'] })));
    const reply = { id: 'e-reply', type: 'session.prompted', at: 2000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { linearSessionId: 's1', body: 'CSV', author: 'L', ack: true, kind: 'instruction' } } as FactoryEvent;
    const out = decide({ ...blocked, activeRunId: undefined, activeJob: undefined }, reply, workflow);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'intake' }));
  });

  it('an intake that submits no assessment does not start the ticket', () => {
    const t = after(ticket(), finished(output(undefined)));
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake' });
    expect(t.size).toBeUndefined();
    expect(blockCause(t.blockReason)).toBe('failed');
  });
});
