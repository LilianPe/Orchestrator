import { describe, expect, it } from 'vitest';
import type { MeasureFacts, RunRecord } from '../store/types.js';
import { auditSheet, humanReviewed, missRate, NO_DEFINITION, type KeptFinding, type ReviewDefect } from './audit.js';
import { TRUSTED, type EventPayloads, type EventType, type FactoryEvent } from './types.js';

const ev = <T extends EventType>(id: string, type: T, at: number, payload: EventPayloads[T], signed: { actor?: string } = {}): FactoryEvent =>
  ({ ...TRUSTED, id, type, at, projectId: 'p', ticketId: 'REL-1', ...signed, payload }) as FactoryEvent;

const run = (patch: Partial<RunRecord>): RunRecord => ({
  id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'success', claudeSessionId: 'c', startedAt: 0, endedAt: 10,
  costUsd: 0, turns: 1, lastText: '', token: 'secret-run-token', cwd: '/w', ...patch,
});

const facts = (patch: Partial<MeasureFacts>): MeasureFacts => ({ devSession: undefined, events: [], runs: [], effects: [], acks: {}, ...patch });

const pr = { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1' };
const spec = { goal: 'Export the list as CSV', criteria: ['Given a list, when exported, then a CSV comes out'] };

const finding = (patch: Partial<KeptFinding> = {}): KeptFinding => ({
  id: 'rv1:correctness:0', sha: 'abc', at: 25, lens: 'correctness', runId: 'rv1', file: 'src/export.ts', line: 12, severity: 'blocking', explanation: 'off by one', suggestion: '', ...patch,
});

const defect = (patch: Partial<ReviewDefect> = {}): ReviewDefect => ({
  id: 'd1', projectId: 'p', ticketId: 'REL-1', prNumber: 3, description: 'the header row is missing', findingId: null, definition: 'breaks a user flow', enteredBy: 'dashboard:armand', at: 100, ...patch,
});

/** A ticket specified, built, checked, reviewed by an AI lens then by a human, sent back once, merged. */
const reviewed = facts({
  events: [
    ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }, { actor: 'u-lilian' }),
    ev('fs', 'run.finished', 5, { runId: 'rs', job: 'spec_draft', outcome: 'success', costUsd: 0, turns: 2, lastText: '', output: { status: 'done', summary: 'spec', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], spec } as never }),
    ev('f', 'run.finished', 10, { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0, turns: 4, lastText: 'merge me, all good' }),
    ev('v', 'verify.passed', 15, { runId: 'r1', job: 'dev', sha: 'abc', commands: ['npm test'] } as never),
    ev('o', 'pr.opened', 20, pr),
    ev('fr', 'run.finished', 25, { runId: 'rv1', job: 'review', outcome: 'success', costUsd: 0, turns: 3, lastText: '' }),
    ev('rh', 'pr.reviewed', 30, { ...pr, kind: 'review', author: 'lilian-gh', body: 'no header row', state: 'CHANGES_REQUESTED' }),
    ev('m', 'pr.merged', 50, { ...pr, mergedAt: 50 } as never),
  ],
  runs: [
    run({ id: 'rs', job: 'spec_draft', startedAt: 1, endedAt: 5 }),
    run({ id: 'r1', startedAt: 6, endedAt: 10 }),
    run({ id: 'rv1', job: 'review', sessionRole: 'reviewer', startedAt: 21, endedAt: 25 }),
  ],
});

describe('auditSheet (ORC-229)', () => {
  it('gives a reviewed PR its three parts: the task, the agent path, the result', () => {
    const sheet = auditSheet({ projectId: 'p', ticketId: 'REL-1', title: 'Export CSV' }, reviewed, [finding()], [defect()]);
    expect(sheet.task).toEqual({ title: 'Export CSV', spec });
    expect(sheet.path.steps.map((s) => [s.job, s.attempts])).toEqual([['spec_draft', 1], ['dev', 1], ['review', 1]]);
    expect(sheet.path.attempts.map((a) => a.id)).toEqual(['rs', 'r1', 'rv1']);
    expect(sheet.path.checks).toMatchObject([{ id: 'v', check: 'verify', result: 'passed', names: ['npm test'] }]);
    expect(sheet.path.findings).toEqual([finding()]);
    expect(sheet.result).toMatchObject({
      prs: [{ number: 3, url: 'https://gh/pr/3', state: 'merged', mergedAt: 50 }],
      reviews: [{ id: 'rh', author: 'lilian-gh', pr: 3, kind: 'review', state: 'changes_requested' }],
      firstTry: false,
      reworks: [{ cause: 'changes_requested', id: 'rh' }],
      revertedWithin14Days: null,
    });
    expect(sheet.defects).toEqual([defect()]);
  });

  it('never carries the agent text nor the run token', () => {
    const served = JSON.stringify(auditSheet({ projectId: 'p', ticketId: 'REL-1', title: 'Export CSV' }, reviewed, [], []));
    expect(served).not.toContain('merge me, all good');
    expect(served).not.toContain('secret-run-token');
  });

  it('a PR closed without merging, or still open, says so; a ticket without a spec has none', () => {
    const sheet = auditSheet({ projectId: 'p', ticketId: 'REL-1', title: 'T' }, facts({
      events: [ev('o', 'pr.opened', 1, pr), ev('c', 'pr.closed', 2, pr), ev('o2', 'pr.opened', 3, { ...pr, number: 4, url: 'https://gh/pr/4' })],
    }), [], []);
    expect(sheet.task.spec).toBeNull();
    expect(sheet.result.prs).toEqual([{ number: 3, url: 'https://gh/pr/3', state: 'closed', mergedAt: null }, { number: 4, url: 'https://gh/pr/4', state: 'open', mergedAt: null }]);
  });

  it('a PR closed then reopened is open again; a merge is timed by GitHub when it names the time', () => {
    const sheet = auditSheet({ projectId: 'p', ticketId: 'REL-1', title: 'T' }, facts({
      events: [ev('o', 'pr.opened', 1, pr), ev('c', 'pr.closed', 2, pr), ev('o2', 'pr.opened', 3, pr)],
    }), [], []);
    expect(sheet.result.prs).toEqual([{ number: 3, url: 'https://gh/pr/3', state: 'open', mergedAt: null }]);
    const merged = auditSheet({ projectId: 'p', ticketId: 'REL-1', title: 'T' }, facts({ events: [ev('o', 'pr.opened', 1, pr), ev('m', 'pr.merged', 90, { ...pr, mergedAt: 40 } as never)] }), [], []);
    expect(merged.result.prs[0]).toMatchObject({ state: 'merged', mergedAt: 40 });
  });
});

describe('humanReviewed (ORC-229)', () => {
  it('a PR a human reviewed on GitHub, or one the factory handed to Human Review, is a reviewed PR; one the AI alone read is not', () => {
    expect(humanReviewed(reviewed)).toBe(true);
    expect(humanReviewed(facts({ events: [ev('o', 'pr.opened', 1, pr)] }))).toBe(false);
    const handed = facts({ events: [ev('o', 'pr.opened', 1, pr)], effects: [{ id: 'e', projectId: 'p', ticketId: 'REL-1', eventId: 'x', seq: 1, i: 1, status: 'done', attempts: 1, effect: { kind: 'move', to: 'human_review' } as never }] });
    expect(humanReviewed(handed)).toBe(true);
  });
});

describe('missRate (ORC-229)', () => {
  const period = { since: 0, until: 1_000 };

  it('counts nothing while no definition of a serious defect is set (ORC-153), and says why', () => {
    const rate = missRate(period, [defect(), defect({ id: 'd2', findingId: 'rv1:correctness:0' })], undefined);
    expect(rate).toEqual({ counted: false, why: NO_DEFINITION });
    expect(Object.values(rate).some((v) => typeof v === 'number')).toBe(false);
  });

  it('is the share of the human defects with no matching AI finding, over those entered under the definition in force', () => {
    const def = 'breaks a user flow';
    const rate = missRate(period, [
      defect({ id: 'd1' }),
      defect({ id: 'd2', findingId: 'rv1:correctness:0' }),
      defect({ id: 'd3' }),
      defect({ id: 'd4', findingId: 'rv1:security:1' }),
      // Entered before the definition was set, or under another one: not counted, said left out.
      defect({ id: 'd5', definition: null }),
      defect({ id: 'd6', definition: 'any bug' }),
      // Out of the period.
      defect({ id: 'd7', at: 1_000 }),
    ], def);
    expect(rate).toEqual({ counted: true, definition: def, defects: 4, missed: 2, rate: 0.5, leftOut: 2 });
  });

  it('gives no rate, never a zero, without a defect to count', () => {
    expect(missRate(period, [], 'breaks a user flow')).toEqual({ counted: true, definition: 'breaks a user flow', defects: 0, missed: 0, rate: null, leftOut: 0 });
  });
});
