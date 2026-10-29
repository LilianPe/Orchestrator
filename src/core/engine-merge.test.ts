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

  it('no commit recorded at the passage in Human Review: nothing merged, back to Human Review to record it', () => {
    expect(decide(inReview({ reviewSha: undefined }), done(), workflow).effects).toEqual(backToReview(/aucun commit relu.*répondez dans le fil/));
  });

  it('GitHub refusing the merge (a push since the review) sends the ticket back to Human Review with the reason', () => {
    const out = decide(inReview({ logical: 'done' }), ev('pr.merge_refused', { number: 7, url: 'u', branch: 'b', reason: 'la branche a reçu un push depuis la review' }), workflow);
    expect(out.effects).toEqual(backToReview(/push depuis la review/));
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
