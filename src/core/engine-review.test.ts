import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { AgentOutput, Finding } from './agent-output.js';
import { decide } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, type EventPayloads, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

const blocking: Finding = { file: 'src/auth.ts', line: 12, severity: 'blocking', explanation: 'The token is compared with ==.', suggestion: 'Use timingSafeEqual.' };
const output = (findings: Finding[] | undefined): AgentOutput => ({ status: 'done', summary: 'Security lens, standard.', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], ...(findings ? { findings } : {}) });

function finished(job: string, out: AgentOutput | undefined, runId = 'r1'): FactoryEvent {
  const payload: EventPayloads['run.finished'] = { runId, job, outcome: 'success', costUsd: 0.4, turns: 9, lastText: '', attempt: out ? 'succeeded' : 'failed', ...(out ? { output: out } : {}) };
  return { id: `e-${runId}`, type: 'run.finished', at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload } as FactoryEvent;
}
function inReview(job: string, patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Export CSV', 'ai_review', 0), delegated: true, activeRunId: 'r1', activeJob: job, linearSessionId: 's1', prNumber: 3, verifiedSha: 'abc123', ...patch };
}

describe('the AI review (ORC-183)', () => {
  it("starts once dev's commit is published: AI Review, the build's summary, then the first lens", () => {
    const t = { ...inReview('dev', { logical: 'dev' }), verifyingRunId: 'r0', activeRunId: 'r0' };
    const out = decide(t, { id: 'e-pub', type: 'publish.done', at: 1, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { runId: 'r0', job: 'dev', sha: 'abc123', output: output(undefined) } } as FactoryEvent, workflow);
    expect(out.effects).toEqual([
      { kind: 'move', to: 'ai_review' },
      expect.objectContaining({ kind: 'post_output', style: 'summary' }),
      expect.objectContaining({ kind: 'start_run', job: 'review' }),
    ]);
  });

  it('keeps the first lens\'s findings on the published commit, then starts the second lens, in a session of its own', () => {
    const out = decide(inReview('review'), finished('review', output([blocking])), workflow);
    expect(out.effects).toEqual([
      { kind: 'review', runId: 'r1', lens: 'correctness', sha: 'abc123', findings: [blocking] },
      expect.objectContaining({ kind: 'start_run', job: 'review-security' }),
    ]);
    const start = out.effects[1] as Extract<(typeof out.effects)[number], { kind: 'start_run' }>;
    expect(start.resume).toBeFalsy();
  });

  it('the second lens publishes both, then shows the PR in Human Review: no summary posted in Linear, nothing fixed', () => {
    const out = decide(inReview('review-security', { activeRunId: 'r2' }), finished('review-security', output([]), 'r2'), workflow);
    expect(out.effects).toEqual([
      { kind: 'review', runId: 'r2', lens: 'security', sha: 'abc123', findings: [], publish: true },
      { kind: 'move', to: 'human_review' },
    ]);
    expect(out.effects.some((e) => e.kind === 'start_run' || e.kind === 'post_output')).toBe(false);
  });

  it('blocks a lens that handed back no findings list: a review that says nothing is no review', () => {
    const t = inReview('review');
    const out = decide(t, finished('review', output(undefined)), workflow);
    expect(out.effects.some((e) => e.kind === 'review' || e.kind === 'start_run')).toBe(false);
    const after = out.events.reduce<TicketState | undefined>((s, x) => reduce(s, x), t)!;
    expect(after).toMatchObject({ blocked: true, blockedJob: 'review' });
    expect(after.blockReason).toMatch(/no findings/);
  });

  it('blocks a lens on a ticket with no published commit, never reviewing another one', () => {
    const out = decide(inReview('review', { verifiedSha: undefined }), finished('review', output([blocking])), workflow);
    expect(out.effects.some((e) => e.kind === 'review' || e.kind === 'start_run')).toBe(false);
    expect(out.events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked' }));
  });

  it('a lens whose run failed is blocked as any failed run, and nothing is published', () => {
    const e = finished('review-security', output([blocking]), 'r2');
    (e.payload as EventPayloads['run.finished']).outcome = 'failure';
    (e.payload as EventPayloads['run.finished']).attempt = 'failed';
    const out = decide(inReview('review-security', { activeRunId: 'r2' }), e, workflow);
    expect(out.effects.some((x) => x.kind === 'review' || x.kind === 'move')).toBe(false);
  });
});

describe('the review → fix loop, on the counter of the review and CI loop (ORC-184)', () => {
  const fold = (t: TicketState, events: Parameters<typeof reduce>[1][]) => events.reduce<TicketState | undefined>((s, x) => reduce(s, x), t)!;
  const red = (n = 1): FactoryEvent => ({ id: `e-red-${n}`, type: 'pr.checks_failed', at: 2000 + n, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { number: 3, url: 'u', branch: 'b', failures: ['test'] } }) as FactoryEvent;
  const pr = (type: 'pr.checks_passed' | 'pr.opened', number = 3): FactoryEvent => ({ id: `e-${type}-${number}`, type, at: 3000, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { number, url: 'u', branch: 'b' } }) as FactoryEvent;
  const secondLens = (patch: Partial<TicketState> = {}) => inReview('review-security', { activeRunId: 'r2', prState: 'OPEN', ...patch });
  const idle = (patch: Partial<TicketState> = {}) => secondLens({ activeRunId: undefined, activeJob: undefined, ...patch });

  it("counts the first lens's blocking findings on the commit, for the lens that publishes", () => {
    const out = decide(inReview('review'), finished('review', output([blocking, { ...blocking, severity: 'minor' }])), workflow);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { reviewBlocking: { sha: 'abc123', lens: 'correctness', count: 1 } } });
  });

  it("a blocking finding of the first lens starts fix-review at the second lens's end, one round counted, the review published, no move", () => {
    const out = decide(secondLens({ reviewBlocking: { sha: 'abc123', lens: 'correctness', count: 1 } }), finished('review-security', output([]), 'r2'), workflow);
    expect(out.effects).toEqual([
      { kind: 'review', runId: 'r2', lens: 'security', sha: 'abc123', findings: [], publish: true },
      { kind: 'start_run', job: 'fix-review', input: 'findings' },
    ]);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { ciFixAttempts: 1 } });
  });

  it("the second lens's own blocking finding starts it too; a count kept on another commit is not this review's", () => {
    const own = decide(secondLens(), finished('review-security', output([blocking]), 'r2'), workflow);
    expect(own.effects).toContainEqual({ kind: 'start_run', job: 'fix-review', input: 'findings' });
    const stale = decide(secondLens({ reviewBlocking: { sha: 'old', lens: 'correctness', count: 2 } }), finished('review-security', output([]), 'r2'), workflow);
    expect(stale.effects.at(-1)).toEqual({ kind: 'move', to: 'human_review' });
    expect(stale.events).toContainEqual({ type: 'ticket.patched', patch: { reviewBlocking: { sha: 'abc123', lens: 'security', count: 0 } } });
    // The same commit reviewed again: the total the lens that publishes wrote last time is not this round's.
    const again = decide(secondLens({ reviewBlocking: { sha: 'abc123', lens: 'security', count: 1 } }), finished('review-security', output([]), 'r2'), workflow);
    expect(again.effects.at(-1)).toEqual({ kind: 'move', to: 'human_review' });
  });

  it('criterion 3: two rounds already used, a review with a blocking finding starts no fix and blocks the run', () => {
    const t = secondLens({ ciFixAttempts: workflow.limits.ciFixAttempts });
    const out = decide(t, finished('review-security', output([blocking]), 'r2'), workflow);
    expect(out.effects.some((e) => e.kind === 'start_run' || e.kind === 'move')).toBe(false);
    // Published all the same: the findings are on the PR for the human.
    expect(out.effects[0]).toMatchObject({ kind: 'review', publish: true });
    expect(fold(t, out.events)).toMatchObject({ blocked: true, blockKind: 'limit', blockedJob: 'fix-review', ciFixAttempts: 2 });
  });

  it('criterion 3: two rounds used by the review, a red CI starts no fix-ci and blocks the run', () => {
    let t = secondLens();
    for (const run of ['r2', 'r3']) t = { ...fold({ ...t, activeRunId: run }, decide({ ...t, activeRunId: run }, finished('review-security', output([blocking]), run), workflow).events) };
    expect(t).toMatchObject({ ciFixAttempts: 2, blocked: false });
    const out = decide({ ...t, activeRunId: undefined, activeJob: undefined, logical: 'human_review' }, red(), workflow);
    expect(out.effects.some((e) => e.kind === 'start_run')).toBe(false);
    expect(out.events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked', kind: 'ci_bound' }));
  });

  it('criterion 4: a red CI at the merge gate uses a round of the same counter, which the review then lacks', () => {
    const ci = decide(idle({ logical: 'human_review' }), red(), workflow);
    expect(ci.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'fix-ci' }));
    expect(ci.events).toContainEqual({ type: 'ticket.patched', patch: { ciFixAttempts: 1 } });
    const review = decide(secondLens({ ciFixAttempts: 1 }), finished('review-security', output([blocking]), 'r2'), workflow);
    expect(review.events).toContainEqual({ type: 'ticket.patched', patch: { ciFixAttempts: 2 } });
    expect(decide(secondLens({ ciFixAttempts: 2 }), finished('review-security', output([blocking]), 'r2'), workflow).events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked' }));
  });

  it('a green CI keeps the count, one per run, and still lifts the red-CI block; another PR starts it over', () => {
    expect(decide(idle({ ciFixAttempts: 2 }), pr('pr.checks_passed'), workflow).events).toEqual([]);
    const ciBlocked = idle({ ciFixAttempts: 2, blocked: true, blockKind: 'ci_bound', blockReason: 'CI still failing after 2 attempts of fix-ci.' });
    expect(decide(ciBlocked, pr('pr.checks_passed'), workflow).events).toEqual([{ type: 'ticket.unblocked' }]);
    expect(decide(idle({ ciFixAttempts: 2 }), pr('pr.opened', 4), workflow).events[0]).toEqual({ type: 'ticket.patched', patch: { ciFixAttempts: 0 } });
  });

  it('the findings fix-review contests stay open on the reviewed commit, until the next review has published', () => {
    const contested = [{ finding: 'security-1', justification: 'The token is hashed first: == compares two digests.' }];
    const fixOut: AgentOutput = { ...output(undefined), summary: 'Fixed one, contested one.', fixed: [{ finding: 'correctness-1', commit: 'aaaaaaa' }], contested };
    const out = decide(inReview('fix-review', { reviewBlocking: { sha: 'abc123', lens: 'security', count: 2 } }), finished('fix-review', fixOut), workflow);
    expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { contested: { sha: 'abc123', items: contested } } });
    // Its commits go through verify first, as any fix.
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'run_verify', job: 'fix-review' }));
    const first = decide(inReview('review', { contested: { sha: 'abc123', items: contested } }), finished('review', output([])), workflow);
    expect(first.events).toEqual([{ type: 'ticket.patched', patch: { reviewBlocking: { sha: 'abc123', lens: 'correctness', count: 0 } } }]);
    const published = decide(secondLens({ contested: { sha: 'abc123', items: contested } }), finished('review-security', output([]), 'r2'), workflow);
    expect(published.events).toContainEqual({ type: 'ticket.patched', patch: { reviewBlocking: { sha: 'abc123', lens: 'security', count: 0 }, contested: null } });
  });

  it('once a fix is published: its reply, then the review again, from AI Review where fix-review leaves it or Human Review for fix-ci', () => {
    const published = (job: string): FactoryEvent => ({ id: 'e-pub', type: 'publish.done', at: 1, projectId: 'p', ticketId: 'REL-1', schemaVersion: 3, taint: 'trusted', payload: { runId: 'r1', job, sha: 'def456', output: output(undefined) } }) as FactoryEvent;
    const review = decide({ ...inReview('fix-review'), verifyingRunId: 'r1' }, published('fix-review'), workflow);
    expect(review.effects).toEqual([expect.objectContaining({ kind: 'post_output', style: 'reply' }), expect.objectContaining({ kind: 'start_run', job: 'review' })]);
    const ci = decide({ ...inReview('fix-ci', { logical: 'human_review' }), verifyingRunId: 'r1', owedMove: 'ai_review' }, published('fix-ci'), workflow);
    expect(ci.effects).toEqual([{ kind: 'move', to: 'ai_review' }, expect.objectContaining({ kind: 'post_output', style: 'reply' }), expect.objectContaining({ kind: 'start_run', job: 'review' })]);
  });

  it('a version frozen before ORC-184, with no on_blocking, goes to Human Review on a blocking finding, as it did', () => {
    const frozen = { ...workflow, jobs: Object.fromEntries(Object.entries(workflow.jobs).map(([k, { onBlocking: _, ...j }]) => [k, j])) };
    const out = decide(secondLens(), finished('review-security', output([blocking]), 'r2'), frozen);
    expect(out.effects.at(-1)).toEqual({ kind: 'move', to: 'human_review' });
    expect(out.events).toEqual([]);
  });
});
