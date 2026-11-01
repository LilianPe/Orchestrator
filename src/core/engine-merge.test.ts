import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../config/load-workflow.js';
import type { Role } from './authz.js';
import { AUTHZ_REFUSED, decide, mayCheck } from './engine.js';
import { reduce } from './reduce.js';
import { newTicketState, SCHEMA_VERSION, type EventPayloads, type EventType, type FactoryEvent, type TicketState } from './types.js';

const workflow = loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') });
const MERGER: Role[] = ['team_member', 'repo_writer', 'repo_merger'];

function ev<T extends EventType>(type: T, payload: EventPayloads[T], actor?: string, roles?: readonly Role[]): FactoryEvent {
  return {
    id: `e-${type}`,
    type,
    at: 1000,
    projectId: 'p',
    ticketId: 'REL-1',
    schemaVersion: SCHEMA_VERSION,
    taint: actor ? 'trusted' : 'untrusted',
    ...(actor ? { actor } : {}),
    ...(roles ? { roles } : {}),
    payload,
  } as FactoryEvent;
}
/** A delegated ticket in Human Review: its PR open, green, the commit shown to the reviewer recorded. */
function inReview(patch: Partial<TicketState> = {}): TicketState {
  return {
    ...newTicketState('p', 'REL-1', 'Titre', 'human_review', 0),
    delegated: true,
    prNumber: 7,
    prUrl: 'https://github.com/acme/app/pull/7',
    prState: 'OPEN',
    reviewSha: 'abc123',
    ...patch,
  };
}
const done = (actor = 'u-lead', roles: readonly Role[] | undefined = MERGER) => ev('status.changed', { from: 'human_review', to: 'done' }, actor, roles);
/** Back to Human Review, the reviewed commit kept: a move that concludes no work of the factory records none. */
const backToReview = (body: RegExp) => [{ kind: 'move', to: 'human_review', keepReviewSha: true }, { kind: 'comment', body: expect.stringMatching(body) }];

describe('decide — Done by a human merges the PR (ORC-148)', () => {
  it('merges, on the commit shown in Human Review, when a human with the merge right moves the ticket to Done', () => {
    const out = decide(inReview(), done(), workflow);
    expect(out.effects).toEqual([{ kind: 'merge', sha: 'abc123' }]);
  });

  it('a human without the merge right: nothing merged, the refusal answered, back to Human Review', () => {
    const out = decide(inReview(), done('u-dev', ['team_member', 'repo_writer']), workflow);
    expect(out.effects.some((e) => e.kind === 'merge')).toBe(false);
    expect(out.trace.some((t) => t.startsWith(AUTHZ_REFUSED))).toBe(true);
    expect(out.effects).toEqual([{ kind: 'comment', body: expect.stringContaining('passer le ticket en Done') }, { kind: 'move', to: 'human_review', keepReviewSha: true }]);
  });

  it('a move to Done with no signed actor or no resolved roles is no human decision: never merged, left as it is', () => {
    // Linear's GitHub integration after a merge on GitHub, the reconciliation: the ticket is not sent back.
    expect(decide(inReview(), ev('status.changed', { from: 'human_review', to: 'done' }, 'u-lead'), workflow).effects).toEqual([]);
    expect(decide(inReview(), ev('status.changed', { from: 'human_review', to: 'done' }), workflow).effects).toEqual([]);
  });

  it('a Done while the ticket is not in Human Review (dev, AI review) is no review decision: no merge, the rules as before', () => {
    for (const logical of ['dev', 'ai_review'] as const) {
      const out = decide(inReview({ logical, activeRunId: 'r1' }), ev('status.changed', { from: logical, to: 'done' }, 'u-lead', MERGER), workflow);
      expect(out.effects.some((e) => e.kind === 'merge' || e.kind === 'move'), logical).toBe(false);
    }
  });

  it('no commit recorded at the passage in Human Review: nothing merged, back to Human Review, the way to record one said', () => {
    // A reply in the thread runs dev-feedback, which moves nothing: only the AI review's move to Human Review records one.
    expect(decide(inReview({ reviewSha: undefined }), done(), workflow).effects).toEqual(backToReview(/aucun commit relu.*Passez le ticket en AI Review/));
  });

  const pushed = { number: 7, url: 'u', branch: 'b', reason: 'la branche a reçu un push depuis la review', headMoved: true };

  it('a merge refused for a push since the review sends the new commits through the AI review, not straight to Human Review', () => {
    // A move by the factory emits no status.changed, so the review is started here, not by the rule `to: ai_review`.
    const out = decide(inReview({ logical: 'done' }), { ...ev('pr.merge_refused', pushed), taint: 'trusted' }, workflow);
    expect(out.effects).toEqual([
      { kind: 'move', to: 'ai_review' },
      { kind: 'comment', body: expect.stringMatching(/push depuis la review.*repassent par la review IA/) },
      { kind: 'start_run', job: 'review' },
    ]);
  });

  it('a merge refused for a push, in a workflow with no AI review, goes back to Human Review with the reason', () => {
    const noReview = { ...workflow, on: { ...workflow.on, 'status.changed': (workflow.on['status.changed'] ?? []).filter((r) => r.to !== 'ai_review') } };
    expect(decide(inReview({ logical: 'done' }), ev('pr.merge_refused', pushed), noReview).effects).toEqual(backToReview(/push depuis la review/));
  });

  it('a merge refused for a push applies the rule a human\'s move to AI Review would: the first that matches, run or not', () => {
    // A rule with no run listed first answers a human's move with no review: so does the refusal.
    const first = { ...workflow, on: { ...workflow.on, 'status.changed': [{ from: 'done', to: 'ai_review' }, ...(workflow.on['status.changed'] ?? [])] } } as typeof workflow;
    expect(decide(inReview({ logical: 'done' }), { ...ev('pr.merge_refused', pushed), taint: 'trusted' }, first).effects).toEqual(backToReview(/push depuis la review/));
  });

  it('a merge refused for a push on a blocked ticket goes back to Human Review: a blocked ticket waits for a human', () => {
    const out = decide(inReview({ logical: 'done', blocked: true, blockReason: 'x' }), { ...ev('pr.merge_refused', pushed), taint: 'trusted' }, workflow);
    expect(out.effects).toEqual(backToReview(/push depuis la review/));
  });

  it('a merge refused late, once a human moved the ticket on from Done, starts no AI review', () => {
    const out = decide(inReview({ logical: 'dev' }), { ...ev('pr.merge_refused', pushed), taint: 'trusted' }, workflow);
    expect(out.effects.some((e) => e.kind === 'start_run' || (e.kind === 'move' && e.to === 'ai_review'))).toBe(false);
  });

  it('a merge refused once the PR is known merged (on GitHub, meanwhile) leaves the delivered ticket as it is', () => {
    expect(decide(inReview({ logical: 'done', prState: 'MERGED' }), { ...ev('pr.merge_refused', pushed), taint: 'trusted' }, workflow).effects).toEqual([]);
  });

  it('a merge effect that died (GitHub down past its retries) sends the ticket back to Human Review: Done no longer says merged', () => {
    const failed = { ...ev('effect.failed', { effectId: 'REL-1:4:0', kind: 'merge', eventId: 'e-status.changed', attempts: 8, error: 'GitHub API PUT /pulls/7/merge: 502' }), taint: 'trusted' as const };
    expect(decide(inReview({ logical: 'done' }), failed, workflow).effects).toEqual(backToReview(/pas pu merger la PR #7 : GitHub API PUT \/pulls\/7\/merge: 502/));
    // A ticket delivered after all (merged on GitHub) is left as it is.
    expect(decide(inReview({ logical: 'done', prState: 'MERGED' }), failed, workflow).effects).toEqual([]);
  });

  it('a merge refused for another reason (PR not mergeable) sends the ticket back to Human Review, the reviewed commit kept', () => {
    const out = decide(inReview({ logical: 'done' }), ev('pr.merge_refused', { number: 7, url: 'u', branch: 'b', reason: 'GitHub refuse le merge (conflit)' }), workflow);
    expect(out.effects).toEqual(backToReview(/GitHub refuse le merge \(conflit\)/));
  });

  it('a ticket cancelled in Human Review writes nothing on the forge: no merge, its PR left open', () => {
    const out = decide(inReview(), ev('status.changed', { from: 'human_review', to: null, cancelled: true }, 'u-lead', MERGER), workflow);
    expect(out.effects).toEqual([{ kind: 'stop_run' }]);
  });

  it('leaves a Done without an open PR to the rules, as before', () => {
    for (const t of [inReview({ prNumber: undefined }), inReview({ prState: 'MERGED' }), inReview({ delegated: false })]) {
      expect(decide(t, done(), workflow).effects.some((e) => e.kind === 'merge' || e.kind === 'move')).toBe(false);
    }
  });

  it('has the roles of a move to Done resolved, so that the matrix checks it', () => {
    expect(mayCheck(done(), workflow)).toBe(true);
    expect(mayCheck(ev('status.changed', { from: 'dev', to: 'human_review' }, 'u', MERGER), workflow)).toBe(false);
  });

  it('records the commit shown in Human Review, and forgets it when the factory moves the ticket elsewhere', () => {
    const shown = reduce(inReview({ reviewSha: undefined, logical: 'ai_review' }), { type: 'status.recorded', to: 'human_review', reviewSha: 'def456' })!;
    expect(shown).toMatchObject({ logical: 'human_review', reviewSha: 'def456' });
    expect(reduce(shown, { type: 'status.recorded', to: 'dev' })!.reviewSha).toBeUndefined();
  });
});
