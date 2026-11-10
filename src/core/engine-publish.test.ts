import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import { planDecision } from './decision-plan.js';
import { decide, mayPublish } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload } as FactoryEvent;
}

/** A delegated ticket whose verification of `r1` is under way, its PR open (`pr.opened` comes before `publish.done`). */
function verifying(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, branch: 'factory/rel-1-titre', worktreePath: '/w', verifyingRunId: 'r1', prNumber: 7, ...patch };
}

const passed = (job = 'dev', sha: string | null = 'abc') => ev('verify.passed', { runId: 'r1', job, ...(sha ? { sha } : {}) });
const after = (t: TicketState, event: FactoryEvent, decision: ReturnType<typeof decide>) => decision.events.reduce<TicketState | undefined>((s, e) => reduce(s, e), reduce(t, event))!;

describe('the publish effect (ORC-125)', () => {
  it('a green verify of a job that writes code publishes that commit, and nothing of its on_success yet', () => {
    const out = decide(verifying(), passed(), workflow);
    expect(out.effects).toEqual([{ kind: 'publish', runId: 'r1', job: 'dev', sha: 'abc' }]);
    expect(after(verifying(), passed(), out).verifiedSha).toBe('abc');
  });

  it('carries the output to the on_success that follows it', () => {
    const output = { result: 'succeeded' as const, summary: 'fait' } as never;
    const out = decide(verifying(), ev('verify.passed', { runId: 'r1', job: 'dev', sha: 'abc', output }), workflow);
    expect(out.effects).toEqual([{ kind: 'publish', runId: 'r1', job: 'dev', sha: 'abc', output }]);
  });

  it('carries the visual proof verify journaled to the check it publishes (ORC-176)', () => {
    const visualProof = { decision: 'not_applicable' as const, triggers: [] };
    const out = decide(verifying(), ev('verify.passed', { runId: 'r1', job: 'dev', sha: 'abc', visualProof }), workflow);
    expect(out.effects).toEqual([{ kind: 'publish', runId: 'r1', job: 'dev', sha: 'abc', visualProof }]);
  });

  it('the ticket stays held while it publishes: no next run starts beside it, and a stop fences its result', () => {
    const event = passed();
    const t = after(verifying(), event, decide(verifying(), event, workflow));
    expect(t.verifyingRunId).toBe('r1');
    const stale = decide({ ...t, verifyingRunId: undefined }, ev('publish.done', { runId: 'r1', job: 'dev', sha: 'abc' }), workflow);
    expect(stale.effects).toEqual([]);
    expect(stale.trace[0]).toMatch(/^fenced: /);
  });

  it('a verify that failed, errored or found no commit publishes nothing', () => {
    const failed = decide(verifying(), ev('verify.failed', { runId: 'r1', job: 'dev', failures: [{ command: 'x', exitCode: 1, output: '' }] }), workflow);
    expect(failed.effects.some((e) => e.kind === 'publish')).toBe(false);
    const errored = decide(verifying(), ev('verify.errored', { runId: 'r1', job: 'dev', error: 'x' }), workflow);
    expect(errored.effects.some((e) => e.kind === 'publish')).toBe(false);
    expect(decide(verifying(), passed('dev', null), workflow).effects.some((e) => e.kind === 'publish')).toBe(false);
  });

  it('the tests step does not publish: it ends in dev, whose commit is the one to verify', () => {
    const out = decide(verifying(), ev('verify.passed', { runId: 'r1', job: 'tests' }), workflow);
    expect(out.effects.some((e) => e.kind === 'publish')).toBe(false);
    expect(out.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev' }));
  });

  it('a job without repo checks publishes nothing: nothing reaches the forge without a verify', () => {
    const jobs = Object.fromEntries(Object.entries(workflow.jobs).map(([k, j]) => { const { repoChecks: _, ...rest } = j; return [k, rest]; }));
    const out = decide(verifying(), passed(), { ...workflow, jobs } as typeof workflow);
    expect(out.effects.some((e) => e.kind === 'publish')).toBe(false);
  });

  it('published, the on_success of the job applies: the move, the summary, the AI review (ORC-183)', () => {
    const out = decide(verifying(), ev('publish.done', { runId: 'r1', job: 'dev', sha: 'abc' }), workflow);
    expect(out.effects).toEqual([{ kind: 'move', to: 'ai_review' }, { kind: 'post_output', style: 'summary', runId: 'r1' }, expect.objectContaining({ kind: 'start_run', job: 'review' })]);
    expect(after(verifying(), ev('publish.done', { runId: 'r1', job: 'dev', sha: 'abc' }), out).verifyingRunId).toBeUndefined();
  });

  it('refused, the ticket is blocked with the reason, nothing moves, and it is settled', () => {
    const event = ev('publish.refused', { runId: 'r1', job: 'dev', sha: 'abc', reason: 'la branche a bougé' });
    const out = decide(verifying(), event, workflow);
    const t = after(verifying(), event, out);
    expect(t).toMatchObject({ blocked: true, verifyingRunId: undefined });
    expect(t.blockReason).toContain('la branche a bougé');
    expect(out.effects.some((e) => e.kind === 'move' || e.kind === 'post_output')).toBe(false);
    expect(out.effects).toContainEqual({ kind: 'block_comment', block: expect.objectContaining({ step: 'publish', reason: expect.stringContaining('la branche a bougé') }) });
  });

  it('a move the refused publication owed comes with the next one: a relaunch by dev-feedback still shows the work, and starts the AI review it came with, once (ORC-183)', () => {
    const owed = after(verifying(), passed(), decide(verifying(), passed(), workflow));
    expect(owed.owedMove).toBe('ai_review');
    const refused = ev('publish.refused', { runId: 'r1', job: 'dev', sha: 'abc', reason: 'x' });
    const blocked = after(owed, refused, decide(owed, refused, workflow));
    expect(blocked.owedMove).toBe('ai_review');
    const relaunched = { ...blocked, blocked: false, blockReason: undefined, verifyingRunId: 'r2' };
    const done = ev('publish.done', { runId: 'r2', job: 'dev-feedback', sha: 'def' });
    const out = decide(relaunched, done, workflow);
    expect(out.effects).toEqual([{ kind: 'move', to: 'ai_review' }, { kind: 'post_output', style: 'reply', runId: 'r2' }, expect.objectContaining({ kind: 'start_run', job: 'review' })]);
    expect(after(relaunched, done, out).owedMove).toBeNull();
  });

  it('a feedback published goes to AI Review and is reviewed, as fix-human: no commit of the factory waits for a human move to be reviewed (ORC-170)', () => {
    const event = ev('verify.passed', { runId: 'r1', job: 'dev-feedback', sha: 'abc' });
    const t = after(verifying(), event, decide(verifying(), event, workflow));
    expect(t.owedMove).toBe('ai_review');
    const done = ev('publish.done', { runId: 'r1', job: 'dev-feedback', sha: 'abc' });
    const out = decide(t, done, workflow);
    expect(out.effects).toEqual([{ kind: 'move', to: 'ai_review' }, { kind: 'post_output', style: 'reply', runId: 'r1' }, expect.objectContaining({ kind: 'start_run', job: 'review' })]);
    expect(after(t, done, out).owedMove).toBeNull();
  });

  describe('nothing new for the AI review (ORC-170)', () => {
    const reviewing = (e: ReturnType<typeof decide>) => e.effects.filter((x) => x.kind === 'move' || x.kind === 'start_run');

    it('no PR: the end posts its reply, moves nothing and starts no review', () => {
      const done = ev('publish.done', { runId: 'r1', job: 'dev-feedback', sha: 'abc' });
      const out = decide(verifying({ prNumber: undefined }), done, workflow);
      expect(out.effects).toEqual([{ kind: 'post_output', style: 'reply', runId: 'r1' }]);
      expect(out.trace).toContainEqual(expect.stringContaining('nothing new at the end of dev-feedback (no PR)'));
      // `dev` too: its summary, and In Progress.
      expect(decide(verifying({ prNumber: undefined }), ev('publish.done', { runId: 'r1', job: 'dev', sha: 'abc' }), workflow).effects).toEqual([{ kind: 'post_output', style: 'summary', runId: 'r1' }]);
    });

    it('the commit shown in Human Review, already reviewed: the ticket stays there, for every fix', () => {
      const shown = verifying({ logical: 'human_review', reviewSha: 'abc' });
      for (const job of ['dev-feedback', 'fix-human', 'fix-ci']) {
        const out = decide(shown, ev('publish.done', { runId: 'r1', job, sha: 'abc' }), workflow);
        expect(reviewing(out), job).toEqual([]);
        expect(out.effects, job).toContainEqual({ kind: 'post_output', style: 'reply', runId: 'r1' });
      }
      // A new commit is reviewed.
      expect(reviewing(decide(shown, ev('publish.done', { runId: 'r1', job: 'dev-feedback', sha: 'def' }), workflow))).toEqual([{ kind: 'move', to: 'ai_review' }, expect.objectContaining({ job: 'review' })]);
    });

    it('in the review loop, a fix that contests without committing is judged again: AI Review has no reviewed commit', () => {
      const loop = verifying({ logical: 'ai_review', reviewSha: undefined, reviewBlocking: { sha: 'abc', counts: { correctness: 1 } } });
      expect(reviewing(decide(loop, ev('publish.done', { runId: 'r1', job: 'fix-review', sha: 'abc' }), workflow))).toEqual([expect.objectContaining({ job: 'review' })]);
    });

    it('the lenses chain as before, a PR or not', () => {
      const end = ev('run.finished', { runId: 'r1', job: 'review', outcome: 'success', costUsd: 0, turns: 1, lastText: '', output: { status: 'done', summary: '', tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [], findings: [] } });
      const lens = verifying({ logical: 'ai_review', prNumber: undefined, verifyingRunId: undefined, activeRunId: 'r1', activeJob: 'review', verifiedSha: 'abc' });
      expect(decide(lens, end, workflow).effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'review-security' }));
    });
  });

  it('a stop keeps its reason over a refusal that comes later', () => {
    const event = ev('publish.refused', { runId: 'r1', job: 'dev', sha: 'abc', reason: 'x' });
    expect(decide(verifying({ verifyingRunId: undefined, blocked: true, blockReason: 'Arrêté à la demande' }), event, workflow).events).toEqual([]);
  });

  it('a publish that died blocks the ticket and lets go of it', () => {
    const event = ev('effect.failed', { effectId: 'REL-1:2:0', kind: 'publish', eventId: 'check:r1', attempts: 8, error: 'forge unreachable' });
    const out = decide(verifying(), event, workflow);
    expect(after(verifying(), event, out)).toMatchObject({ blocked: true, verifyingRunId: undefined });
  });

  it('settles behind its result, as a verdict does', () => {
    const plan = (event: FactoryEvent) => planDecision({ event, known: verifying(), workflow, hash: 'h', now: 1 }).effects.map((e) => e.kind);
    expect(plan(ev('publish.done', { runId: 'r1', job: 'dev', sha: 'abc' }))).toContain('settle');
    expect(plan(ev('publish.refused', { runId: 'r1', job: 'dev', sha: 'abc', reason: 'x' }))).toContain('settle');
  });
});

describe('mayPublish, at the push too', () => {
  it('says no for a commit that is not the one last found green', () => {
    expect(mayPublish({ verifiedSha: 'abc' }, 'abc', workflow)).toBe(true);
    expect(mayPublish({ verifiedSha: 'abc' }, 'def', workflow)).toBe(false);
    expect(mayPublish({}, 'abc', workflow)).toBe(false);
  });
});
