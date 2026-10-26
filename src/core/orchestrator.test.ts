import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeForge } from '../adapters/forge/fake.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import type { Runner } from '../adapters/runner/types.js';
import type { Verifier } from './verify.js';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { EventBus } from './bus.js';
import { FakeClock } from './clock.js';
import { Orchestrator } from './orchestrator.js';
import { Scheduler } from './scheduler.js';
import { newTicketState, TRUSTED, type FactoryEvent } from './types.js';

function setup(o: { runner?: Runner; verify?: Verifier; budget?: number; tweak?: (w: ReturnType<typeof loadWorkflow>) => void } = {}) {
  const packDir = join(import.meta.dirname, '../../packs/standard');
  const workflow = loadWorkflow({ packDir });
  o.tweak?.(workflow);
  const store = new SqliteStore(':memory:');
  const tracker = new FakeTracker();
  const fakeRunner = new FakeRunner();
  const runner = o.runner ?? fakeRunner;
  const scheduler = new Scheduler(store, { dev: 3, questions: 2 });
  let n = 0;
  const orch = new Orchestrator({
    store, clock: new FakeClock(1_000), bus: new EventBus(), scheduler,
    tracker, forge: new FakeForge(), runner, workspaces: new FakeWorkspaces(), verify: o.verify ?? (async () => ({ ok: true, failures: [] })), dailyBudgetUsd: o.budget,
    projects: [{ id: 'p', repoPath: '/repo', teamKey: 'REL', workflow }], packDir,
    agentEnv: (r) => ({ FACTORY_RUN_TOKEN: r.token }), newId: () => `id-${++n}`, activityIntervalMs: 0,
  });
  return { store, tracker, runner: fakeRunner, orch, scheduler };
}

const delegated = (id = 'e1'): FactoryEvent => ({ ...TRUSTED, id, type: 'ticket.delegated', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });

describe('Orchestrator', () => {
  it('starts no dev job on a merged ticket, even one it holds outside decide (ORC-268)', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'T', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    await store.putTicket({ ...newTicketState('p', 'REL-1', 'T', 'done', 1), delegated: true, prState: 'MERGED', pendingJob: { job: 'dev-feedback' } });
    // A result settles the ticket: settle would start the pending job.
    await orch.submit({ ...TRUSTED, id: 'v1', type: 'verify.passed', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { runId: 'old', job: 'dev' } });
    await orch.idle();
    expect(runner.requests).toEqual([]);
    expect((await store.getTicket('p', 'REL-1'))!.pendingJob).toBeUndefined();
    expect((await store.getTicket('p', 'REL-1'))!.blocked).toBe(false);
  });

  it('blocks a ticket from outside an event only after the event in flight, never over it', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getIssue = tracker.getIssue.bind(tracker);
    tracker.getIssue = async (id: string) => (await gate, getIssue(id));
    const order: string[] = [];
    const delegation = orch.submit(delegated()).then(() => void order.push('event'));
    const block = orch.blockTicket('p', 'REL-1', "Question posée par l'agent").then(() => void order.push('block'));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    release();
    await Promise.all([delegation, block]);
    await orch.idle();
    expect(order).toEqual(['event', 'block']);
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ blocked: true, blockReason: "Question posée par l'agent" });
  });

  it('ignores a duplicate event id', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.submit(delegated());
    await orch.idle();
    expect(runner.requests).toHaveLength(1);
  });

  it('creates the ticket from the snapshot carried by the event, without reading the tracker', async () => {
    const { store, tracker, orch } = setup();
    const issue = { title: 'Export CSV', logical: 'todo' as const, priority: 3 };
    const payload = { name: 'fais-le', body: '', linearSessionId: 'q1', author: 'L', issue };
    await orch.submit({ id: 'c1', type: 'command', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload } as FactoryEvent);
    await orch.idle();
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ title: 'Export CSV', priority: 3, questionSessionIds: ['q1'] });
    expect(tracker.calls.filter((c) => c.method === 'getIssue')).toEqual([]);
  });

  it('reads the tracker once to fill a creating event without a snapshot, and journals the filled event', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', stateName: 'In Progress', priority: 2 });
    await orch.submit({ id: 'm1', type: 'session.mentioned', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'q1', body: '?', author: 'L' } } as FactoryEvent);
    await orch.idle();
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ title: 'Export CSV', logical: 'dev', priority: 2 });
    const journaled = (await store.recentEvents(10)).find((e) => e.id === 'm1')!;
    expect(journaled.payload).toMatchObject({ issue: { title: 'Export CSV', logical: 'dev', priority: 2 } });
  });

  it('ignores moves of tickets it does not manage', async () => {
    const { store, orch } = setup();
    await orch.submit({ ...TRUSTED, id: 'm', type: 'status.changed', at: 1, projectId: 'p', ticketId: 'REL-9', payload: { from: 'todo', to: 'dev' } });
    await orch.idle();
    expect(await store.getTicket('p', 'REL-9')).toBeUndefined();
  });

  it('passes the pack, settings and agent env to the runner', async () => {
    const { tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.idle();
    const r = runner.requests[0]!;
    expect(r.pluginDir.endsWith('packs/standard')).toBe(true);
    expect(r.settingsPath.endsWith('packs/standard/settings.json')).toBe(true);
    expect(r.env['FACTORY_RUN_TOKEN']).toBeDefined();
    expect(r.env['PORT']).toBe('4200');
  });

  it('recover() blocks tickets whose run was interrupted', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    runner.enqueue({ hold: true });
    await orch.submit(delegated());
    await orch.recover();
    const t = (await store.getTicket('p', 'REL-1'))!;
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
    expect(await store.runsByStatus('running')).toEqual([]);
  });

  it('stopAll() then idle() waits until the interrupted run is persisted', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    runner.enqueue({ hold: true });
    await orch.submit(delegated());
    await orch.idle();
    const runId = (await store.getTicket('p', 'REL-1'))!.activeRunId!;
    orch.stopAll();
    await orch.idle();
    // A shutdown is not a user stop: the run is `interrupted` and the ticket keeps it for recover() on the next start.
    expect((await store.getRun(runId))!.status).toBe('interrupted');
    expect((await store.getTicket('p', 'REL-1'))!.activeRunId).toBe(runId);
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
    await orch.submit(delegated());
    await orch.idle();
    const t = (await store.getTicket('p', 'REL-1'))!;
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
    expect(scheduler.inUse('dev')).toBe(0);
    expect(await store.runsByStatus('failure')).toHaveLength(1);
    expect(await store.runsByStatus('running')).toEqual([]);
  });

  it('recover() blocks a ticket whose activeRunId points to a finished run', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.idle();
    const t = (await store.getTicket('p', 'REL-1'))!;
    t.activeRunId = (await store.runsByStatus('success'))[0]!.id;
    t.blocked = false;
    await store.putTicket(t);
    await orch.recover();
    const after = (await store.getTicket('p', 'REL-1'))!;
    expect(after.blocked).toBe(true);
    expect(after.activeRunId).toBeUndefined();
    expect(after.blockReason).toContain('redémarré');
  });

  it('recover() blocks a ticket that was being verified', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.submit(delegated());
    await orch.idle();
    const t = (await store.getTicket('p', 'REL-1'))!;
    t.verifyingRunId = 'r-x';
    t.blocked = false;
    await store.putTicket(t);
    await orch.recover();
    const after = (await store.getTicket('p', 'REL-1'))!;
    expect(after.blocked).toBe(true);
    expect(after.verifyingRunId).toBeUndefined();
    expect(after.blockReason).toContain('vérifications');
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
    await orch.submit(delegated());
    await waitFor(async () => !!(await store.getTicket('p', 'REL-1'))?.verifyingRunId);
    await orch.submit({ ...TRUSTED, id: 'stop', type: 'control.stop', at: 2, projectId: 'p', ticketId: 'REL-1', payload: {} });
    expect((await store.getTicket('p', 'REL-1'))!.verifyingRunId).toBeUndefined();
    release();
    await orch.idle();
    const moves = tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);
    expect(moves).not.toContain('Human Review');
    expect((await store.getTicket('p', 'REL-1'))!.logical).not.toBe('human_review');
  });

  it('enqueues over budget and comments only once per ticket per day', async () => {
    const { store, tracker, runner, orch } = setup({ budget: 0.01 });
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    tracker.addIssue({ identifier: 'REL-2', title: 'B' });
    await orch.submit(delegated());
    await orch.idle();
    expect(runner.requests).toHaveLength(1);
    const d2 = (id: string): FactoryEvent => ({ ...TRUSTED, id, type: 'ticket.delegated', at: 1_000, projectId: 'p', ticketId: 'REL-2', payload: { linearSessionId: 'ls-2' } });
    await orch.submit(d2('e2'));
    await orch.submit(d2('e3'));
    await orch.idle();
    expect(runner.requests).toHaveLength(1);
    expect((await store.listQueue()).length).toBeGreaterThanOrEqual(1);
    const comments = tracker.calls.filter((c) => c.method === 'comment' && c.args[0] === 'REL-2');
    expect(comments).toHaveLength(1);
    expect(String(comments[0]!.args[1])).toContain('Budget journalier');
  });

  it('does not start runs after stopAll()', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    orch.stopAll();
    await orch.submit(delegated());
    await orch.tick();
    await orch.idle();
    expect(runner.requests).toHaveLength(0);
    expect(await store.listQueue()).toHaveLength(1);
  });

  it('blocks the ticket with the error when a command throws', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    const move = tracker.moveTo.bind(tracker);
    let n = 0;
    tracker.moveTo = async (id, name) => {
      if (++n > 1) throw new Error('linear down');
      return move(id, name);
    };
    await orch.submit(delegated());
    await orch.idle();
    const t = (await store.getTicket('p', 'REL-1'))!;
    expect(t.blocked).toBe(true);
    expect(t.blockReason).toBe('Erreur : linear down');
    expect(tracker.activities().some((a) => a.type === 'error')).toBe(true);
  });

  const labelled = (label: string): FactoryEvent =>
    ({ ...TRUSTED, id: `l:${label}`, type: 'label.changed', at: 2_000, projectId: 'p', ticketId: 'REL-1', payload: { label, change: 'added' } });

  it('arms a rule timer after its effects, so a stop in the same rule does not delete it', async () => {
    const { store, tracker, orch } = setup({
      tweak: (w) => { w.on['label.changed'] = [{ label: 'agent:x', do: 'stop', run: 'dev-feedback', debounceMs: 180_000 }]; },
    });
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    await orch.submit(delegated());
    await orch.idle();
    await orch.submit(labelled('agent:x'));
    await orch.idle();
    expect((await store.dueTimers(Number.MAX_SAFE_INTEGER)).map((t) => t.key)).toEqual(['REL-1:dev-feedback']);
  });

  it('arms no rule timer when an earlier effect of the rule fails', async () => {
    const { store, tracker, orch } = setup({
      tweak: (w) => { w.on['label.changed'] = [{ label: 'agent:y', comment: 'reçu', run: 'dev-feedback', debounceMs: 180_000 }]; },
    });
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    tracker.comment = async () => { throw new Error('linear down'); };
    await orch.submit(delegated());
    await orch.idle();
    await orch.submit(labelled('agent:y'));
    await orch.idle();
    expect((await store.getTicket('p', 'REL-1'))!.blockReason).toBe('Erreur : linear down');
    expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});
