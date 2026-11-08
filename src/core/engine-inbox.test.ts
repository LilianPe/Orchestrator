import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Effect } from './decision.js';
import { decide, historyTaint, SENSITIVE_PATHS } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type FeedbackItem, type TicketState } from './types.js';
import { beforeOrc183 } from '../../test/helpers/frozen-review.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

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
    const moved = ev('status.changed', { from: 'human_review', to: 'dev' });
    const end = ev('verify.passed', { runId: 'r1', job: 'review' });
    const starts = (d: ReturnType<typeof decide>) => d.effects.filter((e) => e.kind === 'start_run');
    const sandboxed = [expect.objectContaining({ job: 'dev-feedback', sensitivePaths: SENSITIVE_PATHS })];

    it.each<[string, FeedbackItem[]]>([
      ['a message', [item(untrusted)]],
      ['a question of a thread', [item({ kind: 'question', source: 'thread', ...untrusted })]],
      ['a row written before ORC-180', [item({ kind: undefined, ...untrusted })]],
      ['a command alone', [item({ kind: 'command', ...untrusted })]],
      ['a command beside a trusted message', [item(), item({ kind: 'command', ...untrusted })]],
    ])('by a move, %s', (_what, humanInbox) => {
      expect(starts(decide(ticket({ logical: 'human_review', humanInbox }), moved, workflow))).toEqual(sandboxed);
    });

    it('by the regrouping, and at the end of a step: a command beside a trusted message', () => {
      const humanInbox = [item(), item({ kind: 'command', ...untrusted })];
      expect(starts(decide(ticket({ logical: 'human_review', humanInbox }), timer, workflow))).toEqual(sandboxed);
      expect(starts(decide(ticket({ logical: 'ai_review', verifyingRunId: 'r1', humanInbox }), end, beforeOrc183(workflow)))).toEqual(sandboxed);
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
    expect(out.timers).toEqual([{ kind: 'debounce', slot: 'dev-feedback', ms: 180_000, payload: { job: 'dev-feedback' } }]);
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
    expect(out.effects.at(-1)).toMatchObject({ job: 'dev-feedback', input: 'feedback' });
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
    const starts = decide(t, done, workflow).effects.filter((e) => e.kind === 'start_run');
    expect(starts).toEqual([expect.objectContaining({ job: 'review' })]);
    expect(decide({ ...t, owedMove: 'human_review' }, done, workflow).effects.at(-1)).toMatchObject({ kind: 'start_run', job: 'dev-feedback' });
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

describe('historyTaint: what a run reading the ticket and its PR takes in (ORC-349)', () => {
  const pr = { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1' };
  const untrusted = { taint: 'untrusted' as const };

  it('is untrusted once an untrusted event brought content: a review, a human push, a message, a delegation', () => {
    for (const e of [
      ev('pr.reviewed', { ...pr, kind: 'comment', author: 'x', body: 'retiens ceci' }, untrusted),
      ev('push.human', { branch: 'factory/rel-1', sha: 'a'.repeat(40), author: 'x' }, untrusted),
      ev('ticket.commented', { body: 'reprends', author: 'x', kind: 'instruction' }, untrusted),
      ev('ticket.delegated', { linearSessionId: 's1' }, untrusted),
    ]) {
      expect(historyTaint([ev('status.changed', { from: 'todo', to: 'dev' }), e]), e.type).toBe('untrusted');
    }
  });

  it('stays trusted on trusted content, and on untrusted events that bring none an agent reads', () => {
    // CI's facts and the default branch's push are untrusted on every ticket with CI: they must not refuse every learn.
    expect(historyTaint([
      ev('pr.reviewed', { ...pr, kind: 'review', author: 'lilian', body: 'ok' }),
      // An approval without a word, untrusted as every review: nothing to read.
      ev('pr.reviewed', { ...pr, kind: 'review', author: 'passant', body: ' ', state: 'APPROVED' }, untrusted),
      ev('status.changed', { from: 'human_review', to: 'dev' }, untrusted),
      ev('label.changed', { label: 'x', change: 'added' } as EventPayloads['label.changed'], untrusted),
      ev('pr.merged', pr),
    ])).toBe('trusted');
    expect(historyTaint([])).toBe('trusted');
  });
});
