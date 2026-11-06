import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Workflow } from '../config/workflow-schema.js';
import { blockCause } from './block-cause.js';
import type { Role } from './authz.js';
import type { Decision } from './decision.js';
import { BLOCKED_LABEL, decide, mayCheck } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
/** A version frozen before ORC-196, as a recorded journal holds it. */
const frozen: Workflow = (() => {
  const { blockComment: _b, ...rest } = workflow;
  return rest;
})();

function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload, ...extra } as FactoryEvent;
}
const ticket = (patch: Partial<TicketState> = {}): TicketState => ({ ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, linearSessionId: 's-dev', activeRunId: 'r1', activeJob: 'dev', ...patch });
const finished = (patch: Partial<EventPayloads['run.finished']> = {}) => ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'limit', costUsd: 0, turns: 1, lastText: '', ...patch });
const verifying = (patch: Partial<TicketState> = {}) => ticket({ activeRunId: undefined, activeJob: undefined, verifyingRunId: 'r1', ...patch });
const failure = { command: 'npm test', exitCode: 1, output: 'rouge' };

const notice = (d: Decision) => d.effects.find((e) => e.kind === 'block_comment') as Extract<Decision['effects'][number], { kind: 'block_comment' }> | undefined;
const starts = (d: Decision) => d.effects.filter((e) => e.kind === 'start_run');
const MEMBER: readonly Role[] = ['team_member'];
const signed = { actor: 'u-member', roles: MEMBER };
const reply = (extra: Partial<FactoryEvent> = signed) => ev('session.prompted', { linearSessionId: 's-dev', body: 'Continue', author: 'Lilian' }, extra);
const comment = (extra: Partial<FactoryEvent> = signed) => ev('ticket.commented', { body: 'Continue', author: 'Lilian' }, extra);

describe('a block posts the standard comment (ORC-196)', () => {
  it('a run at its cap: structured fields, the comment and the label, and nothing else tells it', () => {
    const out = decide(ticket(), finished(), workflow);
    expect(out.events).toContainEqual({ type: 'ticket.blocked', reason: 'Le run dev a atteint un plafond (tours, durée ou budget).', job: 'dev' });
    expect(notice(out)?.block).toMatchObject({ step: 'build', attempt: 1, max: 1, reason: 'Le run dev a atteint un plafond (tours, durée ou budget).' });
    expect(out.effects).toContainEqual({ kind: 'labels', add: [BLOCKED_LABEL], remove: [] });
    expect(out.effects.filter((e) => e.kind === 'activity' || e.kind === 'comment')).toEqual([]);
  });

  it('the failed checks at the bound: their step, the attempt out of the bound, the commands tried', () => {
    const out = decide(verifying({ verifyAttempts: workflow.limits.verifyAttempts - 1 }), ev('verify.failed', { runId: 'r1', job: 'dev', failures: [failure] }), workflow);
    const max = workflow.limits.verifyAttempts;
    expect(notice(out)?.block).toMatchObject({ step: 'verify', attempt: max, max, tried: ['`npm test` (code 1)'] });
  });

  it('a question of the agent is the comment\'s question, its block the cause « question »', () => {
    const out = decide(ticket(), finished({ outcome: 'success', attempt: 'needs_input', output: { status: 'blocked', question: 'Quel séparateur ?' } as never }), workflow);
    expect(notice(out)?.block.question).toBe('Quel séparateur ?');
    expect(blockCause(reduce(ticket(), out.events[0]!)?.blockReason)).toBe('question');
  });

  it.each<[string, TicketState, FactoryEvent, string]>([
    ['a cap', ticket(), finished(), 'limit'],
    ['a failed run', ticket(), finished({ outcome: 'failure' }), 'failed'],
    ['the loop guard', ticket(), finished({ stagnation: { kind: 'loop', command: 'npm test', failure: 'f', tree: 't', count: 3 } }), 'loop'],
    ['a verification that could not run', verifying(), ev('verify.errored', { runId: 'r1', job: 'dev', error: 'moteur' }), 'infra'],
  ])('the Flux still reads the cause of %s from the reason', (_what, state, event, cause) => {
    const out = decide(state, event, workflow);
    expect(notice(out)).toBeDefined();
    expect(blockCause(out.events.reduce<TicketState | undefined>((t, e) => reduce(t, e), state)?.blockReason)).toBe(cause);
  });

  it('a dead letter is told in the same comment, and its repair still lifts its block', () => {
    const out = decide(ticket(), ev('dead_letter.added', { eventId: 'x', eventType: 'pr.opened', error: 'boom', failures: 1 }), workflow);
    expect(notice(out)?.block.question).toContain('factory run repair REL-1');
    expect(out.effects.filter((e) => e.kind === 'activity')).toEqual([]);
    expect(blockCause(reduce(ticket(), out.events[0]!)?.blockReason)).toBe('dead_letter');
  });

  it('a team with no repo: the comment says a reply is not enough, and still blocks with its reason', () => {
    const out = decide(undefined, ev('ticket.delegated', { linearSessionId: 's1', noRepo: 'ZZZ', issue: { title: 'T', logical: 'todo', priority: 0 } } as never), workflow);
    expect(notice(out)?.block).toMatchObject({ waits: true });
    expect(blockCause((out.events[0] as { reason: string }).reason)).toBe('pickup');
    expect(out.effects.filter((e) => e.kind === 'activity')).toEqual([]);
  });

  it('a ticket whose repo is to be chosen: the same comment, a reply is not enough', () => {
    const out = decide(undefined, ev('ticket.delegated', { linearSessionId: 's1', repos: ['web', 'api'], issue: { title: 'T', logical: 'todo', priority: 0 } } as never), workflow);
    expect(notice(out)?.block).toMatchObject({ waits: true });
    expect(notice(out)?.block.question).toContain('repo:web');
  });

  it('a failed effect blocks by the comment; the death of that comment changes neither its reason nor the label', () => {
    const blocked = decide(ticket(), ev('effect.failed', { effectId: 'p:1:0', kind: 'move', eventId: 'e1', attempts: 8, error: 'boom' }), workflow);
    expect(notice(blocked)?.block.reason).toBe('Erreur : boom');
    const state = ticket({ blocked: true, blockReason: 'Le run dev a échoué.', blockedJob: 'dev' });
    const died = decide(state, ev('effect.failed', { effectId: 'p:1:0', kind: 'block_comment', eventId: 'e1', attempts: 8, error: 'down' }), workflow);
    expect(died.events).toEqual([]);
    expect(died.effects).toEqual([]);
  });

  it('a stop stays an answer in the session, without the label that is gone', () => {
    const out = decide(ticket(), ev('control.stop', {}), workflow);
    expect(out.effects).toContainEqual({ kind: 'activity', type: 'response', body: 'Arrêté. Répondez dans ce ticket pour relancer.' });
  });

  it('the pack no longer knows `agent:reprendre`', () => {
    expect((workflow.on['label.changed'] ?? []).map((r) => r.label)).toEqual(['agent:stop']);
  });
});

describe('versions frozen before it decide bit for bit as they did', () => {
  it('the run\'s cap: the elicitation, no comment, no job on the event', () => {
    const out = decide(ticket(), finished(), frozen);
    expect(out.events).toEqual([{ type: 'ticket.blocked', reason: 'Le run dev a atteint un plafond (tours, durée ou budget).' }]);
    expect(out.effects[0]).toEqual({ kind: 'activity', type: 'elicitation', body: 'Le run dev a atteint un plafond (tours, durée ou budget). Répondez dans ce fil pour que je reprenne.' });
    expect(notice(out)).toBeUndefined();
  });

  it('a stop keeps its sentence, a comment is no reply, a reply runs the rule\'s job', () => {
    expect(decide(ticket(), ev('control.stop', {}), frozen).effects).toContainEqual({ kind: 'activity', type: 'response', body: 'Arrêté. Répondez dans ce fil ou posez le label agent:reprendre pour relancer.' });
    const blocked = ticket({ blocked: true, blockReason: 'Le run dev a échoué.', activeRunId: undefined });
    expect(decide(blocked, comment(), frozen)).toMatchObject({ events: [], effects: [] });
    expect(starts(decide({ ...blocked, blockedJob: 'dev' }, reply(), frozen))[0]).toMatchObject({ job: 'dev-feedback' });
  });

  it('the death of a notice\'s comment on them blocks as any effect did', () => {
    const state = ticket();
    const out = decide(state, ev('effect.failed', { effectId: 'p:1:0', kind: 'comment', eventId: 'e1', attempts: 8, error: 'down' }), frozen);
    expect(out.effects).toContainEqual({ kind: 'labels', add: [BLOCKED_LABEL], remove: [] });
  });
});

describe('a reply resumes the blocked step (ORC-196)', () => {
  const blockedOn = (job: string, patch: Partial<TicketState> = {}) => ticket({ blocked: true, blockReason: 'Le run a échoué.', blockedJob: job, activeRunId: undefined, activeJob: undefined, ...patch });

  it.each([
    ['in the session', reply()],
    ['as a comment on the ticket', comment()],
  ])('a member\'s reply %s starts the job that blocked, with the reply to read, and lifts the label', (_where, event) => {
    const out = decide(blockedOn('dev'), event, workflow);
    expect(starts(out)).toEqual([{ kind: 'start_run', job: 'dev', input: 'feedback' }]);
    expect(out.events.map((e) => e.type)).toEqual(expect.arrayContaining(['feedback.appended', 'ticket.unblocked']));
    expect(out.effects).toContainEqual({ kind: 'labels', add: [], remove: [BLOCKED_LABEL] });
  });

  it('the tests step, the fix of a red CI and the review are each resumed, not `dev-feedback`', () => {
    for (const job of ['tests', 'fix-ci', 'review']) expect(starts(decide(blockedOn(job), comment(), workflow))[0]).toMatchObject({ job, input: 'feedback' });
  });

  it('gives the bounds back as any human relaunch, ORC-220\'s among them', () => {
    const out = decide(blockedOn('dev', { cutRelaunches: [1], leaseRelaunches: 1, repeatedFailure: { signature: 's', count: 3 } }), comment(), workflow);
    expect(out.events).toEqual(expect.arrayContaining([{ type: 'ticket.patched', patch: { cutRelaunches: [] } }, { type: 'ticket.patched', patch: { leaseRelaunches: 0 } }, { type: 'ticket.patched', patch: { repeatedFailure: null } }]));
  });

  it('a block with no step to resume (stop, dead letter, a commit the job does not fix, a refused publication) relaunches the rule\'s job', () => {
    const state = ticket({ blocked: true, blockReason: 'Arrêté à la demande', activeRunId: undefined });
    expect(starts(decide(state, comment(), workflow))[0]).toMatchObject({ job: 'dev-feedback' });
    const review = decide(verifying({ activeJob: 'review' }), ev('verify.failed', { runId: 'r1', job: 'review', failures: [failure] }), workflow);
    expect(review.events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked' }));
    expect((review.events.find((e) => e.type === 'ticket.blocked') as { job?: string }).job).toBeUndefined();
    const refused = decide(verifying(), ev('publish.refused', { runId: 'r1', job: 'dev', reason: 'diff trop gros' } as never), workflow);
    expect((refused.events.find((e) => e.type === 'ticket.blocked') as { job?: string }).job).toBeUndefined();
    expect(notice(refused)?.block.step).toBe('publish');
  });

  it('a refused reply: journaled and answered in the ticket, nothing kept, still blocked', () => {
    const outsider = { actor: 'u-out', roles: [] as readonly Role[] };
    const out = decide(blockedOn('dev'), comment(outsider), workflow);
    expect(out.trace.join()).toContain('authz: refused relaunch_blocked');
    expect(out.effects).toEqual([{ kind: 'comment', body: expect.stringContaining('Refusé') }]);
    expect(out.events).toEqual([]);
    expect(decide(blockedOn('dev'), reply(outsider), workflow).effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-dev', body: expect.stringContaining('Refusé') }]);
  });

  it('a comment on a ticket that waits for no reply is between humans: nothing is kept, nothing starts', () => {
    expect(decide(ticket(), comment(), workflow)).toMatchObject({ events: [], effects: [] });
    expect(decide(blockedOn('dev', { delegated: false }), comment(), workflow)).toMatchObject({ events: [], effects: [] });
  });

  it('a comment does not end a wait for the repo: only a delegation does', () => {
    const out = decide(blockedOn('dev', { awaitingRepo: ['web', 'api'] }), comment(), workflow);
    expect(out).toMatchObject({ events: [], effects: [] });
  });

  it('the roles of who comments are resolved, journaled with the event', () => {
    expect(mayCheck(comment({}), workflow)).toBe(true);
  });

  it('unblocked, the ticket forgets the step', () => {
    const t = reduce(ticket(), { type: 'ticket.blocked', reason: 'r', job: 'dev' });
    expect(t?.blockedJob).toBe('dev');
    expect(reduce(t, { type: 'ticket.unblocked' })?.blockedJob).toBeUndefined();
    expect(reduce(t, { type: 'ticket.blocked', reason: 'other' })?.blockedJob).toBeUndefined();
  });
});
