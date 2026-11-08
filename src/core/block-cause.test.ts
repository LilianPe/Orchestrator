import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput } from './agent-output.js';
import { causeOf, restatesCause, type BlockKind } from './block-cause.js';
import { liftDeadLetterBlock } from './dead-letter.js';
import { decide, settledTicket } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type InternalEvent, type TicketState } from './types.js';
import { legacyBlock } from './upcast.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const blocking = { ...workflow, jobs: { ...workflow.jobs, tests: { ...workflow.jobs['tests']!, red: { ...workflow.jobs['tests']!.red!, mode: 'blocking' as const } } } };

function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', ...extra, payload } as FactoryEvent;
}
const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, ...patch });
const finished = (patch: Partial<EventPayloads['run.finished']>) => ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '', ...patch });
const failure = { command: 'npm test', exitCode: 1, output: 'rouge' };
const intaking = ticket({ logical: 'todo', activeRunId: 'r1', activeJob: 'intake' });
const INTAKE_OUTPUT: AgentOutput = { status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] };

/** The block `decide` writes: the kind is read from what the engine really emits. */
function blockOf(state: TicketState, event: FactoryEvent, wf = workflow): Extract<InternalEvent, { type: 'ticket.blocked' }> {
  const blocked = decide(state, event, wf).events.find((e) => e.type === 'ticket.blocked');
  if (blocked?.type !== 'ticket.blocked') throw new Error(`${event.type} did not block`);
  return blocked;
}

describe('the kind of a block, set by the code that builds it (ORC-345)', () => {
  it.each([
    ['question', () => blockOf(ticket({ activeRunId: 'r1' }), finished({ attempt: 'needs_input', output: { question: 'Laquelle ?' } as EventPayloads['run.finished']['output'] }))],
    ['contested', () => blockOf(ticket({ activeRunId: 'r1' }), finished({ attempt: 'spec_impossible', output: { question: 'Impossible.' } as EventPayloads['run.finished']['output'] }))],
    ['infra', () => blockOf(ticket({ activeRunId: 'r1' }), finished({ attempt: 'errored' }))],
    ['limit', () => blockOf(ticket({ activeRunId: 'r1' }), finished({ outcome: 'limit' }))],
    ['failed', () => blockOf(ticket({ activeRunId: 'r1' }), finished({ outcome: 'failure' }))],
    ['limit', () => blockOf(ticket({ verifyingRunId: 'r1', verifyAttempts: workflow.limits.verifyAttempts - 1 }), ev('verify.failed', { runId: 'r1', job: 'dev', failures: [failure] }))],
    ['loop', () => blockOf(ticket({ verifyingRunId: 'r1', repeatedFailure: { signature: 'dev|abc|npm test:1', count: 2 } }), ev('verify.failed', { runId: 'r1', job: 'dev', tree: 'abc', failures: [failure] }))],
    ['ci_bound', () => blockOf(ticket({ logical: 'human_review', prNumber: 3, ciFixAttempts: 2 }), ev('pr.checks_failed', { number: 3, url: 'u', branch: 'b', failures: ['test'] }))],
    ['red', () => blockOf(ticket({ verifyingRunId: 'r1', redAttempts: blocking.jobs['tests']!.red!.attempts - 1 }), ev('verify.failed', { runId: 'r1', job: 'tests', red: 'compile', failures: [failure] }), blocking)],
    ['infra', () => blockOf(ticket({ verifyingRunId: 'r1' }), ev('verify.failed', { runId: 'r1', job: 'tests', red: 'infra', failures: [failure] }))],
    ['stopped', () => blockOf(ticket({ activeRunId: 'r1' }), ev('control.stop', {}))],
    ['infra', () => blockOf(ticket(), ev('effect.failed', { effectId: 'x:1:1', kind: 'comment', eventId: 'e1', attempts: 8, error: 'boom' }))],
    ['stuck', () => blockOf(ticket({ pendingJob: { job: 'dev-feedback' } }), ev('effect.failed', { effectId: 'x:1:1', kind: 'settle', eventId: 'e1', attempts: 8, error: 'connection reset' }))],
    ['infra', () => blockOf(ticket({ activeRunId: 'r1', leaseRelaunches: 1 }), ev('run.lost', { runId: 'r1', job: 'dev', cause: 'lease' }))],
    ['limit', () => blockOf(ticket({ activeRunId: 'r1', cutRelaunches: [997, 998, 999] }), ev('run.lost', { runId: 'r1', job: 'dev', cause: 'restart' }))],
    ['pr_closed', () => blockOf(ticket({ activeRunId: 'r1', prNumber: 3, prState: 'OPEN' }), ev('pr.closed', { number: 3, url: 'u', branch: 'b' }))],
    ['pickup', () => blockOf(ticket({ delegated: false }), ev('ticket.delegated', { linearSessionId: 's1', noRepo: 'ZZZ' }))],
    ['pickup', () => blockOf(ticket({ delegated: false }), ev('ticket.delegated', { linearSessionId: 's1', repos: ['web', 'api'] }))],
    ['dead_letter', () => blockOf(ticket(), ev('dead_letter.added', { eventId: 'e9', eventType: 'pr.opened', error: 'boom', failures: 1 }))],
    // The guard of intake (ORC-206): an incomplete ticket is a refused pickup, an intake without assessment a failed run.
    ['pickup', () => blockOf(intaking, finished({ job: 'intake', outcome: 'success', attempt: 'succeeded', output: { ...INTAKE_OUTPUT, intake: { size: 'm', risk: 'medium', complete: false, missing: ['CSV or XLSX?'], screen: false } } }))],
    ['failed', () => blockOf(intaking, finished({ job: 'intake', outcome: 'success', attempt: 'failed' }))],
  ] as const)('%s, for a block decide writes; its reason upcasts to the same kind', (kind, block) => {
    const b = block();
    expect(b.kind).toBe(kind);
    // The one place that still reads a reason gives a ticket blocked before ORC-345 the kind decide sets today: what keeps
    // the recorded journals, whose tickets hold the reason alone, replaying bit for bit. A reason reworded later is no
    // longer one a ticket blocked before ORC-345 can hold: take its case out of this check, keep the old head in the table.
    expect(legacyBlock(b.reason).blockKind).toBe(kind);
  });

  it('budget, for a step past its token or turn cap (ORC-216): a kind of its own under the cause limit, set by decide, never read from a reason', () => {
    for (const overBudget of ['tokens', 'turns'] as const) expect(blockOf(ticket({ activeRunId: 'r1' }), finished({ outcome: 'limit', overBudget })).kind).toBe('budget');
    expect(causeOf('budget')).toBe('limit');
    // A ticket blocked on the ticket's budget before ORC-216 keeps the kind its reason gave it.
    expect(legacyBlock('Token budget of the ticket reached: 1000 tokens spent of 1000 by its code runs (budgets.per_ticket_tokens).').blockKind).toBe('limit');
  });

  it('conflict, for a rebase the agent stops on and for the bound the rebases reach: a kind of its own, under its own cause (ORC-146)', () => {
    const rebasing = ticket({ logical: 'human_review', activeRunId: 'r1', activeJob: 'rebase', prNumber: 3, prState: 'OPEN' });
    const stop = finished({ job: 'rebase', outcome: 'success', attempt: 'needs_input', output: { ...INTAKE_OUTPUT, status: 'blocked', reason: 'conflict', conflict: 'logic', question: 'Which side?' } });
    expect(blockOf(rebasing, stop).kind).toBe('conflict');
    const bound = ticket({ logical: 'human_review', prNumber: 3, prState: 'OPEN', ciFixAttempts: workflow.limits.ciFixAttempts });
    expect(blockOf(bound, ev('pr.conflicted', { number: 3, url: 'u', branch: 'b', headSha: 'h', baseRef: 'main' })).kind).toBe('conflict');
    expect(causeOf('conflict')).toBe('conflict');
  });

  it('records the dead-lettered event with its block', () => {
    expect(blockOf(ticket(), ev('dead_letter.added', { eventId: 'e9', eventType: 'pr.opened', error: 'boom', failures: 1 }))).toMatchObject({ kind: 'dead_letter', eventId: 'e9' });
  });

  it('shows each kind under its cause, `other` without a kind', () => {
    expect(causeOf('asked')).toBe('question');
    expect(causeOf('stuck')).toBe('infra');
    expect(causeOf('ci_bound')).toBe('limit');
    expect(causeOf('red')).toBe('red');
    expect(causeOf(undefined)).toBe('other');
    // Written by a newer version: its ticket stays in sight.
    expect(causeOf('a_kind_from_tomorrow' as BlockKind)).toBe('other');
  });

  it('knows the kinds whose reason says no more than their cause (ORC-332)', () => {
    expect(restatesCause('stopped')).toBe(true);
    expect(restatesCause('asked')).toBe(true);
    expect(restatesCause('question')).toBe(false);
    expect(restatesCause(undefined)).toBe(false);
  });
});

/** A blocked ticket as the projection holds it, with a reworded reason: what the engine decides on is the kind. */
const blockedBy = (kind: BlockKind, extra: Partial<TicketState> = {}): TicketState => ticket({ blocked: true, blockKind: kind, blockReason: 'A reason reworded since.', ...extra });

describe('a reworded reason changes no decision (ORC-345, criterion 1)', () => {
  it('a green CI lifts the red-CI bound by its kind, and only it', () => {
    const green = ev('pr.checks_passed', { number: 3, url: 'u', branch: 'b' });
    expect(decide(blockedBy('ci_bound', { prNumber: 3 }), green, workflow).events).toContainEqual({ type: 'ticket.unblocked' });
    // The sentence of the bound on a block of another kind lifts nothing.
    expect(decide(blockedBy('limit', { prNumber: 3, blockReason: 'CI still failing after 2 attempts of fix-ci.' }), green, workflow).events).not.toContainEqual({ type: 'ticket.unblocked' });
  });

  it('a stop settles the ticket by its kind, not by its sentence', () => {
    expect(settledTicket(blockedBy('stopped'))).toBe('stopped');
    expect(settledTicket(blockedBy('infra', { blockReason: 'Stopped on request' }))).toBeUndefined();
    // A failure after it blocks nothing again.
    expect(decide(blockedBy('stopped'), ev('effect.failed', { effectId: 'x:1:1', kind: 'comment', eventId: 'e1', attempts: 8, error: 'boom' }), workflow).events).toEqual([]);
  });

  it("a repair lifts its own dead letter's block by kind and event, whatever its reason says", () => {
    expect(liftDeadLetterBlock(blockedBy('dead_letter', { blockedEvent: 'e9' }), 'e9')).toMatchObject({ blocked: false, blockReason: undefined, blockKind: undefined, blockedEvent: undefined });
    const other = blockedBy('dead_letter', { blockedEvent: 'e8', blockReason: 'Event e9 set aside (pr.opened): its decision failed (boom).' });
    expect(liftDeadLetterBlock(other, 'e9')).toBe(other);
  });

  it('a reply starts the pending job a stuck settle left, by its kind (ORC-360), and not one held by another block', () => {
    const reply = ev('session.prompted', { linearSessionId: 's1', body: 'go', author: 'L' });
    const pendingJob = { job: 'fix-ci', input: 'verify_failures' as const, inputText: 'rouge', resume: true };
    const held = (kind: BlockKind, blockReason: string) => blockedBy(kind, { logical: 'human_review', pendingJob, blockedJob: 'fix-ci', linearSessionId: 's1', blockReason });
    const starts = (t: TicketState) => decide(t, reply, workflow).events.some((e) => e.type === 'pending.cleared');
    expect(starts(held('stuck', 'Reworded.'))).toBe(true);
    // The sentence of a stuck settle on the red-CI bound's block starts nothing.
    expect(starts(held('ci_bound', 'Error: the pending fix-ci could not be started: boom'))).toBe(false);
  });

  it('reduce records the kind and its event with the block, and clears them with it', () => {
    const blocked = reduce(ticket(), { type: 'ticket.blocked', reason: 'r', kind: 'dead_letter', eventId: 'e9' });
    expect(blocked).toMatchObject({ blocked: true, blockReason: 'r', blockKind: 'dead_letter', blockedEvent: 'e9' });
    expect(reduce(blocked, { type: 'ticket.unblocked' })).toMatchObject({ blocked: false, blockKind: undefined, blockedEvent: undefined });
  });
});
