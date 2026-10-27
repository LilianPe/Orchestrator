import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../src/config/load-workflow.js';
import { TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { DecisionRequest } from '../../src/store/types.js';
import type { WorkspaceRequest } from '../../src/adapters/workspace/types.js';
import { CRASH_WORKFLOW, crashAfterDecision } from '../helpers/crash-workflow.js';
import { createHarness, packDir } from '../helpers/harness.js';

const waitFor = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 400 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
  expect(await cond()).toBe(true);
};

/**
 * ORC-149: the worker decides each inbox row in one transaction (journal, projection, outbox,
 * timers, inbox mark), one task per ticket, and executes the outbox rows after the commit.
 */
describe('worker: per-ticket lock and decision transaction', () => {
  it.each([
    { killAt: 1, done: [] as string[], label: 'before any effect' },
    { killAt: 2, done: ['REL-1:1:1'], label: 'after its first effect' },
  ])('loses no event and doubles no effect when killed with SIGKILL after the commit, $label', async ({ killAt, done }) => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-worker-')), 'factory.db');
    const { completed } = crashAfterDecision(file, killAt);
    expect(completed).toEqual(done);

    const h = createHarness({ store: new SqliteStore(file), projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    // Committed before the kill: journal, projection and the three outbox rows, the inbox row processed.
    expect((await h.store.recentEvents(10, 'REL-1')).map((e) => e.type)).toEqual(['ticket.delegated']);
    expect(await h.ticket()).toMatchObject({ delegated: true });
    // The result of each effect done before the kill, written with its row (ORC-150).
    expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(done.map((id) => `effect:${id}`));
    expect((await h.store.listEffects('p', 'REL-1')).map((r) => [r.id, r.effect.kind])).toEqual([
      ['REL-1:1:1', 'labels'],
      ['REL-1:1:2', 'comment'],
      ['REL-1:1:3', 'start_run'],
    ]);

    await h.restart();
    // The rows left are executed once each, and only those (the run's end decides more afterwards).
    expect((await h.store.listEffects('p', 'REL-1')).slice(0, 3).map((r) => r.status)).toEqual(['done', 'done', 'done']);
    const labels = h.tracker.calls.filter((c) => c.method === 'setLabels');
    expect(labels).toHaveLength(killAt === 1 ? 1 : 0);
    expect(h.tracker.calls.filter((c) => c.method === 'comment').map((c) => c.args[1])).toEqual(['Pris en charge.']);
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.recentEvents(10, 'REL-1')).filter((e) => e.type === 'ticket.delegated')).toHaveLength(1);

    // Another start finds nothing left to do.
    await h.restart();
    expect(h.runner.requests).toHaveLength(1);
  });

  it('writes nothing of a decision cut by SIGKILL before its commit, and decides it once at the next start', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-worker-')), 'factory.db');
    expect(crashAfterDecision(file, 0).completed).toEqual([]);

    const h = createHarness({ store: new SqliteStore(file), projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    expect(await h.store.recentEvents(10)).toEqual([]);
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();
    expect(await h.store.listEffects('p', 'REL-1')).toEqual([]);
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['ticket.delegated']);

    await h.restart();
    expect((await h.store.recentEvents(10, 'REL-1')).filter((e) => e.type === 'ticket.delegated')).toHaveLength(1);
    expect(h.tracker.calls.filter((c) => c.method === 'comment')).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
  });

  it('decides a ticket while another one is held in a long workspace setup (criterion 5)', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    let release!: () => void;
    const npmCi = new Promise<void>((r) => (release = r));
    const prepare = h.workspaces.prepare.bind(h.workspaces);
    h.workspaces.prepare = async (req: WorkspaceRequest) => {
      if (req.ticketId === 'REL-1') await npmCi;
      return prepare(req);
    };
    const event = (id: string, ticketId: string) =>
      ({ ...TRUSTED, id, type: 'ticket.delegated' as const, at: h.clock.now(), projectId: 'p', ticketId, payload: { linearSessionId: `ls-${ticketId}` } });

    await h.orch.accept(event('d1', 'REL-1'));
    // REL-1's start_run is in its setup (the outbox row runs under its lease).
    await waitFor(async () => (await h.store.listEffects('p', 'REL-1')).some((r) => r.effect.kind === 'start_run' && r.status === 'running'));
    await h.orch.accept(event('d2', 'REL-2'));
    // REL-2 is decided and its effects run while REL-1 is still in its setup.
    await waitFor(async () => {
      const rows = await h.store.listEffects('p', 'REL-2');
      return rows.length > 0 && rows.every((r) => r.status === 'done');
    });
    expect(await h.ticket('REL-2')).toMatchObject({ delegated: true });
    expect((await h.store.listEffects('p', 'REL-1')).map((r) => [r.effect.kind, r.status])).toEqual([['start_run', 'running']]);
    expect(h.workspaces.prepared.map((r) => r.ticketId)).not.toContain('REL-1');

    release();
    await h.orch.drained();
    expect(h.workspaces.prepared.map((r) => r.ticketId)).toContain('REL-1');
    expect(h.runner.requests).toHaveLength(2);
  });

  it('keeps a ticket on the workflow version it started with when the workflow changes (criterion 4)', async () => {
    const version = (comment: string) => `
version: 1
on:
  label.changed:
    - { label: "agent:x", comment: "${comment}" }
`;
    const h = createHarness({ projectYaml: version('ancienne version') });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const frozen = (await h.ticket()).workflowHash;
    expect(frozen).toMatch(/^[0-9a-f]{64}$/);

    const file = join(mkdtempSync(join(tmpdir(), 'factory-wf-')), 'workflow.yml');
    writeFileSync(file, version('nouvelle version'));
    h.project.workflow = loadWorkflow({ packDir, projectFile: file });
    await h.restart();

    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    await h.send('label.changed', { label: 'agent:x', change: 'added' }, 'REL-2');
    const comments = h.tracker.calls.filter((c) => c.method === 'comment').map((c) => [c.args[0], c.args[1]]);
    expect(comments).toEqual([
      ['REL-1', 'ancienne version'],
      ['REL-2', 'nouvelle version'],
    ]);
    expect((await h.ticket()).workflowHash).toBe(frozen);
    expect((await h.ticket('REL-2')).workflowHash).not.toBe(frozen);
  });

  it('writes the effects of a decision to the outbox as ticket:seq:i, seq the journal position (criterion 3)', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const journal = (await h.store.recentEvents(50, 'REL-1')).reverse().map((e) => e.id);
    const rows = await h.store.listEffects('p', 'REL-1');
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r.id).toBe(`REL-1:${r.seq}:${r.i}`);
      expect(journal[r.seq - 1]).toBe(r.eventId);
    }
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(['REL-1:1:1', 'REL-1:1:2', 'REL-1:1:3']);
  });

  it('takes an event id once: the inbox key dedups it before any decision', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const e = { ...TRUSTED, id: 'd1', type: 'ticket.delegated' as const, at: 1, projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } };
    expect(await h.orch.accept(e)).toBe(true);
    expect(await h.orch.accept(e)).toBe(false);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect((await h.store.recentEvents(10, 'REL-1')).filter((x) => x.id === 'd1')).toHaveLength(1);
  });

  describe('a row whose processing throws', () => {
    const delegation = (h: ReturnType<typeof createHarness>, id: string, ticketId = 'REL-1') =>
      ({ ...TRUSTED, id, type: 'ticket.delegated' as const, at: h.clock.now(), projectId: 'p', ticketId, payload: { linearSessionId: `ls-${ticketId}` } });
    const stop = (h: ReturnType<typeof createHarness>, id: string) =>
      ({ ...TRUSTED, id, type: 'control.stop' as const, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: {} });

    it('is retried in the same process after a backoff, then lets the rows behind it through, in order', async () => {
      const h = createHarness({ processRetry: { attempts: 4, baseMs: 5 } });
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      const getIssue = h.tracker.getIssue.bind(h.tracker);
      let failures = 2;
      h.tracker.getIssue = async (id: string) => {
        if (failures > 0) {
          failures--;
          throw new Error('Linear unreachable');
        }
        return getIssue(id);
      };
      h.runner.enqueue({ hold: true });
      await h.orch.accept(delegation(h, 'd1'));
      // A stop behind the failed delegation is not lost: it goes once the delegation passes.
      await h.orch.accept(stop(h, 's1'));
      await waitFor(async () => (await h.store.pendingInbox(10)).length === 0);
      await h.orch.drained();
      const types = (await h.store.recentEvents(10, 'REL-1')).map((e) => e.id).reverse();
      expect(types.slice(0, 2)).toEqual(['d1', 's1']);
      expect(await h.ticket()).toMatchObject({ delegated: true, blocked: true, blockReason: 'Arrêté à la demande' });
    });

    it('waits for the next start past its last retry, with the rows of its ticket, other tickets aside', async () => {
      const h = createHarness({ processRetry: { attempts: 3, baseMs: 1 } });
      h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
      h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
      const getIssue = h.tracker.getIssue.bind(h.tracker);
      let down = true;
      let tries = 0;
      h.tracker.getIssue = async (id: string) => {
        if (down && id === 'REL-1') {
          tries++;
          throw new Error('Linear unreachable');
        }
        return getIssue(id);
      };
      await h.orch.accept(delegation(h, 'd1'));
      await h.orch.accept(stop(h, 's1'));
      await waitFor(() => tries === 3);
      await new Promise((r) => setTimeout(r, 30));
      expect(tries).toBe(3);
      await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
      expect(await h.ticket('REL-2')).toMatchObject({ delegated: true });
      expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['d1', 's1']);

      down = false;
      await h.restart();
      expect((await h.store.recentEvents(10, 'REL-1')).map((e) => e.id).reverse().slice(0, 2)).toEqual(['d1', 's1']);
      expect(await h.store.pendingInbox(10)).toEqual([]);
    });

    it('holds the later events without a ticket of its project too, instead of leaving them waiting unseen', async () => {
      const inner = new SqliteStore(':memory:');
      let broken = true;
      const decided: string[] = [];
      const store = Object.assign(Object.create(inner) as SqliteStore, {
        decide: (req: DecisionRequest) => {
          decided.push(req.event.id);
          if (broken && req.event.id === 'g1') throw new Error('database hiccup');
          return inner.decide(req);
        },
      });
      const h = createHarness({ store, processRetry: { attempts: 1, baseMs: 1 } });
      const global = (id: string, type: 'control.pause' | 'control.resume') =>
        ({ ...TRUSTED, id, type, at: h.clock.now(), projectId: '*', payload: {} });
      await h.orch.accept(global('g1', 'control.pause'));
      await h.orch.accept(global('g2', 'control.resume'));
      await h.orch.drained();
      // g2 is held behind g1 by this process: never even sent to the store.
      expect(decided).toEqual(['g1']);
      expect((await h.store.pendingInbox(10)).map((e) => e.id)).toEqual(['g1', 'g2']);

      broken = false;
      await h.restart();
      expect(decided.slice(1).filter((id) => !id.startsWith('effect:'))).toEqual(['g1', 'g2']);
      expect(await h.store.getMeta('paused')).toBe('0');
    });
  });

  it('keeps the slot a drain promised to a dequeued item from a start decided meanwhile, and the item its place', async () => {
    const inner = new SqliteStore(':memory:');
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let gating = false;
    let reached = false;
    // The drain's start of REL-2 reads its ticket first: held there, its slot is promised, not taken.
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      getTicket: async (projectId: string, ticketId: string) => {
        if (gating && ticketId === 'REL-2') {
          reached = true;
          await gate;
        }
        return inner.getTicket(projectId, ticketId);
      },
    });
    const h = createHarness({ store, projectYaml: 'version: 1\nlimits:\n  parallel_sessions: 1\n' });
    for (const id of ['REL-1', 'REL-2', 'REL-3']) h.tracker.addIssue({ identifier: id, title: `Ticket ${id}` });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    const queued = (await h.store.listQueue()).find((q) => q.ticketId === 'REL-2')!;
    expect(queued).toBeDefined();

    gating = true;
    h.runner.release(h.runner.requests[0]!.runId);
    await waitFor(() => reached);
    await h.orch.accept({ ...TRUSTED, id: 'd3', type: 'ticket.delegated', at: h.clock.now(), projectId: 'p', ticketId: 'REL-3', payload: { linearSessionId: 'ls-3' } });
    await waitFor(async () => (await h.store.listQueue()).some((q) => q.ticketId === 'REL-3'));
    open();
    await h.orch.drained();

    const tickets = h.runner.requests.map((r) => r.cwd.split(/[\\/]/).pop());
    expect(tickets.slice(0, 2)).toEqual(['REL-1', 'REL-2']);
    expect((await h.store.listQueue()).find((q) => q.ticketId === 'REL-2')).toBeUndefined();
  });
});

/**
 * ORC-150: the outbox executors. Each effect is claimed under a lease, retried with a backoff,
 * dead past its last attempt, and its result comes back through the inbox as `effect:<id>`.
 */
describe('outbox executors: lease, backoff, results through the inbox', () => {
  const journal = async (h: ReturnType<typeof createHarness>) => (await h.store.recentEvents(100, 'REL-1')).reverse();
  const delegation = (h: ReturnType<typeof createHarness>) =>
    ({ ...TRUSTED, id: 'd1', type: 'ticket.delegated' as const, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: { linearSessionId: 'ls-1' } });

  it('writes each effect result to the inbox as effect:<id>, decided by the worker like any event (criteria 4 and 5)', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const rows = await h.store.listEffects('p', 'REL-1');
    const events = await journal(h);
    // Every row settled wrote one result, journaled after the event that decided the row.
    for (const r of rows) {
      expect(r.status).toBe('done');
      const result = events.filter((e) => e.id === `effect:${r.id}`);
      expect(result).toEqual([
        expect.objectContaining({ type: 'effect.done', payload: { effectId: r.id, kind: r.effect.kind, eventId: r.eventId, attempts: 1 } }),
      ]);
      expect(events.findIndex((e) => e.id === `effect:${r.id}`)).toBeGreaterThan(events.findIndex((e) => e.id === r.eventId));
    }
    expect(events.slice(0, 4).map((e) => e.id)).toEqual(['t-1', 'effect:REL-1:1:1', 'effect:REL-1:1:2', 'effect:REL-1:1:3']);
    // The run's result enters as attempt:<id>:finished.
    expect(events.map((e) => e.id)).toContain('attempt:id-1:finished');
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('retries an effect that fails for a while, after a backoff, and blocks nothing (criterion 3)', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW, effectRetry: { attempts: 4, baseMs: 20, capMs: 1_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const comment = h.tracker.comment.bind(h.tracker);
    const tries: number[] = [];
    h.tracker.comment = async (id: string, body: string) => {
      tries.push(Date.now());
      if (tries.length <= 2) throw new Error('Linear unreachable');
      return comment(id, body);
    };
    await h.orch.accept(delegation(h));
    await waitFor(async () => (await h.store.listEffects('p', 'REL-1')).filter((r) => r.status === 'done').length >= 3);
    await h.orch.drained();
    expect(tries).toHaveLength(3);
    // 20 ms, then 40 ms: never before the backoff.
    expect(tries[1]! - tries[0]!).toBeGreaterThanOrEqual(19);
    expect(tries[2]! - tries[1]!).toBeGreaterThanOrEqual(39);
    expect((await h.store.listEffects('p', 'REL-1'))[1]).toMatchObject({ id: 'REL-1:1:2', status: 'done', attempts: 3, error: 'Linear unreachable' });
    expect(await h.ticket()).toMatchObject({ blocked: false });
    expect(h.runner.requests).toHaveLength(1);
    expect((await journal(h)).find((e) => e.id === 'effect:REL-1:1:2')).toMatchObject({ type: 'effect.done', payload: { attempts: 3 } });
  });

  it('lets an effect die past its last attempt: the rest of its decision is skipped and decide blocks the ticket', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW, effectRetry: { attempts: 2, baseMs: 5, capMs: 5 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.orch.accept(delegation(h));
    await waitFor(async () => (await h.store.getTicket('p', 'REL-1'))?.blocked === true);
    await h.orch.drained();
    expect((await h.store.listEffects('p', 'REL-1')).slice(0, 3).map((r) => [r.effect.kind, r.status])).toEqual([
      ['labels', 'done'],
      ['comment', 'dead'],
      ['start_run', 'failed'],
    ]);
    expect(h.runner.requests).toHaveLength(0);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
    expect((await journal(h)).find((e) => e.id === 'effect:REL-1:1:2')).toMatchObject({ type: 'effect.failed', payload: { error: 'Linear down', attempts: 2 } });
    expect(h.tracker.activities().filter((a) => a.type === 'error').map((a) => ('body' in a ? a.body : ''))).toEqual(['Erreur : Linear down']);
  });

  it('does not loop when the error notice of a dead effect dies too', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    h.tracker.activity = async () => {
      throw new Error('Linear down');
    };
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // The comment dies, then its notice: two results, nothing more.
    expect((await journal(h)).filter((e) => e.type === 'effect.failed')).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur : Linear down' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('takes up an effect cut by SIGKILL after it acted once its lease expires, and runs it again (criterion 2, at least once)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-worker-')), 'factory.db');
    const { completed } = crashAfterDecision(file, 'acted:1', 300);
    expect(completed).toEqual([]);

    const h = createHarness({ store: new SqliteStore(file), projectYaml: CRASH_WORKFLOW, effectLeaseMs: 300 });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    // The labels were set, but the row is still running under the dead process's claim, with no result.
    expect((await h.store.listEffects('p', 'REL-1'))[0]).toMatchObject({ id: 'REL-1:1:1', status: 'running', attempts: 1 });
    expect(await h.store.pendingInbox(10)).toEqual([]);

    await h.restart();
    const settled = async () => (await h.store.listEffects('p', 'REL-1')).slice(0, 3).every((r) => r.status === 'done');
    for (let i = 0; i < 100 && !(await settled()); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await h.orch.drained();
    }
    const rows = await h.store.listEffects('p', 'REL-1');
    expect(rows.slice(0, 3).map((r) => [r.id, r.status, r.attempts])).toEqual([
      ['REL-1:1:1', 'done', 2],
      ['REL-1:1:2', 'done', 1],
      ['REL-1:1:3', 'done', 1],
    ]);
    // Run again under its new claim: the labels are set a second time here (idempotency per effect: ORC-162).
    expect(h.tracker.calls.filter((c) => c.method === 'setLabels')).toHaveLength(1);
    expect(h.tracker.calls.filter((c) => c.method === 'comment')).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
    // One result per row, whatever its number of attempts.
    expect((await journal(h)).filter((e) => e.id === 'effect:REL-1:1:1')).toHaveLength(1);
  });

  it('hands a queued start lost in a crash out again once its lease expires', async () => {
    const h = createHarness({ projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.store.setMeta('paused', '1');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-1']);
    // A daemon takes the item, then dies before the start is recorded.
    expect(await h.store.claimQueued('dev', 1)).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    await h.store.setMeta('paused', '0');
    await h.orch.tick();
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toEqual([]);
    expect(await h.store.claimQueued('dev', 60_000)).toBeUndefined();
  });
});

describe('a stop and an effect held back by its backoff (ORC-150, ORC-138)', () => {
  const RUN_THEN_COMMENT = `
version: 1
on:
  ticket.delegated:
    - { run: dev }
  label.changed:
    - { label: "agent:x", comment: "reçu" }
`;

  it.each([
    { type: 'control.stop' as const, payload: {} },
    { type: 'session.stopped' as const, payload: { linearSessionId: 'ls-1' } },
  ])('lets $type stop the run without waiting for the retry, and keeps its block reason', async ({ type, payload }) => {
    // A minute of backoff: the stop must not wait for it.
    const h = createHarness({ projectYaml: RUN_THEN_COMMENT, effectRetry: { attempts: 8, baseMs: 60_000, capMs: 60_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    expect(runId).toBeDefined();
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    const comment = (await h.store.listEffects('p', 'REL-1')).find((r) => r.effect.kind === 'comment')!;
    expect(comment).toMatchObject({ status: 'pending', attempts: 1, error: 'Linear down' });

    const started = Date.now();
    await h.orch.accept({ ...TRUSTED, id: 'stop-1', type, at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload } as FactoryEvent);
    await waitFor(async () => (await h.store.getRun(runId))?.status === 'stopped');
    await h.orch.drained();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Arrêté à la demande' });
    expect((await h.store.listEffects('p', 'REL-1')).find((r) => r.id === comment.id)).toMatchObject({ status: 'failed', error: 'cancelled by stop-1' });
    // No effect.failed for a cancelled row: nothing rewrites the stop's reason.
    expect((await h.store.recentEvents(100, 'REL-1')).some((e) => e.type === 'effect.failed')).toBe(false);
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('lets a stop pass the result of an effect of the same decision done before the one in backoff', async () => {
    const LABEL_THEN_COMMENT = `
version: 1
on:
  ticket.delegated:
    - { run: dev }
  label.changed:
    - { label: "agent:x", labels: { add: ["vu"] }, comment: "reçu" }
`;
    const h = createHarness({ projectYaml: LABEL_THEN_COMMENT, effectRetry: { attempts: 8, baseMs: 60_000, capMs: 60_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    const effects = (await h.store.listEffects('p', 'REL-1')).filter((r) => r.effect.kind === 'labels' || r.effect.kind === 'comment');
    expect(effects.map((r) => [r.effect.kind, r.status])).toEqual([['labels', 'done'], ['comment', 'pending']]);
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['effect.done']);

    await h.orch.accept({ ...TRUSTED, id: 'stop-1', type: 'control.stop', at: h.clock.now(), projectId: 'p', ticketId: 'REL-1', payload: {} });
    await waitFor(async () => (await h.store.getRun(runId))?.status === 'stopped');
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Arrêté à la demande' });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('does not let another event pass the backoff', async () => {
    const h = createHarness({ projectYaml: RUN_THEN_COMMENT, effectRetry: { attempts: 8, baseMs: 60_000, capMs: 60_000 } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.tracker.comment = async () => {
      throw new Error('Linear down');
    };
    await h.send('label.changed', { label: 'agent:x', change: 'added' });
    await h.send('label.changed', { label: 'agent:y', change: 'added' });
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['label.changed']);
    h.orch.stopAll();
  });
});

describe('a start that must not run (ORC-150 review)', () => {
  it('blocks the ticket once when a launch fails and its notice fails too: the start is not retried', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.workspaces.prepare = async () => {
      throw new Error('disk full');
    };
    const activity = h.tracker.activity.bind(h.tracker);
    h.tracker.activity = async (sessionId, a) => {
      if (a.type === 'error') throw new Error('Linear down');
      return activity(sessionId, a);
    };
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: 'Erreur au lancement : disk full' });
    expect((await h.store.listEffects('p', 'REL-1')).find((r) => r.effect.kind === 'start_run')).toMatchObject({ status: 'done', attempts: 1 });
    expect(h.runner.requests).toHaveLength(0);
  });

  it('drops a queued dev start of a ticket blocked meanwhile, without a run', async () => {
    const h = createHarness({ projectYaml: 'version: 1\nlimits:\n  parallel_sessions: 1\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-2']);
    await h.orch.blockTicket('p', 'REL-2', 'Question posée par l\'agent');
    h.runner.release(h.runner.requests[0]!.runId);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toEqual([]);
    const t = await h.ticket('REL-2');
    expect(t.blocked).toBe(true);
    expect(t.activeRunId).toBeUndefined();
  });
});
