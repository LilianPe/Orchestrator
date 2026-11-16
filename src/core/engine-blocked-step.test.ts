import { describe, expect, it } from 'vitest';
import { defaultWorkflow } from '../presets/workflow.js';
import type { Role } from './authz.js';
import type { BlockKind } from './block-cause.js';
import type { Decision } from './decision.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';
import type { Workflow } from './workflow.js';

const workflow = defaultWorkflow();

function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload, ...extra } as FactoryEvent;
}
const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, linearSessionId: 's-dev', prNumber: 7, ...patch });
/** A ticket blocked while the check of `r1`, a dev run that ended well, was under way (ORC-403 keeps its done). */
const blockedDuring = (kind: BlockKind, patch: Partial<TicketState> = {}) =>
  ticket({ blocked: true, blockReason: 'x', blockKind: kind, blockedJob: 'dev', verifyingRunId: 'r1', verifiedSha: 'abc', ...patch });
const after = (state: TicketState, event: FactoryEvent, d: Decision): TicketState => d.events.reduce<TicketState>((t, e) => reduce(t, e)!, reduce(state, event)!);
const starts = (d: Decision) => d.effects.filter((e) => e.kind === 'start_run');
const types = (d: Decision) => d.events.map((e) => e.type);
const MEMBER: readonly Role[] = ['team_member'];
const reply = ev('ticket.commented', { body: 'Continue', author: 'Lilian', kind: 'instruction' }, { actor: 'u-member', roles: MEMBER });
const published = ev('publish.done', { runId: 'r1', job: 'dev', sha: 'abc' });

describe('a run published on a blocked ticket: its next step waits for the block, then starts (ORC-416)', () => {
  it('the publication moves the ticket and hands the review to the block: nothing starts, the block stays', () => {
    const out = decide(blockedDuring('infra'), published, workflow);
    expect(out.effects).toContainEqual({ kind: 'move', to: 'ai_review' });
    expect(starts(out)).toEqual([]);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { nextJob: 'review' } });
    expect(types(out)).not.toContain('ticket.unblocked');
  });

  it('acceptance 1: the reply that lifts the block starts the review, not the job the ticket blocked on', () => {
    const state = blockedDuring('infra');
    const blocked = after(state, published, decide(state, published, workflow));
    expect(blocked).toMatchObject({ blocked: true, blockedJob: 'dev', nextJob: 'review' });
    const out = decide(blocked, reply, workflow);
    expect(starts(out)).toEqual([{ kind: 'start_run', job: 'review' }]);
    expect(types(out)).toEqual(expect.arrayContaining(['feedback.appended', 'ticket.unblocked']));
    expect(after(blocked, reply, out)).toMatchObject({ blocked: false, nextJob: undefined });
  });

  it('acceptance 1: the repair of a dead letter that lifts the block starts the review', () => {
    const blocked = ticket({ blocked: true, blockReason: 'x', blockKind: 'dead_letter', blockedEvent: 'l1', blockedJob: 'dev', nextJob: 'review', logical: 'ai_review' });
    const repaired = ev('dead_letter.repaired', { eventId: 'l1', action: 'skip', by: 'ops', event: ev('label.changed', { label: 'x', change: 'added' }) });
    const out = decide(blocked, repaired, workflow);
    expect(starts(out)).toEqual([{ kind: 'start_run', job: 'review' }]);
    expect(reduce(blocked, repaired)).toMatchObject({ blocked: false, nextJob: undefined });
  });

  it('acceptance 1: the green CI that lifts the red-CI bound starts the review', () => {
    const blocked = ticket({ blocked: true, blockReason: 'x', blockKind: 'ci_bound', blockedJob: 'fix-ci', nextJob: 'review', logical: 'ai_review' });
    const out = decide(blocked, ev('pr.checks_passed', { number: 7, url: 'u', branch: 'b' }), workflow);
    expect(types(out)).toContain('ticket.unblocked');
    expect(starts(out)).toEqual([{ kind: 'start_run', job: 'review' }]);
  });

  it('a lift that starts nothing still starts nothing without a step handed to the block', () => {
    const blocked = ticket({ blocked: true, blockReason: 'x', blockKind: 'ci_bound', blockedJob: 'fix-ci', logical: 'ai_review' });
    expect(starts(decide(blocked, ev('pr.checks_passed', { number: 7, url: 'u', branch: 'b' }), workflow))).toEqual([]);
  });

  it('a new block names its own job: the step handed to the old one goes with it', () => {
    const blocked = ticket({ blocked: true, blockReason: 'x', blockKind: 'infra', blockedJob: 'dev', nextJob: 'review' });
    expect(reduce(blocked, { type: 'ticket.blocked', reason: 'Stopped on request', kind: 'stopped' })).toMatchObject({ blocked: true, nextJob: undefined });
  });

  it('a ticket not blocked starts its next step at once, as before', () => {
    const out = decide(ticket({ verifyingRunId: 'r1', verifiedSha: 'abc' }), published, workflow);
    expect(starts(out)).toEqual([{ kind: 'start_run', job: 'review' }]);
    expect(out.events.some((e) => e.type === 'ticket.patched' && 'nextJob' in e.patch)).toBe(false);
  });
});

describe('a check that fails on a blocked ticket: no attempt counted, the block kept (ORC-416)', () => {
  const failures = [{ command: 'npm test', exitCode: 1, output: 'boom' }];
  const failed = (patch: Partial<EventPayloads['verify.failed']> = {}) => ev('verify.failed', { runId: 'r1', job: 'dev', failures, ...patch });

  it('under the bound: no fix started (the launch would refuse it), no attempt counted, no block', () => {
    const out = decide(blockedDuring('infra', { verifyAttempts: 1 }), failed(), workflow);
    expect(starts(out)).toEqual([]);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([]);
  });

  it('acceptance 2: at the bound, a dead letter stays the block, its repair still lifts it', () => {
    const state = blockedDuring('dead_letter', { blockedEvent: 'l1', verifyAttempts: workflow.limits.verifyAttempts - 1 });
    const out = decide(state, failed(), workflow);
    expect(types(out)).not.toContain('ticket.blocked');
    expect(out.effects.some((e) => e.kind === 'block_comment')).toBe(false);
    const kept = after(state, failed(), out);
    expect(kept).toMatchObject({ blocked: true, blockKind: 'dead_letter', blockedEvent: 'l1', blockReason: 'x' });
    const repaired = ev('dead_letter.repaired', { eventId: 'l1', action: 'skip', by: 'ops', event: ev('label.changed', { label: 'x', change: 'added' }) });
    expect(reduce(kept, repaired)?.blocked).toBe(false);
  });

  it('acceptance 2: the loop guard does not replace the block either', () => {
    const state = blockedDuring('infra', { repeatedFailure: { signature: 'dev|t1|npm test:1', count: workflow.limits.repeatedFailures - 1 } });
    const out = decide(state, failed({ tree: 't1' }), workflow);
    expect(types(out)).not.toContain('ticket.blocked');
    expect(after(state, failed({ tree: 't1' }), out)).toMatchObject({ blockKind: 'infra', blockReason: 'x' });
  });

  it('acceptance 2: nor the red check, in blocking mode or when it could not run', () => {
    const tests = workflow.jobs['tests']!;
    const w: Workflow = { ...workflow, jobs: { ...workflow.jobs, tests: { ...tests, red: { ...tests.red!, mode: 'blocking' } } } };
    for (const [red, used] of [['error', 0], ['error', tests.red!.attempts - 1], ['infra', 0]] as const) {
      const out = decide(blockedDuring('infra', { redAttempts: used }), failed({ job: 'tests', red }), w);
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([]);
    }
  });

  it('a ticket not blocked: the fix starts and counts, and the bound blocks, as before', () => {
    const first = decide(ticket({ verifyingRunId: 'r1' }), failed(), workflow);
    expect(first.events).toEqual([{ type: 'ticket.patched', patch: { verifyAttempts: 1 } }]);
    expect(starts(first)).toEqual([expect.objectContaining({ job: 'dev', input: 'verify_failures' })]);
    const last = decide(ticket({ verifyingRunId: 'r1', verifyAttempts: workflow.limits.verifyAttempts - 1 }), failed(), workflow);
    expect(types(last)).toEqual(['ticket.blocked']);
  });
});
