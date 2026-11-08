import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/store/types.js';
import { createHarness, heldRun } from '../helpers/harness.js';

/**
 * ORC-339: a pending job through every store call of its launch. `settle` starts the job the ticket
 * holds pending; at the n-th store call between the claim of its effect and the runner's start, the
 * call throws once (a passing database error: the effect is retried) or never answers (the daemon
 * dies there: the next one takes the effect up once its lease expires). Whichever call it hits, the
 * job is launched once, or the ticket is blocked and says why: never a delegated ticket with no run,
 * no pending job and no word.
 */
type Fault = 'throw' | 'hang';

interface Window {
  /** Store calls made in the launch window so far. */
  calls: number;
  /** The call to hit (0: none). */
  at: number;
  fault?: Fault;
  hit: boolean;
  open: boolean;
}

function launchWindow(w: Window) {
  return (store: Store): Store =>
    new Proxy(store, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        const f = (value as (...a: unknown[]) => unknown).bind(t);
        return async (...args: unknown[]) => {
          if (w.open && !w.hit && ++w.calls === w.at) {
            w.hit = true;
            if (w.fault === 'hang') return new Promise<never>(() => {});
            throw new Error(`connection reset at ${String(prop)}`);
          }
          const result = await f(...args);
          // The window opens with the claim of the settle effect that starts the job, after the call that made it:
          // not one that finds the ticket's work still in flight (its check), which leaves the job pending.
          if (prop === 'claimEffect' && result && result !== 'busy' && (result as { effect: { kind: string } }).effect.kind === 'settle') {
            const ticket = await t.getTicket('p', 'REL-1');
            if (ticket?.pendingJob && !ticket.activeRunId && !ticket.verifyingRunId) w.open = true;
          }
          return result;
        };
      },
    });
}

async function play(at: number, fault?: Fault): Promise<{ window: Window; h: ReturnType<typeof createHarness> }> {
  const window: Window = { calls: 0, at, fault, hit: false, open: false };
  const h = createHarness({ effectLeaseMs: 60_000, effectRetry: { attempts: 3, baseMs: 1, capMs: 1 }, wrapStore: launchWindow(window) });
  const first = await heldRun(h);
  await h.store.putTicket({ ...(await h.ticket()), pendingJob: { job: 'dev-feedback', resume: true } });
  const start = h.runner.start.bind(h.runner);
  // The window closes at the runner's start: from there on, the run is recover()'s.
  h.runner.start = (req) => ((window.open = false), start(req));
  h.runner.enqueue({ hold: true }, { hold: true });
  h.runner.release(first);
  if (fault === 'hang') {
    // Driven as the clean play is, never awaited: the call that hangs holds it for good.
    void h.orch.drained().catch(() => {});
    await vi.waitFor(() => expect(window.hit).toBe(true));
    await h.restart({ mode: 'brutal' });
    await h.advance(60_001);
  } else {
    // The throw can land on the worker's own read of the inbox, a call of the window as any other: the next poll goes on.
    await h.orch.drained().catch(() => {});
    await h.advance(10).catch(() => {});
    await h.advance(10);
  }
  return { window, h };
}

describe('chaos: a pending job through its launch (ORC-339)', () => {
  it('a throw or a kill at each store call of the launch: launched once, or blocked with its reason', async () => {
    const { window: clean, h: unhurt } = await play(0);
    const n = clean.calls;
    expect(n).toBeGreaterThan(5);
    expect(unhurt.runner.requests).toHaveLength(2);
    for (const fault of ['throw', 'hang'] as const) {
      for (let at = 1; at <= n; at++) {
        const { window, h } = await play(at, fault);
        const where = `${fault} at store call ${at} of ${n}: ${JSON.stringify(h.logs.filter((l) => l.level !== 'info'))}`;
        expect(window.hit, where).toBe(true);
        const t = await h.ticket();
        const feedback = h.runner.requests.filter((r) => r.prompt.startsWith('/factory:feedback'));
        expect(t.pendingJob, where).toBeUndefined();
        if (t.blocked) {
          expect(t.blockReason, where).toMatch(/Launch error/);
          expect(feedback, where).toHaveLength(0);
        } else {
          expect(feedback, where).toHaveLength(1);
          expect(t.activeRunId, where).toBe(feedback[0]!.runId);
        }
      }
    }
  });
});
