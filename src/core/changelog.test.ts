import { describe, expect, it } from 'vitest';
import { changelogEntry, deliveredBody, mergedWork, type MergedPr } from './changelog.js';
import { TRUSTED, type EventPayloads, type EventType, type FactoryEvent } from './types.js';

const ev = <T extends EventType>(type: T, payload: EventPayloads[T]) => ({ ...TRUSTED, id: `${type}:${JSON.stringify(payload).length}`, type, at: 1, projectId: 'p', ticketId: 'REL-1', payload }) as FactoryEvent;
const passed = (runId: string, summary: string, extra: Partial<EventPayloads['verify.passed']> = {}) =>
  ev('verify.passed', { runId, job: 'dev', output: { status: 'done', summary, tests_added: [], why: '', assumptions: [], risks: [], untested: [], review_hints: [] }, ...extra });
const pr: MergedPr = { kind: 'after_merge', number: 3, url: 'https://gh/pr/3', at: 5 };
const ticket = { projectId: 'p', ticketId: 'REL-1', title: 'Export CSV' };

describe('the changelog entry of a merged PR (ORC-197)', () => {
  it('takes the work the factory published last, not a later verdict it never published', () => {
    const events = [passed('r1', 'first'), ev('publish.done', { runId: 'r1', job: 'dev', sha: 'a' }), passed('r2', 'never published')];
    expect(mergedWork(events)?.output?.summary).toBe('first');
    // The commit GitHub merged, when it says it: a human's push verified after the factory's publication.
    const pushed = [...events, passed('check-1', 'pushed', { sha: 'b', output: undefined })];
    expect(mergedWork(pushed, 'b')?.runId).toBe('check-1');
    expect(mergedWork(pushed, 'unknown')?.output?.summary).toBe('first');
    // Nothing published by the factory: its last green verdict.
    expect(mergedWork([passed('r1', 'first'), passed('r2', 'second')])?.output?.summary).toBe('second');
    expect(mergedWork([])).toBeUndefined();
  });

  it("says the ticket's title when no work is recorded, and no visual proof applicable", () => {
    expect(changelogEntry('k', ticket, pr, undefined)).toEqual({ id: 'k', ...ticket, summary: 'Export CSV', prNumber: 3, prUrl: 'https://gh/pr/3', paths: [], visualProof: { status: 'not_applicable' }, at: 5 });
  });

  it('names each capture by the artifact verify kept of it, and the page shot, the root when the agent named none', () => {
    const capture = { side: 'after' as const, sha: 'c'.repeat(40), width: 375, sha256: 'a'.repeat(64) };
    const work = (passed('r1', 'Restyled.', { visualProof: { decision: 'required', triggers: ['app/a.tsx'], captures: [capture] } }) as FactoryEvent<'verify.passed'>).payload;
    expect(changelogEntry('k', ticket, { ...pr, mergeSha: 'm' }, work)).toMatchObject({
      mergeSha: 'm', page: '/', paths: ['app/a.tsx'], visualProof: { status: 'taken', captures: [{ ...capture, artifactId: 'visual:r1:after:375' }] },
    });
  });

  it('mentions the requester by their profile, or no one', () => {
    expect(deliveredBody({ id: 'u', name: 'L', url: 'https://linear.app/x/profiles/l' }, pr)).toBe('Delivered, https://linear.app/x/profiles/l: [PR #3](https://gh/pr/3) is merged.');
    expect(deliveredBody(undefined, pr)).toBe('Delivered: [PR #3](https://gh/pr/3) is merged.');
  });
});
