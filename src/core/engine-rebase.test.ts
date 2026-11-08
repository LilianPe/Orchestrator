import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput } from './agent-output.js';
import { causeOf } from './block-cause.js';
import type { Decision } from './decision.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload } as FactoryEvent;
}

/** A delegated ticket in Human Review, its PR #3 open: what a conflict reaches. */
const reviewed = (patch: Partial<TicketState> = {}): TicketState => ({
  ...newTicketState('p', 'REL-1', 'Titre', 'human_review', 0),
  delegated: true,
  linearSessionId: 's-dev',
  branch: 'factory/rel-1-titre',
  worktreePath: '/w',
  prNumber: 3,
  prUrl: 'u',
  prState: 'OPEN',
  ...patch,
});
const conflicted = (number = 3) => ev('pr.conflicted', { number, url: 'u', branch: 'factory/rel-1-titre', headSha: 'head1', baseRef: 'main' });
const starts = (d: Decision) => d.effects.filter((e) => e.kind === 'start_run');
const notice = (d: Decision) => d.effects.find((e) => e.kind === 'block_comment') as Extract<Decision['effects'][number], { kind: 'block_comment' }> | undefined;
const blocked = (d: Decision) => d.events.find((e) => e.type === 'ticket.blocked');

const OUTPUT: AgentOutput = { status: 'done', summary: 'Rebased on main.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] };
const rebasing = (patch: Partial<TicketState> = {}) => reviewed({ activeRunId: 'r1', activeJob: 'rebase', ...patch });
const finished = (patch: Partial<EventPayloads['run.finished']>) => ev('run.finished', { runId: 'r1', job: 'rebase', outcome: 'success', costUsd: 0, turns: 1, lastText: '', ...patch });
const stopsOn = (conflict: 'logic' | 'migrations' | 'scope', question = 'Which side wins?') =>
  finished({ attempt: 'needs_input', output: { ...OUTPUT, status: 'blocked', reason: 'conflict', conflict, question } });

describe('a conflict with the default branch is handled by a rebase step the engine starts (ORC-146)', () => {
  it('criterion 1: a conflict of the open PR starts the rebase step, counted on the review and CI loop (I5)', () => {
    const out = decide(reviewed(), conflicted(), workflow);
    expect(starts(out)).toEqual([expect.objectContaining({ kind: 'start_run', job: 'rebase' })]);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { ciFixAttempts: 1 } });
    expect(workflow.jobs['rebase']).toMatchObject({ step: 'rebase', queue: 'dev', workspace: 'worktree', skill: 'factory:rebase', repoChecks: true, structuredOutput: true });
  });

  it('criterion 1: the rebase step runs in the sandbox of the ticket, the step of the preset that writes its code, and moves nothing', () => {
    const job = workflow.jobs['rebase']!;
    expect(job.onStart).toEqual({});
    expect(job.onSuccess).toEqual({});
    expect(job.input).toBeUndefined();
  });

  it('shares its bound with red CI: once the loop has used its runs, a conflict starts nothing and blocks with its own kind', () => {
    const bound = workflow.limits.ciFixAttempts;
    const out = decide(reviewed({ ciFixAttempts: bound }), conflicted(), workflow);
    expect(starts(out)).toEqual([]);
    expect(blocked(out)).toMatchObject({ type: 'ticket.blocked', kind: 'conflict', job: 'rebase' });
    expect(notice(out)?.block).toMatchObject({ step: 'rebase', max: bound });
    // A green CI does not lift it: it says nothing of the conflict.
    const t = out.events.reduce<TicketState | undefined>((s, e) => reduce(s, e), reviewed({ ciFixAttempts: bound }))!;
    const green = decide(t, ev('pr.checks_passed', { number: 3, url: 'u', branch: 'b' }), workflow);
    expect(green.events).not.toContainEqual({ type: 'ticket.unblocked' });
  });

  it('a red CI after rebases counts on the same counter', () => {
    const out = decide(reviewed({ ciFixAttempts: workflow.limits.ciFixAttempts }), ev('pr.checks_failed', { number: 3, url: 'u', branch: 'b', failures: ['test'] }), workflow);
    expect(starts(out)).toEqual([]);
    expect(blocked(out)).toMatchObject({ kind: 'ci_bound' });
  });

  it('starts nothing for a PR that is not the open PR of the ticket, a blocked ticket, or one that is not delegated', () => {
    expect(starts(decide(reviewed(), conflicted(4), workflow))).toEqual([]);
    expect(starts(decide(reviewed({ prState: 'MERGED' }), conflicted(), workflow))).toEqual([]);
    expect(starts(decide(reviewed({ prState: 'CLOSED' }), conflicted(), workflow))).toEqual([]);
    expect(starts(decide(reviewed({ blocked: true, blockReason: 'x', blockKind: 'question' }), conflicted(), workflow))).toEqual([]);
    expect(starts(decide(reviewed({ delegated: false }), conflicted(), workflow))).toEqual([]);
    expect(decide(reviewed(), conflicted(4), workflow).events).toEqual([]);
  });

  it('criterion 4: a conflict during another step leaves that run alone: no stop, nothing sent to it, the rebase starts behind it', () => {
    const busy = reviewed({ logical: 'dev', activeRunId: 'r0', activeJob: 'dev-feedback' });
    const out = decide(busy, conflicted(), workflow);
    expect(out.effects.filter((e) => e.kind === 'stop_run')).toEqual([]);
    // The orchestrator keeps a start that meets a busy ticket pending: the rebase follows the end of the work.
    expect(starts(out)).toEqual([expect.objectContaining({ job: 'rebase' })]);
    expect(out.events.map((e) => e.type)).not.toContain('work.cancelled');
  });

  it('criterion 2: a rebase that ends well goes through verify, and its green commit is published over the head the factory published', () => {
    const ran = decide(rebasing(), finished({ attempt: 'succeeded', output: OUTPUT }), workflow);
    expect(ran.effects).toEqual([expect.objectContaining({ kind: 'run_verify', runId: 'r1', job: 'rebase' })]);
    expect(ran.effects.some((e) => e.kind === 'publish')).toBe(false);
    const verifying = reviewed({ verifyingRunId: 'r1' });
    const green = decide(verifying, ev('verify.passed', { runId: 'r1', job: 'rebase', sha: 'rebased' }), workflow);
    expect(green.effects).toEqual([{ kind: 'publish', runId: 'r1', job: 'rebase', sha: 'rebased', rewrite: true }]);
  });

  it('criterion 2: only a rebase replaces what the factory published: another job publishes forward only', () => {
    const green = decide(reviewed({ verifyingRunId: 'r1' }), ev('verify.passed', { runId: 'r1', job: 'dev-feedback', sha: 'abc' }), workflow);
    expect(green.effects).toEqual([{ kind: 'publish', runId: 'r1', job: 'dev-feedback', sha: 'abc' }]);
  });

  it('criterion 2: failed checks send the rebase back, bounded by verify, and block at verify_rebase', () => {
    const failure = { command: 'npm test', exitCode: 1, output: 'red' };
    const back = decide(reviewed({ verifyingRunId: 'r1' }), ev('verify.failed', { runId: 'r1', job: 'rebase', failures: [failure] }), workflow);
    expect(starts(back)).toEqual([expect.objectContaining({ job: 'rebase', input: 'verify_failures', resume: true })]);
    const last = decide(reviewed({ verifyingRunId: 'r1', verifyAttempts: workflow.limits.verifyAttempts - 1 }), ev('verify.failed', { runId: 'r1', job: 'rebase', failures: [failure] }), workflow);
    expect(notice(last)?.block).toMatchObject({ step: 'verify_rebase' });
  });

  it.each([
    ['logic', 'the two sides contradict each other'],
    ['migrations', 'two migrations change the same schema'],
    ['scope', "the resolution goes beyond the ticket's scope"],
  ] as const)('criterion 3: a conflict the agent stops on (%s) blocks with the standard comment and its own kind', (conflict, says) => {
    const out = decide(rebasing(), stopsOn(conflict), workflow);
    expect(blocked(out)).toMatchObject({ type: 'ticket.blocked', kind: 'conflict', job: 'rebase', reason: expect.stringContaining(says) });
    expect(notice(out)?.block).toMatchObject({ step: 'rebase', question: 'Which side wins?' });
    expect(out.effects.filter((e) => e.kind === 'activity' || e.kind === 'run_verify' || e.kind === 'publish')).toEqual([]);
    expect(causeOf('conflict')).toBe('conflict');
  });

  it('a conflict seen again while a rebase runs or waits starts and counts nothing more: one conflict, one rebase', () => {
    const running = decide(reviewed({ activeRunId: 'r1', activeJob: 'rebase', ciFixAttempts: 1 }), conflicted(), workflow);
    expect(starts(running)).toEqual([]);
    expect(running.events).toEqual([]);
    const waiting = decide(reviewed({ logical: 'dev', activeRunId: 'r0', activeJob: 'dev-feedback', pendingJob: { job: 'rebase' }, ciFixAttempts: 1 }), conflicted(), workflow);
    expect(starts(waiting)).toEqual([]);
    expect(waiting.events).toEqual([]);
  });

  it('a conflict another step reports is no conflict block: only the rebase step stops on one', () => {
    const fixing = reviewed({ activeRunId: 'r1', activeJob: 'dev-feedback' });
    const out = decide(fixing, { ...stopsOn('logic'), payload: { ...(stopsOn('logic').payload as EventPayloads['run.finished']), job: 'dev-feedback' } } as FactoryEvent, workflow);
    expect(blocked(out)).toMatchObject({ kind: 'question', job: 'dev-feedback' });
  });

  it('a reply to a conflict block resumes the rebase step with the reply', () => {
    const t = decide(rebasing(), stopsOn('logic'), workflow).events.reduce<TicketState | undefined>((s, e) => reduce(s, e), reduce(rebasing(), stopsOn('logic')))!;
    const reply = ev('ticket.commented', { body: 'Keep the base side.', author: 'Lilian', kind: 'instruction' });
    const out = decide(t, reply, workflow);
    expect(starts(out)).toEqual([expect.objectContaining({ job: 'rebase', input: 'feedback' })]);
  });
});
