import { describe, expect, it, vi } from 'vitest';
import { defaultWorkflow } from '../../presets/workflow.js';
import { FakeClock } from '../../core/clock.js';
import { newTicketState, TRUSTED, type FactoryEvent, type TicketState } from '../../core/types.js';
import { SqliteStore } from '../../store/sqlite-store.js';
import { FakeForge } from './fake.js';
import { PrPoller } from './pr-poller.js';

describe('PrPoller', () => {
  it('emits opened, checks transitions and merged', async () => {
    const workflow = defaultWorkflow();
    const store = new SqliteStore(':memory:');
    const forge = new FakeForge();
    const events: FactoryEvent[] = [];
    const clock = new FakeClock(100);
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b' });
    const poller = new PrPoller({ store, forge, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: (e) => events.push(e), clock, log: () => {} });

    await poller.pollOnce();
    expect(events).toEqual([]);

    forge.setPr('b', { number: 7, url: 'u7', state: 'OPEN', checks: 'fail', failedChecks: ['test'] });
    await poller.pollOnce();
    expect(events.map((e) => [e.id, e.type])).toEqual([
      ['pr:REL-1:7:opened', 'pr.opened'],
      ['pr:REL-1:7:checks:fail:100', 'pr.checks_failed'],
    ]);
    expect(events[1]!.payload).toEqual({ number: 7, url: 'u7', branch: 'b', failures: ['test'] });

    await poller.pollOnce();
    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe('pr.opened');

    forge.setPr('b', { number: 7, url: 'u7', state: 'MERGED', headSha: 'h7', mergeSha: 'm7', mergedAt: 77, checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(events.at(-1)!.id).toBe('pr:REL-1:7:merged');
    // The merge commit and head, as the webhook records them: what a revert names (ORC-278).
    expect(events.at(-1)!.payload).toMatchObject({ number: 7, headSha: 'h7', mergeSha: 'm7', mergedAt: 77 });
  });
  function setup(submit?: (e: FactoryEvent) => void, log: (m: string) => void = () => {}) {
    const workflow = defaultWorkflow();
    const store = new SqliteStore(':memory:');
    const forge = new FakeForge();
    const events: FactoryEvent[] = [];
    const clock = new FakeClock(100);
    const poller = new PrPoller({ store, forge, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: submit ?? ((e) => events.push(e)), clock, log });
    return { store, forge, events, poller };
  }

  it('re-emits checks_failed after fail -> pending -> fail', async () => {
    const { store, forge, events, poller } = setup();
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7 });
    for (const checks of ['fail', 'pending', 'fail'] as const) {
      forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', checks, failedChecks: checks === 'fail' ? ['t'] : [] });
      await poller.pollOnce();
    }
    expect(events.map((e) => e.type)).toEqual(['pr.checks_failed', 'pr.checks_failed']);
  });

  it('isolates a failing ticket and logs', async () => {
    const logs: string[] = [];
    const events: FactoryEvent[] = [];
    const { store, forge, poller } = setup((e) => {
      if (e.ticketId === 'REL-1') throw new Error('boom');
      events.push(e);
    }, (m) => logs.push(m));
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b1' });
    await store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'human_review', 1), branch: 'b2' });
    forge.setPr('b1', { number: 1, url: 'u', state: 'OPEN', checks: 'none', failedChecks: [] });
    forge.setPr('b2', { number: 2, url: 'u', state: 'OPEN', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(events.map((e) => e.id)).toEqual(['pr:REL-2:2:opened']);
    expect(logs.some((m) => m.includes('boom'))).toBe(true);
  });

  it('watches a ticket moved to done before the merge was seen, until its PR is merged or closed (ORC-268)', async () => {
    const { store, forge, events, poller } = setup();
    const findPr = vi.spyOn(forge, 'findPr');
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'done', 1), branch: 'b', prNumber: 7 });
    forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', checks: 'fail', failedChecks: ['t'] });
    await poller.pollOnce();
    expect(events).toEqual([]);
    forge.setPr('b', { number: 7, url: 'u', state: 'MERGED', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(events.map((e) => e.id)).toEqual(['pr:REL-1:7:merged']);
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(2);
    // Done again with the same PR: nothing new to watch. With a new PR: watched again.
    await store.putTicket({ ...(await store.getTicket('p', 'REL-1'))!, logical: 'done' });
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(2);
    await store.putTicket({ ...(await store.getTicket('p', 'REL-1'))!, prNumber: 8 });
    forge.setPr('b', { number: 8, url: 'u8', state: 'OPEN', checks: 'none', failedChecks: [] });
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(3);
    // A done ticket whose PR was never seen has nothing to wait for.
    await store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'done', 1), branch: 'b2' });
    await poller.pollOnce();
    expect(findPr).toHaveBeenCalledTimes(4);
    expect(findPr.mock.calls.map((c) => c[1])).toEqual(['b', 'b', 'b', 'b']);
  });

  describe('a head the factory neither pushed nor heard of (ORC-281)', () => {
    const [PUBLISHED, VERIFIED, HUMAN, OTHER] = ['p', 'v', 'h', 'o'].map((c) => c.repeat(40)) as [string, string, string, string];
    const published = (sha: string, n = 1): FactoryEvent<'publish.done'> => ({ ...TRUSTED, id: `publish-done:${n}`, type: 'publish.done', at: n, projectId: 'p', ticketId: 'REL-1', payload: { runId: `r${n}`, job: 'dev', sha } });
    async function headIs(head: string | undefined, ticket: Partial<TicketState> = {}, publications: string[] = [PUBLISHED]) {
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED, ...ticket });
      for (const [i, sha] of publications.entries()) await s.store.recordEvent(published(sha, i + 1));
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', ...(head ? { headSha: head } : {}), checks: 'none', failedChecks: [] });
      await s.poller.pollOnce('p');
      return s.events.filter((e) => e.type === 'push.human');
    }

    it('is a human push, under the id of its webhook, after the head last known', async () => {
      expect(await headIs(HUMAN, {}, [OTHER, PUBLISHED])).toEqual([
        { ...TRUSTED, taint: 'untrusted', at: 100, projectId: 'p', ticketId: 'REL-1', id: `push:REL-1:${HUMAN}`, type: 'push.human', payload: { branch: 'b', sha: HUMAN, author: 'unknown', before: PUBLISHED } },
      ]);
      // A human head no publication carries yet is the last known.
      expect((await headIs(OTHER, { humanHead: HUMAN }))[0]?.payload).toMatchObject({ sha: OTHER, before: HUMAN });
    });

    it('is no push when the factory pushed it, or the factory knows it already', async () => {
      // Its last publication, while a commit verified since waits to go out.
      expect(await headIs(PUBLISHED)).toEqual([]);
      // The one before: the forge may still read the PR on it, just after a push.
      expect(await headIs(OTHER, {}, [OTHER, PUBLISHED])).toEqual([]);
      // An older one: a branch a human put back, as the webhook reports it.
      expect((await headIs(OTHER, {}, [OTHER, HUMAN, PUBLISHED]))[0]?.payload).toMatchObject({ sha: OTHER, before: PUBLISHED });
      // Verified last: published, its `publish.done` not yet read, or a human's whose check passed.
      expect(await headIs(VERIFIED)).toEqual([]);
      // A human's the inbox has already, and no publication carries yet.
      expect(await headIs(HUMAN, { humanHead: HUMAN })).toEqual([]);
    });

    it('judges each head once: the journal is read again only for a new head', async () => {
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED });
      await s.store.recordEvent(published(PUBLISHED));
      const journal = vi.spyOn(s.store, 'ticketJournal');
      for (const head of [PUBLISHED, PUBLISHED, HUMAN, HUMAN]) {
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.poller.pollOnce('p');
      }
      expect(journal).toHaveBeenCalledTimes(2);
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: HUMAN })]);
    });

    it('judges the head on the ticket as it is once the PR is read, not as the pass began', async () => {
      // A commit verified and published while the pass reads the forge: on the PR before its `publish.done`, and before the pass's snapshot knows it.
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED });
      await s.store.recordEvent(published(PUBLISHED));
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: OTHER, checks: 'none', failedChecks: [] });
      const findPr = s.forge.findPr.bind(s.forge);
      vi.spyOn(s.forge, 'findPr').mockImplementation(async (...a) => {
        await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, verifiedSha: OTHER });
        return findPr(...a);
      });
      await s.poller.pollOnce('p');
      expect(s.events.filter((e) => e.type === 'push.human')).toEqual([]);
    });

    it('waits for a take-over to end, and for a publication to compare with, before judging a head', async () => {
      // A take-over's bundle is on the forge before its `push.human`, under the human's name, is accepted.
      expect(await headIs(HUMAN, { blocked: true, blockKind: 'taken_over' })).toEqual([]);
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED, blocked: true, blockKind: 'taken_over' });
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: HUMAN, checks: 'none', failedChecks: [] });
      await s.poller.pollOnce('p');
      // No publication yet: nothing to compare with.
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, blocked: false, blockKind: undefined });
      await s.poller.pollOnce('p');
      expect(s.events.filter((e) => e.type === 'push.human')).toEqual([]);
      // The same head, judged again once both are there.
      await s.store.recordEvent(published(PUBLISHED));
      await s.poller.pollOnce('p');
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: HUMAN, before: PUBLISHED })]);
    });

    it("holds back no CI verdict when the head's judgement fails", async () => {
      const logs: string[] = [];
      const events: FactoryEvent[] = [];
      const s = setup((e) => {
        if (e.type === 'push.human') throw new Error('inbox down');
        events.push(e);
      }, (m) => logs.push(m));
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED });
      await s.store.recordEvent(published(PUBLISHED));
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: HUMAN, checks: 'pass', failedChecks: [] });
      await s.poller.pollOnce('p');
      expect(events.map((e) => e.type)).toEqual(['pr.checks_passed']);
      expect(logs).toEqual([expect.stringContaining('inbox down')]);
    });

    it('is not told with no publication of the factory to compare with, nor without a head', async () => {
      expect(await headIs(HUMAN, {}, [])).toEqual([]);
      // An `empty` publication pushed nothing (ORC-402): its sha is no head of the factory's.
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED });
      await s.store.recordEvent(published(PUBLISHED, 1));
      await s.store.recordEvent({ ...published(OTHER, 2), payload: { ...published(OTHER, 2).payload, empty: true } });
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: OTHER, checks: 'none', failedChecks: [] });
      await s.poller.pollOnce('p');
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: OTHER, before: PUBLISHED })]);
      expect(await headIs(undefined)).toEqual([]);
    });
  });

  it('start() survives a rejecting pollOnce', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const { poller } = setup(undefined, (m) => logs.push(m));
      vi.spyOn(poller, 'pollOnce').mockRejectedValue(new Error('nope'));
      poller.start(10);
      await vi.advanceTimersByTimeAsync(15);
      await poller.stop();
      expect(logs.some((m) => m.includes('nope'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() resolves once the poll under way has finished, and starts none after', async () => {
    vi.useFakeTimers();
    try {
      const { poller } = setup();
      let release!: () => void;
      const polls = vi.spyOn(poller, 'pollOnce').mockImplementation(() => new Promise<void>((r) => (release = r)));
      poller.start(10);
      await vi.advanceTimersByTimeAsync(15);
      let stopped = false;
      const stop = poller.stop().then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(50);
      expect(stopped).toBe(false);
      release();
      await stop;
      expect(polls).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
