import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/adapters/forge/github-app.js';
import type { Exec } from '../../src/adapters/exec.js';
import { fetchOrigin } from '../../src/adapters/workspace/git-workspaces.js';
import { START_RETRY } from '../../src/core/orchestrator.js';
import { TRUSTED } from '../../src/core/types.js';
import { EFFECT_RETRY, effectBackoff } from '../../src/runtime/outbox.js';
import { backoff, type RetryPolicy } from '../../src/runtime/transient.js';
import { PROCESS_RETRY } from '../../src/runtime/worker.js';
import { RUN_BEAT_MS, type DecisionRequest, type Store } from '../../src/store/types.js';
import { createHarness, heldRun } from '../helpers/harness.js';

/**
 * ORC-343: a short outage of GitHub, Linear or the database blocks no ticket and loses no result. Each fault is what the
 * adapter really throws (`isTransient`, src/runtime/transient.ts), on the simulated clock: no real wait.
 */
type Harness = ReturnType<typeof createHarness>;
const OUTAGE_MS = 10 * 60_000;

/** A store whose every call throws as `pg` does with the database down, while `down.now` holds. A new object: the Postgres harness's store is a proxy. */
function droppable(down: { now: boolean }): (store: Store) => Store {
  return (store) =>
    new Proxy(store, {
      get(target, prop) {
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (!down.now) return (value as (...a: unknown[]) => unknown).apply(target, args);
          return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' }));
        };
      },
    });
}

/**
 * Advances the clock along `policy`'s backoff, one attempt after the other, until the outage that started at `from`
 * ended: the most attempts an outage of `OUTAGE_MS` can take (a coarser step would take fewer), then once more.
 */
async function sitOut(h: Harness, policy: RetryPolicy, from: number, back: () => void, each: () => Promise<void> = async () => {}): Promise<void> {
  for (let n = 1; h.clock.now() - from < OUTAGE_MS; n++) {
    // A millisecond past it: the SQLite store hands out a queue item only once its wait is over, strictly.
    await h.advance(backoff(policy, n) + 1);
    await each();
  }
  back();
  await h.advance(policy.capMs! + 1);
  await each();
}

/** What `fetchOrigin` throws with GitHub out of reach: the launch's fetch of the forge. */
async function forgeUnreachable(): Promise<Error> {
  const exec: Exec = async () => ({ code: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com" });
  return fetchOrigin(exec, '/repo').then(
    () => {
      throw new Error('fetchOrigin passed');
    },
    (err: Error) => err,
  );
}

describe('a short outage blocks no ticket and loses no result (ORC-343)', () => {
  it('criterion 1: GitHub down for 10 minutes, its effect passes once it is back, and no ticket is blocked', async () => {
    const h = createHarness({ effectRetry: EFFECT_RETRY });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.workspaces.heads.set('/tmp/factory-fake/p/REL-1', 'abc123');
    let down = true;
    const publish = h.publisher.publish.bind(h.publisher);
    let tries = 0;
    h.publisher.publish = async (req) => {
      tries++;
      if (down) throw new GitHubApiError(503, 'POST /repos/o/r/pulls: 503 Service Unavailable');
      return publish(req);
    };
    const from = h.clock.now();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(tries).toBe(1);
    // More attempts than ORC-129's 8, which died within about 2 minutes.
    await sitOut(h, EFFECT_RETRY, from, () => (down = false));
    expect(tries).toBeGreaterThan(EFFECT_RETRY.attempts);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', prNumber: 1, blocked: false });
    expect(h.forge.opened).toHaveLength(1);
  });

  it('a permanent refusal of GitHub still kills its effect in the short window, and blocks the ticket', async () => {
    const h = createHarness({ effectRetry: EFFECT_RETRY });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.workspaces.heads.set('/tmp/factory-fake/p/REL-1', 'abc123');
    h.publisher.publish = async () => {
      throw new GitHubApiError(403, 'POST /repos/o/r/pulls: 403 Resource not accessible by integration');
    };
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    for (let n = 1; n < EFFECT_RETRY.attempts; n++) await h.advance(effectBackoff(n));
    expect(await h.ticket()).toMatchObject({ blocked: true });
    expect(h.forge.opened).toEqual([]);
  });

  it('criterion 2: a decided start that meets GitHub down at its launch runs once GitHub is back', async () => {
    const h = createHarness({ effectRetry: EFFECT_RETRY });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const prepare = h.workspaces.prepare.bind(h.workspaces);
    let down = true;
    const failure = await forgeUnreachable();
    h.workspaces.prepare = async (req) => {
      if (down) throw failure;
      return prepare(req);
    };
    h.runner.enqueue({ hold: true });
    const from = h.clock.now();
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ blocked: false });
    await sitOut(h, EFFECT_RETRY, from, () => (down = false));
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ blocked: false, activeRunId: h.runner.requests[0]!.runId });
  });

  it('criterion 2: a queued start that meets GitHub down at its launch runs once GitHub is back', async () => {
    const h = createHarness({ projectYaml: 'version: 1\nlimits:\n  parallel_sessions: 1\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    h.runner.enqueue({ hold: true }, { hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-2']);
    const prepare = h.workspaces.prepare.bind(h.workspaces);
    let down = true;
    const failure = await forgeUnreachable();
    h.workspaces.prepare = async (req) => {
      if (down && req.ticketId === 'REL-2') throw failure;
      return prepare(req);
    };
    const from = h.clock.now();
    h.runner.release(h.runner.requests[0]!.runId);
    await h.orch.drained();
    expect(await h.ticket('REL-2')).toMatchObject({ blocked: false });
    // The queue's backoff runs on the store's clock, which `advance` moves: its `notBefore`, then the drain of the next tick.
    await sitOut(h, START_RETRY, from, () => (down = false), async () => {
      await h.orch.tick();
      await h.orch.drained();
    });
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.ticket('REL-2')).toMatchObject({ blocked: false, activeRunId: h.runner.requests[1]!.runId });
  });

  it('criterion 3: the database down for 30 s at the end of a run, its result is recorded once the database is back', async () => {
    const down = { now: false };
    const h = createHarness({ wrapStore: droppable(down) });
    const runId = await heldRun(h);
    // The pump's short retries are over once it says so (the harness's `inboxRetry`): kept, or lost.
    let gaveUp: () => void = () => {};
    const shortRetriesOver = new Promise<void>((resolve) => (gaveUp = resolve));
    const push = h.logs.push.bind(h.logs);
    h.logs.push = (...lines) => {
      if (lines.some((l) => /not written to the inbox after/.test(l.message))) gaveUp();
      return push(...lines);
    };
    down.now = true;
    h.runner.release(runId);
    await shortRetriesOver;
    // Two beats with the database still down, 30 s in all: the result waits.
    h.clock.advance(15_000);
    await expect(h.orch.supervise()).rejects.toThrow(/ECONNREFUSED/);
    h.clock.advance(15_000);
    await expect(h.orch.supervise()).rejects.toThrow(/ECONNREFUSED/);
    down.now = false;
    await h.advance(RUN_BEAT_MS);
    expect((await h.store.recentEvents(50, 'REL-1')).map((e) => e.id)).toContain(`attempt:${runId}:finished`);
    expect(await h.store.getRun(runId)).toMatchObject({ status: 'success' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: false });
    expect((await h.ticket()).activeRunId).not.toBe(runId);
  });

  it("criterion 3: the run's record committed but its answer lost, the retry still sends its result", async () => {
    let lost = 1;
    const h = createHarness({
      wrapStore: (inner) =>
        Object.assign(Object.create(inner) as Store, {
          putRun: async (run: Parameters<Store['putRun']>[0]) => {
            await inner.putRun(run);
            // The COMMIT went through, the connection broke before its answer.
            if (run.status !== 'running' && lost-- > 0) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
          },
        }),
    });
    const runId = await heldRun(h);
    h.runner.release(runId);
    await h.orch.drained();
    expect((await h.store.recentEvents(50, 'REL-1')).map((e) => e.id)).toContain(`attempt:${runId}:finished`);
    expect(await h.store.getRun(runId)).toMatchObject({ status: 'success' });
  });

  it('point 4: an event whose decision meets the database down for 10 minutes is decided once it is back, not dead-lettered', async () => {
    let down = false;
    const h = createHarness({
      wrapStore: (inner) =>
        Object.assign(Object.create(inner) as Store, {
          decide: async (req: DecisionRequest) => {
            // `pg`'s answer while Postgres shuts down or restarts: SQLSTATE 57P01.
            if (down && req.event.id === 'stop') throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' });
            return inner.decide(req);
          },
        }),
    });
    await heldRun(h);
    down = true;
    const from = h.clock.now();
    await h.orch.accept({ ...TRUSTED, id: 'stop', type: 'control.stop', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: {} });
    await h.orch.drained();
    // The worker's retries are due on its clock: `advance` polls them, past their time.
    await sitOut(h, PROCESS_RETRY, from, () => (down = false));
    expect(await h.store.deadLetters('REL-1')).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Stopped on request' });
  });
});
