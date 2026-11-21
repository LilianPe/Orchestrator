import { describe, expect, it, vi } from 'vitest';
import { defaultWorkflow } from '../../presets/workflow.js';
import { FakeClock } from '../../core/clock.js';
import { newTicketState, TRUSTED, type FactoryEvent, type TicketState } from '../../core/types.js';
import { MemoryStore } from '../../store/memory-store.js';
import { FakeForge } from './fake.js';
import { GithubReconciler } from './github-reconcile.js';

describe('GithubReconciler', () => {
  it('emits opened, checks transitions and merged', async () => {
    const workflow = defaultWorkflow();
    const store = new MemoryStore();
    const forge = new FakeForge();
    const events: FactoryEvent[] = [];
    const clock = new FakeClock(100);
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b' });
    const reconciler = new GithubReconciler({ store, forge, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: (e) => events.push(e), clock, log: () => {} });

    await reconciler.once();
    expect(events).toEqual([]);

    forge.setPr('b', { number: 7, url: 'u7', state: 'OPEN', checks: 'fail', failedChecks: ['test'] });
    await reconciler.once();
    expect(events.map((e) => [e.id, e.type])).toEqual([
      ['pr:REL-1:7:opened', 'pr.opened'],
      ['pr:REL-1:7:checks:fail:100', 'pr.checks_failed'],
    ]);
    expect(events[1]!.payload).toEqual({ number: 7, url: 'u7', branch: 'b', failures: ['test'] });

    await reconciler.once();
    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe('pr.opened');

    forge.setPr('b', { number: 7, url: 'u7', state: 'MERGED', headSha: 'h7', mergeSha: 'm7', mergedAt: 77, checks: 'none', failedChecks: [] });
    await reconciler.once();
    expect(events.at(-1)!.id).toBe('pr:REL-1:7:merged');
    // The merge commit and head, as the webhook records them: what a revert names (ORC-278).
    expect(events.at(-1)!.payload).toMatchObject({ number: 7, headSha: 'h7', mergeSha: 'm7', mergedAt: 77 });
  });
  function setup(submit?: (e: FactoryEvent) => void, log: (m: string) => void = () => {}) {
    const workflow = defaultWorkflow();
    const store = new MemoryStore();
    const forge = new FakeForge();
    const events: FactoryEvent[] = [];
    const clock = new FakeClock(100);
    const reconciler = new GithubReconciler({ store, forge, projects: [{ id: 'p', repoPath: '/r', teamKey: 'REL', workflow }], submit: submit ?? ((e) => events.push(e)), clock, log });
    return { store, forge, events, reconciler };
  }

  it('re-emits checks_failed after fail -> pending -> fail', async () => {
    const { store, forge, events, reconciler } = setup();
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7 });
    for (const checks of ['fail', 'pending', 'fail'] as const) {
      forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', checks, failedChecks: checks === 'fail' ? ['t'] : [] });
      await reconciler.once();
    }
    expect(events.map((e) => e.type)).toEqual(['pr.checks_failed', 'pr.checks_failed']);
  });

  it('isolates a failing ticket and logs', async () => {
    const logs: string[] = [];
    const events: FactoryEvent[] = [];
    const { store, forge, reconciler } = setup((e) => {
      if (e.ticketId === 'REL-1') throw new Error('boom');
      events.push(e);
    }, (m) => logs.push(m));
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b1' });
    await store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'human_review', 1), branch: 'b2' });
    forge.setPr('b1', { number: 1, url: 'u', state: 'OPEN', checks: 'none', failedChecks: [] });
    forge.setPr('b2', { number: 2, url: 'u', state: 'OPEN', checks: 'none', failedChecks: [] });
    await reconciler.once();
    expect(events.map((e) => e.id)).toEqual(['pr:REL-2:2:opened']);
    expect(logs.some((m) => m.includes('boom'))).toBe(true);
  });

  it('watches a ticket moved to done before the merge was seen, until its PR is merged or closed (ORC-268)', async () => {
    const { store, forge, events, reconciler } = setup();
    const findPr = vi.spyOn(forge, 'findPr');
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'done', 1), branch: 'b', prNumber: 7 });
    forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', checks: 'fail', failedChecks: ['t'] });
    await reconciler.once();
    expect(events).toEqual([]);
    forge.setPr('b', { number: 7, url: 'u', state: 'MERGED', checks: 'none', failedChecks: [] });
    await reconciler.once();
    expect(events.map((e) => e.id)).toEqual(['pr:REL-1:7:merged']);
    await reconciler.once();
    expect(findPr).toHaveBeenCalledTimes(2);
    // Done again with the same PR: nothing new to watch. With a new PR: watched again.
    await store.putTicket({ ...(await store.getTicket('p', 'REL-1'))!, logical: 'done' });
    await reconciler.once();
    expect(findPr).toHaveBeenCalledTimes(2);
    await store.putTicket({ ...(await store.getTicket('p', 'REL-1'))!, prNumber: 8 });
    forge.setPr('b', { number: 8, url: 'u8', state: 'OPEN', checks: 'none', failedChecks: [] });
    await reconciler.once();
    expect(findPr).toHaveBeenCalledTimes(3);
    // A done ticket whose PR was never seen has nothing to wait for.
    await store.putTicket({ ...newTicketState('p', 'REL-2', 'T', 'done', 1), branch: 'b2' });
    await reconciler.once();
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
      await s.reconciler.once('p');
      return s.events.filter((e) => e.type === 'push.human');
    }

    it('is a human push, under the id of its webhook, after the head last known', async () => {
      expect(await headIs(HUMAN, {}, [OTHER, PUBLISHED])).toEqual([
        { ...TRUSTED, taint: 'untrusted', at: 100, projectId: 'p', ticketId: 'REL-1', id: `push:REL-1:${HUMAN}`, type: 'push.human', payload: { branch: 'b', sha: HUMAN, author: 'inconnu', before: PUBLISHED } },
      ]);
      // A human head no publication carries yet is the last known.
      expect((await headIs(OTHER, { humanHead: HUMAN }))[0]?.payload).toMatchObject({ sha: OTHER, before: HUMAN });
    });

    it('is no push when the factory pushed it, or the factory knows it already', async () => {
      // Its last publication, while a commit verified since waits to go out.
      expect(await headIs(PUBLISHED)).toEqual([]);
      // The one before: the forge may still read the PR on it, just after a push.
      expect(await headIs(OTHER, {}, [OTHER, PUBLISHED])).toEqual([]);
      // The one before, a second publication of the same commit between them.
      expect(await headIs(OTHER, {}, [OTHER, PUBLISHED, PUBLISHED])).toEqual([]);
      // An older one: a branch a human put back, as the webhook reports it.
      expect((await headIs(OTHER, {}, [OTHER, HUMAN, PUBLISHED]))[0]?.payload).toMatchObject({ sha: OTHER, before: PUBLISHED });
      // Verified last: published, its `publish.done` not yet read, or a human's whose check passed.
      expect(await headIs(VERIFIED)).toEqual([]);
      // A human's the inbox has already, and no publication carries yet.
      expect(await headIs(HUMAN, { humanHead: HUMAN })).toEqual([]);
    });

    it('reads the journal at each pass whose head is neither the commit verified last nor a human push received', async () => {
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED });
      await s.store.recordEvent(published(PUBLISHED));
      const journal = vi.spyOn(s.store, 'ticketJournal');
      const read = async (head: string) => {
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.reconciler.once('p');
      };
      for (const head of [PUBLISHED, PUBLISHED, HUMAN, VERIFIED]) await read(head);
      expect(journal).toHaveBeenCalledTimes(3);
      // The push caught up is the ticket's `humanHead` once reduced: its head is not read again.
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, humanHead: HUMAN });
      await read(HUMAN);
      expect(journal).toHaveBeenCalledTimes(3);
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
      await s.reconciler.once('p');
      expect(s.events.filter((e) => e.type === 'push.human')).toEqual([]);
    });

    it('waits for a take-over to end before judging a head', async () => {
      // A take-over's bundle is on the forge before its `push.human`, under the human's name, is accepted.
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: VERIFIED, blocked: true, blockKind: 'taken_over' });
      await s.store.recordEvent(published(PUBLISHED));
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: HUMAN, checks: 'none', failedChecks: [] });
      await s.reconciler.once('p');
      expect(s.events.filter((e) => e.type === 'push.human')).toEqual([]);
      // The same head, judged once the take-over has ended.
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, blocked: false, blockKind: undefined });
      await s.reconciler.once('p');
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: HUMAN, before: PUBLISHED })]);
    });

    it('judges a head again when the branch comes back to it, whatever it was judged before', async () => {
      const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(40)) as [string, string, string, string];
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: C });
      for (const [i, sha] of [A, B, C].entries()) await s.store.recordEvent(published(sha, i + 1));
      const read = async (head: string) => {
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.reconciler.once('p');
      };
      // Just after C, the forge still reads B: the factory's.
      await read(B);
      // D published and read, the commit verified last.
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, verifiedSha: D });
      await s.store.recordEvent(published(D, 4));
      await read(D);
      // A human puts the branch back on B, now out of the window.
      await read(B);
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: B, before: D })]);
    });

    it('judges the head read last again once the factory has published since, no poll between', async () => {
      const [C, D, E] = ['c', 'd', 'e'].map((x) => x.repeat(40)) as [string, string, string];
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: C });
      await s.store.recordEvent(published(C, 1));
      const read = async (head: string) => {
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.reconciler.once('p');
      };
      await read(C);
      // D then E verified and published before the next poll: no pass reads either.
      for (const [i, sha] of [D, E].entries()) {
        await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, verifiedSha: sha });
        await s.store.recordEvent(published(sha, i + 2));
      }
      // A human puts the branch back on C, its webhook lost: C, out of the window [D, E], is the head read last.
      await read(C);
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: C, before: E })]);
    });

    it('judges a head again once it is out of the window, whatever commit is verified then', async () => {
      const [C, D, E] = ['c', 'd', 'e'].map((x) => x.repeat(40)) as [string, string, string];
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: D });
      for (const [i, sha] of [C, D].entries()) await s.store.recordEvent(published(sha, i + 1));
      const read = async (head: string) => {
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.reconciler.once('p');
      };
      // Just after D, the forge still reads C: the factory's.
      await read(C);
      // E published; a human puts the branch back on D, its webhook received and D verified green again.
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, verifiedSha: E });
      await s.store.recordEvent(published(E, 3));
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, verifiedSha: D, humanHead: D });
      // The human puts it back on C, that webhook lost, no poll between: the commit verified is D again.
      await read(C);
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: C, before: D })]);
    });

    it('judges a head again once it is out of the window, for a job that publishes without verify', async () => {
      const [C, D, E] = ['c', 'd', 'e'].map((x) => x.repeat(40)) as [string, string, string];
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7 });
      await s.store.recordEvent(published(C, 1));
      const read = async (head: string) => {
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.reconciler.once('p');
      };
      await read(C);
      // D then E published, no commit verified, no poll between; a human puts the branch back on C, its webhook lost.
      for (const [i, sha] of [D, E].entries()) await s.store.recordEvent(published(sha, i + 2));
      await read(C);
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: C, before: E })]);
    });

    it('takes no head in the window for a push when a commit is verified with no publication', async () => {
      const [C, D, X] = ['c', 'd', 'x'].map((x) => x.repeat(40)) as [string, string, string];
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, verifiedSha: D });
      for (const [i, sha] of [C, D].entries()) await s.store.recordEvent(published(sha, i + 1));
      const read = async (head: string) => {
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.reconciler.once('p');
      };
      await read(C);
      // A commit verified that waits for its publication: C, the one before the last pushed, stays the factory's.
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, verifiedSha: X });
      await read(C);
      expect(s.events.filter((e) => e.type === 'push.human')).toEqual([]);
    });

    it('takes a head from before the first publication for no push, even read again just after it', async () => {
      const s = setup();
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7 });
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: OTHER, checks: 'none', failedChecks: [] });
      await s.reconciler.once('p');
      // The factory publishes; the forge still reads the PR on the head before, which no publication of its own precedes.
      await s.store.putTicket({ ...(await s.store.getTicket('p', 'REL-1'))!, verifiedSha: PUBLISHED });
      await s.store.recordEvent(published(PUBLISHED));
      await s.reconciler.once('p');
      expect(s.events.filter((e) => e.type === 'push.human')).toEqual([]);
    });

    it('writes the head read before the first publication once', async () => {
      const s = setup();
      const setMeta = vi.spyOn(s.store, 'setMeta');
      const writes = () => setMeta.mock.calls.filter(([key]) => key.startsWith('lost-push:')).map(([, value]) => value);
      await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7 });
      s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: OTHER, checks: 'none', failedChecks: [] });
      await s.reconciler.once('p');
      await s.reconciler.once('p');
      expect(writes()).toEqual([OTHER]);
    });

    describe('a last push that names the head it replaced (ORC-438)', () => {
      const replaced = (sha: string, before: string, n = 1): FactoryEvent<'publish.done'> => {
        const e = published(sha, n);
        return { ...e, payload: { ...e.payload, before } };
      };
      async function headAfter(head: string, events: FactoryEvent<'publish.done'>[], ticket: Partial<TicketState> = {}, s = setup()) {
        await s.store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'human_review', 1), branch: 'b', prNumber: 7, ...ticket });
        for (const e of events) await s.store.recordEvent(e);
        s.forge.setPr('b', { number: 7, url: 'u', state: 'OPEN', headSha: head, checks: 'none', failedChecks: [] });
        await s.reconciler.once('p');
        return s.events.filter((e) => e.type === 'push.human').map((e) => e.payload);
      }

      it('takes the head it replaced for the factory\'s, whoever pushed it: the forge may still read the PR on it', async () => {
        // A human's push the factory went over, its webhook received then, no longer the ticket's `humanHead`.
        expect(await headAfter(HUMAN, [published(OTHER, 1), replaced(PUBLISHED, HUMAN, 2)])).toEqual([]);
        // The head read before the first publication, with no head kept from then.
        expect(await headAfter(OTHER, [replaced(PUBLISHED, OTHER)])).toEqual([]);
        expect(await headAfter(PUBLISHED, [replaced(PUBLISHED, OTHER)])).toEqual([]);
      });

      it('takes any older head for a human push, even one the factory pushed', async () => {
        // OTHER, the factory's push before the last, which replaced a human's push: a branch put back on it.
        expect(await headAfter(OTHER, [published(OTHER, 1), replaced(PUBLISHED, HUMAN, 2)])).toEqual([expect.objectContaining({ sha: OTHER, before: PUBLISHED })]);
      });

      it('reads no head kept before the first publication', async () => {
        const s = setup();
        const getMeta = vi.spyOn(s.store, 'getMeta');
        expect(await headAfter(HUMAN, [replaced(PUBLISHED, OTHER)], {}, s)).toEqual([expect.objectContaining({ sha: HUMAN, before: PUBLISHED })]);
        expect(getMeta.mock.calls.filter(([key]) => key.startsWith('lost-push:'))).toEqual([]);
      });

      it('keeps the head a push went over through a publication of the same commit since, which pushed nothing', async () => {
        const again = published(PUBLISHED, 3);
        expect(await headAfter(HUMAN, [published(OTHER, 1), replaced(PUBLISHED, HUMAN, 2), again])).toEqual([]);
        expect(await headAfter(OTHER, [published(OTHER, 1), replaced(PUBLISHED, HUMAN, 2), again])).toEqual([expect.objectContaining({ sha: OTHER })]);
      });

      it('falls back on the window when the last push names none, as an older journal\'s', async () => {
        // A publication journaled before ORC-438, after one that named its head replaced.
        expect(await headAfter(OTHER, [replaced(OTHER, HUMAN, 1), published(PUBLISHED, 2)])).toEqual([]);
      });
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
      await s.reconciler.once('p');
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
      await s.reconciler.once('p');
      expect(s.events.filter((e) => e.type === 'push.human').map((e) => e.payload)).toEqual([expect.objectContaining({ sha: OTHER, before: PUBLISHED })]);
      expect(await headIs(undefined)).toEqual([]);
    });
  });
});
