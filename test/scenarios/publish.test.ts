import { describe, expect, it, vi } from 'vitest';
import { newTicketState, type FactoryEvent, type TicketState } from '../../src/core/types.js';
import type { Store } from '../../src/store/types.js';
import { createHarness } from '../helpers/harness.js';

/**
 * ORC-125: the factory publishes, through the outbox. The agent only commits; what `verify` found green goes out, and the job's
 * `on_success` waits for it. Nothing reaches the forge otherwise, and a replay doubles nothing.
 */
type Harness = ReturnType<typeof createHarness>;
const BRANCH = 'factory/rel-1-export-csv';
const WORKTREE = '/tmp/factory-fake/p/REL-1';
const SHA = 'abc123';

function verified(opts: Parameters<typeof createHarness>[0] = {}): Harness {
  const h = createHarness(opts);
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
  h.workspaces.heads.set(WORKTREE, SHA);
  h.runner.enqueue({ events: [{ kind: 'init', sessionId: 'x' }, { kind: 'text', text: 'SECRET_LAST_MESSAGE' }] });
  return h;
}

/** A store with some methods replaced. A new object, not an assignment: the Postgres harness's store is a proxy, which would ignore one. */
function overriding(store: Store, over: Partial<Store>): Store {
  return new Proxy(store, {
    get(target, prop) {
      const own = (over as Record<string | symbol, unknown>)[prop];
      if (own) return own;
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The ticket changed under the effect, as it is claimed: what a decision between the two would leave. */
const onPublishClaim = (change: (t: TicketState) => TicketState) => (store: Store) =>
  overriding(store, {
    claimEffect: async (...args) => {
      const row = await store.claimEffect(...args);
      if (row && row !== 'busy' && row.effect.kind === 'publish') await store.updateTicket('p', 'REL-1', change);
      return row;
    },
  });

const delegate = (h: Harness) => h.send('ticket.delegated', { linearSessionId: 'ls-1' });
const moves = (h: Harness) => h.tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);
/** The run's summary in the session: its `post_output`, not what the run's stream shows on the way. */
const responses = (h: Harness) => h.tracker.calls.filter((c) => c.method === 'activity' && (c.args[1] as { type: string }).type === 'response');

describe('the factory publishes (ORC-125)', () => {
  it('a green verify: pushed by the factory, a draft PR linked to the ticket, then Human Review on that commit, out of draft', async () => {
    const h = verified();
    await delegate(h);
    expect(h.publisher.published).toEqual([expect.objectContaining({ ticketId: 'REL-1', branch: BRANCH, sha: SHA, worktree: WORKTREE, repoPath: '/repo' })]);
    expect(h.forge.opened).toEqual([expect.objectContaining({ branch: BRANCH, draft: true })]);
    const t = await h.ticket();
    expect(t).toMatchObject({ logical: 'human_review', prNumber: 1, prState: 'OPEN', verifiedSha: SHA, reviewSha: SHA });
    expect(t.verifyingRunId).toBeUndefined();
    expect(h.tracker.calls.some((c) => c.method === 'addExternalUrl' && c.args[2] === 'https://github.test/pr/1')).toBe(true);
    expect(h.forge.readied).toEqual([1]);
  });

  it("copies nothing of the agent's last message into GitHub", async () => {
    const h = verified();
    await delegate(h);
    const [pr] = h.forge.opened;
    expect(pr!.title).toBe('REL-1 Export CSV');
    expect(JSON.stringify(pr)).not.toContain('SECRET_LAST_MESSAGE');
  });

  it('the summary and the move wait for the publication: a run held on it shows neither', async () => {
    const h = verified();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = h.publisher.publish.bind(h.publisher);
    vi.spyOn(h.publisher, 'publish').mockImplementation(async (req) => {
      await gate;
      return real(req);
    });
    const delegated = delegate(h);
    await vi.waitFor(() => expect(h.publisher.publish).toHaveBeenCalled());
    expect(moves(h)).not.toContain('Human Review');
    expect((await h.ticket()).verifyingRunId).toBeDefined();
    release();
    await delegated;
    expect(moves(h)).toContain('Human Review');
  });

  it('a stale event refused while the ticket is in publication: told once the publication ended, which it leaves alone (ORC-316)', async () => {
    const h = verified({ extraProjects: ['api'] });
    // The copy that waited under another project of the team: neither refuses the holder's publication nor shares its effect keys.
    const waiting = { ...newTicketState('api', 'REL-1', 'T', 'dev', 1), delegated: true, blocked: true, awaitingRepo: ['p', 'api'] };
    await h.store.putTicket(waiting);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = h.publisher.publish.bind(h.publisher);
    vi.spyOn(h.publisher, 'publish').mockImplementation(async (req) => {
      await gate;
      return real(req);
    });
    const delegated = delegate(h);
    await vi.waitFor(() => expect(h.publisher.publish).toHaveBeenCalled());
    const publishing = await h.ticket();
    expect(publishing.verifyingRunId).toBeDefined();

    await h.orch.accept({ id: 'stale', type: 'ticket.delegated', at: h.clock.now(), projectId: 'api', ticketId: 'REL-1', actor: 'user-1', taint: 'trusted', payload: { linearSessionId: 's9' } } as FactoryEvent);
    await vi.waitFor(async () => expect(await h.store.getDeadLetter('stale')).toMatchObject({ status: 'open' }));
    expect(await h.ticket()).toMatchObject({ verifyingRunId: publishing.verifyingRunId, blocked: false });

    release();
    await delegated;
    await h.orch.drained();
    expect(h.publisher.published).toHaveLength(1);
    expect(h.forge.opened).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', prNumber: 1, blocked: false });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();
    expect(await h.store.getTicket('api', 'REL-1')).toEqual(waiting);
    expect(h.tracker.activities('ls-1')).toContainEqual({ type: 'thought', body: expect.stringContaining('stale') });
    expect(h.tracker.activities('s9')).toEqual([{ type: 'response', body: expect.stringContaining('stale') }]);
    // Only the one refused: `pr.opened` and `publish.done` went through as the holder's.
    expect((await h.store.deadLetters('REL-1')).map((d) => d.eventId)).toEqual(['stale']);
  });

  it('a verify that fails publishes nothing (criterion 6)', async () => {
    const failing = createHarness({ cleanVerify: async () => ({ ok: false, failures: [{ command: 'npm test', exitCode: 1, output: 'x' }], sha: SHA, tree: 't' }), sandboxed: true });
    failing.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    failing.runner.enqueue({ events: [{ kind: 'text', text: 'fait' }] });
    await delegate(failing);
    expect(failing.publisher.asked).toEqual([]);
    expect(failing.forge.opened).toEqual([]);
  });

  it('a commit that is no longer the green one when the effect runs: nothing is pushed, the ticket blocked (criterion 6)', async () => {
    const h = verified({ wrapStore: onPublishClaim((t) => ({ ...t, verifiedSha: 'other' })) });
    await delegate(h);
    expect(h.publisher.asked).toEqual([]);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(t.blockReason).toMatch(/n'a pas de vérification verte/);
    expect(moves(h)).not.toContain('Human Review');
  });

  it("the diff refused: nothing goes out, no move, no summary; the ticket is blocked with the check's reason (criteria 2, 3)", async () => {
    const h = verified();
    h.publisher.refuseNext('diff', 'factory/chemins-interdits : .npmrc');
    await delegate(h);
    expect(h.publisher.published).toEqual([]);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(t.verifyingRunId).toBeUndefined();
    expect(t.blockReason).toContain('.npmrc');
    expect(moves(h)).not.toContain('Human Review');
    expect(responses(h)).toEqual([]);
  });

  it('a branch a human moved: refused, and a relaunch publishes again once the work holds their commit (criterion 4)', async () => {
    const h = verified();
    h.publisher.refuseNext('moved', 'la branche porte un commit humain');
    await delegate(h);
    expect((await h.ticket()).blockReason).toContain('commit humain');
    h.workspaces.heads.set(WORKTREE, 'def456');
    h.runner.enqueue({ events: [{ kind: 'text', text: 'intégré' }] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'a' });
    await h.advance(1);
    expect(h.publisher.published.map((p) => p.sha)).toEqual(['def456']);
    expect((await h.ticket()).blocked).toBe(false);
  });

  it('a run that committed nothing beyond the base ends as before, without a PR', async () => {
    const h = verified();
    h.publisher.refuseNext('empty');
    await delegate(h);
    expect(h.forge.opened).toEqual([]);
    const t = await h.ticket();
    expect(t).toMatchObject({ logical: 'human_review', blocked: false });
    expect(t.prNumber).toBeUndefined();
  });

  it('a stop while it publishes: its result moves nothing', async () => {
    const h = verified();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = h.publisher.publish.bind(h.publisher);
    vi.spyOn(h.publisher, 'publish').mockImplementation(async (req) => {
      await gate;
      return real(req);
    });
    const delegated = delegate(h);
    await vi.waitFor(() => expect(h.publisher.publish).toHaveBeenCalled());
    const stopped = h.send('control.stop', {});
    release();
    await Promise.all([delegated, stopped]);
    await h.advance(1);
    expect(moves(h)).not.toContain('Human Review');
    expect((await h.ticket()).blocked).toBe(true);
  });

  it('a stop before the effect runs: nothing goes out', async () => {
    const h = verified({ wrapStore: onPublishClaim((t) => ({ ...t, verifyingRunId: undefined })) });
    await delegate(h);
    expect(h.publisher.asked).toEqual([]);
    expect(moves(h)).not.toContain('Human Review');
  });

  it('without a publisher, the ticket is blocked and told why', async () => {
    const h = verified({ noPublisher: true });
    await delegate(h);
    expect((await h.ticket()).blockReason).toMatch(/GitHub App/);
    expect(moves(h)).not.toContain('Human Review');
  });

  describe('a replay doubles nothing (criterion 5)', () => {
    it('a crash between the push and the PR: the outbox plays it again, one PR, one result', async () => {
      const h = verified({ effectRetry: { attempts: 3, baseMs: 1, capMs: 1 } });
      const real = h.publisher.publish.bind(h.publisher);
      let cut = true;
      vi.spyOn(h.publisher, 'publish').mockImplementation(async (req) => {
        const out = await real(req);
        if (cut) {
          cut = false;
          throw new Error('coupé après le push');
        }
        return out;
      });
      await delegate(h);
      await h.advance(10);
      expect(h.publisher.publish).toHaveBeenCalledTimes(2);
      expect(h.forge.opened).toHaveLength(1);
      expect(await h.ticket()).toMatchObject({ logical: 'human_review', prNumber: 1 });
      expect(moves(h).filter((m) => m === 'Human Review')).toHaveLength(1);
      expect(responses(h)).toHaveLength(1);
    });

    it('a process killed during the publication: the next one finishes it, once', async () => {
      const h = verified({ effectRetry: { attempts: 3, baseMs: 1, capMs: 1 }, effectLeaseMs: 1000 });
      let die: () => void = () => {};
      const dying = new Promise<void>((r) => (die = r));
      const real = h.publisher.publish.bind(h.publisher);
      let first = true;
      vi.spyOn(h.publisher, 'publish').mockImplementation(async (req) => {
        const out = await real(req);
        if (first) {
          first = false;
          die();
          return new Promise(() => {});
        }
        return out;
      });
      void delegate(h);
      await dying;
      await h.restart({ mode: 'brutal' });
      await h.advance(2000);
      await h.advance(2000);
      expect(h.forge.opened).toHaveLength(1);
      const t = await h.ticket();
      expect(t).toMatchObject({ logical: 'human_review', prNumber: 1 });
      expect(t.verifyingRunId).toBeUndefined();
    });

    it('a refusal is decided once: replayed, it says the same, and reads no forge that changed', async () => {
      let failures = 2;
      const h = verified({
        effectRetry: { attempts: 6, baseMs: 1, capMs: 1 },
        wrapStore: (store) =>
          overriding(store, {
            appendInbox: async (e) => {
              if (e.id.startsWith('publish-refused:') && failures > 0) {
                failures--;
                throw new Error('inbox down');
              }
              return store.appendInbox(e);
            },
          }),
      });
      h.publisher.refuseNext('moved', 'bougée');
      await delegate(h);
      await h.advance(10);
      await h.advance(10);
      expect(h.publisher.asked).toHaveLength(1);
      expect((await h.ticket()).blockReason).toContain('bougée');
    });
  });
});
