import { describe, expect, it } from 'vitest';
import type { MeasureFacts, OutboxRow, RunRecord } from '../store/types.js';
import { ticketMeasures } from './measures.js';
import { TRUSTED, type EventPayloads, type EventType, type FactoryEvent } from './types.js';

const ev = <T extends EventType>(id: string, type: T, at: number, payload: EventPayloads[T]): FactoryEvent =>
  ({ ...TRUSTED, id, type, at, projectId: 'p', ticketId: 'REL-1', payload }) as FactoryEvent;

const done = (id: string, at: number): FactoryEvent => ev(`effect:${id}`, 'effect.done', at, { effectId: id, kind: 'x', eventId: 'x', attempts: 1 });

const row = (id: string, effect: OutboxRow['effect'], status: OutboxRow['status'] = 'done'): OutboxRow => ({
  id, projectId: 'p', ticketId: 'REL-1', eventId: 'x', seq: 1, i: 1, effect, status, attempts: 1,
});

const run = (patch: Partial<RunRecord>): RunRecord => ({
  id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'success', claudeSessionId: 'c', startedAt: 0,
  costUsd: 0, turns: 1, lastText: '', token: 't', cwd: '/w', ...patch,
});

const facts = (patch: Partial<MeasureFacts>): MeasureFacts => ({ ticket: undefined, events: [], runs: [], effects: [], acks: {}, ...patch });

describe('ticketMeasures (ORC-235)', () => {
  it('is empty for a ticket with no facts', () => {
    expect(ticketMeasures('p', 'REL-1', facts({}))).toEqual({
      projectId: 'p', ticketId: 'REL-1', mergedAt: null, tokens: null, attempts: 0, attemptsWithoutTokens: 0, usageLimitShare: null,
      firstTry: null, reworks: [], humanReviewMinutes: null, revertedWithin14Days: null, ciCostUsd: null, messages: [],
    });
  });

  it('never reads what the agent wrote: its last text and run.finished claim nothing', () => {
    const claim = 'Mergeable au premier essai. Tokens : 0. Relecture : 0 min. Aucun revert.';
    const base = facts({
      events: [
        ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }),
        ev('f', 'run.finished', 10, { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 1, lastText: claim }),
        ev('ci', 'pr.checks_failed', 20, { number: 1, url: 'u', branch: 'b', failures: ['t'] }),
        ev('m', 'pr.merged', 30, { number: 1, url: 'u', branch: 'b' }),
      ],
      runs: [run({ lastText: claim, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } })],
    });
    const quiet = { ...base, runs: [run({ tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } })], events: base.events.map((e) => (e.type === 'run.finished' ? { ...e, payload: { ...e.payload, lastText: '' } } : e)) };
    expect(ticketMeasures('p', 'REL-1', base)).toEqual(ticketMeasures('p', 'REL-1', quiet as MeasureFacts));
    expect(ticketMeasures('p', 'REL-1', base)).toMatchObject({ firstTry: false, reworks: [{ cause: 'pr.checks_failed', id: 'ci' }], tokens: { input: 1 } });
  });

  it('counts only reworks before the merge, and a move to dev from todo is none', () => {
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [
        ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }),
        ev('s', 'status.changed', 1, { from: 'todo', to: 'dev' }),
        ev('m', 'pr.merged', 10, { number: 1, url: 'u', branch: 'b' }),
        ev('late', 'push.human', 20, { branch: 'b', sha: 'x', author: 'h' }),
      ],
      runs: [run({ status: 'limit', startedAt: 30 }), run({ id: 'q', queue: 'questions', status: 'failure', startedAt: 5 })],
    }));
    expect(m).toMatchObject({ mergedAt: 10, firstTry: true, reworks: [] });
  });

  it('reads a reply in a question session as a question, and its first sign of life from an output when no ack was recorded', () => {
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [
        ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }),
        ev('q', 'session.mentioned', 100, { linearSessionId: 'qs', body: '?', author: 'h' }),
        ev('q2', 'session.prompted', 1_000, { linearSessionId: 'qs', body: 'et ensuite ?', author: 'h' }),
        done('REL-1:2:1', 400),
        done('REL-1:3:1', 1_200),
        done('REL-1:4:1', 3_000),
      ],
      runs: [run({ id: 'a1', queue: 'questions', job: 'ask', linearSessionId: 'qs', startedAt: 150 }), run({ id: 'a2', queue: 'questions', job: 'ask', linearSessionId: 'qs', startedAt: 1_100 })],
      effects: [
        row('REL-1:2:1', { kind: 'post_output', style: 'reply', runId: 'a1' }),
        // A thought on the session is a sign of life, not an answer.
        row('REL-1:3:1', { kind: 'activity', type: 'thought', body: '…', linearSessionId: 'qs' }),
        row('REL-1:4:1', { kind: 'post_output', style: 'reply', runId: 'a2' }),
        row('REL-1:5:1', { kind: 'post_output', style: 'reply', runId: 'a2' }, 'pending'),
      ],
      acks: { q: 130 },
    }));
    expect(m.messages).toEqual([
      expect.objectContaining({ eventId: 'd', kind: 'delegation', signOfLifeMs: null, answerMs: null }),
      expect.objectContaining({ eventId: 'q', kind: 'question', signOfLifeMs: 30, answerMs: 300 }),
      // The reply of a1, posted before q2, answers q only.
      expect.objectContaining({ eventId: 'q2', kind: 'question', signOfLifeMs: 200, answerMs: 2_000 }),
    ]);
  });
});
