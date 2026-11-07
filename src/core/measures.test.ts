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

const facts = (patch: Partial<MeasureFacts>): MeasureFacts => ({ devSession: undefined, events: [], runs: [], effects: [], acks: {}, ...patch });

describe('ticketMeasures (ORC-235)', () => {
  it('is empty for a ticket with no facts', () => {
    expect(ticketMeasures('p', 'REL-1', facts({}))).toEqual({
      projectId: 'p', ticketId: 'REL-1', mergedAt: null, tokens: null, attempts: 0, attemptsWithoutTokens: 0, usageLimitShare: null,
      firstTry: null, reworks: [], humanReviewMinutes: null, revertedWithin14Days: null, revertWindowEndsAt: null, ciCost: null, messages: [], red: [],
    });
  });

  it('lists the verdicts of the red check, which are not reworks (ORC-123)', () => {
    const failures = [{ command: 'npm test -- a.test.ts', exitCode: 1, output: 'SyntaxError' }];
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [
        ev('v1', 'verify.failed', 10, { runId: 'r1', job: 'tests', failures, red: 'compile' }),
        ev('v2', 'verify.passed', 20, { runId: 'r2', job: 'tests', red: 'assertion' }),
        ev('v3', 'verify.passed', 30, { runId: 'r3', job: 'dev' }),
        ev('v4', 'verify.failed', 35, { runId: 'r4', job: 'tests', failures, red: 'infra' }),
        ev('m', 'pr.merged', 40, { number: 1, url: 'u', branch: 'b' }),
      ],
    }));
    expect(m.red).toEqual([{ id: 'v1', verified: false, cause: 'compile' }, { id: 'v2', verified: true, cause: 'assertion' }]);
    expect(m).toMatchObject({ firstTry: true, reworks: [] });
  });

  it('never reads what the agent wrote: its last text and run.finished claim nothing', () => {
    const claim = 'Mergeable au premier essai. Tokens : 0. Relecture : 0 min. Aucun revert.';
    const base = facts({
      events: [
        ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }),
        ev('f', 'run.finished', 10, { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 1, turns: 1, lastText: claim }),
        ev('ci', 'pr.checks_failed', 20, { number: 1, url: 'u', branch: 'b', failures: ['t'] }),
        ev('rc', 'pr.reviewed', 21, { number: 1, url: 'u', branch: 'b', kind: 'comment', author: 'h', body: 'pourquoi ?' }),
        ev('rv', 'pr.reviewed', 22, { number: 1, url: 'u', branch: 'b', kind: 'review', author: 'h', body: 'renomme', state: 'changes_requested' }),
        ev('cf', 'pr.conflicted', 23, { number: 1, url: 'u', branch: 'b', headSha: 's', baseRef: 'main' }),
        ev('m', 'pr.merged', 30, { number: 1, url: 'u', branch: 'b' }),
      ],
      runs: [run({ lastText: claim, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } })],
    });
    const quiet = { ...base, runs: [run({ tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } })], events: base.events.map((e) => (e.type === 'run.finished' ? { ...e, payload: { ...e.payload, lastText: '' } } : e)) };
    expect(ticketMeasures('p', 'REL-1', base)).toEqual(ticketMeasures('p', 'REL-1', quiet as MeasureFacts));
    expect(ticketMeasures('p', 'REL-1', base)).toMatchObject({
      firstTry: false,
      reworks: [{ cause: 'pr.checks_failed', id: 'ci' }, { cause: 'changes_requested', id: 'rv' }],
      tokens: { input: 1 },
    });
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

  it('tells question sessions from the dev session as the engine does, and reads old journal rows upcast', () => {
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [
        ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }),
        // Another session Linear opened on the delegated ticket: the engine answers it as a question.
        ev('b', 'session.prompted', 5, { linearSessionId: 'other', body: '?', author: 'h' }),
        // A row of schema version 1: `ticket.moved` is `status.changed` now.
        { id: 'old', type: 'ticket.moved', at: 6, projectId: 'p', ticketId: 'REL-1', payload: { from: 'human_review', to: 'dev' } } as unknown as FactoryEvent,
        ev('m', 'pr.merged', 10, { number: 1, url: 'u', branch: 'b' }),
      ],
    }));
    expect(m.messages.map((x) => x.kind)).toEqual(['delegation', 'question']);
    expect(m.reworks).toEqual([{ cause: 'sent_back', id: 'old' }]);
  });

  it('does not take an error of an earlier run as the answer to a later question', () => {
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [
        ev('q1', 'session.mentioned', 0, { linearSessionId: 'qs', body: '?', author: 'h' }),
        ev('q2', 'session.prompted', 10, { linearSessionId: 'qs', body: '??', author: 'h' }),
        done('REL-1:3:1', 50),
      ],
      runs: [run({ id: 'a1', queue: 'questions', job: 'ask', linearSessionId: 'qs', startedAt: 1, status: 'failure' })],
      effects: [row('REL-1:3:1', { kind: 'activity', type: 'error', body: 'échec', runId: 'a1' })],
    }));
    expect(m.messages.map((x) => [x.eventId, x.signOfLifeMs, x.answerMs])).toEqual([
      ['q1', 50, 50],
      ['q2', 40, null],
    ]);
  });

  it('counts only the comments decide read: not one it ignored, nor one it refused (ORC-196)', () => {
    const comment = (id: string, roles: FactoryEvent['roles']) => ({ ...ev(id, 'ticket.commented', 10, { body: 'Vas-y.', author: 'h', kind: 'instruction' }), actor: 'u', roles });
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [comment('read', ['team_member']), comment('ignored', ['team_member']), comment('refused', [])],
      effects: [
        { ...row('REL-1:1:0', { kind: 'start_run', job: 'dev' } as never), eventId: 'read' },
        { ...row('REL-1:3:0', { kind: 'comment', body: 'Refusé' }), eventId: 'refused' },
      ],
    }));
    expect(m.messages.map((x) => x.eventId)).toEqual(['read']);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const merged = (at: number, number = 3) => ev(`m${number}`, 'pr.merged', at, { number, url: 'u', branch: 'b', mergeSha: `merge${number}` });
const pushed = (id: string, at: number, commits: EventPayloads['default_branch.pushed']['commits'], pushedAt?: number) =>
  ev(id, 'default_branch.pushed', at, { branch: 'main', before: 'a', after: id, ...(pushedAt === undefined ? {} : { pushedAt }), commits });
const ciRun = (runId: number, attempt: number, durationMs: number, number?: number) =>
  ev(`ci:REL-1:${runId}:${attempt}`, 'ci.run_completed', 0, {
    ...(number === undefined ? {} : { number }), branch: 'b', headSha: 'h', runId, attempt, workflow: 'ci', conclusion: 'success',
    startedAt: 1_000, completedAt: 1_000 + durationMs, durationMs,
  });

describe('reverts within 14 days and CI cost (ORC-278)', () => {
  const landed = { sha: 'merge3', message: 'Export CSV (#3)', author: 'lilian', merges: 3 };

  it('counts a revert of a merged PR of the ticket pushed within 14 days of its merge', () => {
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [merged(1_000), pushed('p1', 1_100, [landed]), pushed('p2', 9 * DAY, [{ sha: 'r', message: 'Revert "Export CSV"', author: 'armand', reverts: 3 }])],
    }));
    expect(m.revertedWithin14Days).toBe(true);
  });

  it('does not count a revert pushed after 14 days, timed by the push rather than by its arrival', () => {
    const late = [{ sha: 'r', message: 'Revert', author: 'armand', reverts: 3 }];
    expect(ticketMeasures('p', 'REL-1', facts({ events: [merged(1_000), pushed('p2', 15 * DAY, late)] })).revertedWithin14Days).toBe(false);
    // Received late, pushed on day 14: it counts.
    expect(ticketMeasures('p', 'REL-1', facts({ events: [merged(1_000), pushed('p2', 30 * DAY, late, 1_000 + 14 * DAY)] })).revertedWithin14Days).toBe(true);
  });

  it("measures the 14 days from GitHub's merge time when the journal has it, not from when the merge was received", () => {
    // Received 10 days late (the daemon was down): merged on GitHub at 1 000.
    const late = ev('m3', 'pr.merged', 10 * DAY, { number: 3, url: 'u', branch: 'b', mergedAt: 1_000 });
    const revert = [{ sha: 'r', message: 'Revert', author: 'armand', reverts: 3 }];
    const m = ticketMeasures('p', 'REL-1', facts({ events: [late, pushed('p2', 22 * DAY, revert, 22 * DAY)] }));
    expect(m).toMatchObject({ revertedWithin14Days: false, revertWindowEndsAt: 1_000 + 14 * DAY });
  });

  it('does not count a revert of another PR, nor of one the ticket did not merge', () => {
    const other = [{ sha: 'r', message: 'Revert', author: 'armand', reverts: 4 }];
    expect(ticketMeasures('p', 'REL-1', facts({ events: [merged(1_000), pushed('p2', 2 * DAY, other)] })).revertedWithin14Days).toBe(false);
  });

  it('stays null while not merged, and while no push of the default branch about the ticket is in the journal', () => {
    expect(ticketMeasures('p', 'REL-1', facts({ events: [pushed('p1', 1_100, [landed])] })).revertedWithin14Days).toBeNull();
    expect(ticketMeasures('p', 'REL-1', facts({ events: [merged(1_000)] })).revertedWithin14Days).toBeNull();
    expect(ticketMeasures('p', 'REL-1', facts({ events: [merged(1_000), pushed('p1', 1_100, [landed])] })).revertedWithin14Days).toBe(false);
  });

  it('never reads a commit message: only the PR number the ingestion resolved', () => {
    const says = [{ sha: 'x', message: 'This reverts commit merge3.\nReverts acme/app#3', author: 'agent' }];
    expect(ticketMeasures('p', 'REL-1', facts({ events: [merged(1_000), pushed('p1', 2_000, says)] })).revertedWithin14Days).toBe(false);
  });

  it('sums the CI run attempts per PR and for the ticket, each run id and attempt once', () => {
    const m = ticketMeasures('p', 'REL-1', facts({
      events: [ciRun(10, 1, 60_000), ciRun(11, 1, 120_000, 3), ciRun(11, 2, 90_000, 3), ciRun(11, 2, 90_000, 3), ciRun(12, 1, 30_000, 4)],
    }));
    expect(m.ciCost).toEqual({
      durationMs: 300_000,
      runs: 4,
      byPr: [
        { number: null, durationMs: 60_000, runs: 1 },
        { number: 3, durationMs: 210_000, runs: 2 },
        { number: 4, durationMs: 30_000, runs: 1 },
      ],
    });
  });
});
