import { describe, expect, it } from 'vitest';
import type { Store } from '../../src/store/types.js';
import { createHarness, mortal } from '../helpers/harness.js';

const LEASE_MS = 600_000;
const DEBOUNCE_MS = 180_000;

/** REL-1 delegated, run and in human review. */
async function inReview(h: ReturnType<typeof createHarness>): Promise<void> {
  h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
  h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
  await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
  expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
}

/**
 * ORC-228: `restart({ mode: 'brutal' })` drops the process as `kill -9` would, in the middle of its
 * work, and another one starts on the same database (SQLite here, Postgres in `scenarios-pg`).
 */
describe('a brutal restart in the middle of the processing', () => {
  it('loses no written event, timer or effect, and doubles no visible effect', async () => {
    const h = createHarness({ effectLeaseMs: LEASE_MS });
    await inReview(h);

    // A timer: the reply arms the 3-minute debounce of fix-human (ORC-190), in the database.
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'L' });
    expect((await h.store.dueTimers(Number.MAX_SAFE_INTEGER)).map((t) => t.key)).toEqual(['REL-1:fix-human']);

    // An effect claimed, half done, never settled: REL-2's start moves the issue in Linear, then its
    // process hangs there, before the run is launched.
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    const moveTo = h.tracker.moveTo.bind(h.tracker);
    let hung = false;
    let hang!: () => void;
    const hanging = new Promise<void>((r) => (hang = r));
    h.tracker.moveTo = async (id: string, state: string) => {
      await moveTo(id, state);
      if (id === 'REL-2' && !hung) {
        hung = true;
        hang();
        await new Promise<never>(() => {});
      }
    };
    await h.orch.accept({ id: 'd2', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-2', payload: { linearSessionId: 'ls-2' } });
    await hanging;
    const claimed = (await h.store.listEffects('p', 'REL-2')).find((r) => r.status === 'running')!;
    expect(claimed).toMatchObject({ effect: { kind: 'start_run' }, attempts: 1 });

    // An event in the inbox, not decided: REL-2's task is held by its effect.
    await h.orch.accept({ id: 'p2', type: 'session.prompted', at: h.clock.now(), projectId: 'p', ticketId: 'REL-2', payload: { linearSessionId: 'ls-2', body: 'et le PDF ?', author: 'L' } });
    expect((await h.store.pendingInbox(10)).map((e) => e.id)).toContain('p2');

    // The debounce is due, not fired yet.
    h.clock.advance(DEBOUNCE_MS);
    const runs = h.runner.requests.length;

    await h.restart({ mode: 'brutal' });
    // The new process found everything in the database: the timer still due, the event still in the
    // inbox, the effect still claimed by the dead process, whose lease runs until it expires.
    expect((await h.store.dueTimers(h.clock.now())).map((t) => t.key)).toEqual(['REL-1:fix-human']);
    expect((await h.store.pendingInbox(10)).map((e) => e.id)).toContain('p2');
    expect((await h.store.listEffects('p', 'REL-2')).find((r) => r.id === claimed.id)).toMatchObject({ status: 'running', attempts: 1 });

    // The timer fires through the inbox: the fix-human job runs once.
    await h.advance(0);
    expect(await h.store.dueTimers(h.clock.now())).toEqual([]);
    expect(h.runner.requests.slice(runs).map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:feedback']);
    expect((await h.store.listEffects('p', 'REL-2')).find((r) => r.id === claimed.id)).toMatchObject({ status: 'running', attempts: 1 });

    // Past the lease, the new process takes the effect up again, then decides the event behind it.
    await h.advance(LEASE_MS);
    const rel2 = await h.store.listEffects('p', 'REL-2');
    expect(rel2.find((r) => r.id === claimed.id)).toMatchObject({ status: 'done', attempts: 2 });
    expect(rel2.filter((r) => r.status !== 'done')).toEqual([]);
    expect(await h.store.pendingInbox(10)).toEqual([]);

    // Nothing written was lost, nothing was decided twice.
    const journal = [...(await h.store.recentEvents(500, 'REL-1')), ...(await h.store.recentEvents(500, 'REL-2'))];
    const ids = journal.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['d2', 'p2', `effect:${claimed.id}`]));
    expect(journal.filter((e) => e.type === 'timer.fired')).toHaveLength(1);
    expect(await h.ticket('REL-2')).toMatchObject({ delegated: true, humanInbox: [expect.objectContaining({ body: 'et le PDF ?' })] });

    // No visible duplicate: the start taken up again moved the issue to the state it was already in
    // (the move is idempotent), and launched its run once; the timer started its run once.
    const { dev, human_review } = h.project.workflow.states;
    expect(h.tracker.calls.filter((c) => c.method === 'moveTo' && c.args[0] === 'REL-2').map((c) => c.args[1])).toEqual([dev, dev, human_review]);
    expect(h.runner.requests.filter((r) => r.cwd.endsWith('REL-2'))).toHaveLength(1);
    expect(h.runner.requests.filter((r) => r.prompt.startsWith('/factory:feedback\n'))).toHaveLength(1);
    const written = h.tracker.calls.filter((c) => c.method === 'activity' || c.method === 'comment').map((c) => JSON.stringify(c.args));
    expect(new Set(written).size).toBe(written.length);
  });
  // A restart during a check, which blocked the ticket here until ORC-220: test/scenarios/recovery.test.ts.
});

describe('mortal', () => {
  it('once killed, neither reaches the store nor answers', async () => {
    let calls = 0;
    const { store, kill } = mortal({ getMeta: async () => (++calls, 'v') } as unknown as Store);
    expect(await store.getMeta('k')).toBe('v');
    kill();
    const late = await Promise.race([store.getMeta('k').then(() => 'answered'), new Promise((r) => setTimeout(() => r('silent'), 20))]);
    expect(late).toBe('silent');
    expect(calls).toBe(1);
  });
});
