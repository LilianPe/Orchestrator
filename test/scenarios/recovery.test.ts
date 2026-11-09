import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import { CUT_RELAUNCHES, CUT_WINDOW_MS, RUN_BEAT_MS, RUN_LEASE_MS } from '../../src/store/types.js';
import type { Store } from '../../src/store/types.js';
import { checkChain, Faults, settled } from '../helpers/faults.js';
import { createHarness, heldRun } from '../helpers/harness.js';
import { testPreset } from '../helpers/test-preset.js';

/** The head of the reason of the cut bound (ORC-220): only its sentence, the block's kind is `limit`. */
const CUT_BOUND = /^Too many relaunches after a cut: /;

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

  it('reattaches with the limits the attempt was launched with, the ticket token budget included (ORC-340)', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    const launched = { ...h.runner.requests[0]!.limits, tokens: 1_234 };
    await h.store.putRun({ ...(await h.store.getRun(runId))!, limits: launched });
    const seen: unknown[] = [];
    const attach = h.runner.attach.bind(h.runner);
    h.runner.attach = (req) => (seen.push(req.limits), attach(req));
    await h.restart({ mode: 'brutal' });
    expect(seen).toEqual([launched]);
    h.runner.release(runId);
    await h.orch.drained();
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

  it('a clean shutdown leaves the attempt to finish: the next start reattaches to it, nothing runs twice (ORC-344)', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    await h.restart();
    // Neither stopped nor closed: the same attempt, its sandbox kept, followed by the new process.
    expect(h.sandboxes.destroyed).toEqual([]);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.getRun(runId))!.status).toBe('running');
    expect(await h.ticket()).toMatchObject({ activeRunId: runId, blocked: false });
    h.runner.release(runId);
    await h.orch.drained();
    expect((await h.store.getRun(runId))!.status).toBe('success');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(h.runner.requests).toHaveLength(1);
  });

  it('a clean shutdown whose attempt is gone by the next start: the step starts again from the ticket session, never a block', async () => {
    const h = createHarness();
    const runId = await heldRun(h);
    h.runner.forget(runId);
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
    await h.restart();
    expect((await h.store.getRun(runId))!.status).not.toBe('running');
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
    // The end of a build is its recap (ORC-195): the summary the dead process recorded, then the tests added and the work.
    expect(h.tracker.activities('ls-1').at(-1)).toEqual({ type: 'response', body: expect.stringMatching(/^PR ouverte\.\n\n\*\*Tests added\*\*\n_None stated\._\n\n\*\*Work\*\*: /) });
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
    expect(t.blockReason).toMatch(CUT_BOUND);
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
    expect(t.blockReason).toMatch(CUT_BOUND);
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

  it('an attempt that never returns and shows no progress: its lease runs out, its sandbox goes, and the step starts again (ORC-344)', async () => {
    const h = createHarness({ sandboxed: true });
    const first = await heldRun(h);
    const box = (await h.sandboxes.findByAttempt(first))!.id;
    saved(h);
    h.runner.enqueue({ hold: true });
    // Its container runs on, its agent writes nothing more: alive is not progress.
    const silent = h.project.workflow.limits.silentAfterMs!;
    for (let t = 0; t < silent; t += RUN_BEAT_MS) await h.advance(RUN_BEAT_MS);
    expect(h.runner.requests).toHaveLength(1);
    await h.advance(RUN_LEASE_MS + 1);
    expect(h.sandboxes.destroyed).toContain(box);
    expect((await h.store.getRun(first))!.status).toBe('failure');
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]).toMatchObject({ resume: true, claudeSessionId: h.runner.requests[0]!.claudeSessionId });
    expect(await h.ticket()).toMatchObject({ blocked: false, leaseRelaunches: 1 });
    expect((await h.ticket()).activeRunId).not.toBe(first);
  });

  it('an attempt that keeps writing keeps its lease, past the silence bound', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    const silent = h.project.workflow.limits.silentAfterMs!;
    for (let t = 0; t < silent + RUN_LEASE_MS * 2; t += RUN_BEAT_MS) {
      h.runner.say(runId, { kind: 'text', text: `step ${t}` });
      await h.advance(RUN_BEAT_MS);
    }
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ activeRunId: runId, blocked: false });
    expect((await h.store.getRun(runId))!.leaseUntil).toBeGreaterThan(h.clock.now());
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

/** ORC-344, criterion 3: the lease token, checked at each write of the attempt. */
describe('two daemons over one database', () => {
  it('the daemon an attempt was taken from renews it no more: the one that reattached it follows it alone', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    const first = h.orch;
    const second = h.another();
    await second.recover();
    const lease = (await h.store.getRun(runId))!.leaseUntil!;
    h.clock.advance(RUN_BEAT_MS);
    await first.supervise();
    expect((await h.store.getRun(runId))!.leaseUntil).toBe(lease);
    await second.supervise();
    expect((await h.store.getRun(runId))!.leaseUntil).toBe(h.clock.now() + RUN_LEASE_MS);
    h.runner.release(runId);
    await Promise.all([first.drained(), second.drained()]);
    expect((await h.store.getRun(runId))!.status).toBe('success');
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
  });

  it('the daemon whose lease ran out has its later writes refused: the attempt stays as the new holder closed it', async () => {
    const h = createHarness({ sandboxed: true });
    const runId = await heldRun(h);
    const first = h.orch;
    const second = h.another();
    h.runner.enqueue({ hold: true });
    // The first daemon is stuck: no beat. The second sees the lease run out and takes the attempt over.
    h.clock.advance(RUN_LEASE_MS + 1);
    await second.supervise();
    await second.drained();
    const closed = (await h.store.getRun(runId))!;
    expect(closed.status).toBe('failure');
    const relaunched = (await h.ticket()).activeRunId!;
    expect(relaunched).not.toBe(runId);
    // The first wakes up, and its attempt ends there: nothing of it is written any more.
    h.runner.release(runId);
    await first.drained();
    await first.supervise();
    expect(await h.store.getRun(runId)).toEqual(closed);
    expect(await h.ticket()).toMatchObject({ activeRunId: relaunched, blocked: false });
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

/** The ticket runs `dev`, with `dev-feedback` pending behind it: the run's end settles the ticket, whose settle starts the pending job. */
async function pendingBehind(h: H): Promise<string> {
  const first = await heldRun(h);
  await h.store.putTicket({ ...(await h.ticket()), pendingJob: { job: 'dev-feedback', resume: true } });
  return first;
}

const prompts = (h: H) => h.runner.requests.map((r) => r.prompt.split('\n')[0]);

/** ORC-339: a pending job leaves the ticket only with the run that starts it. */
describe('a pending job through its launch', () => {
  it('the daemon killed during the setup of its launch: the next start launches it', async () => {
    const h = createHarness({ effectLeaseMs: 60_000 });
    const first = await pendingBehind(h);
    const prepare = h.workspaces.prepare.bind(h.workspaces);
    let cut = false;
    // The launch never gets past its workspace: the process dies there.
    h.workspaces.prepare = (req) => (cut ? prepare(req) : ((cut = true), new Promise<never>(() => {})));
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    // The verdict of the first run's check comes first: seconds on a loaded Postgres.
    await vi.waitFor(() => expect(cut).toBe(true), { timeout: 10_000 });
    await h.restart({ mode: 'brutal' });
    await h.advance(60_001);
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, activeRunId: h.runner.requests[1]!.runId });
    expect(t.pendingJob).toBeUndefined();
  });

  it('a passing store error during its start: the retry of the effect launches it', async () => {
    let armed = false;
    let thrown = false;
    const h = createHarness({
      effectRetry: { attempts: 3, baseMs: 1, capMs: 1 },
      wrapStore: (store) =>
        new Proxy(store, {
          get(t, prop) {
            if (prop === 'claimEffect') {
              return async (...args: Parameters<Store['claimEffect']>) => {
                const row = await t.claimEffect(...args);
                if (row && row !== 'busy' && row.effect.kind === 'settle') armed = true;
                return row;
              };
            }
            // The pause, which the start reads once settle took the job off the ticket before ORC-339.
            if (prop === 'getMeta') {
              return async (key: string) => {
                if (armed && !thrown && key === 'paused') {
                  thrown = true;
                  throw new Error('connection reset');
                }
                return t.getMeta(key);
              };
            }
            const value: unknown = Reflect.get(t, prop, t);
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
          },
        }),
    });
    const first = await pendingBehind(h);
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained();
    await h.advance(10);
    expect(thrown).toBe(true);
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, activeRunId: h.runner.requests[1]!.runId });
    expect(t.pendingJob).toBeUndefined();
  });

  it('a launch that succeeds launches it once: never again at the end of its run', async () => {
    const h = createHarness();
    const first = await pendingBehind(h);
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained();
    const t = await h.ticket();
    expect(t.pendingJob).toBeUndefined();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    h.runner.release(t.activeRunId!);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
  });

  it('a launch cut right after the ticket took its run: the step starts again once, the pending job never again', async () => {
    // The second run's first write: after `run.started`, before the run is written.
    const faults = new Faults({ point: 'run.write', mode: 'kill', nth: 2 });
    const h = createHarness({ faults, effectLeaseMs: 60_000 });
    const first = await pendingBehind(h);
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await faults.killed;
    await h.restart({ mode: 'brutal' });
    await h.advance(60_001);
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    expect((await h.ticket()).pendingJob).toBeUndefined();
    h.runner.release((await h.ticket()).activeRunId!);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    expect((await h.ticket()).pendingJob).toBeUndefined();
  });
});

/**
 * A store whose calls `fault` may make throw (`throw`) or never answer (`hang`), from the claim of the settle that starts
 * the ticket's pending job on: the claim of a settle that finds the first run's check still in flight opens nothing.
 */
function settleWindow(fault: (method: string, args: unknown[]) => 'throw' | 'hang' | undefined) {
  const w = { open: false };
  const wrap = (store: Store): Store =>
    new Proxy(store, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        const f = (value as (...a: unknown[]) => unknown).bind(t);
        return async (...args: unknown[]) => {
          const hit = w.open ? fault(String(prop), args) : undefined;
          if (hit === 'hang') return new Promise<never>(() => {});
          if (hit === 'throw') throw new Error(`connection reset at ${String(prop)}`);
          const result = await f(...args);
          if (prop === 'claimEffect' && result && result !== 'busy' && (result as { effect: { kind: string } }).effect.kind === 'settle') {
            const ticket = await t.getTicket('p', 'REL-1');
            if (ticket?.pendingJob && !ticket.activeRunId && !ticket.verifyingRunId) w.open = true;
          }
          return result;
        };
      },
    });
  return { w, wrap };
}

const control = (h: H, id: string, type: 'control.pause' | 'control.resume') => h.orch.accept({ ...TRUSTED, id, type, at: h.clock.now(), projectId: '*', payload: {} } as FactoryEvent);

/** ORC-339, after review: the holes of a pending job kept through its launch. */
describe('a pending job: queue, death of its settle, messages and races', () => {
  it('queued by a settle cut before it cleared it: the queue launches it once, and its run takes it off the ticket', async () => {
    let queued = false;
    let hung = false;
    // The clear that follows the enqueue never answers: the daemon dies between the two.
    const { wrap } = settleWindow((method) => {
      if (method === 'enqueue') queued = true;
      else if (method === 'updateTicket' && queued && !hung) return (hung = true), 'hang';
      return undefined;
    });
    const h = createHarness({ effectLeaseMs: 60_000, wrapStore: wrap });
    const first = await pendingBehind(h);
    await control(h, 'g1', 'control.pause');
    await h.orch.drained();
    h.runner.enqueue({ hold: true }, { hold: true });
    h.runner.release(first);
    await vi.waitFor(() => expect(hung).toBe(true), { timeout: 10_000 });
    await h.restart({ mode: 'brutal' });
    // Resumed before the settle's lease expires: the queue launches the job while the ticket still holds it.
    await control(h, 'g2', 'control.resume');
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    expect((await h.ticket()).pendingJob).toBeUndefined();
    await h.advance(60_001);
    h.runner.release((await h.ticket()).activeRunId!);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    expect(await h.store.listQueue()).toEqual([]);
  });

  it('a settle whose retries are spent: the ticket is blocked on the pending job, which a reply starts as it was set', async () => {
    let outage = true;
    const { wrap } = settleWindow((method) => (outage && method === 'queuedItems' ? 'throw' : undefined));
    const h = createHarness({ effectRetry: { attempts: 3, baseMs: 1, capMs: 1 }, wrapStore: wrap });
    const first = await heldRun(h);
    // Restricted when it was set pending (an untrusted reply came in behind it, ORC-274).
    const pendingJob = { job: 'fix-ci', input: 'ci_failures' as const, inputText: 'lint: 3 errors in src/export.ts', sensitivePaths: ['.github/**'] };
    await h.store.putTicket({ ...(await h.ticket()), pendingJob });
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained();
    for (let i = 0; i < 3; i++) await h.advance(10);
    const blocked = await h.ticket();
    expect(blocked).toMatchObject({ blocked: true, blockReason: 'Error: the pending fix-ci could not be started: connection reset at queuedItems', pendingJob });
    expect(prompts(h)).toEqual(['/factory:dev']);
    outage = false;
    // A trusted reply: the restriction the run gets is the pending job's own.
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'try again', author: 'L', kind: 'instruction' }, 'REL-1', { taint: 'trusted' });
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false });
    expect(t.pendingJob).toBeUndefined();
    // That very job, its input and its restrictions: not the reply's own rule.
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:fix-ci']);
    expect(h.runner.requests[1]!.prompt).toContain('lint: 3 errors in src/export.ts');
    expect(h.runner.requests[1]!.sensitivePaths).toBeDefined();
  });

  it('a message that comes in during the launch stays in the inbox for the next run', async () => {
    const h = createHarness();
    const first = await pendingBehind(h);
    const item = { author: 'L', authorId: 'u1', body: 'one more thing', at: h.clock.now(), source: 'session' as const, kind: 'instruction' as const, taint: 'trusted' as const };
    const reset = h.workspaces.resetClaudeDir.bind(h.workspaces);
    // Written by another worker's decision after the launch read the inbox, before its run is written.
    h.workspaces.resetClaudeDir = async (path) => {
      if (h.runner.requests.length === 1) await h.store.updateTicket('p', 'REL-1', (t) => ({ ...t, humanInbox: [...t.humanInbox, item] }));
      return reset(path);
    };
    await h.store.putTicket({ ...(await h.ticket()), humanInbox: [{ ...item, body: 'read at the launch', at: item.at - 1 }] });
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained();
    expect(h.runner.requests[1]!.prompt).toContain('read at the launch');
    expect(h.runner.requests[1]!.prompt).not.toContain('one more thing');
    expect((await h.ticket()).humanInbox.map((i) => i.body)).toEqual(['one more thing']);
  });

  it('a launch that finds the ticket taken by another launch lets go: one run, never two', async () => {
    const h = createHarness();
    const first = await pendingBehind(h);
    const prepare = h.workspaces.prepare.bind(h.workspaces);
    // Another worker, which took up this settle after a lost lease, wrote its run first.
    h.workspaces.prepare = async (req) => {
      if (req.runId !== h.runner.requests[0]?.runId) await h.store.updateTicket('p', 'REL-1', (t) => ({ ...t, activeRunId: 'other', activeJob: 'dev-feedback', activeStart: { job: 'dev-feedback', resume: true }, pendingJob: undefined }));
      return prepare(req);
    };
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev']);
    const t = await h.ticket();
    expect(t).toMatchObject({ activeRunId: 'other', blocked: false });
    // The winner runs this very job: nothing left pending behind it, and its worktree stays.
    expect(t.pendingJob).toBeUndefined();
    expect(h.logs.some((l) => /took the ticket first/.test(l.message))).toBe(true);
  });

  it('a launch that loses to a run of another job, before its first write: no side effect, and the job waits behind that run', async () => {
    const h = createHarness();
    const first = await pendingBehind(h);
    const prepare = h.workspaces.prepare.bind(h.workspaces);
    let cleaned = 0;
    const cleanup = h.workspaces.cleanup.bind(h.workspaces);
    h.workspaces.cleanup = async (...args) => ((cleaned += 1), cleanup(...args));
    // Another worker launched `dev` on the ticket while this launch prepared its workspace.
    h.workspaces.prepare = async (req) => {
      const ws = await prepare(req);
      if (req.runId !== h.runner.requests[0]?.runId) await h.store.updateTicket('p', 'REL-1', (t) => ({ ...t, activeRunId: 'other', activeJob: 'dev', worktreePath: '/elsewhere' }));
      return ws;
    };
    h.runner.release(first);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev']);
    const t = await h.ticket();
    // No `workspace.prepared` over the winner's, and its worktree left in place.
    expect(t).toMatchObject({ activeRunId: 'other', worktreePath: '/elsewhere', pendingJob: { job: 'dev-feedback', resume: true } });
    expect(cleaned).toBe(0);
  });

  it('a launch whose run.started loses to a run of another job keeps the job pending behind it', async () => {
    const h = createHarness();
    const first = await pendingBehind(h);
    const reset = h.workspaces.resetClaudeDir.bind(h.workspaces);
    // Past every early look: the other worker's run.started lands just before this one's.
    h.workspaces.resetClaudeDir = async (path) => {
      if (h.runner.requests.length === 1) await h.store.updateTicket('p', 'REL-1', (t) => ({ ...t, activeRunId: 'other', activeJob: 'dev' }));
      return reset(path);
    };
    h.runner.release(first);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev']);
    expect(await h.ticket()).toMatchObject({ activeRunId: 'other', pendingJob: { job: 'dev-feedback', resume: true } });
  });

  it('a settle whose start finds the ticket taken meanwhile keeps the job pending, never clears it', async () => {
    let taken = false;
    const { w, wrap } = settleWindow(() => undefined);
    const h = createHarness({
      wrapStore: (store) => {
        const inner = wrap(store);
        return new Proxy(inner, {
          get(t, prop) {
            const value: unknown = Reflect.get(t, prop, t);
            if (prop !== 'queuedItems' || typeof value !== 'function') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
            // Between the settle's look and its start: another worker's run takes the ticket.
            return async (...args: unknown[]) => {
              if (w.open && !taken) {
                taken = true;
                await store.updateTicket('p', 'REL-1', (x) => ({ ...x, activeRunId: 'other', activeJob: 'dev' }));
              }
              return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
          },
        });
      },
    });
    const first = await pendingBehind(h);
    h.runner.release(first);
    await h.orch.drained();
    expect(taken).toBe(true);
    expect(prompts(h)).toEqual(['/factory:dev']);
    expect(await h.ticket()).toMatchObject({ activeRunId: 'other', pendingJob: { job: 'dev-feedback', resume: true } });
  });

  it('a queue item whose start fails on the store every time: back in line, then the ticket is blocked after 5 attempts', async () => {
    let failing = false;
    const { wrap } = settleWindow(() => undefined);
    const h = createHarness({
      wrapStore: (store) => {
        const inner = wrap(store);
        return new Proxy(inner, {
          get(t, prop) {
            const value: unknown = Reflect.get(t, prop, t);
            if (typeof value !== 'function') return value;
            return async (...args: unknown[]) => {
              if (failing && prop === 'getMeta' && String(args[0]).startsWith('setup-pending:')) throw new Error('database down');
              return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
          },
        });
      },
    });
    const first = await pendingBehind(h);
    await control(h, 'g1', 'control.pause');
    await h.orch.drained();
    h.runner.release(first);
    await h.orch.drained();
    expect((await h.store.listQueue()).map((q) => q.job)).toEqual(['dev-feedback']);
    failing = true;
    await control(h, 'g2', 'control.resume');
    await h.orch.drained();
    const tries = () => h.logs.filter((l) => /back in line/.test(l.message)).length;
    expect(tries()).toBe(1);
    // Not handed out again before its wait: ticks within it spend no attempt.
    for (let i = 0; i < 5; i++) {
      await h.orch.tick();
      await h.orch.drained();
    }
    expect(tries()).toBe(1);
    // 2 s, 4 s, 8 s, 16 s: each wait over, one more attempt.
    for (const wait of [2_000, 4_000, 8_000, 16_000]) {
      await h.advance(wait - 1);
      await h.orch.tick();
      await h.orch.drained();
      await h.advance(2);
      await h.orch.tick();
      await h.orch.drained();
    }
    expect(prompts(h)).toEqual(['/factory:dev']);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Launch error: database down' });
    expect(await h.store.listQueue()).toEqual([]);
    expect(tries()).toBe(4);
    expect(h.logs.filter((l) => /back in line/.test(l.message)).map((l) => /in (\d+) s$/.exec(l.message)?.[1])).toEqual(['2', '4', '8', '16']);
  });

  it('a launch that fails past another launch taking the ticket leaves that launch run as it is', async () => {
    const h = createHarness();
    const first = await pendingBehind(h);
    const reset = h.workspaces.resetClaudeDir.bind(h.workspaces);
    // Past the early looks, another worker's run takes the ticket, then this launch fails on its own.
    h.workspaces.resetClaudeDir = async (path) => {
      if (h.runner.requests.length === 1) {
        await h.store.putRun({ ...(await h.store.getRun(first))!, id: 'other', job: 'dev', status: 'running', endedAt: undefined });
        await h.store.updateTicket('p', 'REL-1', (t) => ({ ...t, activeRunId: 'other', activeJob: 'dev' }));
        throw new Error('disk full');
      }
      return reset(path);
    };
    h.runner.release(first);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev']);
    // Blocked on its own failure, but the other launch's run is still the ticket's, and still running.
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Launch error: disk full', activeRunId: 'other' });
    expect((await h.store.getRun('other'))!.status).toBe('running');
  });

  it('a queue item that loses to another job while the ticket holds another pending job stays in line, and that job stays', async () => {
    const h = createHarness();
    const first = await heldRun(h);
    h.runner.release(first);
    await h.orch.drained();
    const other = { job: 'fix-ci', input: 'ci_failures' as const, inputText: 'lint failed' };
    await h.store.putTicket({ ...(await h.ticket()), activeRunId: undefined, verifyingRunId: undefined, pendingJob: other });
    await h.store.enqueue({ projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', queue: 'dev', input: 'feedback', priority: 0, enqueuedAt: 1 });
    const reset = h.workspaces.resetClaudeDir.bind(h.workspaces);
    // Its run.started loses to another worker's run of another job.
    h.workspaces.resetClaudeDir = async (path) => {
      if (h.runner.requests.length === 1) await h.store.updateTicket('p', 'REL-1', (t) => ({ ...t, activeRunId: 'z', activeJob: 'dev', activeStart: { job: 'dev' } }));
      return reset(path);
    };
    await h.orch.tick();
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev']);
    expect(await h.ticket()).toMatchObject({ activeRunId: 'z', pendingJob: other });
    expect((await h.store.listQueue()).map((q) => q.job)).toEqual(['dev-feedback']);
    // Handed out again while the ticket is busy: still in line, the pending job never replaced.
    await h.orch.tick();
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ pendingJob: other });
    expect((await h.store.listQueue()).map((q) => q.job)).toEqual(['dev-feedback']);
  });

  it('a leftover queue item whose start is handled does not hold the pending job: settle starts it, once', async () => {
    const h = createHarness();
    const first = await pendingBehind(h);
    // Left in the queue by a start whose run was written, its removal lost.
    await h.store.enqueue({ projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', queue: 'dev', resume: true, priority: 0, enqueuedAt: 1, startMark: 'start:left' });
    await h.store.setMeta('start:left', first);
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    expect((await h.ticket()).pendingJob).toBeUndefined();
    await h.orch.tick();
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    expect(await h.store.listQueue()).toEqual([]);
  });

  it('a passing store error inside the launch, before its run.started: retried, never a launch error', async () => {
    let thrown = false;
    const { wrap } = settleWindow((method, args) => (!thrown && method === 'getMeta' && String(args[0]).startsWith('setup-pending:') ? ((thrown = true), 'throw') : undefined));
    const h = createHarness({ effectRetry: { attempts: 3, baseMs: 1, capMs: 1 }, wrapStore: wrap });
    const first = await pendingBehind(h);
    h.runner.enqueue({ hold: true });
    h.runner.release(first);
    await h.orch.drained();
    await h.advance(10);
    expect(thrown).toBe(true);
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
    const t = await h.ticket();
    expect(t).toMatchObject({ blocked: false, activeRunId: h.runner.requests[1]!.runId });
    expect(t.pendingJob).toBeUndefined();
  });
});

/** ORC-362: the follow-ups of ORC-360, at the orchestrator's level. */
const FAILED = JSON.stringify([{ command: 'npm test', exitCode: 1, output: '1 failed' }]);

/**
 * What settle leaves of the relaunch a verify.failed decided, once it could not launch it (paused, no free slot): an item of
 * the queue, off the ticket, in the loop its failure counted.
 */
async function queuedRelaunch(h: H): Promise<void> {
  const now = h.clock.now();
  await h.store.putTicket({ ...(await h.ticket()), verifyAttempts: 1 });
  await h.store.enqueue({ projectId: 'p', ticketId: 'REL-1', job: 'dev', queue: 'dev', input: 'verify_failures', inputText: FAILED, resume: true, priority: 0, enqueuedAt: now, startMark: `start:p:REL-1:dev:${now}:queued` });
}

describe('a relaunch past a green check, a settle stuck on a ticket blocked already', () => {
  it('a verify relaunch settle queued does not start once a green check came before its launch', async () => {
    const h = createHarness();
    const first = await heldRun(h);
    await control(h, 'g1', 'control.pause');
    await h.orch.drained();
    await queuedRelaunch(h);
    // The check of the ticket's run passes before the queue hands the relaunch out: the loop starts over, its failures gone.
    h.runner.release(first);
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ verifyAttempts: 0 });
    await control(h, 'g2', 'control.resume');
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev']);
    expect(await h.store.listQueue()).toEqual([]);
    expect(await h.ticket()).toMatchObject({ blocked: false });
  });

  it('a verify relaunch in the queue still starts while its loop is open', async () => {
    // The control of the previous one: the same item, no green check in between.
    const h = createHarness();
    const first = await heldRun(h);
    h.runner.release(first);
    await h.orch.drained();
    await control(h, 'g1', 'control.pause');
    await h.orch.drained();
    await queuedRelaunch(h);
    h.runner.enqueue({ hold: true });
    await control(h, 'g2', 'control.resume');
    await h.orch.drained();
    expect(prompts(h)).toEqual(['/factory:dev', '/factory:dev']);
    expect(h.runner.requests[1]!.prompt).toContain('1 failed');
  });

  for (const lift of ['a green CI', 'a reply'] as const) {
    it(`a settle stuck on a ticket blocked already: one block, and ${lift} that lifts it starts the pending job once`, async () => {
      let outage = true;
      const { wrap } = settleWindow((method) => (outage && method === 'queuedItems' ? 'throw' : undefined));
      const h = createHarness({ effectRetry: { attempts: 3, baseMs: 1, capMs: 1 }, wrapStore: wrap });
      const first = await heldRun(h);
      // A job kept pending behind the run, then the red-CI bound blocked the ticket: one the lift leaves to do. A green CI
      // leaves a reply's job; a reply, a relaunch on CI failures.
      const pendingJob = lift === 'a green CI' ? { job: 'dev-feedback', input: 'feedback' as const, resume: true } : { job: 'fix-ci', input: 'ci_failures' as const, inputText: 'lint: 3 errors in src/export.ts' };
      const reason = 'CI still failing after 2 attempts of fix-ci.';
      await h.store.putTicket({ ...(await h.ticket()), pendingJob, blocked: true, blockKind: 'ci_bound', blockReason: reason, blockedJob: 'fix-ci', prNumber: 7, prUrl: 'https://forge/pr/7' });
      const said = () => [...h.tracker.comments('REL-1'), ...h.tracker.activities().map((a) => ('body' in a ? String(a.body) : ''))].filter((b) => /could not be started/.test(b));
      h.runner.enqueue({ hold: true }, { hold: true });
      h.runner.release(first);
      await h.orch.drained();
      for (let i = 0; i < 3; i++) await h.advance(10);
      // The settle died: the block that was there stays the only one, and the job stays pending for its lift.
      expect(await h.ticket()).toMatchObject({ blocked: true, blockKind: 'ci_bound', blockReason: reason, pendingJob });
      expect(said()).toEqual([]);
      expect(prompts(h)).toEqual(['/factory:dev']);
      outage = false;
      if (lift === 'a green CI') {
        await h.send('pr.checks_passed', { number: 7, url: 'https://forge/pr/7', branch: 'factory/rel-1-export-csv' });
        expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
      } else {
        // The reply's own job first: the pending one waits behind its run.
        await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'try again', author: 'L', kind: 'instruction' }, 'REL-1', { taint: 'trusted' });
        expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback']);
        expect((await h.ticket()).pendingJob).toEqual(pendingJob);
        h.runner.release((await h.ticket()).activeRunId!);
        await h.orch.drained();
        expect(prompts(h)).toEqual(['/factory:dev', '/factory:feedback', '/factory:fix-ci']);
        expect(h.runner.requests.at(-1)!.prompt).toContain('lint: 3 errors in src/export.ts');
      }
      const t = await h.ticket();
      expect(t).toMatchObject({ blocked: false });
      expect(t.pendingJob).toBeUndefined();
      // Once: its end starts nothing more.
      const started = prompts(h);
      h.runner.release(t.activeRunId!);
      await h.orch.drained();
      await h.advance(10);
      expect(prompts(h)).toEqual(started);
    });
  }
});
