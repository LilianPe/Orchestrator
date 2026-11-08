import { describe, expect, it, vi } from 'vitest';
import { TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import type { Store } from '../../src/store/types.js';
import { createHarness, heldRun, trackHarnesses } from '../helpers/harness.js';

/**
 * ORC-339: a pending job through every store call of its start. `settle` starts the job the ticket holds pending,
 * at once (a free slot) or through the queue (the factory paused: the queue launches it on resume). At the n-th
 * store call between the claim of that settle and the runner's start, the call:
 *
 * - `throw`: throws once, a passing database error (the effect, or the drain, tries again);
 * - `hang`: never answers, the daemon dies there (the next one takes the effect up once its lease expires);
 * - `outage`: starts an outage of the store's reads, which lasts until the settle's retries are spent.
 *
 * Whichever call it hits, the job is launched once, or the ticket is blocked and says why: never a delegated ticket
 * with no run, no pending job and no word, nor a job run twice.
 */
type Fault = 'throw' | 'hang' | 'outage';

class InjectedFault extends Error {}

/** The ticket's state, its runs and the queue, which an outage refuses; the outbox's own bookkeeping still answers, so that the settle's death is recorded. */
const OUTAGE = new Set(['getTicket', 'updateTicket', 'putTicket', 'listQueue', 'queuedItems', 'enqueue', 'getMeta', 'setMeta', 'getRun', 'putRun', 'renewRun', 'runsByStatus']);

interface Window {
  /** Store calls made in the window so far. */
  calls: number;
  /** The call to hit (0: none). */
  at: number;
  fault?: Fault;
  hit: boolean;
  open: boolean;
  /** Closed by the runner's start. */
  closed: boolean;
  /** An outage under way, until the settle effect dies. */
  outage: boolean;
  /** The call that wrote the launch's `run.started`: the ticket holds a run from there on. */
  startAt?: number;
  /** The store under the faults: what the test reads counts for nothing. */
  raw?: Store;
  trace: string[];
}

function launchWindow(w: Window) {
  return (store: Store): Store => {
    w.raw ??= store;
    return new Proxy(store, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        const f = (value as (...a: unknown[]) => unknown).bind(t);
        return async (...args: unknown[]) => {
          const method = String(prop);
          if (w.open && !w.hit) w.trace.push(method);
          if (w.open && !w.hit && ++w.calls === w.at) {
            w.hit = true;
            if (w.fault === 'hang') return new Promise<never>(() => {});
            if (w.fault === 'outage') w.outage = true;
            else throw new InjectedFault(`connection reset at ${method}`);
          }
          if (w.outage && OUTAGE.has(method)) throw new InjectedFault(`database down at ${method}`);
          // The settle's last attempt failed: the outage ends, the effect's death is decided on a store that answers.
          if (method === 'failEffect') w.outage = false;
          const result = await f(...args);
          if (method === 'updateTicket' && w.open && w.startAt === undefined && (result as { activeRunId?: string } | undefined)?.activeRunId) w.startAt = w.calls;
          // The window opens with the claim of the settle effect that starts the job, after the call that made it:
          // not one that finds the ticket's work still in flight (its check), which leaves the job pending.
          if (method === 'claimEffect' && result && result !== 'busy' && (result as { effect: { kind: string } }).effect.kind === 'settle') {
            const ticket = await t.getTicket('p', 'REL-1');
            if (ticket?.pendingJob && !ticket.activeRunId && !ticket.verifyingRunId) w.open = true;
          }
          return result;
        };
      },
    });
  };
}

/** Only the injected fault may come out of the process: anything else fails the play. */
const injected = (err: unknown): void => {
  if (!(err instanceof InjectedFault)) throw err;
};

const shutdown = trackHarnesses();

/**
 * One step of the daemon's loop, each part on its own: in an outage the heartbeat throws, and the poll that follows it in
 * `advance` must still run. The tick drains the queue again, as an item put back in line after a fault waits for it.
 */
async function step(h: ReturnType<typeof createHarness>): Promise<void> {
  await h.advance(10).catch(injected);
  await h.orch.poll().catch(injected);
  await h.orch.drained().catch(injected);
  await h.orch.tick();
}

async function play(at: number, fault: Fault | undefined, queued: boolean): Promise<{ window: Window; h: ReturnType<typeof createHarness> }> {
  const window: Window = { calls: 0, at, fault, hit: false, open: false, closed: false, outage: false, trace: [] };
  const h = createHarness({ effectLeaseMs: 60_000, effectRetry: { attempts: 3, baseMs: 1, capMs: 1 }, processRetry: { attempts: 5, baseMs: 1 }, wrapStore: launchWindow(window) });
  let n = 0;
  const control = (type: 'control.pause' | 'control.resume') => h.orch.accept({ ...TRUSTED, id: `c-${++n}`, type, at: h.clock.now(), projectId: '*', payload: {} } as FactoryEvent).catch(injected);
  const first = await heldRun(h);
  await h.store.putTicket({ ...(await h.ticket()), pendingJob: { job: 'dev-feedback', resume: true } });
  if (queued) {
    await control('control.pause');
    await h.orch.drained();
  }
  const start = h.runner.start.bind(h.runner);
  // The window closes at the runner's start: from there on, the run is recover()'s.
  h.runner.start = (req) => {
    if (window.open) window.closed = true;
    window.open = false;
    return start(req);
  };
  h.runner.enqueue({ hold: true }, { hold: true }, { hold: true });
  h.runner.release(first);
  /** The settle put the job in the queue: the job is the queue's, the ticket no longer holds it. */
  const inQueue = async () => (await window.raw!.listQueue()).length > 0 && !(await window.raw!.getTicket('p', 'REL-1'))!.pendingJob;
  if (fault === 'hang') {
    // Driven as the clean play is, never awaited: the call that hangs holds it for good.
    void h.orch.drained().catch(injected);
    if (queued) {
      await vi.waitFor(async () => expect(window.hit || (await inQueue())).toBe(true), { timeout: 10_000 });
      if (!window.hit) {
        // Never awaited either: its own inbox write may be the call that hangs.
        void control('control.resume').then(() => h.orch.drained().catch(injected));
      }
    }
    // Or the runner started first: this play's start made fewer calls than the clean one, the fault fell past its window.
    await vi.waitFor(() => expect(window.hit || window.closed).toBe(true), { timeout: 10_000 });
    if (window.hit) {
      await h.restart({ mode: 'brutal' });
      if (queued) await control('control.resume');
      await h.advance(60_001);
    }
    await h.orch.drained();
  } else {
    await h.orch.drained().catch(injected);
    // Twice: an injected fault may have cut the first one's write or its processing.
    if (queued) for (let i = 0; i < 2; i++) await control('control.resume');
    for (let i = 0; i < 6; i++) {
      // An outage ends: with the settle's death, or after a while when a drain of the queue, which never dies, meets it.
      if (i === 3) window.outage = false;
      await step(h);
    }
    await h.orch.drained();
  }
  return { window, h };
}

/**
 * Launched once, or blocked with its reason: never lost, never twice. A ticket blocked on the pending job no settle
 * could start still holds it, for the reply that starts it; any other end leaves nothing pending.
 */
async function holds(h: ReturnType<typeof createHarness>, where: string): Promise<void> {
  const t = await h.ticket();
  const feedback = h.runner.requests.filter((r) => r.prompt.startsWith('/factory:feedback'));
  expect(await h.store.listQueue(), where).toEqual([]);
  if (t.blocked) {
    expect(t.blockReason, where).toMatch(/^(Launch error|Error: the pending dev-feedback could not be started)/);
    expect(t.pendingJob, where).toEqual(/could not be started/.test(t.blockReason!) ? { job: 'dev-feedback', resume: true } : undefined);
    expect(feedback, where).toHaveLength(0);
  } else {
    expect(t.pendingJob, where).toBeUndefined();
    expect(feedback, where).toHaveLength(1);
    expect(t.activeRunId, where).toBe(feedback[0]!.runId);
  }
}

describe('chaos: a pending job through its start (ORC-339)', () => {
  for (const queued of [false, true]) {
    it(`${queued ? 'through the queue' : 'at once'}: a throw, a kill or an outage at each store call of its start`, async () => {
      const { window: clean, h: unhurt } = await play(0, undefined, queued);
      const n = clean.calls;
      expect(n).toBeGreaterThan(5);
      // ponytail: an outage from the run.started write on leaves the ticket a run that never started until recover() at the
      // next start, as on every launch path (the launch error's own cleanup fails too): ORC-343's transient errors.
      const started = clean.startAt!;
      expect(started).toBeGreaterThan(1);
      await holds(unhurt, 'no fault');
      await shutdown();
      for (const fault of ['throw', 'hang', 'outage'] as const) {
        for (let at = 1; at <= (fault === 'outage' ? started - 1 : n); at++) {
          const { window, h } = await play(at, fault, queued);
          const where = `${fault} at store call ${at} of ${n} (run.started at ${started}), after ${window.trace.slice(-4).join(', ')}: ${JSON.stringify(h.logs.filter((l) => l.level !== 'info'))}`;
          // A kill can fall past the runner's start: that play's start made fewer calls than the clean one.
          if (fault !== 'hang') expect(window.hit, where).toBe(true);
          await holds(h, where);
          await shutdown();
        }
      }
    });
  }

  it('a settle whose retries are all spent by an outage: the ticket is blocked on the job, which no run took', async () => {
    const window: Window = { calls: 0, at: 1, fault: 'outage', hit: false, open: false, closed: false, outage: false, trace: [] };
    const h = createHarness({ effectRetry: { attempts: 3, baseMs: 1, capMs: 1 }, wrapStore: launchWindow(window) });
    const first = await heldRun(h);
    await h.store.putTicket({ ...(await h.ticket()), pendingJob: { job: 'dev-feedback', resume: true } });
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained().catch(injected);
    for (let i = 0; i < 6; i++) await step(h);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true, blockReason: expect.stringMatching(/^Error: the pending dev-feedback could not be started: database down at /) });
    // Kept for the reply that starts it.
    expect(t.pendingJob).toEqual({ job: 'dev-feedback', resume: true });
    expect(h.runner.requests).toHaveLength(1);
    await shutdown();
  });
});
