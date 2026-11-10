import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Workflow } from '../config/workflow-schema.js';
import type { Effect } from './decision.js';
import { decide, SENSITIVE_PATHS } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type FeedbackItem, type TicketState } from './types.js';
import { beforeOrc183 } from '../../test/helpers/frozen-review.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
/** `workflow` as a version frozen before ORC-375 holds it: no relay job, the reply rule's job answers a relayed question. */
const { relayJob: _relayJob, ...beforeOrc375 } = workflow;
/** A version frozen before ORC-170, whose `dev-feedback` moves nothing and starts no review. */
const beforeOrc170: Workflow = { ...workflow, jobs: { ...workflow.jobs, 'dev-feedback': { ...workflow.jobs['dev-feedback']!, onSuccess: { post: 'reply' } } } };

function ev<T extends EventType>(type: T, payload: EventPayloads[T], patch: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', ...patch, payload } as FactoryEvent;
}
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, linearSessionId: 's1', ...patch };
}
/** A reply as the Linear webhook brings it (ORC-180): classified, to acknowledge. */
const reply = (kind: 'question' | 'instruction' | 'command', body: string, session = 's1', patch: Partial<FactoryEvent> = {}) =>
  ev('session.prompted', { linearSessionId: session, body, author: 'Lilian', ack: true, kind }, patch);
const item = (patch: Partial<FeedbackItem> = {}): FeedbackItem => ({ author: 'L', body: 'corrige ça', at: 1, source: 'session', kind: 'instruction', ...patch });
const timer = ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback', inbox: true } });
const acked = (effects: Effect[]) => effects.find((e) => e.kind === 'ack');
const appended = (d: ReturnType<typeof decide>) => d.events.flatMap((e) => (e.type === 'feedback.appended' ? [e.item] : []));

describe('decide — a classified message (ORC-180)', () => {
  it('an instruction during a run: kept, acked, regrouped; no run started, none stopped', () => {
    const out = decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), reply('instruction', 'corrige le tri'), workflow);
    expect(appended(out)).toEqual([expect.objectContaining({ body: 'corrige le tri', kind: 'instruction', source: 'session', taint: 'trusted' })]);
    expect(out.effects).toEqual([{ kind: 'ack', body: 'Noted, taken into account at the next step.', linearSessionId: 's1' }]);
    expect(out.timers).toEqual([{ kind: 'debounce', slot: 'dev-feedback', ms: 180_000, payload: { job: 'dev-feedback', inbox: true } }]);
  });

  it('a question in the dev session starts the answer at once, and is kept for the agent as well', () => {
    const out = decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), reply('question', 'et pour mobile ?'), workflow);
    expect(appended(out)).toEqual([expect.objectContaining({ body: 'et pour mobile ?', kind: 'question', source: 'session' })]);
    expect(out.effects).toEqual([
      { kind: 'ack', body: 'Noted, I am looking into it and will answer here.', linearSessionId: 's1' },
      expect.objectContaining({ kind: 'start_run', job: 'ask', input: 'thread', inputText: 'et pour mobile ?', linearSessionId: 's1' }),
    ]);
    expect(out.timers).toEqual([expect.objectContaining({ slot: 'dev-feedback' })]);
  });

  it('a question in a question thread: kept and answered, no agent asked for it', () => {
    const out = decide(ticket({ questionSessionIds: ['s9'] }), reply('question', 'et ?', 's9'), workflow);
    expect(appended(out)).toEqual([expect.objectContaining({ kind: 'question', source: 'thread' })]);
    expect(out.effects.map((e) => e.kind)).toEqual(['ack', 'start_run']);
    expect(out.timers).toEqual([]);
  });

  it('an instruction in a thread of a delegated ticket never takes the question path', () => {
    const out = decide(ticket({ questionSessionIds: ['s9'] }), reply('instruction', 'change le titre', 's9'), workflow);
    expect(appended(out)).toEqual([expect.objectContaining({ kind: 'instruction', source: 'session' })]);
    expect(out.effects).toEqual([{ kind: 'ack', body: 'Noted, taken into account at the next step.', linearSessionId: 's9' }]);
    expect(out.timers).toEqual([expect.objectContaining({ slot: 'dev-feedback' })]);
  });

  it('a mention that asks for an action goes the same way; one that asks a question is answered, both kept', () => {
    const t = ticket();
    const order = decide(t, ev('session.mentioned', { linearSessionId: 's9', body: 'change le titre', author: 'L', ack: true, kind: 'instruction' }), workflow);
    expect(appended(order)).toEqual([expect.objectContaining({ kind: 'instruction', source: 'session' })]);
    expect(order.effects.map((e) => e.kind)).toEqual(['ack']);
    expect(order.timers).toEqual([expect.objectContaining({ slot: 'dev-feedback' })]);
    const asked = decide(t, ev('session.mentioned', { linearSessionId: 's9', body: 'pourquoi ?', author: 'L', ack: true, kind: 'question' }), workflow);
    expect(appended(asked)).toEqual([expect.objectContaining({ kind: 'question', source: 'thread' })]);
    expect(asked.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'ask' }));
  });

  it('on a ticket not delegated, whatever the class, the only reaction is the answer', () => {
    const out = decide(ticket({ delegated: false }), reply('instruction', 'change le titre'), workflow);
    expect(appended(out)).toEqual([expect.objectContaining({ source: 'thread' })]);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'ask' }));
    expect(out.timers).toEqual([]);
  });

  it('a command is kept apart: /status answers from the projection, nothing else moves', () => {
    const t = ticket({ logical: 'human_review', blocked: true, blockReason: 'CI rouge', humanInbox: [item()] });
    const out = decide(t, reply('command', '/status'), workflow);
    expect(appended(out)).toEqual([expect.objectContaining({ body: '/status', kind: 'command' })]);
    expect(out.effects).toEqual([{ kind: 'activity', type: 'response', linearSessionId: 's1', body: expect.stringMatching(/human_review[\s\S]*Blocked: CI rouge[\s\S]*agent: 1/) }]);
    expect(out.timers).toEqual([]);
    expect(out.events.map((e) => e.type)).not.toContain('ticket.unblocked');
  });

  it('/stop stops as the stop signal of the session does, in the dev session and in a thread', () => {
    const out = decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), reply('command', '/stop'), workflow);
    expect(out.events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked', reason: 'Stopped on request' }));
    expect(out.effects.map((e) => e.kind)).toEqual(expect.arrayContaining(['stop_run', 'activity']));
    expect(out.effects.map((e) => e.kind)).not.toContain('ack');
    expect(appended(out)).toEqual([expect.objectContaining({ body: '/stop', kind: 'command' })]);
    const thread = decide(ticket({ questionSessionIds: ['s9'] }), reply('command', '/stop', 's9'), workflow);
    expect(thread.effects).toContainEqual({ kind: 'stop_run', linearSessionId: 's9' });
    expect(thread.events.map((e) => e.type)).not.toContain('ticket.blocked');
  });

  it('a command sent as a mention is a command: no model, and /stop stops the ticket, not the session it opened', () => {
    const mention = (body: string) => ev('session.mentioned', { linearSessionId: 's9', body, author: 'L', ack: true, kind: 'command' });
    const status = decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), mention('/status'), workflow);
    expect(status.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'response', linearSessionId: 's9', body: expect.stringContaining('Running: dev') })]);
    const stop = decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), mention('/stop'), workflow);
    expect(stop.effects.map((e) => e.kind)).toEqual(expect.arrayContaining(['stop_run']));
    expect(stop.effects).not.toContainEqual(expect.objectContaining({ kind: 'start_run' }));
    expect(stop.events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked' }));
    // A ticket not delegated has no work to stop, and blocks on nothing.
    const free = decide(ticket({ delegated: false }), mention('/stop'), workflow);
    expect(free.events.map((e) => e.type)).toEqual(['feedback.appended']);
  });

  it('on a blocked ticket a command stays open to whoever may reply: it relaunches nothing', () => {
    const t = ticket({ blocked: true, blockReason: 'plafond', initiatorId: 'u-req' });
    const out = decide(t, reply('command', '/status', 's1', { actor: 'u-req', roles: [] }), workflow);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringContaining('Blocked: plafond') })]);
    expect(out.events.map((e) => e.type)).toEqual(['feedback.appended']);
  });

  it('a mask is told to its author on every path, with no ack to carry it', () => {
    const masked = { linearSessionId: 's1', body: '/status [masqué]', author: 'L', ack: true as const, kind: 'command' as const, masked: true as const };
    const notice = expect.objectContaining({ kind: 'activity', linearSessionId: 's1', body: expect.stringContaining('secret') });
    expect(decide(ticket(), ev('session.prompted', masked), workflow).effects).toContainEqual(notice);
    expect(decide(ticket(), ev('session.prompted', masked, { actor: 'u-out', roles: [] }), workflow).effects).toContainEqual(notice);
  });

  it('a refused message is not kept, gets its refusal, and no ack', () => {
    const out = decide(ticket(), reply('instruction', 'passe en prod', 's1', { actor: 'u-out', roles: [] }), workflow);
    expect(appended(out)).toEqual([]);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^Refused/) })]);
    expect(out.timers).toEqual([]);
  });

  it('keeps the taint of its event through the inbox, and hands it to the run (I12)', () => {
    const out = decide(ticket({ logical: 'human_review' }), reply('instruction', 'corrige', 's1', { taint: 'untrusted' }), workflow);
    expect(appended(out)[0]!.taint).toBe('untrusted');
    const t = ticket({ logical: 'human_review', humanInbox: appended(out) });
    expect(decide(t, timer, workflow).effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'dev-feedback', sensitivePaths: SENSITIVE_PATHS })]);
  });

  describe('a trusted event starts a run that empties an untrusted inbox (I12)', () => {
    const untrusted = { taint: 'untrusted' as const };
    // A debounce armed before ORC-180 (no `inbox`): it starts its job whatever waits, as a move back to dev did before ORC-190.
    const moved = ev('timer.fired', { kind: 'debounce', payload: { job: 'fix-human' } });
    const end = ev('verify.passed', { runId: 'r1', job: 'review' });
    const starts = (d: ReturnType<typeof decide>) => d.effects.filter((e) => e.kind === 'start_run');
    const sandboxed = (job = 'fix-human') => [expect.objectContaining({ job, sensitivePaths: SENSITIVE_PATHS })];

    it.each<[string, FeedbackItem[]]>([
      ['a message', [item(untrusted)]],
      ['a question of a thread', [item({ kind: 'question', source: 'thread', ...untrusted })]],
      ['a row written before ORC-180', [item({ kind: undefined, ...untrusted })]],
      ['a command alone', [item({ kind: 'command', ...untrusted })]],
      ['a command beside a trusted message', [item(), item({ kind: 'command', ...untrusted })]],
    ])('by a debounce, %s', (_what, humanInbox) => {
      expect(starts(decide(ticket({ logical: 'human_review', humanInbox }), moved, workflow))).toEqual(sandboxed());
    });

    it('by the regrouping, and at the end of a step: a command beside a trusted message', () => {
      const humanInbox = [item(), item({ kind: 'command', ...untrusted })];
      expect(starts(decide(ticket({ logical: 'human_review', humanInbox }), timer, workflow))).toEqual(sandboxed('dev-feedback'));
      // Handed to the round of human feedback the end of the review leaves in Human Review (ORC-190).
      expect(starts(decide(ticket({ logical: 'ai_review', verifyingRunId: 'r1', humanInbox }), end, beforeOrc183(workflow)))).toEqual(sandboxed());
    });

    it('all of it trusted, no sensitive path', () => {
      const [start] = starts(decide(ticket({ logical: 'human_review', humanInbox: [item(), item({ kind: 'command' })] }), moved, workflow));
      expect(start).not.toHaveProperty('sensitivePaths');
    });
  });

  it('a mask at the ingestion is told to its author with the ack', () => {
    const out = decide(ticket(), ev('session.prompted', { linearSessionId: 's1', body: 'token [masqué]', author: 'L', ack: true, kind: 'question', masked: true }), workflow);
    expect(acked(out.effects)).toMatchObject({ body: expect.stringContaining('secret') });
  });

  it('a reply on a delivered ticket is kept, and its ack promises no next step', () => {
    const out = decide(ticket({ logical: 'done', prState: 'MERGED' }), reply('instruction', 'corrige'), workflow);
    expect(appended(out)).toHaveLength(1);
    expect(acked(out.effects)).toMatchObject({ body: expect.stringContaining('delivered') });
  });

  it('a reply to a ticket waiting for its repo is kept with the question it gets back, unless the matrix would refuse it', () => {
    const waiting = ticket({ blocked: true, awaitingRepo: ['web', 'api'] });
    const out = decide(waiting, reply('instruction', 'corrige'), workflow);
    expect(appended(out)).toHaveLength(1);
    expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', type: 'response' })]);
    expect(appended(decide(waiting, reply('instruction', 'passe en prod', 's1', { actor: 'u-out', roles: [] }), workflow))).toEqual([]);
    expect(appended(decide(waiting, reply('instruction', 'corrige', 's1', { actor: 'u-m', roles: ['team_member'] }), workflow))).toHaveLength(1);
  });

  describe('the blocked path stays the rule of the workflow (ORC-196)', () => {
    it('any reply in the dev session relaunches at once, a question gets no answer of its own', () => {
      for (const kind of ['question', 'instruction'] as const) {
        const out = decide(ticket({ blocked: true, blockReason: 'x' }), reply(kind, 'oui'), workflow);
        expect(out.events.map((e) => e.type)).toEqual(['feedback.appended', 'ticket.unblocked']);
        expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'dev-feedback' })]);
        expect(acked(out.effects)).toMatchObject({ body: 'Noted, resuming.' });
      }
    });

    it('a reply in a thread does not relaunch it', () => {
      const out = decide(ticket({ blocked: true, questionSessionIds: ['s9'] }), reply('instruction', 'corrige', 's9'), workflow);
      expect(out.events.map((e) => e.type)).toEqual(['feedback.appended']);
      expect(out.effects.map((e) => e.kind)).toEqual(['ack']);
    });

    it('the relaunch is refused to whom the matrix refuses it', () => {
      const out = decide(ticket({ blocked: true }), reply('instruction', 'vas-y', 's1', { actor: 'u-out', roles: [] }), workflow);
      expect(out.events).toEqual([]);
      expect(out.effects).toEqual([expect.objectContaining({ kind: 'activity', body: expect.stringMatching(/^Refused/) })]);
    });
  });

  it('a row journaled before ORC-180, without a class, decides as it did', () => {
    const old = ev('session.prompted', { linearSessionId: 's1', body: 'boutons', author: 'L' });
    const out = decide(ticket({ logical: 'human_review' }), old, workflow);
    expect(out.effects).toEqual([]);
    expect(out.timers).toEqual([{ kind: 'debounce', slot: 'fix-human', ms: 180_000, payload: { job: 'fix-human' } }]);
    expect(appended(out)).toEqual([expect.not.objectContaining({ kind: expect.anything() })]);
  });
});

describe('decide — the regrouping ends (ORC-180)', () => {
  const inbox = [item()];

  it.each([
    ['a run', { activeRunId: 'r1', activeJob: 'dev' }],
    ['a verification', { verifyingRunId: 'r1' }],
    ['a pending job', { pendingJob: { job: 'review' } }],
  ])('with %s in flight, no job is started: the messages wait for its end', (_what, patch) => {
    const out = decide(ticket({ humanInbox: inbox, ...patch }), timer, workflow);
    expect(out.effects).toEqual([]);
    expect(out.events).toEqual([]);
    expect(out.trace.join()).toMatch(/held/);
  });

  it('a blocked ticket holds them by its block, not by a pending job left with it (ORC-339)', () => {
    const out = decide(ticket({ humanInbox: inbox, blocked: true, blockReason: 'x', blockedJob: 'dev', pendingJob: { job: 'review' } }), timer, workflow);
    expect(out.effects).toEqual([]);
    expect(out.trace.join()).toMatch(/held by the block/);
  });

  it('with no work in flight, the agent is resumed on them', () => {
    expect(decide(ticket({ logical: 'human_review', humanInbox: inbox }), timer, workflow).effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'dev-feedback', input: 'feedback' })]);
  });

  it('with the messages already handed over, nothing starts', () => {
    expect(decide(ticket({ logical: 'human_review' }), timer, workflow).effects).toEqual([]);
    expect(decide(ticket({ logical: 'human_review', humanInbox: [item({ kind: 'command' })] }), timer, workflow).effects).toEqual([]);
  });

  it('a block that came since waits for its human: the timer does not lift it', () => {
    const out = decide(ticket({ blocked: true, blockReason: 'plafond', humanInbox: inbox }), timer, workflow);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([]);
  });

  it('a debounce armed before ORC-180 starts its job as it did', () => {
    const old = ev('timer.fired', { kind: 'debounce', payload: { job: 'dev-feedback' } });
    expect(decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), old, workflow).effects).toEqual([expect.objectContaining({ kind: 'start_run', job: 'dev-feedback' })]);
  });
});

describe('decide — a step ends with messages waiting (ORC-180)', () => {
  const run = 'r1';
  const inReview = (patch: Partial<TicketState>) => ticket({ logical: 'ai_review', activeRunId: run, activeJob: 'review', ...patch });

  // A `review` frozen before ORC-183 verifies, as it has repo checks: its success goes through its check, then publishes.
  const frozen = beforeOrc183(workflow);
  const passed = ev('verify.passed', { runId: run, job: 'review' });
  const verifying = (patch: Partial<TicketState>) => ticket({ logical: 'ai_review', verifyingRunId: run, ...patch });

  it('the end of the work moves the ticket, then the agent is resumed on them', () => {
    const out = decide(verifying({ humanInbox: [item()] }), passed, frozen);
    expect(out.effects.map((e) => e.kind)).toEqual(['move', 'post_output', 'start_run']);
    // In Human Review, a round of human feedback (ORC-190).
    expect(out.effects.at(-1)).toMatchObject({ job: 'fix-human', input: 'feedback' });
  });

  it.each([
    ['nothing waits', { humanInbox: [] }],
    ['only a question of a thread waits', { humanInbox: [item({ kind: 'question', source: 'thread' })] }],
    ['only an answered command waits', { humanInbox: [item({ kind: 'command' })] }],
    ['only what was written before ORC-180 waits', { humanInbox: [item({ kind: undefined })] }],
    ['a pending job comes next and reads them', { humanInbox: [item()], pendingJob: { job: 'dev-feedback' } }],
    ['it is no longer delegated', { humanInbox: [item()], delegated: false }],
  ])('no run when %s', (_what, patch) => {
    expect(decide(verifying(patch), passed, frozen).effects.map((e) => e.kind)).not.toContain('start_run');
  });

  it('the state it is read on is the one this end leaves, a move owed by a refused publication included', () => {
    const done = ev('publish.done', { runId: run, job: 'dev-feedback', sha: 'abc' });
    const t = ticket({ logical: 'dev', verifyingRunId: run, owedMove: 'ai_review', humanInbox: [item()] });
    // Owed to AI Review, where no reply rule applies: the messages wait; only the review the move came with starts (ORC-183).
    const starts = decide(t, done, beforeOrc170).effects.filter((e) => e.kind === 'start_run');
    expect(starts).toEqual([expect.objectContaining({ job: 'review' })]);
    expect(decide({ ...t, owedMove: 'human_review' }, done, beforeOrc170).effects.at(-1)).toMatchObject({ kind: 'start_run', job: 'fix-human' });
    // Since ORC-170 the job's own move comes first: its commit is reviewed, the messages wait for the review's end.
    expect(decide({ ...t, owedMove: 'human_review' }, done, workflow).effects.filter((e) => e.kind === 'move' || e.kind === 'start_run')).toEqual([{ kind: 'move', to: 'ai_review' }, expect.objectContaining({ job: 'review' })]);
  });

  it('the end of an answer starts no agent', () => {
    const asked = ev('run.finished', { runId: 'q1', job: 'ask', outcome: 'success', costUsd: 0, turns: 1, lastText: 'Parce que.' });
    expect(decide(inReview({ humanInbox: [item()] }), asked, workflow).effects.map((e) => e.kind)).toEqual(['post_output']);
  });

  it('a failed check resumes the agent: its start carries them, no second run is decided', () => {
    const failed = ev('verify.failed', { runId: run, job: 'dev', failures: [{ command: 'npm test', exitCode: 1, output: 'x' }] });
    const out = decide(ticket({ verifyingRunId: run, humanInbox: [item()] }), failed, { ...workflow, limits: { ...workflow.limits, verifyAttempts: 3 } });
    expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'dev', input: 'verify_failures' })]);
  });

  it('a block at the end of a step keeps them for the reply that lifts it', () => {
    const failedRun = ev('run.finished', { runId: run, job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' });
    const t = ticket({ activeRunId: run, activeJob: 'dev', humanInbox: [item()] });
    const out = decide(t, failedRun, workflow);
    expect(out.events.map((e) => e.type)).toEqual(['ticket.blocked']);
    let after = reduce(t, failedRun);
    for (const e of out.events) after = reduce(after, e);
    expect(after!.humanInbox).toHaveLength(1);
  });
});

describe('the relay of a question the answer agent cannot answer (ORC-182)', () => {
  const output = { status: 'done' as const, summary: 'Je ne trouve pas.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] };
  const asked = (patch: Record<string, unknown> = {}, job = 'ask') =>
    ev('run.finished', { runId: 'q1', job, outcome: 'success', costUsd: 0, turns: 1, lastText: '', output: { ...output, relay: true }, ...patch }, { at: 5000 });
  const relays = (d: ReturnType<typeof decide>) => d.events.filter((e) => e.type === 'relay.added' || e.type === 'relay.done');
  const activities = (d: ReturnType<typeof decide>) => d.effects.filter((e) => e.kind === 'activity');
  const handed = (runId: string, to?: string) => ({ runId, at: 1, ...(to ? { handedTo: to } : {}) });

  it('posts its answer, tells the human the question goes to the agent that implements, and adds it to the run inbox', () => {
    const out = decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), asked(), workflow);
    expect(out.effects.map((e) => e.kind)).toEqual(['post_output', 'activity']);
    expect(activities(out)).toEqual([{ kind: 'activity', type: 'response', body: expect.stringContaining('at the end of its current step'), runId: 'q1' }]);
    expect(relays(out)).toEqual([{ type: 'relay.added', question: { runId: 'q1', at: 5000 } }]);
  });

  it('starts the workflow\'s relay job when nothing runs, a question and not a round of human review (ORC-374, ORC-375)', () => {
    // At its bound of rounds, still: the relay answers a question, it is no review.
    const out = decide(ticket({ logical: 'human_review', humanReviewRounds: workflow.limits.humanReviewRounds }), asked(), workflow);
    expect(relays(out)).toEqual([{ type: 'relay.added', question: { runId: 'q1', at: 5000 } }]);
    expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'answer-relayed', input: 'feedback' })]);
    expect(activities(out)).toEqual([expect.objectContaining({ runId: 'q1', body: expect.stringContaining('I am asking the agent that implements now') })]);
    expect(out.events.map((e) => e.type)).not.toContain('ticket.patched');
    expect(out.events.map((e) => e.type)).not.toContain('ticket.blocked');
    // In In Progress with no step at work, the same job, where a reply starts one.
    expect(decide(ticket(), asked(), workflow).effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'answer-relayed' })]);
  });

  it('a version frozen before ORC-375, with no relay job, starts the reply rule\'s job as it did (ORC-374)', () => {
    const out = decide(ticket({ logical: 'human_review', humanReviewRounds: workflow.limits.humanReviewRounds }), asked(), beforeOrc375);
    expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'fix-human', input: 'feedback' })]);
    expect(out.events.map((e) => e.type)).not.toContain('ticket.patched');
    expect(decide(ticket(), asked(), beforeOrc375).effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'dev-feedback' })]);
  });

  it('a human change request waiting beside it makes the start a round of human review: that job reads it (ORC-190)', () => {
    const bound = workflow.limits.humanReviewRounds!;
    const feedback = [item(), item({ kind: 'question', body: 'pourquoi ?' })];
    expect(decide(ticket({ logical: 'human_review', humanInbox: feedback, humanReviewRounds: 0 }), asked(), workflow).events).toContainEqual({ type: 'ticket.patched', patch: { humanReviewRounds: 1 } });
    const past = decide(ticket({ logical: 'human_review', humanInbox: feedback, humanReviewRounds: bound }), asked(), workflow);
    expect(past.events.map((e) => e.type)).toContain('ticket.blocked');
    expect(past.effects.filter((e) => e.kind === 'start_run')).toEqual([]);
    // A question of the session alone, the one relayed maybe, is no change request: the relay job answers it (ORC-375).
    expect(decide(ticket({ logical: 'human_review', humanInbox: [feedback[1]!], humanReviewRounds: bound }), asked(), workflow).effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'answer-relayed' })]);
  });

  it('with no reply rule to start, or waiting on its blockers, keeps it for the launch still to come (ORC-363)', () => {
    for (const t of [ticket({ waitingOn: { blockers: ['REL-0'], start: { job: 'dev' } } }), ticket({ logical: 'todo', waitingOn: { blockers: ['REL-0'], start: { job: 'dev' } } }), ticket({ logical: 'ai_review' })]) {
      const out = decide(t, asked(), workflow);
      expect(relays(out)).toHaveLength(1);
      expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([]);
      expect(activities(out)).toEqual([expect.objectContaining({ body: expect.stringContaining('when its next step starts') })]);
    }
  });

  it('tells the human no answer will come, and keeps nothing, on a blocked ticket (ORC-374)', () => {
    for (const t of [ticket({ blocked: true, blockReason: 'x', blockKind: 'failed' }), ticket({ blocked: true, blockReason: 'x', blockKind: 'failed', activeRunId: 'r1', activeJob: 'dev' })]) {
      const out = decide(t, asked(), workflow);
      expect(relays(out)).toEqual([]);
      expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([]);
      expect(activities(out)).toEqual([expect.objectContaining({ runId: 'q1', body: expect.stringContaining('no answer will come') })]);
    }
  });

  it('relays nothing for a ticket no agent implements: not delegated, or delivered', () => {
    for (const t of [ticket({ delegated: false }), ticket({ prState: 'MERGED', logical: 'done' })]) {
      const out = decide(t, asked(), workflow);
      expect(relays(out)).toEqual([]);
      expect(activities(out)).toEqual([expect.objectContaining({ type: 'response', body: expect.stringContaining('No agent implements this ticket') })]);
    }
  });

  it('an answer without relay, one that did not finish, or a relay from another job of the queue relays nothing', () => {
    const t = ticket({ activeRunId: 'r1' });
    expect(relays(decide(t, asked({ output }), workflow))).toEqual([]);
    expect(relays(decide(t, asked({ outcome: 'failure' }), workflow))).toEqual([]);
    // A questions job that is not the answer agent: no human question waits on it.
    const other = { ...workflow, jobs: { ...workflow.jobs, other: { ...workflow.jobs['ask']!, name: 'other', workspace: 'worktree' as const } } };
    const out = decide(t, asked({}, 'other'), other);
    expect(relays(out)).toEqual([]);
    expect(activities(out)).toEqual([]);
  });

  it("relays the implementer's answer to each question it was handed, where it was asked, then they leave the run inbox", () => {
    const t = ticket({ activeRunId: 'r1', activeJob: 'dev-feedback', relayed: [handed('q1', 'r1'), handed('q2', 'r1'), handed('q3')] });
    const end = ev('run.finished', { runId: 'r1', job: 'dev-feedback', outcome: 'success', costUsd: 0, turns: 1, lastText: '', output: { ...output, answers: [{ question: 'q1', answer: 'Le ticket demande du CSV.' }] } });
    const out = decide(t, end, workflow);
    expect(activities(out)).toEqual([
      { kind: 'activity', type: 'response', body: 'The agent that implements answers: Le ticket demande du CSV.', runId: 'q1' },
      { kind: 'activity', type: 'response', body: expect.stringContaining('without answering your question'), runId: 'q2' },
    ]);
    expect(relays(out)).toEqual([{ type: 'relay.done', runId: 'r1' }]);
  });

  it('a stopped or failed step answers none of its questions: the humans are told, the questions leave', () => {
    const t = ticket({ activeRunId: 'r1', activeJob: 'dev', relayed: [handed('q1', 'r1')] });
    for (const outcome of ['stopped', 'failure'] as const) {
      const out = decide(t, ev('run.finished', { runId: 'r1', job: 'dev', outcome, costUsd: 0, turns: 1, lastText: '' }), workflow);
      expect(activities(out), outcome).toContainEqual(expect.objectContaining({ runId: 'q1', body: expect.stringContaining('without answering your question') }));
      expect(relays(out), outcome).toEqual([{ type: 'relay.done', runId: 'r1' }]);
    }
  });

  it('a step cut by the usage limit keeps its questions for its relaunch, or the next launch of the session', () => {
    const t = ticket({ activeRunId: 'r1', activeJob: 'dev', relayed: [handed('q1', 'r1')] });
    const out = decide(t, ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '', usageLimit: { resetAt: 9000 } }), workflow);
    expect(relays(out)).toEqual([]);
    expect(activities(out).filter((a) => a.runId === 'q1')).toEqual([]);
  });

  it('the end of a step with no message waiting but a question relayed meanwhile resumes the agent, as no round (ORC-374)', () => {
    // The AI review was at work when the question came: its end, in Human Review, is the step boundary that asks it.
    const frozen = beforeOrc183(workflow);
    const passed = ev('verify.passed', { runId: 'r1', job: 'review' });
    const t = ticket({ logical: 'ai_review', verifyingRunId: 'r1', relayed: [handed('q1')], humanReviewRounds: workflow.limits.humanReviewRounds });
    const out = decide(t, passed, frozen);
    expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'answer-relayed', input: 'feedback' })]);
    expect(out.events.map((e) => e.type)).not.toContain('ticket.blocked');
    // Frozen before ORC-375: the reply rule's job, as it was.
    const { relayJob: _r, ...older } = frozen;
    expect(decide(t, passed, older).effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'fix-human', input: 'feedback' })]);
  });

  describe('the end of the relay job (ORC-375)', () => {
    const sha = 'a'.repeat(40);
    const FROZEN: TicketState['frozenTests'] = { sha, files: {} };
    const answered = { ...output, answers: [{ question: 'q1', answer: 'Le ticket demande du CSV.' }] };
    const end = (committed = false) => ev('run.finished', { runId: 'r1', job: 'answer-relayed', outcome: 'success', costUsd: 0, turns: 1, lastText: '', output: answered, ...(committed ? { committed: true as const } : {}) });
    const inReviewAnswering = (patch: Partial<TicketState> = {}) =>
      ticket({ logical: 'human_review', activeRunId: 'r1', activeJob: 'answer-relayed', verifiedSha: sha, relayed: [handed('q1', 'r1')], ...patch });

    it('with no commit: the answer is relayed, and nothing moves, posts, checks or reviews (criterion 1)', () => {
      // Frozen tests too (ORC-131): they check a commit, and the answer wrote none.
      for (const t of [inReviewAnswering(), inReviewAnswering({ frozenTests: FROZEN })]) {
        const out = decide(t, end(), workflow);
        expect(activities(out)).toEqual([expect.objectContaining({ runId: 'q1', body: 'The agent that implements answers: Le ticket demande du CSV.' })]);
        expect(out.effects.map((e) => e.kind)).toEqual(['activity']);
        expect(out.events.map((e) => e.type)).toEqual(['relay.done']);
      }
    });

    it('with a commit: the reply rule\'s path, its checks, then its publication, move and review', () => {
      const t = inReviewAnswering();
      const out = decide(t, end(true), workflow);
      expect(out.events).toContainEqual({ type: 'verify.started', runId: 'r1' });
      expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'run_verify', runId: 'r1', job: 'fix-human' }));
      expect(out.effects.filter((e) => e.kind === 'move' || e.kind === 'post_output' || e.kind === 'start_run')).toEqual([]);
      // Not a round of human review: a question started it.
      expect(out.events.filter((e) => e.type === 'ticket.patched')).toEqual([]);
      let after = reduce(t, end(true));
      for (const e of out.events) after = reduce(after, e);
      const published = decide({ ...after!, owedMove: 'ai_review' }, ev('publish.done', { runId: 'r1', job: 'fix-human', sha: 'b'.repeat(40) }), workflow);
      expect(published.effects.filter((e) => e.kind === 'move' || e.kind === 'start_run')).toEqual([{ kind: 'move', to: 'ai_review' }, expect.objectContaining({ job: 'review' })]);
    });

    it('in a state where no reply starts a job any more, a commit still goes through the relay job\'s own end', () => {
      const out = decide(inReviewAnswering({ logical: 'ai_review' }), end(true), workflow);
      expect(out.effects.filter((e) => e.kind === 'run_verify')).toEqual([]);
      expect(out.trace).toContainEqual(expect.stringContaining('left unpublished'));
    });
  });

  it('the end of the step the questions were handed to starts nothing for them: they are answered', () => {
    const quick = { ...beforeOrc170, jobs: { ...beforeOrc170.jobs, 'dev-feedback': { ...beforeOrc170.jobs['dev-feedback']!, verify: [], repoChecks: false } } };
    const end = ev('run.finished', { runId: 'r1', job: 'dev-feedback', outcome: 'success', costUsd: 0, turns: 1, lastText: '', output });
    const out = decide(ticket({ activeRunId: 'r1', activeJob: 'dev-feedback', relayed: [handed('q1', 'r1')] }), end, quick);
    expect(relays(out)).toEqual([{ type: 'relay.done', runId: 'r1' }]);
    expect(out.effects.filter((e) => e.kind === 'start_run')).toEqual([]);
    // One relayed since that launch is still to ask.
    const later = decide(ticket({ activeRunId: 'r1', activeJob: 'dev-feedback', relayed: [handed('q1', 'r1'), handed('q2')] }), end, quick);
    expect(later.effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'answer-relayed' })]);
    // Since ORC-170 the end of `dev-feedback` starts the review: a question relayed since waits for the review's end.
    const current = { ...workflow, jobs: { ...workflow.jobs, 'dev-feedback': { ...workflow.jobs['dev-feedback']!, verify: [], repoChecks: false } } };
    const reviewed = decide(ticket({ activeRunId: 'r1', activeJob: 'dev-feedback', relayed: [handed('q1', 'r1'), handed('q2')] }), end, current);
    expect(relays(reviewed)).toEqual([{ type: 'relay.done', runId: 'r1' }]);
    expect(reviewed.effects.filter((e) => e.kind === 'start_run')).toEqual([expect.objectContaining({ job: 'review' })]);
  });

  describe('the questions still relayed when the work ends (ORC-374)', () => {
    const relayed = [handed('q1', 'r1'), handed('q2')];
    const dropped = (d: ReturnType<typeof decide>) => d.events.filter((e) => e.type === 'relay.dropped');
    const merged = ev('pr.merged', { number: 7, url: 'u' } as EventPayloads['pr.merged']);
    const cancelled = ev('status.changed', { from: 'dev', to: null, cancelled: true });
    const undelegated = ev('ticket.undelegated', {});

    it.each([
      ['merged', ticket({ activeRunId: 'r1', activeJob: 'dev', prNumber: 7, prState: 'OPEN', relayed }), merged],
      ['cancelled', ticket({ activeRunId: 'r1', activeJob: 'dev', relayed }), cancelled],
      ['undelegated', ticket({ activeRunId: 'r1', activeJob: 'dev', relayed }), undelegated],
      // Blocked, an undelegation cancels no work: the questions go all the same.
      ['undelegated while blocked', ticket({ blocked: true, blockReason: 'x', blockKind: 'failed', relayed }), undelegated],
    ])('%s: each human hears no answer will come, in the thread of the question, and they leave', (_what, t, event) => {
      const out = decide(t, event, workflow);
      expect(activities(out).filter((a) => a.runId)).toEqual([
        { kind: 'activity', type: 'response', body: expect.stringContaining('no answer will come'), runId: 'q1' },
        { kind: 'activity', type: 'response', body: expect.stringContaining('no answer will come'), runId: 'q2' },
      ]);
      expect(dropped(out)).toEqual([{ type: 'relay.dropped' }]);
      let after = reduce(t, event);
      for (const e of out.events) after = reduce(after, e);
      expect(after!.relayed).toBeUndefined();
    });

    it('work cancelled to go on, by a stop, keeps them for the launch that resumes it', () => {
      const out = decide(ticket({ activeRunId: 'r1', activeJob: 'dev', relayed }), ev('label.changed', { label: 'agent:stop', change: 'added' }), workflow);
      expect(out.events.map((e) => e.type)).toContain('work.cancelled');
      expect(dropped(out)).toEqual([]);
      expect(activities(out).filter((a) => a.runId)).toEqual([]);
    });

    it('nothing relayed, nothing said nor dropped', () => {
      expect(dropped(decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), cancelled, workflow))).toEqual([]);
    });

    it('the stopped run that held them says nothing more', () => {
      const t = ticket({ activeRunId: 'r1', activeJob: 'dev', relayed });
      const out = decide(t, cancelled, workflow);
      let after = reduce(t, cancelled);
      for (const e of out.events) after = reduce(after, e);
      const stopped = decide(after, ev('run.finished', { runId: 'r1', job: 'dev', outcome: 'stopped', costUsd: 0, turns: 1, lastText: '' }), workflow);
      expect(activities(stopped)).toEqual([]);
    });
  });

  it('reduce adds, hands and removes them by run, whatever else came in meanwhile', () => {
    let t: TicketState = ticket();
    t = reduce(t, { type: 'relay.added', question: handed('q1') })!;
    t = reduce(t, { type: 'relay.handed', runIds: ['q1'], to: 'r1' })!;
    t = reduce(t, { type: 'relay.added', question: handed('q2') })!;
    expect(t.relayed).toEqual([handed('q1', 'r1'), handed('q2')]);
    t = reduce(t, { type: 'relay.done', runId: 'r1' })!;
    expect(t.relayed).toEqual([handed('q2')]);
    t = reduce(reduce(t, { type: 'relay.handed', runIds: ['q2'], to: 'r2' })!, { type: 'relay.done', runId: 'r2' })!;
    expect(t.relayed).toBeUndefined();
  });
});
