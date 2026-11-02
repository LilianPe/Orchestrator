import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeRunSettings } from '../config/run-settings.js';
import { FakeForge } from '../adapters/forge/fake.js';
import { FakeRunner } from '../adapters/runner/fake.js';
import type { Runner } from '../adapters/runner/types.js';
import type { Verifier } from './verify.js';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { stateEchoKey } from '../adapters/tracker/types.js';
import { FakeWorkspaces } from '../adapters/workspace/fake.js';
import { loadWorkflow } from '../config/load-workflow.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { hashText } from './attempt-labels.js';
import { EventBus } from './bus.js';
import { FakeClock } from './clock.js';
import { Orchestrator } from './orchestrator.js';
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
    budget?: number;
    hold?: boolean;
    settingsPath?: string;
    tweak?: (w: ReturnType<typeof loadWorkflow>) => void;
    effectRetry?: EffectRetry;
    workspaces?: FakeWorkspaces;
  } = {},
) {
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
    tracker, forge: new FakeForge(), runner, workspaces: o.workspaces ?? new FakeWorkspaces(), verify: o.verify ?? (async () => ({ ok: true, failures: [] })), dailyBudgetUsd: o.budget,
    projects: [{ id: 'p', repoPath: '/repo', teamKey: 'REL', workflow }], packDir, settingsPath: o.settingsPath,
    agentEnv: (r) => ({ FACTORY_RUN_TOKEN: r.token }), newId: () => `id-${++n}`, activityIntervalMs: 0, holdInboxUntilReplay: o.hold, factoryCommit: 'cafe42',
    // One attempt: a failed effect dies at once (the retries have their own tests).
    effectRetry: o.effectRetry ?? { attempts: 1, baseMs: 1, capMs: 1 },
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

  it('blocks a ticket from outside an event only after the event in flight, never over it', async () => {
    const { store, tracker, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getIssue = tracker.getIssue.bind(tracker);
    tracker.getIssue = async (id: string) => (await gate, getIssue(id));
    let blocked = false;
    await orch.accept(delegated());
    const block = orch.blockTicket('p', 'REL-1', "Question posée par l'agent").then(() => void (blocked = true));
    await new Promise((r) => setTimeout(r, 10));
    // The delegation waits for the tracker: the block waits behind it, in the ticket's task.
    expect(blocked).toBe(false);
    expect(await store.getTicket('p', 'REL-1')).toBeUndefined();
    release();
    await block;
    await orch.drained();
    // Applied after the delegation created the ticket: on top of it, not lost before it.
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ delegated: true, blocked: true, blockReason: "Question posée par l'agent" });
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
    expect(r.pluginDir.endsWith('packs/standard')).toBe(true);
    expect(r.settingsPath.endsWith('packs/standard/settings.json')).toBe(true);
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

  it('labels the attempt it launches, and the labels outlive the run settling (ORC-226)', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await orch.accept(delegated());
    await orch.drained();
    const req = runner.requests[0]!;
    const run = (await store.getRun(req.runId))!;
    expect(run.status).not.toBe('running');
    expect(run.labels).toMatchObject({ task: run.job, queue: run.queue, model: req.model, factoryCommit: 'cafe42', effort: null });
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

  it('recover() blocks tickets whose run was interrupted', async () => {
    const { store, tracker, runner, orch } = setup();
    tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    runner.enqueue({ hold: true });
    await orch.accept(delegated());
    await orch.drained();
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
    await orch.accept(delegated());
    await orch.drained();
    const runId = (await store.getTicket('p', 'REL-1'))!.activeRunId!;
    orch.stopAll();
    await orch.drained();
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
    await orch.accept(delegated());
    await orch.drained();
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
    await orch.accept(delegated());
    await orch.drained();
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
    await orch.accept(delegated());
    await orch.drained();
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
    await orch.accept(delegated());
    await waitFor(async () => !!(await store.getTicket('p', 'REL-1'))?.verifyingRunId);
    await orch.accept({ ...TRUSTED, id: 'stop', type: 'control.stop', at: 2, projectId: 'p', ticketId: 'REL-1', payload: {} });
    await waitFor(async () => (await store.getTicket('p', 'REL-1'))!.verifyingRunId === undefined);
    release();
    await orch.drained();
    const moves = tracker.calls.filter((c) => c.method === 'moveTo').map((c) => c.args[1]);
    expect(moves).not.toContain('Human Review');
    expect((await store.getTicket('p', 'REL-1'))!.logical).not.toBe('human_review');
  });

  it('enqueues over budget and comments only once per ticket per day', async () => {
    const { store, tracker, runner, orch } = setup({ budget: 0.01 });
    tracker.addIssue({ identifier: 'REL-1', title: 'A' });
    tracker.addIssue({ identifier: 'REL-2', title: 'B' });
    await orch.accept(delegated());
    await orch.drained();
    expect(runner.requests).toHaveLength(1);
    const d2 = (id: string): FactoryEvent => ({ ...TRUSTED, id, type: 'ticket.delegated', at: 1_000, projectId: 'p', ticketId: 'REL-2', payload: { linearSessionId: 'ls-2' } });
    await orch.accept(d2('e2'));
    await orch.accept(d2('e3'));
    await orch.drained();
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
      expect(t.blockReason).toMatch(/^Événement l1 mis de côté \(label\.changed\) : sa décision a échoué/);
      expect(tracker.activities().filter((a) => a.type === 'error').map((a) => ('body' in a ? a.body : ''))).toEqual([`${t.blockReason} Un mainteneur peut le réparer : \`factory run repair REL-1\`.`]);
      // Not retried: nothing pending; the reply behind it was decided (kept as feedback for the next run, I6).
      expect(await store.pendingInbox(10)).toEqual([]);
      expect(t.pendingFeedback.map((f) => f.body)).toEqual(['ok']);
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
      expect(tracker.activities().map((a) => ('body' in a ? a.body : ''))).toContain('Événement l1 réparé par armand (rejoué) : le ticket est débloqué.');
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
      ['skip', 'ignoré'],
      ['force', 'forcé'],
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
      expect(tracker.activities().map((a) => ('body' in a ? a.body : ''))).toContain(`Événement l1 réparé par armand (${label_}) : le ticket est débloqué.`);
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
    expect((await store.getTicket('p', 'REL-1'))!.blockReason).toBe('Erreur : linear down');
    expect(await store.dueTimers(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});
