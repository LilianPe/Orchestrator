import { describe, expect, it } from 'vitest';
import type { AgentOutput } from './agent-output.js';
import type { MeasureFacts, OutboxRow, RunRecord } from '../store/types.js';
import { LABELS } from '../../test/helpers/store-suite.js';
import { pendingLabels } from './attempt-labels.js';
import { runDetail } from './run-detail.js';
import { TRUSTED, type EventPayloads, type EventType, type FactoryEvent } from './types.js';

const ev = <T extends EventType>(id: string, type: T, at: number, payload: EventPayloads[T], signed: { actor?: string } = {}): FactoryEvent =>
  ({ ...TRUSTED, id, type, at, projectId: 'p', ticketId: 'REL-1', ...signed, payload }) as FactoryEvent;

const done = (effectId: string, kind: string, at: number): FactoryEvent => ev(`effect:${effectId}`, 'effect.done', at, { effectId, kind, eventId: 'x', attempts: 1 });

const row = (id: string, effect: OutboxRow['effect'], status: OutboxRow['status'] = 'done'): OutboxRow => ({
  id, projectId: 'p', ticketId: 'REL-1', eventId: 'x', seq: 1, i: 1, effect, status, attempts: 1,
});

const run = (patch: Partial<RunRecord>): RunRecord => ({
  id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'success', claudeSessionId: 'c', startedAt: 0, endedAt: 10,
  costUsd: 0, turns: 1, lastText: '', token: 'secret-run-token', cwd: '/w', ...patch,
});

const facts = (patch: Partial<MeasureFacts>): MeasureFacts => ({ devSession: undefined, events: [], runs: [], effects: [], acks: {}, ...patch });

const tokens = (n: number) => ({ input: n, output: n, cacheRead: n, cacheCreation: n });
const pr = { number: 3, url: 'https://gh/pr/3', branch: 'factory/rel-1' };
const output: AgentOutput = { status: 'done', summary: 'Export CSV added.', tests_added: ['export.test.ts'], why: '', assumptions: [], risks: ['large lists'], untested: [], review_hints: [] };

describe('runDetail (ORC-298)', () => {
  it('the timeline: every event of the ticket in journal order, those of this run marked, each said in the factory words', () => {
    const d = runDetail(run({ id: 'r1' }), facts({
      events: [
        ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }, { actor: 'u-lilian' }),
        ev('f', 'run.finished', 10, { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0, turns: 4, lastText: '' }),
        ev('v', 'verify.failed', 20, { runId: 'r1', job: 'dev', failures: [{ command: 'factory/anti-triche', exitCode: 1, output: '…' }] }),
        ev('f2', 'run.finished', 30, { runId: 'r2', job: 'dev', outcome: 'success', costUsd: 0, turns: 2, lastText: '' }),
        ev('s', 'status.changed', 40, { from: 'dev', to: 'human_review' }, { actor: 'u-lilian' }),
      ],
      runs: [run({ id: 'r1' }), run({ id: 'r2', startedAt: 25, endedAt: 30 })],
    }));
    expect(d.timeline).toEqual([
      { id: 'd', type: 'ticket.delegated', at: 0, ofRun: false, what: 'Delegated to the factory' },
      { id: 'f', type: 'run.finished', at: 10, ofRun: true, what: 'dev ended: success, 4 turns' },
      { id: 'v', type: 'verify.failed', at: 20, ofRun: true, what: 'Check of dev failed: factory/anti-triche' },
      { id: 'f2', type: 'run.finished', at: 30, ofRun: false, what: 'dev ended: success, 2 turns' },
      { id: 's', type: 'status.changed', at: 40, ofRun: false, what: 'Moved from dev to human_review' },
    ]);
  });

  it('never carries the agent text nor the run token: lastText is left out of the run and of the timeline', () => {
    const claim = 'Mergeable at the first try, 0 tokens spent.';
    const d = runDetail(run({ lastText: claim }), facts({
      events: [ev('f', 'run.finished', 10, { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: claim })],
      runs: [run({ lastText: claim })],
    }));
    const served = JSON.stringify(d);
    expect(served).not.toContain(claim);
    expect(served).not.toContain('secret-run-token');
  });

  it('the human decisions: who, when and what, from the signed actor or the author the source signed, never the factory own moves', () => {
    const d = runDetail(run({}), facts({
      events: [
        ev('d', 'ticket.delegated', 0, { linearSessionId: 'ls' }, { actor: 'u-lilian' }),
        ev('c', 'command', 5, { name: 'stop', body: '/stop', linearSessionId: 'ls', author: 'Lilian' }, { actor: 'u-lilian' }),
        ev('p', 'session.prompted', 6, { linearSessionId: 'ls', body: 'rename the column', author: 'Armand', kind: 'instruction' }, { actor: 'u-armand' }),
        // The factory moved it to Human Review, Linear echoes that move: not a human's.
        ev('m', 'status.changed', 7, { from: 'dev', to: 'human_review' }),
        ev('h', 'push.human', 8, { branch: 'b', sha: 'abc1234', author: 'armand-gh' }),
        ev('r', 'pr.reviewed', 9, { ...pr, kind: 'review', author: 'lilian-gh', body: 'ok', state: 'APPROVED' }),
        ev('ui:control.stop:11', 'control.stop', 11, {}),
        ev('rep', 'dead_letter.repaired', 12, { eventId: 'x', action: 'skip', by: 'armand', event: {} as never }),
        ev('s', 'status.changed', 13, { from: 'human_review', to: 'dev' }, { actor: 'u-lilian' }),
      ],
    }));
    expect(d.decisions.map(({ id, at, channel, who, what }) => ({ id, at, channel, who, what }))).toEqual([
      { id: 'd', at: 0, channel: 'linear', who: 'u-lilian', what: 'Delegated to the factory' },
      { id: 'c', at: 5, channel: 'linear', who: 'Lilian', what: 'Command /stop' },
      { id: 'p', at: 6, channel: 'linear', who: 'Armand', what: 'Replied in the session (instruction)' },
      { id: 'h', at: 8, channel: 'github', who: 'armand-gh', what: 'Pushed abc1234 on b' },
      { id: 'r', at: 9, channel: 'github', who: 'lilian-gh', what: 'Reviewed PR #3: approved' },
      { id: 'ui:control.stop:11', at: 11, channel: 'dashboard', who: null, what: 'Stopped the ticket' },
      { id: 'rep', at: 12, channel: 'cli', who: 'armand', what: 'Repaired a dead-lettered event (skip)' },
      { id: 's', at: 13, channel: 'linear', who: 'u-lilian', what: 'Moved from human_review to dev' },
    ]);
  });

  it('a merge done by the factory on the PR head is no human decision; one on GitHub is, an earlier PR merged by a human included', () => {
    const merged = (id: string, number: number, headSha: string) => ev(id, 'pr.merged', 10, { ...pr, number, headSha });
    expect(runDetail(run({}), facts({ events: [merged('m3', 3, 'aaa')] })).decisions.map((d) => d.what)).toEqual(['Merged PR #3']);
    const byFactory = facts({ events: [merged('m3', 3, 'aaa'), done('e1', 'merge', 19), merged('m5', 5, 'bbb')], effects: [row('e1', { kind: 'merge', sha: 'bbb' })] });
    expect(runDetail(run({}), byFactory).decisions.map((d) => d.id)).toEqual(['m3']);
    // A row from before ORC-278 names no head: any merge the factory carried out on the ticket counts.
    const old = facts({ events: [done('e1', 'merge', 9), ev('m', 'pr.merged', 10, pr)], effects: [row('e1', { kind: 'merge', sha: 'bbb' })] });
    expect(runDetail(run({}), old).decisions).toEqual([]);
  });

  it('the merge gate: the time in Human Review, from the factory move there to whatever moved the ticket out', () => {
    const move = (id: string, to: 'human_review' | 'done', status: OutboxRow['status'] = 'done') => row(id, { kind: 'move', to }, status);
    // The factory merges on a human's move to done: the gate ends with the factory's move to done, not with a guess.
    const merged = runDetail(run({}), facts({
      events: [
        done('e1', 'move', 20),
        // The echo of the factory's own move moves nothing.
        ev('echo', 'status.changed', 21, { from: 'dev', to: 'human_review' }),
        ev('cr', 'pr.reviewed', 25, { ...pr, kind: 'review', author: 'h', body: 'no', state: 'CHANGES_REQUESTED' }),
        ev('ok', 'status.changed', 30, { from: 'human_review', to: 'done' }, { actor: 'u' }),
        done('e2', 'merge', 31),
        ev('mg', 'pr.merged', 32, { ...pr, headSha: 'h1' }),
        done('e3', 'move', 33),
      ],
      effects: [move('e1', 'human_review'), row('e2', { kind: 'merge', sha: 'h1' }), move('e3', 'done')],
    }));
    // A review asking for changes moves nothing yet (ORC-190): the gate stays open until the human's move to done.
    expect(merged.gates).toEqual([{ gate: 'merge', openedAt: 20, closedAt: 30, to: 'done', closedBy: 'ok' }]);
    expect(merged.decisions.map((d) => d.id)).toEqual(['cr', 'ok']);

    // Sent back to AI review, then handed over again: two gates; a cancel closes the second.
    const twice = runDetail(run({}), facts({
      events: [
        done('e1', 'move', 20),
        ev('ai', 'status.changed', 25, { from: 'human_review', to: 'ai_review' }, { actor: 'u' }),
        done('e2', 'move', 40),
        ev('x', 'status.changed', 50, { from: 'human_review', to: null, cancelled: true }, { actor: 'u' }),
      ],
      effects: [move('e1', 'human_review'), move('e2', 'human_review')],
    }));
    expect(twice.gates).toEqual([
      { gate: 'merge', openedAt: 20, closedAt: 25, to: 'ai_review', closedBy: 'ai' },
      { gate: 'merge', openedAt: 40, closedAt: 50, to: 'cancelled', closedBy: 'x' },
    ]);

    // Still open; and a move the factory did not carry out opens nothing.
    expect(runDetail(run({}), facts({ events: [done('e1', 'move', 20)], effects: [move('e1', 'human_review')] })).gates).toEqual([{ gate: 'merge', openedAt: 20, closedAt: null, to: null, closedBy: null }]);
    expect(runDetail(run({}), facts({ events: [done('e1', 'move', 20)], effects: [move('e1', 'human_review', 'dead')] })).gates).toEqual([]);
  });

  it('the findings: the human reviews of the PR and the AI review rounds, with the closed outcome and the findings each lens handed back (ORC-183)', () => {
    const blocking = { file: 'src/export.ts', line: 12, severity: 'blocking' as const, explanation: 'The CSV is not escaped.', suggestion: 'Quote the fields.' };
    const d = runDetail(run({}), facts({
      events: [
        ev('rc', 'pr.reviewed', 5, { ...pr, kind: 'comment', author: 'lilian-gh', body: 'why?' }),
        ev('f', 'run.finished', 9, { runId: 'rv1', job: 'review', outcome: 'failure', costUsd: 0, turns: 3, lastText: '', attempt: 'failed' }),
        ev('rv', 'pr.reviewed', 10, { ...pr, kind: 'review', author: 'lilian-gh', body: 'rename', state: 'CHANGES_REQUESTED' }),
        ev('s', 'run.finished', 13, { runId: 'rv3', job: 'review-security', outcome: 'success', costUsd: 0, turns: 2, lastText: '', attempt: 'succeeded', output: { ...output, findings: [blocking] } }),
      ],
      runs: [
        run({ id: 'r1' }),
        run({ id: 'rv1', job: 'review', sessionRole: 'reviewer', status: 'failure', startedAt: 6, endedAt: 9 }),
        run({ id: 'rv2', job: 'review', sessionRole: 'reviewer', status: 'running', startedAt: 11, endedAt: undefined }),
        run({ id: 'rv3', job: 'review-security', sessionRole: 'reviewer', status: 'success', startedAt: 12, endedAt: 13 }),
      ],
    }));
    expect(d.findings).toEqual([
      { source: 'human', id: 'rc', at: 5, author: 'lilian-gh', pr: 3, kind: 'comment', state: null },
      { source: 'ai', runId: 'rv1', at: 9, job: 'review', status: 'failure', outcome: 'failed', findings: [] },
      { source: 'human', id: 'rv', at: 10, author: 'lilian-gh', pr: 3, kind: 'review', state: 'changes_requested' },
      { source: 'ai', runId: 'rv2', at: 11, job: 'review', status: 'running', outcome: null, findings: [] },
      { source: 'ai', runId: 'rv3', at: 13, job: 'review-security', status: 'success', outcome: 'succeeded', findings: [blocking] },
    ]);
  });

  it('two review rounds at the same instant come in journal order, whatever order the store gives the attempts in', () => {
    const lens = (runId: string, job: string) => ev(`f-${runId}`, 'run.finished', 9, { runId, job, outcome: 'success', costUsd: 0, turns: 1, lastText: '', attempt: 'succeeded' });
    const d = runDetail(run({}), facts({
      events: [lens('a', 'review'), lens('b', 'review-security')],
      runs: [
        run({ id: 'b', job: 'review-security', sessionRole: 'reviewer', status: 'success', startedAt: 6, endedAt: 9 }),
        run({ id: 'a', job: 'review', sessionRole: 'reviewer', status: 'success', startedAt: 6, endedAt: 9 }),
      ],
    }));
    expect(d.findings.map((f) => (f.source === 'ai' ? f.job : f.id))).toEqual(['review', 'review-security']);
  });

  it('the checks: verify, red with its cause, the factory checks that failed by name, an errored check, and the CI', () => {
    const d = runDetail(run({}), facts({
      events: [
        ev('red', 'verify.failed', 1, { runId: 'r0', job: 'tests', failures: [{ command: 'npm test', exitCode: 0, output: '' }], red: 'passing' }),
        ev('vf', 'verify.failed', 2, { runId: 'r1', job: 'dev', failures: [
          { command: 'factory/anti-triche', exitCode: 1, output: '' }, { command: 'factory/taille-du-diff', exitCode: 1, output: '' }, { command: 'factory/anti-triche', exitCode: 1, output: '' },
        ] }),
        ev('ve', 'verify.errored', 3, { runId: 'r2', job: 'dev', error: 'engine down' }),
        ev('vp', 'verify.passed', 4, { runId: 'r3', job: 'dev', commands: ['npm test', 'npm run lint'], sha: 'abc' }),
        ev('cf', 'pr.checks_failed', 5, { ...pr, failures: ['build'] }),
        ev('cp', 'pr.checks_passed', 6, pr),
      ],
    }));
    expect(d.checks).toEqual([
      { id: 'red', at: 1, check: 'red', result: 'failed', runId: 'r0', job: 'tests', names: ['npm test'], red: 'passing' },
      { id: 'vf', at: 2, check: 'verify', result: 'failed', runId: 'r1', job: 'dev', names: ['factory/anti-triche', 'factory/taille-du-diff'], red: null },
      { id: 've', at: 3, check: 'verify', result: 'errored', runId: 'r2', job: 'dev', names: [], red: null },
      { id: 'vp', at: 4, check: 'verify', result: 'passed', runId: 'r3', job: 'dev', names: ['npm test', 'npm run lint'], red: null },
      { id: 'cf', at: 5, check: 'ci', result: 'failed', runId: null, job: null, names: ['build'], red: null },
      { id: 'cp', at: 6, check: 'ci', result: 'passed', runId: null, job: null, names: [], red: null },
    ]);
  });

  it('the cost per step: each job of the ticket in the order it first ran, its attempts, tokens, turns and time', () => {
    const d = runDetail(run({ id: 'a' }), facts({
      runs: [
        run({ id: 'a', job: 'dev', tokens: tokens(10), turns: 4, startedAt: 0, endedAt: 100 }),
        run({ id: 'b', job: 'review', tokens: tokens(1), turns: 2, startedAt: 100, endedAt: 130, sessionRole: 'reviewer' }),
        run({ id: 'c', job: 'dev', turns: 3, startedAt: 200, endedAt: 260, status: 'failure', infra: true }),
        run({ id: 'd', job: 'dev', tokens: tokens(5), turns: 1, startedAt: 300, endedAt: undefined, status: 'running' }),
      ],
    }));
    expect(d.steps).toEqual([
      { job: 'dev', attempts: 3, tokens: tokens(15), attemptsWithoutTokens: 1, turns: 8, workMs: 160, costUsd: 0 },
      { job: 'review', attempts: 1, tokens: tokens(1), attemptsWithoutTokens: 0, turns: 2, workMs: 30, costUsd: 0 },
    ]);
    expect(d.attempts.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('the run itself: its measure, closed outcome, labels with those still pending, and its structured output when it has one', () => {
    const r = run({ id: 'r1', labels: LABELS, turns: 4, tokens: tokens(2) });
    const d = runDetail(r, facts({
      events: [ev('f', 'run.finished', 10, { runId: 'r1', job: 'dev', outcome: 'success', costUsd: 0, turns: 4, lastText: '', attempt: 'succeeded', output })],
      runs: [r],
    }));
    expect(d.run).toMatchObject({ id: 'r1', projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', status: 'success', durationMs: 10, turns: 4, tokens: tokens(2), outcome: 'succeeded', infra: false });
    expect(d.run.labels).toEqual({ ...LABELS, pending: pendingLabels(LABELS) });
    expect(d.output).toEqual(output);

    const bare = runDetail(run({}), facts({ events: [ev('f', 'run.finished', 10, { runId: 'r1', job: 'dev', outcome: 'failure', costUsd: 0, turns: 1, lastText: '' })] }));
    expect(bare.run).toMatchObject({ outcome: null, labels: null });
    expect(bare.output).toBeNull();
  });
});
