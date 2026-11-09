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
