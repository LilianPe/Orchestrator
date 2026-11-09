import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeRunSettings } from '../config/run-settings.js';
import { saveAgentOutput } from './agent-output.js';
import { FakeForge } from '../adapters/forge/fake.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import type { Runner } from '../adapters/runner/types.js';
import type { Verifier } from './verify.js';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { stateEchoKey } from '../adapters/tracker/types.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import type { loadWorkflow } from '../config/load-workflow.js';
import { loadTestWorkflow } from '../../test/helpers/harness.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { hashText } from './attempt-labels.js';
import { EventBus } from './bus.js';
import { FakeClock } from './clock.js';
import { fullReadEnv, Orchestrator } from './orchestrator.js';
import { runRepair } from '../cli/repair.js';
import type { StoredEvent } from './upcast.js';
import type { EffectRetry } from '../runtime/outbox.js';
import { Scheduler } from './scheduler.js';
import { newTicketState, SCHEMA_VERSION, TRUSTED, type FactoryEvent } from './types.js';

const packDir = join(import.meta.dirname, '../../packs/standard');

function setup(
  o: {
    runner?: Runner;
    verify?: Verifier;
    hold?: boolean;
    settingsPath?: string;
    tweak?: (w: ReturnType<typeof loadWorkflow>) => void;
    effectRetry?: EffectRetry;
    workspaces?: FakeWorkspaces;
    processRetry?: { attempts: number; baseMs: number };
    perTicketTokens?: number;
    onUsageLimit?: 'wait';
    account?: () => string | undefined;
  } = {},
) {
  // `dev` straight to Human Review, as the harness has it: the AI review's own scenarios are test/scenarios/review.test.ts (ORC-183).
  const workflow = loadTestWorkflow();
  o.tweak?.(workflow);
  const store = new SqliteStore(':memory:');
  const tracker = new FakeTracker();
  const fakeRunner = new FakeRunner();
  fakeRunner.submit = (runId, output) => saveAgentOutput(store, runId, output);
  const runner = o.runner ?? fakeRunner;
  const scheduler = new Scheduler(store, { dev: 3, questions: 2 });
  let n = 0;
  const bus = new EventBus();
  const clock = new FakeClock(1_000);
  const orch = new Orchestrator({
    store, clock, bus, scheduler,
    tracker, forge: new FakeForge(), runner, workspaces: o.workspaces ?? new FakeWorkspaces(), verify: o.verify ?? (async () => ({ ok: true, failures: [] })), hostChecks: true,
    projects: [{ id: 'p', repoPath: '/repo', teamKey: 'REL', workflow }], packDir, settingsPath: o.settingsPath,
    agentEnv: (r) => ({ FACTORY_RUN_TOKEN: r.token }), newId: () => `id-${++n}`, activityIntervalMs: 0, holdInboxUntilReplay: o.hold, factoryCommit: 'cafe42',
    // One attempt: a failed effect dies at once (the retries have their own tests).
    effectRetry: o.effectRetry ?? { attempts: 1, baseMs: 1, capMs: 1 },
    processRetry: o.processRetry,
    ...(o.perTicketTokens ? { perTicketTokens: o.perTicketTokens } : {}),
    ...(o.onUsageLimit ? { onUsageLimit: o.onUsageLimit } : {}),
    ...(o.account ? { claudeAccount: o.account } : {}),
  });
  return { store, tracker, runner: fakeRunner, orch, scheduler, bus, clock };
}

const mentioned = (ticketId: string): FactoryEvent => ({
  ...TRUSTED, id: 'm1', type: 'session.mentioned', at: 1_000, projectId: 'p', ticketId, payload: { linearSessionId: 'q1', body: '?', author: 'L' },
});
const delegated = (id = 'e1'): FactoryEvent => ({ ...TRUSTED, id, type: 'ticket.delegated', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });

describe('Orchestrator', () => {
  it('starts no dev job on a merged ticket, even one it holds outside decide (ORC-268)', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'T', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'done', 1), delegated: true, prState: 'MERGED', pendingJob: { job: 'dev-feedback' } });
    // A result settles the ticket: settle would start the pending job.
    // Its settle is an outbox effect, run by the worker: startRun refuses the job all the same.
    await orch.accept({ ...TRUSTED, id: 'v1', type: 'verify.passed', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { runId: 'old', job: 'dev' } });
    await orch.drained();
    expect(runner.requests).toEqual([]);
    expect((await store.getTicket('p', 'REL-1'))!.pendingJob).toBeUndefined();
    expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(false);
  });

  it('with holdInboxUntilReplay, only writes the events accepted before replayInbox()', async () => {
    const { store, tracker, orch } = setup({ hold: true });
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    expect(await orch.accept(delegated())).toBe(true);
    await orch.drained();
    expect(await store.getTicket('p', 'REL-1')).toBeUndefined();
    expect((await store.pendingInbox(10)).map((e) => e.id)).toEqual(['e1']);
    await orch.replayInbox();
    await orch.drained();
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ delegated: true });
    expect(await store.pendingInbox(10)).toEqual([]);
  });

  it('marks its own move as an echo under the key the webhook and the reconciliation look up', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const moves = tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1] as string);
    expect(moves.length).toBeGreaterThan(0);
    for (const name of moves) expect(await store.isEcho(stateEchoKey('REL-1', name), 1_000)).toBe(true);
  });

  it('ignores a duplicate event id', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.accept(delegated());
    await orch.drained();
    expect(runner.requests).toHaveLength(1);
  });

  it('creates the ticket from the snapshot carried by the event, without reading the tracker', async () => {
    const { store, tracker, orch } = setup();
    const issue = { title: 'Export CSV', logical: 'todo' as const, priority: 3 };
    const payload = { name: 'fais-le', body: '', linearSessionId: 'q1', author: 'L', issue };
    await orch.accept({ id: 'c1', type: 'command', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload } as FactoryEvent);
    await orch.drained();
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ title: 'Export CSV', priority: 3, questionSessionIds: ['q1'] });
    expect(tracker.calls.filter((c) => c.method === 'getIssue')).toEqual([]);
  });

  it('reads the tracker once to fill a creating event without a snapshot, and journals the filled event', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', stateName: 'In Progress', priority: 2 });
    await orch.accept({ id: 'm1', type: 'session.mentioned', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'q1', body: '?', author: 'L' } } as FactoryEvent);
    await orch.drained();
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ title: 'Export CSV', logical: 'dev', priority: 2 });
    const journaled = (await store.recentEvents(10)).find((e) => e.id === 'm1')!;
    expect(journaled.payload).toMatchObject({ issue: { title: 'Export CSV', logical: 'dev', priority: 2 } });
  });

  it('drops, and journals, a creating event without a snapshot on an issue the tracker no longer finds (ORC-302)', async () => {
    const { store, tracker, runner, orch, bus } = setup({ processRetry: { attempts: 3, baseMs: 1 } });
    const logs: string[] = [];
    bus.subscribe((m) => void (m.kind === 'log' && logs.push(m.message)));
    const getIssue = vi.spyOn(tracker, 'getIssue');
    await orch.accept(mentioned('REL-9'));
    await orch.drained();
    expect(getIssue).toHaveBeenCalledTimes(1);
    // Retried, it would still be in the inbox: a failed row stays there until its last attempt.
    expect(await store.pendingInbox(10)).toEqual([]);
    expect((await store.recentEvents(10)).map((e) => e.id)).toContain('m1');
    expect(await store.getTicket('p', 'REL-9')).toBeUndefined();
    // Decided without the snapshot, the mention would plan a `start_run` on a ticket nothing tracks.
    expect(await store.listEffects('p', 'REL-9')).toEqual([]);
    expect(runner.requests).toEqual([]);
    expect(logs.some((l) => l.includes('REL-9') && l.includes('not found in the tracker, left without a snapshot'))).toBe(true);
  });

  it('still retries a creating event whose snapshot read fails for another reason (ORC-302)', async () => {
    const { store, tracker, orch } = setup({ processRetry: { attempts: 3, baseMs: 1 } });
    const getIssue = vi.spyOn(tracker, 'getIssue').mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    await orch.accept(mentioned('REL-1'));
    await orch.drained();
    await vi.waitFor(() => expect(getIssue).toHaveBeenCalledTimes(3), { interval: 1 });
    expect((await store.pendingInbox(10)).map((e) => e.id)).toEqual(['m1']);
  });

  it('ignores moves of tickets it does not manage', async () => {
    const { store, orch } = setup();
    await orch.accept({ ...TRUSTED, id: 'm', type: 'status.changed', at: 1, projectId: 'p', ticketId: 'REL-9', payload: { from: 'todo', to: 'dev' } });
    await orch.drained();
    expect(await store.getTicket('p', 'REL-9')).toBeUndefined();
  });

  it('passes the pack, settings and agent env to the runner', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const r = runner.requests[0]!;
    expect(r.pluginDir.endsWith(join('packs', 'standard'))).toBe(true);
    expect(r.settingsPath.endsWith(join('packs', 'standard', 'settings.json'))).toBe(true);
    expect(r.env['FACTORY_RUN_TOKEN']).toBeDefined();
    expect(r.env['PORT']).toBe('4200');
  });

  it('reads the conventions before it resets .claude/, which holds one of them (ORC-284)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ws-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'local conventions');
    const workspaces = new FakeWorkspaces();
    const prepare = workspaces.prepare.bind(workspaces);
    workspaces.prepare = async (req) => ({ ...(await prepare(req)), path: dir });
    workspaces.resetClaudeDir = async (path) => rmSync(join(path, '.claude'), { recursive: true, force: true });
    const { tracker, runner, orch } = setup({ workspaces });
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    expect(runner.requests[0]!.prompt).toContain('### .claude/CLAUDE.md\nlocal conventions');
  });

  it('watches a question for silence only, and a version frozen before the detector not at all (ORC-136)', async () => {
    const dev = setup();
    dev.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await dev.orch.accept(delegated());
    await dev.orch.drained();
    expect(dev.runner.requests[0]!.stagnation).toEqual({ repeats: 3, silentMs: 30 * 60_000 });
    const frozen = setup({ tweak: (w) => void delete w.limits.silentAfterMs });
    frozen.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await frozen.orch.accept(delegated());
    await frozen.orch.drained();
    expect(frozen.runner.requests[0]).not.toHaveProperty('stagnation');
  });

  it('labels the attempt it launches, and the labels outlive the run settling (ORC-226)', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const req = runner.requests[0]!;
    const run = (await store.getRun(req.runId))!;
    expect(run.status).not.toBe('running');
    expect(run.labels).toMatchObject({ task: run.job, queue: run.queue, model: req.model, factoryCommit: 'cafe42', effort: 'medium' });
    expect(run.labels!.fingerprints.prompt).toBe(hashText(req.prompt));
    expect(run.labels!.fingerprints.workflow).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gives two instances with different homes the same config fingerprint (ORC-226)', async () => {
    const homes = [mkdtempSync(join(tmpdir(), 'home-a-')), mkdtempSync(join(tmpdir(), 'home-b-'))];
    try {
      const configs: (string | null)[] = [];
      for (const home of homes) {
        const settingsPath = writeRunSettings(packDir, home);
        const { store, tracker, runner, orch } = setup({ settingsPath });
        tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
        await orch.accept(delegated());
        await orch.drained();
        expect(runner.requests[0]!.settingsPath).toBe(settingsPath);
        configs.push((await store.getRun(runner.requests[0]!.runId))!.labels!.fingerprints.config);
      }
      expect(readFileSync(join(homes[0]!, 'run-settings.json'), 'utf8')).not.toBe(readFileSync(join(homes[1]!, 'run-settings.json'), 'utf8'));
      expect(configs[1]).toBe(configs[0]);
    } finally {
      for (const home of homes) rmSync(home, { recursive: true, force: true });
    }
  });

  it('stopAll() lets go of a run still under way: neither stopped nor closed, the ticket keeps it for recover() (ORC-344)', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    runner.enqueue({ hold: true });
    await orch.accept(delegated());
    await orch.drained();
    const runId = (await store.getTicket('p', 'REL-1'))!.activeRunId!;
    orch.stopAll();
    await orch.drained();
    // A shutdown is not a user stop: the run goes on, and recover() reattaches to it at the next start (or starts its step again).
    expect((await store.getRun(runId))!.status).toBe('running');
    expect((await store.getTicket('p', 'REL-1'))!.activeRunId).toBe(runId);
    // Its end, after the shutdown, is not this process's to write.
    runner.release(runId);
    await orch.drained();
    expect((await store.getRun(runId))!.status).toBe('running');
  });

  const waitFor = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
    expect(await cond()).toBe(true);
  };

  it('fails the run, frees the slot and blocks the ticket when the runner rejects', async () => {
    const rejecting: Runner = {
      start: () => ({
        events: (async function* () {})(),
        done: new Promise((_, rej) => setTimeout(() => rej(new Error('spawn boom')), 5)),
        stop: () => {},
      }),
    };
    const { store, tracker, orch, scheduler } = setup({ runner: rejecting });
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const t = (await store.getTicket('p', 'REL-1'))!;
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
    expect(scheduler.inUse('dev')).toBe(0);
    expect(await store.runsByStatus('failure')).toHaveLength(1);
    expect(await store.runsByStatus('running')).toEqual([]);
  });

  // Was: blocked. A run that really ended has a result: it is delivered (ORC-220), never run again.
  it('recover() delivers the result of a finished run its ticket still holds', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const t = (await store.getTicket('p', 'REL-1'))!;
    const run = (await store.runsByStatus('success'))[0]!;
    const finished = (await store.recentEvents(50, 'REL-1')).find((e) => e.type === 'run.finished')!;
    t.activeRunId = 'r-unsent';
    t.blocked = false;
    await store.putTicket(t);
    await store.putRun({ ...run, id: 'r-unsent', token: 't-unsent' });
    await orch.recover();
    expect((await store.pendingInbox(10)).find((e) => e.id === 'attempt:r-unsent:finished')).toMatchObject({ type: 'run.finished', payload: { runId: 'r-unsent', outcome: 'success', job: (finished.payload as { job: string }).job } });
    expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(false);
  });

  // Was: blocked. The check runs again on the same attempt (ORC-220), whose verdict keeps its id.
  it('recover() takes up a check whose verdict never came', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const t = (await store.getTicket('p', 'REL-1'))!;
    const run = (await store.runsByStatus('success'))[0]!;
    t.verifyingRunId = run.id;
    await store.putTicket(t);
    await orch.recover();
    expect((await store.pendingInbox(10)).find((e) => e.id.startsWith(`check:${run.id}:lost`))).toMatchObject({ type: 'verify.lost', payload: { runId: run.id, job: run.job } });
    expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(false);
  });

  // Was: blocked. Nothing says what to check: the wait ends, and the ticket is not held for a verdict that cannot come.
  it('recover() drops a check that names a run never written', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const t = (await store.getTicket('p', 'REL-1'))!;
    t.verifyingRunId = 'r-x';
    await store.putTicket(t);
    await orch.recover();
    const after = (await store.getTicket('p', 'REL-1'))!;
    expect(after.blocked).toBe(false);
    expect(after.verifyingRunId).toBeUndefined();
  });

  it('ignores a verification result that arrives after the ticket was stopped', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { store, tracker, orch } = setup({
      verify: async () => {
        await gate;
        return { ok: true, failures: [] };
      },
      tweak: (w) => {
        w.jobs['dev']!.verify = ['true'];
      },
    });
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    // The daemon's poll: a run.finished that came in while its launch still held the ticket waits for it.
    await waitFor(async () => (await orch.poll(), !!(await store.getTicket('p', 'REL-1'))?.verifyingRunId));
    await orch.accept({ ...TRUSTED, id: 'stop', type: 'control.stop', at: 2, projectId: 'p', ticketId: 'REL-1', payload: {} });
    await waitFor(async () => (await store.getTicket('p', 'REL-1'))!.verifyingRunId === undefined);
    release();
    await orch.drained();
    const moves = tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);
    expect(moves).not.toContain('Human Review');
    expect((await store.getTicket('p', 'REL-1'))!.logical).not.toBe('human_review');
  });

  it('logs a worktree fingerprint verify could not read, with the ticket (ORC-319)', async () => {
    const { tracker, orch, bus } = setup({
      verify: async (_cwd, commands, _timeoutMs, _env, warn) => {
        warn?.('boom');
        return { ok: false, failures: [{ command: commands[0]!, exitCode: 1, output: '' }] };
      },
      tweak: (w) => {
        w.jobs['dev']!.verify = ['false'];
      },
    });
    const logs: string[] = [];
    bus.subscribe((m) => void (m.kind === 'log' && logs.push(`${m.level}: ${m.message}`)));
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    await orch.accept(delegated());
    await orch.drained();
    expect(logs).toContain('warn: verify of REL-1: boom');
  });

  it('never holds the queue on a daily budget in dollars, however much the day cost (ORC-216)', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    tracker.addIssue({ identifier: 'REL-2', title: 'B' });
    runner.enqueue({ costUsd: 10_000 });
    await orch.accept(delegated());
    await orch.drained();
    await orch.accept({ ...TRUSTED, id: 'e2', type: 'ticket.delegated', at: 1_000, projectId: 'p', ticketId: 'REL-2', payload: { linearSessionId: 'ls-2' } });
    await orch.drained();
    expect(runner.requests.map((r) => r.runId)).toHaveLength(2);
    expect(await store.listQueue()).toEqual([]);
    expect(tracker.calls.filter((c) => c.method === 'comment' && String(c.args[1]).includes('budget'))).toEqual([]);
  });

  describe('the cost caps of factory.yml (ORC-340)', () => {
    /** An earlier attempt of REL-1 that spent `output` tokens. */
    const spent = (store: SqliteStore, output: number, run: { id: string; job: string; queue: 'dev' | 'questions' } = { id: 'old', job: 'dev', queue: 'dev' }) =>
      store.putRun({ ...run, projectId: 'p', ticketId: 'REL-1', status: 'limit', claudeSessionId: 's', startedAt: 1, endedAt: 2, costUsd: 1, turns: 1, lastText: '', token: `t-${run.id}`, cwd: '/w', tokens: { input: 0, output, cacheRead: 5_000_000, cacheCreation: 0 } });

    it('blocks a ticket past per_ticket_tokens before its next run, before any workspace, and says why', async () => {
      const workspaces = new FakeWorkspaces();
      const { store, tracker, runner, orch } = setup({ perTicketTokens: 1_000, workspaces });
      tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      await spent(store, 1_000);
      await orch.accept(delegated());
      await orch.drained();
      expect(runner.requests).toEqual([]);
      expect(workspaces.prepared).toEqual([]);
      const t = (await store.getTicket('p', 'REL-1'))!;
      expect(t.blocked).toBe(true);
      // Typed (ORC-216): the Flow files it under its cause, the engine decides on its kind, never on the sentence.
      expect(t.blockKind).toBe('budget');
      // It says when a raised cap counts: factory.yml is read once, at the daemon's start.
      expect(t.blockReason).toBe("Token budget of the ticket reached: 1000 tokens spent of 1000 by its code runs (budgets.per_ticket_tokens). Raise the cap (factory.yml counts once the daemon restarts, the repository's .factory/config.yml at the next launch) or split the ticket, then reply here.");
    });

    it('caps a run under it at what the ticket has left, counting its code runs only, and keeps the cap on the run', async () => {
      const { store, tracker, runner, orch } = setup({ perTicketTokens: 1_000 });
      tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      await spent(store, 400);
      // A question on the ticket is no code run: its tokens are not the ticket's budget.
      await spent(store, 500, { id: 'q-old', job: 'ask', queue: 'questions' });
      await orch.accept(delegated());
      await orch.drained();
      expect(runner.requests[0]!.limits.tokens).toBe(600);
      expect((await store.getRun(runner.requests[0]!.runId))!.limits).toMatchObject({ tokens: 600 });
    });

    it('on_usage_limit: wait, a run the usage limit stopped waits for the reset instead of blocking', async () => {
      const { store, tracker, runner, orch } = setup({ onUsageLimit: 'wait' });
      tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      runner.enqueue({ outcome: 'failure', usageLimit: { resetAt: 1_000_000 } });
      await orch.accept(delegated());
      await orch.drained();
      expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(false);
      expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toMatchObject([{ key: 'REL-1:usage.reset', kind: 'usage.reset', payload: { job: 'dev', account: 'default' }, fireAt: 1_000_000 }]);
    });

    it('a run that spends what the ticket had left is blocked, kind budget, with the standard comment (ORC-216)', async () => {
      const { store, tracker, runner, orch } = setup({ perTicketTokens: 1_000 });
      tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      await spent(store, 400);
      runner.enqueue({ tokens: { input: 0, output: 700, cacheRead: 0, cacheCreation: 0 } });
      await orch.accept(delegated());
      await orch.drained();
      const run = (await store.getRun(runner.requests[0]!.runId))!;
      expect(run).toMatchObject({ status: 'limit', overBudget: 'tokens' });
      expect(await store.getTicket('p', 'REL-1')).toMatchObject({ blocked: true, blockKind: 'budget', blockReason: 'The run dev spent its token budget (budgets.per_step_tokens, or what the ticket had left).' });
      expect(tracker.comments('REL-1').at(-1)).toMatch(/^🔴 Blocked at step build/);
    });

    it('without a cap, a launch reads no run of the ticket', async () => {
      const { store, tracker, runner, orch } = setup();
      tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      const read = vi.spyOn(store, 'ticketRuns');
      // Held: the launch alone. Its check and publication after it read the ticket's runs once, for ORC-338's mark.
      runner.enqueue({ hold: true });
      await orch.accept(delegated());
      await orch.drained();
      expect(runner.requests).toHaveLength(1);
      expect(runner.requests[0]!.limits.tokens).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    });

    /** REL-1 delegated, its first run cut by the usage limit until 50 000. */
    async function cutByTheLimit() {
      const s = setup({ onUsageLimit: 'wait' });
      s.tracker.addIssue({ identifier: 'REL-1', title: 'A' });
      s.tracker.addIssue({ identifier: 'REL-2', title: 'B' });
      s.runner.enqueue({ outcome: 'failure', usageLimit: { resetAt: 1_000_000 } });
      await s.orch.accept(delegated());
      await s.orch.drained();
      const reset = (): FactoryEvent => ({ ...TRUSTED, id: 'timer:REL-1:usage.reset:1000000', type: 'timer.fired', at: 1_000_000, projectId: 'p', ticketId: 'REL-1', payload: { kind: 'usage.reset', payload: { job: 'dev', runId: s.runner.requests[0]!.runId } } });
      return { ...s, reset };
    }

    it('the limit is the account: no launch of any ticket until the reset, then the cut step first, as a relaunch of what it read', async () => {
      const { store, runner, orch, clock, reset } = await cutByTheLimit();
      const cut = runner.requests[0]!;
      await orch.accept({ ...TRUSTED, id: 'e2', type: 'ticket.delegated', at: 2_000, projectId: 'p', ticketId: 'REL-2', payload: { linearSessionId: 'ls-2' } });
      await orch.drained();
      await orch.tick();
      expect(runner.requests).toHaveLength(1);
      expect((await store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-2']);
      clock.set(1_000_000);
      await orch.accept(reset());
      await orch.drained();
      await orch.tick();
      await orch.drained();
      const relaunch = runner.requests[1]!;
      expect(await store.getRun(relaunch.runId)).toMatchObject({ ticketId: 'REL-1', job: 'dev' });
      // The implementer's session, taken up: a relaunch of the cut run, not a step from scratch.
      expect(relaunch).toMatchObject({ claudeSessionId: cut.claudeSessionId, resume: true });
      expect((await store.getRun(runner.requests[2]!.runId))!.ticketId).toBe('REL-2');
    });

    it("holds the ticket's next steps behind the cut one: they wait for it, never start in its place", async () => {
      const { store, runner, orch, clock, reset } = await cutByTheLimit();
      await store.putTicket({ ...(await store.getTicket('p', 'REL-1'))!, pendingJob: { job: 'dev-feedback' } });
      clock.set(1_000_000);
      // A result settles the ticket: settle would start the pending job, which waits behind the cut step.
      await orch.accept({ ...TRUSTED, id: 'v1', type: 'verify.passed', at: 1_000_000, projectId: 'p', ticketId: 'REL-1', payload: { runId: 'old', job: 'dev' } });
      await orch.drained();
      expect(runner.requests).toHaveLength(1);
      expect((await store.getTicket('p', 'REL-1'))!.pendingJob).toMatchObject({ job: 'dev-feedback' });
      await orch.accept(reset());
      await orch.drained();
      // The cut step again, then, once it ended, the step that waited behind it.
      expect(runner.requests.map((r) => r.prompt.split('\n')[0])).toEqual(['/factory:dev', '/factory:dev', '/factory:feedback']);
    });

    it("a reset already past waits 5 minutes at least; the hold is the active account's, logged and shown", async () => {
      let account = 'acc-1';
      const { tracker, runner, orch, bus } = setup({ onUsageLimit: 'wait', account: () => account });
      const logs: string[] = [];
      bus.subscribe((m) => void (m.kind === 'log' && logs.push(`${m.level}: ${m.message}`)));
      tracker.addIssue({ identifier: 'REL-1', title: 'A' });
      runner.enqueue({ outcome: 'failure', usageLimit: { resetAt: 500 } });
      await orch.accept(delegated());
      await orch.drained();
      const until = 1_000 + 5 * 60_000;
      expect(await orch.usageLimitedUntil()).toBe(until);
      expect(logs).toContain(`warn: usage limit of the Claude account acc-1 reached (run ${runner.requests[0]!.runId}): launches held until ${new Date(until).toISOString()}`);
      // Another account has its own limit: not held.
      account = 'acc-2';
      expect(await orch.usageLimitedUntil()).toBeUndefined();
    });

    it('the hold is the account the run was launched on, even when `active` changed under it (ORC-215)', async () => {
      let account = 'acc-1';
      const { store, tracker, runner, orch } = setup({ onUsageLimit: 'wait', account: () => account });
      tracker.addIssue({ identifier: 'REL-1', title: 'A' });
      runner.enqueue({ outcome: 'failure', usageLimit: { resetAt: 1_000_000 }, hold: true });
      await orch.accept(delegated());
      await orch.drained();
      const runId = runner.requests[0]!.runId;
      expect(await store.getRun(runId)).toMatchObject({ account: 'acc-1' });
      account = 'acc-2';
      runner.release(runId);
      await orch.drained();
      expect(await orch.usageLimitedUntil()).toBeUndefined();
      expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toMatchObject([{ kind: 'usage.reset', payload: { account: 'acc-1' } }]);
      account = 'acc-1';
      expect(await orch.usageLimitedUntil()).toBe(1_000_000);
    });

    it('a store that fails to record the hold never holds back the result: the step still waits for its reset', async () => {
      const { store, tracker, runner, orch } = setup({ onUsageLimit: 'wait' });
      tracker.addIssue({ identifier: 'REL-1', title: 'A' });
      const setMeta = store.setMeta.bind(store);
      vi.spyOn(store, 'setMeta').mockImplementation(async (key, value) => (key.startsWith('usage-limited-until') ? Promise.reject(new Error('disk full')) : setMeta(key, value)));
      runner.enqueue({ outcome: 'failure', usageLimit: { resetAt: 1_000_000 } });
      await orch.accept(delegated());
      await orch.drained();
      expect(await store.getTicket('p', 'REL-1')).toMatchObject({ blocked: false, usageWait: { job: 'dev' } });
      expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    });

    it('a budget block says in its state line the same figure as its reason: code runs only', async () => {
      const { store, tracker, orch } = setup({ perTicketTokens: 1_000 });
      tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      await spent(store, 1_000);
      await spent(store, 500, { id: 'q-old', job: 'ask', queue: 'questions' });
      await orch.accept(delegated());
      await orch.drained();
      const comment = String(tracker.calls.find((c) => c.method === 'comment')!.args[1]);
      expect(comment).toContain('1000 tokens spent of 1000 by its code runs');
      expect(comment).toContain('· code-run tokens 1000 ·');
    });

    it('without on_usage_limit, the same run blocks the ticket as any failure', async () => {
      const { store, tracker, runner, orch } = setup();
      tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      runner.enqueue({ outcome: 'failure', usageLimit: { resetAt: 1_000_000 } });
      await orch.accept(delegated());
      await orch.drained();
      expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(true);
      expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
    });
  });

  it('does not start runs after stopAll()', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    orch.stopAll();
    await orch.accept(delegated());
    await orch.tick();
    await orch.drained();
    expect(runner.requests).toHaveLength(0);
    expect(await store.listQueue()).toHaveLength(1);
  });

  // ORC-175, in place of 'blocks the ticket with the error when a command throws': a failed effect is
  // still decided as `effect.failed` (below, 'arms no rule timer…'); what throws now is the decision itself.
  describe('an event whose decision throws (ORC-175)', () => {
    /** A rule whose condition is broken (`when` not a parsed condition): `decide` throws on `label.changed`. */
    function broken() {
      let workflow!: ReturnType<typeof loadWorkflow>;
      const s = setup({
        tweak: (w) => {
          workflow = w;
          w.on['label.changed'] = [{ label: 'agent:x', when: {} as never, comment: 'reçu' }];
        },
      });
      s.tracker.addIssue({ identifier: 'REL-1', title: 'A' });
      const fix = () => void (workflow.on['label.changed'] = [{ label: 'agent:x', comment: 'reçu' }]);
      return { ...s, fix };
    }
    const label = (id: string): FactoryEvent =>
      ({ ...TRUSTED, id, type: 'label.changed', at: 2_000, projectId: 'p', ticketId: 'REL-1', payload: { label: 'agent:x', change: 'added' } });

    it('dead-letters it and blocks the ticket, with a message naming it; the events behind it go on', async () => {
      const { store, tracker, orch } = broken();
      await orch.accept(delegated());
      await orch.drained();
      await orch.accept(label('l1'));
      await orch.accept({ ...TRUSTED, id: 's1', type: 'session.prompted', at: 2_000, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1', body: 'ok', author: 'lilian' } });
      await orch.drained();
      const [dl] = await store.deadLetters('REL-1');
      expect(dl).toMatchObject({ eventId: 'l1', projectId: 'p', ticketId: 'REL-1', status: 'open', failures: 1, event: { type: 'label.changed' } });
      expect(dl!.error).toMatch(/every/);
      const t = (await store.getTicket('p', 'REL-1'))!;
      expect(t.blocked).toBe(true);
      expect(t.blockReason).toMatch(/^Event l1 set aside \(label\.changed\): its decision failed/);
      expect(tracker.comments('REL-1').at(-1)).toContain(`Reason: ${t.blockReason}`);
      expect(tracker.comments('REL-1').at(-1)).toContain('`factory run repair REL-1`');
      expect(tracker.activities().filter((a) => a.type === 'error')).toEqual([]);
      // Not retried: nothing pending; the reply behind it was decided (kept as feedback for the next run, I6).
      expect(await store.pendingInbox(10)).toEqual([]);
      expect(t.humanInbox.map((f) => f.body)).toEqual(['ok']);
      // The block is a decision of its own, journaled: the poison event is not.
      const journal = (await store.recentEvents(20, 'REL-1')).map((e) => e.id);
      expect(journal).toContain('dead-letter:l1:1');
      expect(journal).not.toContain('l1');
    });

    it('replays it once fixed with `factory run repair`, which unblocks the ticket and is journaled', async () => {
      const { store, tracker, orch, fix } = broken();
      await orch.accept(delegated());
      await orch.accept(label('l1'));
      await orch.drained();
      fix();
      const lines: string[] = [];
      expect(await runRepair({ store, target: 'REL-1', action: 'replay', by: 'armand', now: 3_000, print: (l) => void lines.push(l) })).toBe(0);
      await orch.drained();
      const t = (await store.getTicket('p', 'REL-1'))!;
      expect(t.blocked).toBe(false);
      expect(t.blockReason).toBeUndefined();
      // The rule of the replayed event ran: its comment is posted.
      expect(tracker.calls.filter((c) => c.method === 'comment').map((c) => c.args[1])).toContain('reçu');
      expect(tracker.activities().map((a) => ('body' in a ? a.body : ''))).toContain('Event l1 repaired by armand (replayed): the ticket is unblocked.');
      expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'l1', status: 'replayed', resolvedBy: 'armand' }]);
      expect((await store.recentEvents(20, 'REL-1')).find((e) => e.id === 'repair:l1:1')).toMatchObject({
        type: 'dead_letter.repaired',
        payload: { eventId: 'l1', action: 'replay', by: 'armand', event: { id: 'l1', type: 'label.changed' } },
      });
    });

    it('reopens the dead letter of an event its upcast refuses when it is forced: the command does not fail', async () => {
      const { store, orch } = broken();
      await orch.accept(delegated());
      await orch.accept({ ...label('future'), schemaVersion: 99 } as unknown as StoredEvent);
      await orch.drained();
      expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'future', failures: 1, error: `event future: schema version 99 is newer than ${SCHEMA_VERSION}` }]);
      expect(await runRepair({ store, target: 'REL-1', action: 'force', by: 'armand', now: 3_000, print: () => {} })).toBe(0);
      await orch.drained();
      expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'future', status: 'open', failures: 2 }]);
      expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(true);
      // `skip` never upcasts it.
      expect(await runRepair({ store, target: 'REL-1', action: 'skip', by: 'armand', now: 4_000, print: () => {} })).toBe(0);
      await orch.drained();
      expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(false);
    });

    it('dead-letters a replay that throws again on the same event, one failure more', async () => {
      const { store, orch } = broken();
      await orch.accept(delegated());
      await orch.accept(label('l1'));
      await orch.drained();
      await runRepair({ store, target: 'REL-1', action: 'replay', by: 'armand', now: 3_000, print: () => {} });
      await orch.drained();
      expect(await store.deadLetters('REL-1')).toMatchObject([{ eventId: 'l1', status: 'open', failures: 2 }]);
      expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(true);
      expect((await store.recentEvents(20, 'REL-1')).map((e) => e.id)).toContain('dead-letter:l1:2');
    });

    it.each([
      ['skip', 'skipped'],
      ['force', 'forced'],
    ] as const)('%s: unblocks the ticket without the decision of the event', async (action, label_) => {
      const { store, tracker, orch } = broken();
      await orch.accept(delegated());
      await orch.accept(label('l1'));
      await orch.drained();
      // Still broken: neither repair decides the event.
      expect(await runRepair({ store, target: 'REL-1', action, by: 'armand', now: 3_000, print: () => {} })).toBe(0);
      await orch.drained();
      expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(false);
      expect(tracker.calls.filter((c) => c.method === 'comment').map((c) => c.args[1])).not.toContain('reçu');
      expect(tracker.activities().map((a) => ('body' in a ? a.body : ''))).toContain(`Event l1 repaired by armand (${label_}): the ticket is unblocked.`);
      expect(await store.deadLetters('REL-1')).toMatchObject([{ status: action === 'skip' ? 'skipped' : 'forced', resolvedBy: 'armand' }]);
      expect((await store.recentEvents(20, 'REL-1')).find((e) => e.id === 'repair:l1:1')).toMatchObject({ payload: { action, by: 'armand' } });
    });
  });

  const labelled = (label: string): FactoryEvent =>
    ({ ...TRUSTED, id: `l:${label}`, type: 'label.changed', at: 2_000, projectId: 'p', ticketId: 'REL-1', payload: { label, change: 'added' } });

  it('arms a rule timer after its effects, so a stop in the same rule does not delete it', async () => {
    const { store, tracker, orch } = setup({
      tweak: (w) => { w.on['label.changed'] = [{ label: 'agent:x', do: 'stop', run: 'dev-feedback', debounceMs: 180_000 }]; },
    });
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    await orch.accept(delegated());
    await orch.drained();
    await orch.accept(labelled('agent:x'));
    await orch.drained();
    expect((await store.dueTimers(Number.MAX_SAFE_INTEGER)).map((t) => t.key)).toEqual(['REL-1:dev-feedback']);
  });

  it('arms no rule timer when an earlier effect of the rule fails', async () => {
    const { store, tracker, orch } = setup({
      tweak: (w) => { w.on['label.changed'] = [{ label: 'agent:y', comment: 'reçu', run: 'dev-feedback', debounceMs: 180_000 }]; },
    });
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    tracker.comment = async () => { throw new Error('linear down'); };
    await orch.accept(delegated());
    await orch.drained();
    await orch.accept(labelled('agent:y'));
    await orch.drained();
    expect((await store.getTicket('p', 'REL-1'))!.blockReason).toBe('Error: linear down');
    expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});

describe('fullReadEnv (ORC-279)', () => {
  it('gives each path under the run cwd, as JSON', () => {
    expect(fullReadEnv('/work', ['a b.test.ts', 'src/é.test.ts'])).toEqual({ FACTORY_FULL_READ_PATHS: JSON.stringify(['/work/a b.test.ts', '/work/src/é.test.ts']) });
  });

  it('gives nothing for no path', () => {
    expect(fullReadEnv('/work', [])).toEqual({});
  });

  it('refuses a list over what one environment string can safely hold, and takes one under it', () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `packages/some-package-${i}/src/some-feature.test.ts`);
    expect(() => fullReadEnv('/work', paths(5000))).toThrow(/5000 paths/);
    expect(Buffer.byteLength(fullReadEnv('/work', paths(1000))['FACTORY_FULL_READ_PATHS']!)).toBeLessThanOrEqual(64 * 1024);
  });
});
