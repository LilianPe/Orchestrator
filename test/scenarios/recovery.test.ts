import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import { CUT_BOUND_REASON } from '../../src/core/engine.js';
import { CUT_RELAUNCHES, CUT_WINDOW_MS, RUN_BEAT_MS, RUN_LEASE_MS } from '../../src/store/types.js';
import { checkChain, Faults, settled } from '../helpers/faults.js';
import { createHarness, heldRun } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';

type H = ReturnType<typeof createHarness>;

const claudeDir = (h: H) => join(h.sessionsDir!, 'p', 'REL-1');

/**
 * The n-th check is running and nothing else is under way. A kill before that leaves an effect of the ticket to its
 * lease (60 s), and `verify.lost` waits behind it, which a slower database shows: these scenarios are about the check.
 */
async function checking(h: H, n: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(h.checks.calls).toHaveLength(n);
    expect(await settled(h.store, 'p', ['REL-1'])).toBe(true);
  }, { timeout: 10_000 });
}

/** The container of the attempt is gone, and its process with no way to say it: no more beats. */
async function lose(h: H, runId: string): Promise<void> {
  await h.sandboxes.destroy((await h.sandboxes.findByAttempt(runId))!.id);
}

/** Claude Code's file of the ticket's session: `--resume` finds it. */
function saved(h: H): void {
  const dir = join(claudeDir(h), 'projects', '-work');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${h.runner.requests[0]!.claudeSessionId}.jsonl`), '{}\n');
}

/** ORC-220, criterion 2: `factoryd` killed, then restarted; the ticket goes on without anybody. */
describe('a restart during a run', () => {
  it('kill -9 with the attempt still alive: the supervisor reattaches to it and takes its real result', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    await h.restart({ mode: 'brutal' });
    // Nothing launched again, nothing closed: the same attempt, still active, in a free-standing process.
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.getRun(runId))!.status).toBe('running');
    expect(await h.ticket()).toMatchObject({ activeRunId: runId, blocked: false });
    h.runner.release(runId);
    await h.orch.drained();
    expect((await h.store.getRun(runId))!.status).toBe('success');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(h.runner.requests).toHaveLength(1);
  });

  it('kill -9 with the attempt alive in a sandbox: the same sandbox stays, and goes once the attempt ends', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    await h.restart({ mode: 'brutal' });
    expect(h.sandboxes.destroyed).toEqual([]);
    expect(h.sandboxes.active()).toHaveLength(1);
    h.runner.release(runId);
    await h.orch.drained();
    expect(h.sandboxes.destroyed).toEqual(['sbx-1']);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it('the attached attempt holds its slot, and a stop reaches it', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    await h.restart({ mode: 'brutal' });
    await h.orch.accept({ ...TRUSTED, id: 'stop', type: 'control.stop', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: {} });
    await h.orch.drained();
    expect((await h.store.getRun(runId))!.status).toBe('stopped');
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Stopped on request' });
    expect((await h.ticket()).activeRunId).toBeUndefined();
    expect(h.runner.requests).toHaveLength(1);
  });

  it('kill -9 with the attempt gone: the step is launched again on the ticket session, without a human', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    const [first] = h.runner.requests;
    h.runner.forget(runId);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
    await h.restart({ mode: 'brutal' });
    expect((await h.store.getRun(runId))!.status).toBe('failure');
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]).toMatchObject({ resume: true, claudeSessionId: first!.claudeSessionId });
    expect(h.runner.requests[1]!.prompt).toContain('## Resumed after a cut');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect((await h.tracker.getIssue('REL-1')).labels).not.toContain('Bloqué');
  });

  it('an attempt its ticket no longer holds is not taken up, even alive: it is closed, its sandbox destroyed', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    await h.store.putTicket({ ...(await h.ticket()), activeRunId: undefined, activeJob: undefined });
    await h.restart({ mode: 'brutal' });
    expect((await h.store.getRun(runId))!.status).toBe('failure');
    expect(h.sandboxes.destroyed).toEqual(['sbx-1']);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('an attempt that ends as it is reattached keeps its real result, whatever recover() read before', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    const attach = h.runner.attach.bind(h.runner);
    h.runner.attach = (req) => {
      const handle = attach(req);
      h.runner.release(runId);
      return handle;
    };
    await h.restart({ mode: 'brutal' });
    expect((await h.store.getRun(runId))!.status).toBe('success');
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it('a start out of the queue without an effect, cut once launched, is not handed out to run again', async () => {
    const faults = new Faults({ point: 'run.written', mode: 'kill', nth: 2 });
    const h = createHarness({ faults, effectLeaseMs: 60_000 });
    const first = await heldRun(h);
    const control = (id: string, type: 'control.pause' | 'control.resume') => h.orch.accept({ ...TRUSTED, id, type, at: h.clock.now(), projectId: '*', payload: {} } as FactoryEvent);
    await h.store.putTicket({ ...(await h.ticket()), pendingJob: { job: 'dev-feedback', resume: true } });
    await control('g1', 'control.pause');
    await h.orch.drained();
    // Its end settles the ticket, whose pending job goes to the queue: paused, and started by no effect.
    h.runner.release(first);
    await h.orch.drained();
    expect((await h.store.listQueue()).map((q) => q.job)).toEqual(['dev-feedback']);
    await control('g2', 'control.resume');
    await faults.killed;
    await h.restart({ mode: 'brutal' });
    await h.advance(60_001);
    await h.orch.tick();
    await h.orch.drained();
    // The first attempt, then the relaunch of the one cut before the runner: never the queue item again.
    expect(h.runner.requests.map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:dev', '/factory:feedback']);
    expect(await h.store.listQueue()).toEqual([]);
  });

  it('a clean shutdown: the step starts again from the ticket session (`interrupted`, never a block)', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
    await h.restart();
    expect((await h.store.getRun(runId))!.status).toBe('stopped');
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]).toMatchObject({ resume: true, claudeSessionId: h.runner.requests[0]!.claudeSessionId });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it('what the attempt read is read again: the feedback it consumed is not lost, its taint stays', async () => {
    const h = createHarness({ effectLeaseMs: 60_000 });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.runner.enqueue({ hold: true });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'boutons mal alignés', author: 'L' }, 'REL-1', { taint: 'untrusted' });
    await h.advance(180_000);
    const cut = (await h.ticket()).activeRunId!;
    expect((await h.store.getRun(cut))!.sensitivePaths).toBeDefined();
    h.runner.forget(cut);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Corrigé.' }] });
    await h.restart({ mode: 'brutal' });
    const again = h.runner.requests[2]!;
    expect(again.prompt).toContain('boutons mal alignés');
    expect(again.sensitivePaths).toBeDefined();
    expect((await h.ticket()).humanInbox).toEqual([]);
  });

  it('a first run whose session was never written starts it under the same id: --resume would fail on it (ORC-128, call 9)', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    h.runner.forget(runId);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
    await h.restart({ mode: 'brutal' });
    expect(h.runner.requests[1]).toMatchObject({ resume: false, claudeSessionId: h.runner.requests[0]!.claudeSessionId });
    expect(h.runner.requests[1]!.prompt).not.toContain('## Resumed after a cut');
  });

  it('a session already written is resumed: --session-id would fail on it (ORC-128, call 10)', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    const session = h.runner.requests[0]!.claudeSessionId;
    saved(h);
    h.runner.forget(runId);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
    await h.restart({ mode: 'brutal' });
    expect(h.runner.requests[1]).toMatchObject({ resume: true, claudeSessionId: session });
    // The dead attempt's sandbox went first, the relaunch had its own.
    expect(h.sandboxes.destroyed).toEqual(['sbx-1', 'sbx-2']);
  });

  it('a review cut starts afresh: it never had the ticket session', async () => {
    const h = createHarness({ sandboxed: true });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.runner.enqueue({ hold: true });
    await h.send('status.changed', { from: 'human_review', to: 'ai_review' });
    const review = (await h.ticket()).activeRunId!;
    h.runner.forget(review);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Rien à redire.' }] });
    await h.restart({ mode: 'brutal' });
    const [dev, , again] = h.runner.requests;
    expect(again!.prompt.startsWith('/factory:review\n')).toBe(true);
    expect(again).toMatchObject({ resume: false });
    expect(again!.claudeSessionId).not.toBe(dev!.claudeSessionId);
    expect((await h.ticket()).claudeSessionId).toBe(dev!.claudeSessionId);
  });

  it('a question whose attempt is alive is answered: « reposez » is only for one that is gone', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true, events: [{ kind: 'text', text: 'Dans src/.' }] });
    await h.send('session.mentioned', { linearSessionId: 'ls-9', body: 'où ?', author: 'L' });
    const runId = h.runner.requests[0]!.runId;
    await h.restart({ mode: 'brutal' });
    expect(JSON.stringify(h.tracker.activities('ls-9'))).not.toContain('Ask the question again');
    h.runner.release(runId);
    await h.orch.drained();
    expect(h.tracker.activities('ls-9').at(-1)).toMatchObject({ type: 'response' });
    expect(h.runner.requests).toHaveLength(1);
  });

  it('a ticket a human stopped while its run was cut is not started again', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    h.runner.forget(runId);
    await h.orch.accept({ ...TRUSTED, id: 'stop', type: 'control.stop', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: {} });
    await h.orch.drained();
    await h.restart({ mode: 'brutal' });
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Stopped on request' });
    expect((await h.ticket()).activeRunId).toBeUndefined();
  });

  it('a result the dead process recorded but never sent is delivered as it was, not run again', async () => {
    const faults = new Faults({ point: 'run.result', mode: 'kill' });
    const h = createHarness({ faults, effectLeaseMs: 60_000 });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'PR ouverte.' }] });
    await h.orch.accept({ ...TRUSTED, id: 'd1', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });
    await faults.killed;
    await h.restart({ mode: 'brutal' });
    await h.advance(60_001);
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: 'PR ouverte.' });
  });
});

/** A crash loop must not launch an agent at each restart, without limit and out of the budget's reach. */
describe('the bound of the relaunches after a cut', () => {
  /** The active attempt dies with the daemon, the next one held: one more cut. */
  async function cut(h: H, ms = 60_000): Promise<void> {
    h.runner.forget((await h.ticket()).activeRunId!);
    h.runner.enqueue({ hold: true });
    h.clock.advance(ms);
    await h.restart({ mode: 'brutal' });
  }

  it('a crash loop: N cuts in the window give N relaunches, the next one blocks, with its reason and no agent', async () => {
    const faults = new Faults();
    const h = createHarness({ faults });
    await heldRun(h);
    for (let i = 1; i <= CUT_RELAUNCHES; i++) {
      await cut(h);
      expect(h.runner.requests).toHaveLength(1 + i);
      expect((await h.ticket()).blocked).toBe(false);
    }
    await cut(h);
    expect(h.runner.requests).toHaveLength(1 + CUT_RELAUNCHES);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: true });
    expect(t.blockReason).toMatch(CUT_BOUND_REASON);
    expect(t.activeRunId).toBeUndefined();
    expect(h.tracker.comments('REL-1').at(-1)).toContain('Reason: Too many relaunches after a cut: ');
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
    // A normal outcome for the checker of the chaos, strict as it is: nothing lost, nothing doubled, replayed bit for bit.
    expect(await checkChain(h.store, { projectId: 'p', tickets: ['REL-1'], acked: [], calls: faults.calls })).toEqual({ violations: [], atLeastOnce: [] });
  });

  it('a cut after the window is started again', async () => {
    const h = createHarness();
    await heldRun(h);
    for (let i = 0; i < CUT_RELAUNCHES; i++) await cut(h);
    await cut(h, CUT_WINDOW_MS);
    expect(h.runner.requests).toHaveLength(2 + CUT_RELAUNCHES);
    expect((await h.ticket()).blocked).toBe(false);
    expect((await h.ticket()).cutRelaunches).toHaveLength(1);
  });

  it('a daemon restarted again and again beside a living attempt relaunches nothing and counts nothing', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    for (let i = 0; i <= CUT_RELAUNCHES + 1; i++) await h.restart({ mode: 'brutal' });
    expect(h.runner.requests).toHaveLength(1);
    const t = await h.ticket();
    expect(t).toMatchObject({ activeRunId: runId, blocked: false });
    expect(t.cutRelaunches).toBeUndefined();
  });

  it('an attempt that ends between two cuts gives nothing back: a loop that finishes a step now and then still stops', async () => {
    const h = createHarness();
    await heldRun(h);
    await cut(h);
    const relaunched = (await h.ticket()).activeRunId!;
    h.runner.release(relaunched);
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', cutRelaunches: [expect.any(Number)] });
  });

  it('only a human relaunch gives the bound back', async () => {
    const h = createHarness();
    await heldRun(h);
    for (let i = 0; i <= CUT_RELAUNCHES; i++) await cut(h);
    expect((await h.ticket()).blocked).toBe(true);
    h.runner.enqueue({ hold: true });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    await h.advance(180_000);
    expect(await h.ticket()).toMatchObject({ blocked: false, cutRelaunches: [] });
    const runs = h.runner.requests.length;
    await cut(h);
    expect(h.runner.requests).toHaveLength(runs + 1);
  });

  it('a check cut again and again: the same bound, and the ticket no longer waits for a verdict', async () => {
    const h = createHarness({ preset: testPreset() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.checks.holdNext();
    void h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await checking(h, 1);
    for (let i = 1; i <= CUT_RELAUNCHES; i++) {
      h.checks.holdNext();
      h.clock.advance(1_000);
      void h.restart({ mode: 'brutal' });
      await checking(h, 1 + i);
    }
    h.clock.advance(1_000);
    await h.restart({ mode: 'brutal' });
    expect(h.checks.calls).toHaveLength(1 + CUT_RELAUNCHES);
    const t = await h.ticket();
    expect(t.blockReason).toMatch(CUT_BOUND_REASON);
    expect(t.verifyingRunId).toBeUndefined();
  });
});

/** ORC-220, criterion 1: a heartbeat per attempt, a lease in the store. */
describe('the lease of an attempt', () => {
  it('stays renewed while the attempt lives, whatever the time it takes', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    const before = (await h.store.getRun(runId))!.leaseUntil!;
    for (let i = 0; i < 10; i++) await h.advance(RUN_BEAT_MS);
    expect((await h.store.getRun(runId))!.leaseUntil).toBeGreaterThan(before);
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ activeRunId: runId, blocked: false });
  });

  it('expires once: one relaunch on the ticket session; a second time: blocked', async () => {
    const h = createHarness({ sandboxed: true });
    const first = await heldRun(h);
    saved(h);
    h.runner.enqueue({ hold: true });
    await lose(h, first);
    for (let i = 0; i < 3; i++) await h.advance(RUN_BEAT_MS);
    // The lease still runs: a beat missed is not an expiry.
    expect(h.runner.requests).toHaveLength(1);
    await h.advance(1);
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]).toMatchObject({ resume: true, claudeSessionId: h.runner.requests[0]!.claudeSessionId });
    const second = (await h.ticket()).activeRunId!;
    expect(second).not.toBe(first);
    expect(await h.ticket()).toMatchObject({ blocked: false, leaseRelaunches: 1 });

    await lose(h, second);
    await h.advance(RUN_LEASE_MS + 1);
    expect(h.runner.requests).toHaveLength(2);
    const t = await h.ticket();
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
    expect(t.blockReason).toContain('lease');
    expect(h.tracker.comments('REL-1').at(-1)).toContain('🔴 Blocked');
    expect((await h.tracker.getIssue('REL-1')).labels).toContain('Bloqué');
  });

  it('a relaunched attempt that ends gives the bound back', async () => {
    const h = createHarness({ sandboxed: true });
    const first = await heldRun(h);
    h.runner.enqueue({ hold: true });
    await lose(h, first);
    await h.advance(RUN_LEASE_MS + 1);
    const second = (await h.ticket()).activeRunId!;
    h.runner.release(second);
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, leaseRelaunches: 0 });
  });

  it('the attempt it ends may end before its loss is written: the step does start again', async () => {
    const h = createHarness({ sandboxed: true });
    const first = await heldRun(h);
    h.runner.enqueue({ hold: true });
    await lose(h, first);
    // Its process ends at once, and the store is slow to write the loss: its own end must say nothing.
    const accept = h.orch.accept.bind(h.orch);
    h.orch.accept = async (e) => {
      if (e.type === 'run.lost') await new Promise((r) => setTimeout(r, 30));
      return accept(e);
    };
    await h.advance(RUN_LEASE_MS + 1);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(2);
    expect((await h.ticket()).activeRunId).not.toBe(first);
    expect((await h.ticket()).blocked).toBe(false);
    expect((await h.store.getRun(first))!.status).toBe('failure');
  });

  it('an engine that does not answer relaunches nothing: the attempt may well be alive, as the next beat finds', async () => {
    const h = createHarness({ sandboxed: true });
    const first = await heldRun(h);
    const find = h.sandboxes.findByAttempt.bind(h.sandboxes);
    h.sandboxes.findByAttempt = async () => Promise.reject(new Error('engine down'));
    await h.advance(RUN_LEASE_MS + 1);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.ticket()).activeRunId).toBe(first);
    h.sandboxes.findByAttempt = find;
    await h.advance(1);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.getRun(first))!.leaseUntil).toBeGreaterThan(h.clock.now());
  });

  it('a slot follows the relaunch: the replaced attempt ends without freeing the one that took its place', async () => {
    const h = createHarness({ sandboxed: true });
    const first = await heldRun(h);
    h.runner.enqueue({ hold: true });
    await lose(h, first);
    await h.advance(RUN_LEASE_MS + 1);
    const second = (await h.ticket()).activeRunId!;
    await h.orch.drained();
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Autre' });
    const capacity = h.project.workflow.limits.parallelSessions;
    h.runner.enqueue(...Array.from({ length: capacity }, () => ({ hold: true })));
    for (let i = 2; i <= capacity + 1; i++) {
      h.tracker.addIssue({ identifier: `REL-${i}`, title: `T${i}` });
      await h.send('ticket.delegated', { linearSessionId: `ls-${i}` }, `REL-${i}`);
    }
    // The first attempt's end freed nothing: REL-1's slot is the relaunch's, so one ticket waits in line.
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual([`REL-${capacity + 1}`]);
    expect((await h.ticket()).activeRunId).toBe(second);
  });
});

/** ORC-220, criterion 3: fencing. */
describe('a replaced attempt', () => {
  it('its late result is ignored: the attempt that replaced it stays active', async () => {
    const h = createHarness({ sandboxed: true });
    const first = await heldRun(h);
    h.runner.enqueue({ hold: true });
    await lose(h, first);
    await h.advance(RUN_LEASE_MS + 1);
    const second = (await h.ticket()).activeRunId!;
    const late: FactoryEvent = { ...TRUSTED, id: `late:${first}`, type: 'run.finished', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { runId: first, job: 'dev', outcome: 'success', costUsd: 0, turns: 1, lastText: 'trop tard' } };
    await h.orch.accept(late);
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ activeRunId: second, logical: 'dev', blocked: false });
    expect(JSON.stringify(h.tracker.activities('ls-1'))).not.toContain('trop tard');
    expect(h.logs.map((l) => l.message).join('\n')).toContain('ignored stale run.finished');
  });

  it('a late « lost » of an attempt no longer active relaunches nothing', async () => {
    const h = createHarness();
    await heldRun(h);
    const lost: FactoryEvent = { ...TRUSTED, id: 'lost:old', type: 'run.lost', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { runId: 'old', job: 'dev', cause: 'lease' } };
    await h.orch.accept(lost);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
  });
});

/** ORC-220, criterion 5: one of the seven mandatory scenarios of docs/tests.md. */
describe('a restart during a check', () => {
  it('the check runs again in the new process, and the ticket goes on without a human', async () => {
    const h = createHarness({ preset: testPreset() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const release = h.checks.holdNext();
    void h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await checking(h, 1);
    const verifying = (await h.ticket()).verifyingRunId!;
    expect(verifying).toBeDefined();
    const runs = h.runner.requests.length;

    await h.restart({ mode: 'brutal' });
    // Run again on the same attempt: `check:<run>` is the id of its verdict, kept once by the inbox.
    expect(h.checks.calls).toHaveLength(2);
    expect(h.runner.requests).toHaveLength(runs);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();
    expect((await h.store.recentEvents(50, 'REL-1')).filter((e) => e.id === `check:${verifying}`)).toHaveLength(1);

    // The first check ends in the dead process: its result goes to a store that no longer answers.
    release();
    await h.advance(0);
    expect((await h.store.recentEvents(50, 'REL-1')).filter((e) => e.id === `check:${verifying}`)).toHaveLength(1);
    expect(h.checks.calls).toHaveLength(2);
  });

  it('a second kill during the check run again: it runs a third time, the ticket is not left waiting for a verdict', async () => {
    const h = createHarness({ preset: testPreset() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.checks.holdNext();
    void h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await checking(h, 1);
    h.checks.holdNext();
    void h.restart({ mode: 'brutal' });
    await checking(h, 2);
    h.clock.advance(1_000);
    await h.restart({ mode: 'brutal' });
    expect(h.checks.calls).toHaveLength(3);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect((await h.ticket()).verifyingRunId).toBeUndefined();
  });

  it('a verdict written before the kill is decided as it is: no second check', async () => {
    const h = createHarness({ preset: testPreset() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const hold = h.checks.holdNext();
    void h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await checking(h, 1);
    const t = await h.ticket();
    await h.store.appendInbox({ ...TRUSTED, id: `check:${t.verifyingRunId}`, type: 'verify.passed', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { runId: t.verifyingRunId!, job: t.activeJob ?? 'dev' } });
    await h.restart({ mode: 'brutal' });
    hold();
    expect(h.checks.calls).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });
});
