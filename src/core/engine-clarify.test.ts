import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput } from './agent-output.js';
import { parseAgentOutput } from './agent-output.js';
import { causeOf } from './block-cause.js';
import { CLARIFY_EXPIRE_MS, CLARIFY_REMIND_MS, decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

const output = (intake: AgentOutput['intake']): AgentOutput => ({ status: 'done', summary: 'Read.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...(intake ? { intake } : {}) });
const assessed = (patch: Partial<NonNullable<AgentOutput['intake']>> = {}) => output({ size: 'm', risk: 'medium', complete: true, missing: [], screen: false, ...patch });
const RATE = { question: 'Does the rate limit apply to admin accounts too?', options: ['Yes, to everyone', 'No, admins are exempt'] };
const FORMAT = { question: 'Which export format?', options: ['CSV', 'XLSX'] };

function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload, ...extra } as FactoryEvent;
}
const finished = (out: AgentOutput, extra: Partial<EventPayloads['run.finished']> = {}) =>
  ev('run.finished', { runId: 'r1', job: 'intake', outcome: 'success', costUsd: 0.1, turns: 3, lastText: 'ok', attempt: 'succeeded', output: out, ...extra });
const reply = (body: string, extra: Partial<FactoryEvent> = {}, payload: Partial<EventPayloads['session.prompted']> = {}) =>
  ev('session.prompted', { linearSessionId: 's1', body, author: 'Lilian', ack: true, kind: 'instruction', ...payload }, { id: `e-reply-${body}`, at: 2000, ...extra });

function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'todo', 0), delegated: true, activeRunId: 'r1', activeJob: 'intake', linearSessionId: 's1', initiatorId: 'u-requester', ...patch };
}
/** The ticket once the decision is applied. */
const after = (t: TicketState, e: FactoryEvent) => decide(t, e, workflow).events.reduce<TicketState | undefined>((s, x) => reduce(s, x), reduce(t, e))!;
/** The ticket waiting on its questions, once intake asked them. */
const asking = (questions = [RATE, FORMAT]) => after(ticket(), finished(assessed({ complete: false, missing: questions })));
const timer = (kind: 'clarify.remind' | 'clarify.expire', at = 1000) => ev('timer.fired', { kind, payload: { at } }, { id: `e-${kind}`, at: 1000 + (kind === 'clarify.remind' ? CLARIFY_REMIND_MS : CLARIFY_EXPIRE_MS) });

describe('clarify (ORC-210)', () => {
  it('criterion 1: a clear ticket asks nothing and starts dev', () => {
    const out = decide(ticket(), finished(assessed()), workflow);
    expect(out.effects.filter((x) => x.kind === 'activity')).toEqual([]);
    expect(out.timers).toEqual([]);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev' }));
  });

  it('criterion 2: an unclear ticket gets its questions as elicitations with select, one at a time, a free answer possible, and is neither blocked nor moved', () => {
    const e = finished(assessed({ complete: false, missing: [RATE, FORMAT] }));
    const out = decide(ticket(), e, workflow);
    // One at a time: Linear sends a picked option back as a plain reply, so the list on screen is the question it answers.
    expect(out.effects.filter((x) => x.kind === 'activity')).toEqual([
      expect.objectContaining({ type: 'elicitation', body: expect.stringMatching(/^Question 1\/2: Does the rate limit[\s\S]*your own words/), options: RATE.options }),
    ]);
    expect(out.effects.some((x) => x.kind === 'start_run' || x.kind === 'move' || x.kind === 'block_comment')).toBe(false);
    const t = after(ticket(), e);
    expect(t).toMatchObject({ blocked: false, logical: 'todo', clarify: { job: 'intake', at: 1000, answered: 0, questions: [RATE, FORMAT] } });
    expect(decide(t, reply('Yes, to everyone'), workflow).effects.filter((x) => x.kind === 'activity')).toEqual([
      expect.objectContaining({ type: 'elicitation', body: expect.stringMatching(/^Question 2\/2: Which export format\?/), options: FORMAT.options }),
    ]);
  });

  it('criterion 2: at most 3 questions, each with its options; a question without options is a free one', () => {
    const many = { ...output(undefined), intake: { size: 'm', risk: 'low', complete: false, missing: [RATE, FORMAT, RATE, FORMAT], screen: false } };
    expect(parseAgentOutput(many).ok).toBe(false);
    expect(parseAgentOutput({ ...many, intake: { ...many.intake, missing: [RATE, 'Which page?'] } }).ok).toBe(true);
    const out = decide(ticket(), finished(assessed({ complete: false, missing: ['Which page?'] })), workflow);
    const [asked] = out.effects.filter((x) => x.kind === 'activity');
    expect(asked).toMatchObject({ type: 'elicitation', body: expect.stringContaining('Which page?') });
    expect(asked).not.toHaveProperty('options');
  });

  it('the deterministic checks that failed are asked too, as a free question, within the 3', () => {
    const e = finished(assessed({ complete: false, missing: [RATE, FORMAT, RATE] }), { pickup: ['The description has no acceptance criteria.'] });
    const t = after(ticket(), e);
    expect(t.clarify?.questions).toHaveLength(3);
    expect(t.clarify?.questions[0]).toEqual({ question: expect.stringContaining('The description has no acceptance criteria.'), options: [] });
  });

  it('arms the reminder at 24 h and the block at 72 h, on the simulated clock of the decision', () => {
    const out = decide(ticket(), finished(assessed({ complete: false, missing: [RATE] })), workflow);
    expect(out.timers).toEqual([
      { kind: 'clarify.remind', slot: 'clarify.remind', ms: 24 * 3_600_000, payload: { at: 1000 } },
      { kind: 'clarify.expire', slot: 'clarify.expire', ms: 72 * 3_600_000, payload: { at: 1000 } },
    ]);
  });

  it('criterion 3: unanswered at 24 h, the questions still open are asked again', () => {
    const t = after(asking(), reply('Yes, to everyone'));
    const out = decide(t, timer('clarify.remind'), workflow);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'elicitation', body: expect.stringMatching(/^Reminder/), options: FORMAT.options })]);
    expect(out.events).toEqual([]);
  });

  it('criterion 4: unanswered at 72 h, the ticket is blocked on intake, cause question, the open questions in its comment', () => {
    const e = timer('clarify.expire');
    const out = decide(asking(), e, workflow);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'block_comment', block: expect.objectContaining({ step: 'clarify', question: expect.stringContaining(RATE.question) }) }));
    const t = after(asking(), e);
    expect(t).toMatchObject({ blocked: true, blockedJob: 'intake', clarify: null });
    expect(t.blockKind).toBe('question');
    expect(causeOf(t.blockKind)).toBe('question');
  });

  it('a reply to the 72 h block relaunches intake, which reads the answer', () => {
    const blocked = after(asking(), timer('clarify.expire'));
    const out = decide(blocked, reply('CSV', { roles: ['team_member'], actor: 'u-member' }), workflow);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'intake', input: 'feedback' }));
  });

  it('a timer of questions answered since, or of a ticket that moved on, does nothing', () => {
    const answered = [reply('Yes, to everyone'), reply('CSV')].reduce(after, asking());
    expect(answered.clarify).toBeNull();
    for (const kind of ['clarify.remind', 'clarify.expire'] as const) {
      expect(decide({ ...answered, activeRunId: undefined }, timer(kind), workflow)).toMatchObject({ events: [], effects: [], timers: [] });
      // Asked again later: the first round's timers are not this round's.
      expect(decide(asking(), timer(kind, 999), workflow)).toMatchObject({ events: [], effects: [], timers: [] });
      expect(decide(reduce(asking(), ev('ticket.undelegated', {}))!, timer(kind), workflow)).toMatchObject({ events: [], effects: [] });
    }
  });

  it('an answer is kept for the agent; once every question has one, intake reads the ticket again with them', () => {
    const first = decide(asking(), reply('Yes, to everyone'), workflow);
    expect(first.events).toContainEqual(expect.objectContaining({ type: 'feedback.appended' }));
    expect(first.effects.some((x) => x.kind === 'start_run')).toBe(false);
    expect(first.trace).toContain('clarify: answered, 1 question(s) still open');
    const t = after(asking(), reply('Yes, to everyone'));
    expect(t.clarify).toMatchObject({ answered: 1 });
    const out = decide(t, reply('CSV'), workflow);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'intake', input: 'feedback' }));
    expect(after(t, reply('CSV')).clarify).toBeNull();
  });

  it('criterion 5: an answer from outside the authorized roles is refused, journaled and answered in the session, and counts for nothing', () => {
    const stranger = reply('No, admins are exempt', { actor: 'u-stranger', roles: [] });
    const out = decide(asking(), stranger, workflow);
    expect(out.trace).toContainEqual(expect.stringMatching(/^authz: refused answer_clarify to u-stranger/));
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'response', body: expect.stringMatching(/^Refused/), linearSessionId: 's1' })]);
    expect(out.events).toEqual([]);
    // The requester and team members may answer.
    expect(decide(asking(), reply('Yes', { actor: 'u-requester', roles: [] }), workflow).events).toContainEqual(expect.objectContaining({ type: 'feedback.appended' }));
    expect(decide(asking(), reply('Yes', { actor: 'u-member', roles: ['team_member'] }), workflow).events).toContainEqual(expect.objectContaining({ type: 'feedback.appended' }));
  });

  it('a command is no answer: /status is answered, the questions stay open', () => {
    const t = after(asking(), reply('/status', {}, { kind: 'command' }));
    expect(t.clarify).toMatchObject({ answered: 0 });
  });

  it('a question back is no answer: it is answered in the session, the questions stay open', () => {
    const e = reply('What do you mean by admin accounts?', {}, { kind: 'question' });
    expect(decide(asking(), e, workflow).effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'ask' }));
    expect(after(asking(), e)).toMatchObject({ clarify: { answered: 0 } });
    expect(after(asking(), e).decisions).toBeUndefined();
  });

  it('an unsigned answer answers its question for the agent, but is no decision of the ticket (I12)', () => {
    const t = after(asking([RATE]), reply('Yes', { taint: 'untrusted' }));
    expect(t.clarify).toBeNull();
    expect(t.decisions).toBeUndefined();
  });

  it('criterion 6: an accepted answer is kept as a decision of the ticket, and is found in the tests once frozen', () => {
    const answered = [reply('Yes, to everyone'), reply('CSV')].reduce(after, asking());
    expect(answered.decisions).toEqual([
      { question: RATE.question, answer: 'Yes, to everyone', author: 'Lilian', at: 2000 },
      { question: FORMAT.question, answer: 'CSV', author: 'Lilian', at: 2000 },
    ]);
    // A later freeze, or a refreeze, holds the ticket's decisions as they are then.
    const refrozen = decide({ ...answered, frozenTests: { sha: 'old', files: {} } }, ev('command', { name: '/refreeze', body: '', linearSessionId: 's1', author: 'M', frozen: { sha: 'new', files: {} } }, { roles: ['maintainer'], actor: 'u-m' }), workflow);
    expect(refrozen.events).toContainEqual({ type: 'ticket.patched', patch: { frozenTests: { sha: 'new', files: {}, decisions: answered.decisions, refrozenBy: 'u-m' } } });
    const frozen = { sha: 'abc', files: { 'test/rate.test.ts': 'f1' }, rules: 1 };
    const t = after({ ...answered, activeRunId: 'r2', activeJob: 'tests', verifyingRunId: 'r2' }, ev('verify.passed', { runId: 'r2', job: 'tests', red: 'assertion', frozen }));
    expect(t.frozenTests).toMatchObject({ sha: 'abc', decisions: answered.decisions });
  });
});
