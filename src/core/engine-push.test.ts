import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FREEZE_CHECK } from '../checks/freeze.js';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Workflow } from '../config/workflow-schema.js';
import type { Role } from './authz.js';
import type { Decision } from './decision.js';
import { decide, isFenced, pushCheckId } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

/**
 * ORC-159: a human's push on the agent's branch pauses the agent, and `verify` starts again from the pushed head in a
 * fresh clone; an approval from before the push passes no gate.
 */
const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const MERGER: Role[] = ['team_member', 'repo_writer', 'repo_merger'];
const AGENT = 'a9e47aaa';
const HUMAN = 'cafe1234';
const CHECK = pushCheckId(HUMAN, 1000);

function ev<T extends EventType>(type: T, payload: EventPayloads[T], over: Partial<FactoryEvent> = {}): FactoryEvent {
  return { id: `e-${type}`, type, at: 1000, projectId: 'p', ticketId: 'REL-1', schemaVersion: SCHEMA_VERSION, taint: 'trusted', payload, ...over } as FactoryEvent;
}
const push = (sha = HUMAN, at = 1000) => ev('push.human', { branch: 'factory/rel-1', sha, author: 'lilian', before: AGENT }, { id: `push:REL-1:${sha}`, taint: 'untrusted', at });
function ticket(patch: Partial<TicketState> = {}): TicketState {
  return { ...newTicketState('p', 'REL-1', 'Titre', 'dev', 0), delegated: true, branch: 'factory/rel-1', worktreePath: '/w', verifiedSha: AGENT, ...patch };
}
/** The ticket once the decision is applied, as the worker records it. */
const after = (state: TicketState, event: FactoryEvent, d: Decision): TicketState => d.events.reduce<TicketState>((t, e) => reduce(t, e)!, reduce(state, event)!);
const kinds = (d: Decision) => ({ events: d.events.map((e) => e.type), effects: d.effects.map((e) => e.kind) });
const verdict = <T extends 'verify.passed' | 'verify.failed' | 'verify.errored'>(type: T, payload: Omit<EventPayloads[T], 'runId' | 'job'>, runId = CHECK) =>
  ev(type, { runId, job: 'dev', ...payload } as EventPayloads[T], { id: `check:${runId}` });

describe('a human push on the agent branch (ORC-159)', () => {
  describe('criterion 1: the agent is paused and verify starts again from the new HEAD, in a fresh clone', () => {
    it('stops the run in flight, blocks the ticket on its job, and checks the pushed commit, not the worktree', () => {
      const t = ticket({ activeRunId: 'r1', activeJob: 'dev' });
      const out = decide(t, push(), workflow);
      expect(kinds(out)).toEqual({ events: ['work.cancelled', 'ticket.blocked', 'verify.started'], effects: ['stop_run', 'run_verify', 'labels'] });
      expect(out.events[1]).toMatchObject({ type: 'ticket.blocked', kind: 'human_push', job: 'dev' });
      expect(out.events[2]).toEqual({ type: 'verify.started', runId: CHECK });
      expect(out.effects[1]).toEqual({ kind: 'run_verify', runId: CHECK, job: 'dev', head: HUMAN });
      expect(after(t, push(), out)).toMatchObject({ blocked: true, blockKind: 'human_push', blockedJob: 'dev', verifyingRunId: CHECK, humanPushes: [{ before: AGENT, after: HUMAN }] });
    });

    it('drops the check or the publication awaited and the waiting job: their late results are fenced', () => {
      const t = ticket({ verifyingRunId: 'r1', pendingJob: { job: 'dev-feedback', input: 'feedback' } });
      const out = decide(t, push(), workflow);
      const paused = after(t, push(), out);
      expect(paused).toMatchObject({ verifyingRunId: CHECK, pendingJob: undefined });
      expect(isFenced(decide(paused, ev('verify.passed', { runId: 'r1', job: 'dev', sha: AGENT }), workflow))).toBe(true);
      expect(isFenced(decide(paused, ev('publish.done', { runId: 'r1', job: 'dev', sha: AGENT }), workflow))).toBe(true);
    });

    it('a ticket at rest in Human Review is paused all the same, with no job to resume', () => {
      const t = ticket({ logical: 'human_review', prNumber: 3, prState: 'OPEN', reviewSha: AGENT });
      const out = decide(t, push(), workflow);
      expect(out.events[1]).toEqual({ type: 'ticket.blocked', reason: expect.stringContaining(HUMAN), kind: 'human_push' });
      expect(out.effects).toContainEqual({ kind: 'run_verify', runId: CHECK, job: 'dev', head: HUMAN });
    });

    it("a second push replaces the first one's check: its verdict is fenced, the job to resume stays", () => {
      const t = ticket({ activeRunId: 'r1', activeJob: 'dev' });
      const once = after(t, push(), decide(t, push(), workflow));
      const NEWER = 'beef5678';
      const out = decide(once, push(NEWER, 2000), workflow);
      const twice = after(once, push(NEWER, 2000), out);
      expect(twice).toMatchObject({ blockKind: 'human_push', blockedJob: 'dev', verifyingRunId: pushCheckId(NEWER, 2000) });
      expect(twice.blockReason).toContain(NEWER);
      expect(isFenced(decide(twice, verdict('verify.passed', { sha: HUMAN }), workflow))).toBe(true);
    });

    it('a cut check runs again on the same pushed commit', () => {
      const t = after(ticket(), push(), decide(ticket(), push(), workflow));
      const out = decide(t, ev('verify.lost', { runId: CHECK, job: 'dev' }, { at: 5000 }), workflow);
      expect(out.effects).toContainEqual({ kind: 'run_verify', runId: CHECK, job: 'dev', head: HUMAN });
    });

    it('green: the pushed commit is the one verified, the ticket stays paused and the human is told, nothing is published or moved', () => {
      const t = after(ticket({ activeRunId: 'r1', activeJob: 'dev' }), push(), decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), push(), workflow));
      const green = verdict('verify.passed', { sha: HUMAN });
      const out = decide(t, green, workflow);
      expect(out.events).toContainEqual({ type: 'ticket.patched', patch: { verifiedSha: HUMAN } });
      expect(out.effects.map((e) => e.kind)).toEqual(['block_comment']);
      expect(out.effects[0]).toMatchObject({ block: { step: 'verify', reason: expect.stringContaining('verify passed') } });
      const paused = after(t, green, out);
      expect(paused).toMatchObject({ blocked: true, blockKind: 'human_push', blockedJob: 'dev', verifiedSha: HUMAN, verifyingRunId: undefined });
      // A reply resumes the job the push paused, on top of the push.
      const reply = decide(paused, ev('ticket.commented', { body: 'vas-y', author: 'L', kind: 'instruction' }), workflow);
      expect(reply.events).toContainEqual({ type: 'ticket.unblocked' });
      expect(reply.effects).toContainEqual(expect.objectContaining({ kind: 'start_run', job: 'dev' }));
    });

    it('red: the ticket stays paused with what failed, nothing verified, nothing started', () => {
      const t = after(ticket(), push(), decide(ticket(), push(), workflow));
      const red = verdict('verify.failed', { failures: [{ command: 'npm test', exitCode: 1, output: 'boom' }] });
      const out = decide(t, red, workflow);
      expect(out.events.some((e) => e.type === 'ticket.patched')).toBe(false);
      expect(out.effects.map((e) => e.kind)).toEqual(['block_comment']);
      expect(out.effects[0]).toMatchObject({ block: { tried: ['`npm test` (code 1)'] } });
      expect(after(t, red, out)).toMatchObject({ blocked: true, blockKind: 'human_push', verifiedSha: AGENT, verifyAttempts: 0 });
    });

    it('a check that could not run blocks as an infrastructure failure', () => {
      const t = after(ticket(), push(), decide(ticket(), push(), workflow));
      const out = decide(t, verdict('verify.errored', { error: 'engine down' }), workflow);
      expect(out.events).toContainEqual(expect.objectContaining({ type: 'ticket.blocked', kind: 'infra' }));
    });

    it('a verdict that comes once a human relaunched the ticket records the green commit and lets the work go on', () => {
      const t = after(ticket(), push(), decide(ticket(), push(), workflow));
      const relaunched = { ...t, blocked: false, blockKind: undefined, blockReason: undefined };
      const out = decide(relaunched, verdict('verify.passed', { sha: HUMAN }), workflow);
      expect(out.events).toEqual([{ type: 'ticket.patched', patch: { verifiedSha: HUMAN } }]);
      expect(out.effects).toEqual([]);
    });
  });

  describe("the factory's own pushes are never taken for a human's", () => {
    it('a push of the commit verify last found green is the factory publishing: nothing pauses, nothing is recorded as human', () => {
      const t = ticket({ activeRunId: 'r1', activeJob: 'dev', verifiedSha: HUMAN });
      const out = decide(t, push(), workflow);
      expect(kinds(out)).toEqual({ events: [], effects: [] });
      expect(reduce(t, push())!.humanPushes).toBeUndefined();
    });

    it('a version whose agents push themselves (no job the factory publishes) does not react', () => {
      const legacy: Workflow = { ...workflow, jobs: Object.fromEntries(Object.entries(workflow.jobs).map(([k, j]) => [k, { ...j, repoChecks: false }])) };
      expect(kinds(decide(ticket({ activeRunId: 'r1', activeJob: 'dev' }), push(), legacy))).toEqual({ events: [], effects: [] });
    });
  });

  it('pauses nothing on a ticket the factory does not work on: not delegated, delivered, stopped, or its PR closed', () => {
    for (const t of [
      ticket({ delegated: false }),
      ticket({ logical: 'done' }),
      ticket({ prState: 'MERGED' }),
      ticket({ prState: 'CLOSED', blocked: true, blockKind: 'pr_closed' }),
      ticket({ blocked: true, blockKind: 'stopped' }),
    ]) {
      expect(kinds(decide(t, push(), workflow))).toEqual({ events: [], effects: [] });
    }
  });

  it('a ticket blocked for another reason keeps it, its push still checked', () => {
    const t = ticket({ blocked: true, blockKind: 'asked', blockReason: 'Question asked by the agent', blockedJob: 'dev' });
    const out = decide(t, push(), workflow);
    expect(out.events.some((e) => e.type === 'ticket.blocked')).toBe(false);
    expect(out.effects).toContainEqual({ kind: 'run_verify', runId: CHECK, job: 'dev', head: HUMAN });
  });

  describe('criterion 3: a human commit that changes a frozen test fails verify', () => {
    it('the check of the push goes through the freeze, and its failure keeps the ticket paused until a /refreeze', () => {
      const frozenTests = { sha: AGENT, files: { 'src/a.test.ts': 'f'.repeat(64) } };
      const t = after(ticket({ frozenTests }), push(), decide(ticket({ frozenTests }), push(), workflow));
      const red = verdict('verify.failed', { failures: [{ command: FREEZE_CHECK, exitCode: 1, output: 'src/a.test.ts changed' }] });
      const out = decide(t, red, workflow);
      expect(out.effects[0]).toMatchObject({ kind: 'block_comment', block: { question: expect.stringContaining('/refreeze') } });
      expect(after(t, red, out)).toMatchObject({ blocked: true, blockKind: 'human_push', verifiedSha: AGENT });
    });
  });

  describe('criterion 4: an approval from before a human push passes no gate', () => {
    const done = ev('status.changed', { from: 'human_review', to: 'done' }, { actor: 'u-lead', roles: MERGER });
    const inReview = ticket({ logical: 'human_review', prNumber: 7, prState: 'OPEN', reviewSha: AGENT });

    it('the commit under review is no longer reviewed once a human pushed', () => {
      expect(reduce(inReview, push())!.reviewSha).toBeUndefined();
      // Merged as before without the push.
      expect(decide(inReview, done, workflow).effects).toContainEqual({ kind: 'merge', sha: AGENT });
    });

    it('a Done after the push merges nothing, before or after the green check of the push', () => {
      const paused = after(inReview, push(), decide(inReview, push(), workflow));
      const green = verdict('verify.passed', { sha: HUMAN });
      const checked = after(paused, green, decide(paused, green, workflow));
      for (const t of [paused, checked]) {
        const out = decide(t, done, workflow);
        expect(out.effects.some((e) => e.kind === 'merge')).toBe(false);
        expect(out.effects).toContainEqual({ kind: 'move', to: 'human_review', keepReviewSha: true });
      }
    });
  });
});
