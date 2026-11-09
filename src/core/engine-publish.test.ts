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

/** A delegated ticket whose verification of `r1` is under way. */
function verifying(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, branch: 'factory/rel-1-titre', worktreePath: '/w', verifyingRunId: 'r1', ...patch };
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

  it('a move the refused publication owed comes with the next one: a relaunch by dev-feedback, which has no move of its own, still shows the work, and starts the AI review it came with (ORC-183)', () => {
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

  it('a feedback published in its own course owes nothing, and moves nothing', () => {
    const event = ev('verify.passed', { runId: 'r1', job: 'dev-feedback', sha: 'abc' });
    const t = after(verifying(), event, decide(verifying(), event, workflow));
    expect(t.owedMove).toBeUndefined();
    const done = ev('publish.done', { runId: 'r1', job: 'dev-feedback', sha: 'abc' });
    expect(decide(t, done, workflow).effects).toEqual([{ kind: 'post_output', style: 'reply', runId: 'r1' }]);
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
