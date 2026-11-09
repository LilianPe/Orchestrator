import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Workflow } from '../config/workflow-schema.js';
import { causeOf, type BlockKind } from './block-cause.js';
import type { Role } from './authz.js';
import type { Decision } from './decision.js';
import { BLOCKED_LABEL, decide, mayCheck, SENSITIVE_PATHS } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type FeedbackItem, type MessageKind, type TicketState } from './types.js';
import { beforeOrc183 } from '../../test/helpers/frozen-review.js';

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
/** A row journaled before ORC-180, with no class: what a frozen version replays. */
const reply = (extra: Partial<FactoryEvent> = signed) => ev('session.prompted', { linearSessionId: 's-dev', body: 'Continue', author: 'Lilian' }, extra);
const comment = (extra: Partial<FactoryEvent> = signed, kind: MessageKind = 'instruction', patch: Partial<EventPayloads['ticket.commented']> = {}) => ev('ticket.commented', { body: 'Continue', author: 'Lilian', kind, ...patch }, extra);
/** A reply as the webhook brings it: classified (ORC-180). */
const classified = (kind: MessageKind, body: string, linearSessionId = 's-dev', extra: Partial<FactoryEvent> = signed) => ev('session.prompted', { linearSessionId, body, author: 'Lilian', ack: true, kind }, extra);

describe('a block posts the standard comment (ORC-196)', () => {
  it('a run at its cap: structured fields, the comment and the label, and nothing else tells it', () => {
    const out = decide(ticket(), finished(), workflow);
    expect(out.events).toContainEqual({ type: 'ticket.blocked', reason: 'The run dev reached a limit (turns, duration or budget).', kind: 'limit', job: 'dev' });
    expect(notice(out)?.block).toMatchObject({ step: 'build', max: 1, reason: 'The run dev reached a limit (turns, duration or budget).' });
    expect(notice(out)?.block).not.toHaveProperty('attempt');
    expect(out.effects).toContainEqual({ kind: 'labels', add: [BLOCKED_LABEL], remove: [] });
    expect(out.effects.filter((e) => e.kind === 'activity' || e.kind === 'comment')).toEqual([]);
  });

  it('the failed checks at the bound: their step, the attempt out of the bound, the commands tried', () => {
    const out = decide(verifying({ verifyAttempts: workflow.limits.verifyAttempts - 1 }), ev('verify.failed', { runId: 'r1', job: 'dev', failures: [failure] }), workflow);
    const max = workflow.limits.verifyAttempts;
    expect(notice(out)?.block).toMatchObject({ step: 'verify', max, tried: ['`npm test` (code 1)'] });
  });

  it('a question of the agent is the comment\'s question, its block the cause « question »', () => {
    const out = decide(ticket(), finished({ outcome: 'success', attempt: 'needs_input', output: { status: 'blocked', question: 'Quel séparateur ?' } as never }), workflow);
    expect(notice(out)?.block.question).toBe('Quel séparateur ?');
    expect(causeOf(reduce(ticket(), out.events[0]!)?.blockKind)).toBe('question');
  });

  it('an agent that gives no question, or no justification, leaves the default question: no empty line', () => {
    const asks = decide(ticket(), finished({ outcome: 'success', attempt: 'needs_input', output: { status: 'blocked', question: '' } as never }), workflow);
    expect(notice(asks)?.block.question).toMatch(/^Shall I redo the step/);
    const disputes = decide(ticket(), finished({ outcome: 'success', attempt: 'spec_impossible', output: { status: 'blocked' } as never }), workflow);
    expect(notice(disputes)?.block.question).toMatch(/^Can you fix the ticket/);
  });

  it.each<[string, TicketState, FactoryEvent, string]>([
    ['a cap', ticket(), finished(), 'limit'],
    ['a failed run', ticket(), finished({ outcome: 'failure' }), 'failed'],
    ['the loop guard', ticket(), finished({ stagnation: { kind: 'loop', command: 'npm test', failure: 'f', tree: 't', count: 3 } }), 'loop'],
    ['a verification that could not run', verifying(), ev('verify.errored', { runId: 'r1', job: 'dev', error: 'moteur' }), 'infra'],
  ])('the Flow reads the cause of %s from its kind', (_what, state, event, cause) => {
    const out = decide(state, event, workflow);
    expect(notice(out)).toBeDefined();
    expect(causeOf(out.events.reduce<TicketState | undefined>((t, e) => reduce(t, e), state)?.blockKind)).toBe(cause);
  });

  it('a red check that could not run says why in the comment', () => {
    const wf: Workflow = { ...workflow, jobs: { ...workflow.jobs, tests: { ...workflow.jobs['tests']!, red: { command: 'npm test --', mode: 'measure', attempts: 3 } } } };
    const out = decide(verifying({ activeJob: 'tests' }), ev('verify.failed', { runId: 'r1', job: 'tests', red: 'infra', failures: [{ command: 'factory/red', exitCode: null, output: 'base absente' }] }), wf);
    // One line per check, as every verify path: never the raw output.
    expect(notice(out)?.block).toMatchObject({ step: 'red', tried: ['`factory/red` (code timeout)'] });
  });

  it('a dead letter is told in the same comment, and its repair still lifts its block', () => {
    const out = decide(ticket(), ev('dead_letter.added', { eventId: 'x', eventType: 'pr.opened', error: 'boom', failures: 1 }), workflow);
    expect(notice(out)?.block.question).toContain('factory run repair REL-1');
    expect(out.effects.filter((e) => e.kind === 'activity')).toEqual([]);
    expect(causeOf(reduce(ticket(), out.events[0]!)?.blockKind)).toBe('dead_letter');
  });

  it('a row out of its attempts says so: the attempts in the header and what was tried, no failed decision for an outage (ORC-320)', () => {
    const out = decide(ticket(), ev('dead_letter.added', { eventId: 'x', eventType: 'pr.opened', error: 'connection refused', failures: 1, attempts: 5 }), workflow);
    expect(notice(out)?.block).toMatchObject({ max: 5, tried: ['5 attempts to process this event.'], reason: 'Event x set aside (pr.opened): 5 attempts without success (connection refused).' });
    expect(out.events[0]).toMatchObject({ type: 'ticket.blocked', kind: 'dead_letter', eventId: 'x' });
    expect(reduce(reduce(ticket(), out.events[0]!), { ...ev('dead_letter.repaired', { eventId: 'x', action: 'skip', by: 'ops', event: {} as never }) } as FactoryEvent)?.blocked).toBe(false);
  });

  it('a row whose decision threw keeps its sentence, and so does one journaled before', () => {
    const out = decide(ticket(), ev('dead_letter.added', { eventId: 'x', eventType: 'pr.opened', error: 'boom', failures: 1 }), workflow);
    expect(notice(out)?.block).toMatchObject({ max: 1, tried: ['1 decision(s) of this event.'], reason: 'Event x set aside (pr.opened): its decision failed (boom).' });
  });

  it('a team with no repo: the comment says a reply is not enough, and still blocks with its reason', () => {
    const out = decide(undefined, ev('ticket.delegated', { linearSessionId: 's1', noRepo: 'ZZZ', issue: { title: 'T', logical: 'todo', priority: 0 } } as never), workflow);
    expect(notice(out)?.block).toMatchObject({ waits: true });
    expect(causeOf((out.events[0] as { kind: BlockKind }).kind)).toBe('pickup');
    expect(out.effects.filter((e) => e.kind === 'activity')).toEqual([]);
  });

  it('a ticket whose repo is to be chosen: the same comment, a reply is not enough', () => {
    const out = decide(undefined, ev('ticket.delegated', { linearSessionId: 's1', repos: ['web', 'api'], issue: { title: 'T', logical: 'todo', priority: 0 } } as never), workflow);
    expect(notice(out)?.block).toMatchObject({ waits: true });
    expect(notice(out)?.block.question).toContain('repo:web');
  });

  it('a failed effect blocks by the comment; the death of that comment changes neither its reason nor the label', () => {
    const blocked = decide(ticket(), ev('effect.failed', { effectId: 'p:1:0', kind: 'move', eventId: 'e1', attempts: 8, error: 'boom' }), workflow);
    expect(notice(blocked)?.block.reason).toBe('Error: boom');
    const state = ticket({ blocked: true, blockReason: 'The run dev failed.', blockedJob: 'dev' });
    const died = decide(state, ev('effect.failed', { effectId: 'p:1:0', kind: 'block_comment', eventId: 'e1', attempts: 8, error: 'down' }), workflow);
    expect(died.events).toEqual([]);
    expect(died.effects).toEqual([]);
  });

  it('a stop stays an answer in the session, without the label that is gone', () => {
    const out = decide(ticket(), ev('control.stop', {}), workflow);
    expect(out.effects).toContainEqual({ kind: 'activity', type: 'response', body: 'Stopped. Reply on this ticket to relaunch.' });
  });

  it('the pack no longer knows `agent:reprendre`', () => {
    expect((workflow.on['label.changed'] ?? []).map((r) => r.label)).toEqual(['agent:stop']);
  });
});

describe('the question of the agent, journaled (ORC-196)', () => {
  const asked = ev('agent.asked', { question: 'Laquelle ?', job: 'dev' });

  it('blocks with the cause « question », the job at work to resume, the question in the comment', () => {
    const out = decide(ticket(), asked, workflow);
    expect(out.events).toEqual([{ type: 'ticket.blocked', reason: 'Question asked by the agent', kind: 'asked', job: 'dev' }]);
    expect(causeOf('asked')).toBe('question');
    expect(notice(out)?.block).toMatchObject({ step: 'build', question: 'Laquelle ?' });
  });

  it('a question run has no job of the ticket to resume', () => {
    expect(decide(ticket({ activeRunId: undefined, activeJob: undefined }), ev('agent.asked', { question: 'Q', job: 'ask' }), workflow).events).toEqual([{ type: 'ticket.blocked', reason: 'Question asked by the agent', kind: 'asked' }]);
  });

  it('a frozen version posts what it did', () => {
    expect(decide(ticket(), asked, frozen).effects[0]).toEqual({ kind: 'activity', type: 'elicitation', body: 'Laquelle ?' });
  });

  it('a question asked from a question thread is told there too, besides the ticket comment', () => {
    const out = decide(ticket(), ev('agent.asked', { question: 'Q', job: 'ask', linearSessionId: 's-q' }), workflow);
    expect(out.effects).toContainEqual({ kind: 'activity', type: 'elicitation', body: 'Q', linearSessionId: 's-q' });
    expect(notice(out)).toBeDefined();
    // The dev session hears it by the comment only: one channel.
    expect(decide(ticket(), ev('agent.asked', { question: 'Q', job: 'dev', linearSessionId: 's-dev' }), workflow).effects.filter((e) => e.kind === 'activity')).toEqual([]);
    expect(decide(ticket(), ev('agent.asked', { question: 'Q', job: 'dev', linearSessionId: 's-q' }), frozen).effects[0]).toEqual({ kind: 'activity', type: 'elicitation', body: 'Q', linearSessionId: 's-q' });
  });

  it('a ticket not delegated is not blocked: no reply on it would resume anything, the question goes to its thread only', () => {
    const out = decide(ticket({ delegated: false }), ev('agent.asked', { question: 'Q', job: 'ask', linearSessionId: 's-q' }), workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'elicitation', body: 'Q', linearSessionId: 's-q' }]);
  });
});

describe('versions frozen before it decide bit for bit as they did', () => {
  it('the run\'s cap: the elicitation, no comment, no job on the event', () => {
    const out = decide(ticket(), finished(), frozen);
    expect(out.events).toEqual([{ type: 'ticket.blocked', reason: 'The run dev reached a limit (turns, duration or budget).', kind: 'limit' }]);
    expect(out.effects[0]).toEqual({ kind: 'activity', type: 'elicitation', body: 'The run dev reached a limit (turns, duration or budget). Reply in this thread and I will resume.' });
    expect(notice(out)).toBeUndefined();
  });

  it('a stop keeps its sentence, a comment is no reply, a reply runs the rule\'s job', () => {
    expect(decide(ticket(), ev('control.stop', {}), frozen).effects).toContainEqual({ kind: 'activity', type: 'response', body: 'Stopped. Reply in this thread or add the agent:reprendre label to relaunch.' });
    const blocked = ticket({ blocked: true, blockReason: 'The run dev failed.', activeRunId: undefined });
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
  const blockedOn = (job: string, patch: Partial<TicketState> = {}) => ticket({ blocked: true, blockReason: 'The run failed.', blockedJob: job, activeRunId: undefined, activeJob: undefined, ...patch });

  it.each([
    ['in the session, a row with no class', reply()],
    ['in the session, a direction', classified('instruction', 'Corrige le tri')],
    ['in the session, a question', classified('question', 'et le séparateur ?')],
    ['as a comment, a direction', comment()],
    ['as a comment, a question', comment(signed, 'question')],
  ])('a member\'s reply %s starts the job that blocked, with the reply to read, and lifts the label', (_where, event) => {
    const out = decide(blockedOn('dev'), event, workflow);
    expect(starts(out)).toEqual([{ kind: 'start_run', job: 'dev', input: 'feedback' }]);
    expect(out.events.map((e) => e.type)).toEqual(expect.arrayContaining(['feedback.appended', 'ticket.unblocked']));
    expect(out.effects).toContainEqual({ kind: 'labels', add: [], remove: [BLOCKED_LABEL] });
  });

  it('a classified reply says it resumes, in the ack that is its sign of life', () => {
    expect(decide(blockedOn('dev'), classified('question', 'et le séparateur ?'), workflow).effects[0]).toEqual({ kind: 'ack', body: 'Noted, resuming.', linearSessionId: 's-dev' });
  });

  it.each([
    ['in the session', classified('command', '/status'), { kind: 'activity', type: 'response', linearSessionId: 's-dev', body: expect.stringContaining('Blocked: The run failed.') }],
    ['as a comment', comment(signed, 'command', { body: '/status' }), { kind: 'comment', body: expect.stringContaining('Blocked: The run failed.') }],
  ])('`/status` %s answers, resumes nothing, the step kept', (_where, event, answer) => {
    const out = decide(blockedOn('dev'), event, workflow);
    expect(out.effects).toEqual([answer]);
    expect(out.events.map((e) => e.type)).toEqual(['feedback.appended']);
    expect(out.events[0]).toMatchObject({ item: { kind: 'command' } });
  });

  it.each([
    ['in the session', classified('command', '/stop')],
    ['as a comment', comment(signed, 'command', { body: '/stop' })],
  ])('`/stop` %s stops: it does not relaunch what it stops', (_where, event) => {
    const out = decide(blockedOn('dev'), event, workflow);
    expect(starts(out)).toEqual([]);
    expect(out.events).toContainEqual({ type: 'ticket.blocked', reason: 'Stopped on request', kind: 'stopped' });
  });

  it('a question in another thread of a blocked ticket is no reply to its block', () => {
    const out = decide(blockedOn('dev', { questionSessionIds: ['s-q'] }), classified('question', 'et ça ?', 's-q'), workflow);
    expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
    expect(starts(out)).toEqual([expect.objectContaining({ job: 'ask', input: 'thread' })]);
  });

  describe('a comment enters the human inbox under the same taint rule as a reply (I12)', () => {
    const item = (taint: FeedbackItem['taint'], kind: MessageKind = 'instruction'): FeedbackItem => ({ author: 'x', body: 'b', at: 1, source: 'session', taint, kind });
    const appended = (d: Decision) => d.events.flatMap((e) => (e.type === 'feedback.appended' ? [e.item] : []));

    it('it keeps its class and its taint, as a message that waits for the agent', () => {
      expect(appended(decide(blockedOn('dev'), comment({ ...signed, taint: 'untrusted' }), workflow))).toEqual([{ author: 'Lilian', authorId: 'u-member', body: 'Continue', at: 1000, source: 'session', taint: 'untrusted', kind: 'instruction' }]);
    });

    it.each([
      ['an untrusted comment', blockedOn('dev'), comment({ taint: 'untrusted' })],
      ['a trusted comment over an untrusted message', blockedOn('dev', { humanInbox: [item('untrusted')] }), comment()],
      ['a trusted comment over an untrusted command, which the agent is not given', blockedOn('dev', { humanInbox: [item('untrusted', 'command')] }), comment()],
    ])('%s: the resumed run takes the sensitive paths', (_what, state, event) => {
      expect(starts(decide(state, event, workflow))).toEqual([expect.objectContaining({ job: 'dev', input: 'feedback', sensitivePaths: SENSITIVE_PATHS })]);
    });

    it('a trusted comment over a trusted inbox: none', () => {
      expect(starts(decide(blockedOn('dev', { humanInbox: [item('trusted')] }), comment(), workflow))[0]).not.toHaveProperty('sensitivePaths');
    });

    it('a resumed job that writes the knowledge base is refused on what it would read, and the ticket stays blocked', () => {
      const wf: Workflow = { ...workflow, jobs: { ...workflow.jobs, notes: { ...workflow.jobs['dev']!, name: 'notes', workspace: 'knowledge' } } };
      const out = decide(blockedOn('notes', { humanInbox: [item('untrusted')] }), comment(), wf);
      expect(starts(out)).toEqual([]);
      expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
    });

    it('a secret masked out of a comment is told on the ticket, which has no session to carry it', () => {
      const out = decide(blockedOn('dev'), comment(signed, 'instruction', { masked: true }), workflow);
      expect(out.effects).toContainEqual({ kind: 'comment', body: expect.stringContaining('contained a secret') });
    });

    it('a masked comment that is not read gets no notice: not awaited, or refused', () => {
      const masked = (extra: Partial<FactoryEvent>) => comment(extra, 'instruction', { masked: true });
      expect(decide(ticket(), masked(signed), workflow).effects).toEqual([]);
      expect(decide(blockedOn('dev'), masked({ actor: 'u-out', roles: [] }), workflow).effects).toEqual([{ kind: 'comment', body: expect.stringContaining('Refused') }]);
    });
  });

  it('`fix-ci` reads its red checks, not a reply: the rule\'s job takes it up, the same step', () => {
    expect(starts(decide(blockedOn('fix-ci'), comment(), workflow))[0]).toMatchObject({ job: 'dev-feedback' });
  });

  it('the tests step and the review are each resumed, not `dev-feedback`', () => {
    for (const job of ['tests', 'review']) expect(starts(decide(blockedOn(job), comment(), workflow))[0]).toMatchObject({ job, input: 'feedback' });
  });

  it('gives the bounds back as any human relaunch, ORC-220\'s among them', () => {
    const out = decide(blockedOn('dev', { cutRelaunches: [1], leaseRelaunches: 1, repeatedFailure: { signature: 's', count: 3 } }), comment(), workflow);
    expect(out.events).toEqual(expect.arrayContaining([{ type: 'ticket.patched', patch: { cutRelaunches: [] } }, { type: 'ticket.patched', patch: { leaseRelaunches: 0 } }, { type: 'ticket.patched', patch: { repeatedFailure: null } }]));
  });

  it('a block with no step to resume (stop, dead letter, a commit the job does not fix, a refused publication) relaunches the rule\'s job', () => {
    const state = ticket({ blocked: true, blockReason: 'Arrêté à la demande', activeRunId: undefined });
    expect(starts(decide(state, comment(), workflow))[0]).toMatchObject({ job: 'dev-feedback' });
    const review = decide(verifying({ activeJob: 'review' }), ev('verify.failed', { runId: 'r1', job: 'review', failures: [failure] }), beforeOrc183(workflow));
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
    expect(out.effects).toEqual([{ kind: 'comment', body: expect.stringContaining('Refused') }]);
    expect(out.events).toEqual([]);
    expect(decide(blockedOn('dev'), reply(outsider), workflow).effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's-dev', body: expect.stringContaining('Refused') }]);
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
    const t = reduce(ticket(), { type: 'ticket.blocked', reason: 'r', kind: 'infra', job: 'dev' });
    expect(t?.blockedJob).toBe('dev');
    expect(reduce(t, { type: 'ticket.unblocked' })?.blockedJob).toBeUndefined();
    expect(reduce(t, { type: 'ticket.blocked', reason: 'other', kind: 'other' })?.blockedJob).toBeUndefined();
  });
});
