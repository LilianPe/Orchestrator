import { describe, expect, it } from 'vitest';
import { RECONCILE_MS, reconcileTicket } from '../../src/core/engine.js';
import { createHarness } from '../helpers/harness.js';

/** ORC-185: the reconciliation runs on a timer in the store, every 5 minutes, not on a setInterval of the process. */
describe('reconciliation on a timer in the store (ORC-185)', () => {
  it('is planned in the store at the start, then every 5 minutes, each firing reconciling the project once', async () => {
    const passes: string[] = [];
    const h = createHarness({ reconcile: async (p) => void passes.push(p.id) });
    await h.orch.armReconciliation();
    const planned = async () => (await h.store.dueTimers(Number.MAX_SAFE_INTEGER)).filter((t) => t.kind === 'reconcile');
    expect((await planned()).map((t) => [t.key, t.ticketId])).toEqual([[`${reconcileTicket('p')}:reconcile`, reconcileTicket('p')]]);
    // The connection to Linear passes at once: the timer's first pass is in 5 minutes.
    await h.advance(RECONCILE_MS);
    expect(passes).toEqual(['p']);
    expect((await planned())[0]!.fireAt).toBe(h.clock.now() + RECONCILE_MS);
    await h.advance(RECONCILE_MS);
    expect(passes).toEqual(['p', 'p']);
  });

  it('keeps the 5-minute chain when a pass fails: the error is logged, the next timer stays armed', async () => {
    let calls = 0;
    const h = createHarness({
      reconcile: async () => {
        calls++;
        if (calls === 1) throw new Error('Linear down');
      },
    });
    await h.orch.armReconciliation();
    await h.advance(RECONCILE_MS);
    await h.advance(RECONCILE_MS);
    expect(calls).toBe(2);
  });

  it('arms nothing again when the timer is already planned (a restart)', async () => {
    const h = createHarness({ reconcile: async () => {} });
    await h.orch.armReconciliation();
    await h.advance(1000);
    const before = await h.store.dueTimers(Number.MAX_SAFE_INTEGER);
    await h.orch.armReconciliation();
    expect(await h.store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual(before);
  });
});
