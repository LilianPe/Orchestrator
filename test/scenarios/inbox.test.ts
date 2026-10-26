import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { TRUSTED } from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Store } from '../../src/store/types.js';
import { createHarness } from '../helpers/harness.js';
import { crashAfterAck, linearIngest, signedDelegation } from '../helpers/linear-webhook.js';
import { testPreset } from '../helpers/test-preset.js';

const delegations = async (store: Store) => (await store.recentEvents(50, 'REL-1')).filter((e) => e.type === 'ticket.delegated');

/**
 * ORC-147: the webhook answers once the event is in the inbox, and the orchestrator processes
 * events from the inbox. A daemon that dies between the two loses nothing: the next start
 * processes the event, once.
 */
describe('inbox: written before the answer, processed from the inbox', () => {
  it('processes once, after a restart, a delegation acked by a daemon killed with SIGKILL before processing it', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-inbox-')), 'factory.db');
    const { response, exited } = crashAfterAck(file);
    expect(response).toEqual({ status: 200 });
    expect(exited.status === 0 && exited.signal === null).toBe(false);

    const h = createHarness({ store: new SqliteStore(file) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['ticket.delegated']);
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();

    await h.restart();
    expect(await h.ticket()).toMatchObject({ delegated: true });
    expect(await delegations(h.store)).toHaveLength(1);
    expect(await h.store.pendingInbox(10)).toEqual([]);
    const runs = h.runner.requests.length;
    expect(runs).toBeGreaterThan(0);

    // Exactly once: neither another start nor Linear sending the webhook again processes it twice.
    await h.restart();
    const acks: string[] = [];
    const { raw, headers } = signedDelegation();
    expect(await linearIngest((e) => h.orch.accept(e), acks)(raw, headers)).toEqual({ status: 200 });
    await h.orch.drained();
    expect(acks).toEqual([]);
    expect(await delegations(h.store)).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(runs);
  });

  it('keeps in the inbox an event whose processing threw, and processes it once on the next start', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    const getIssue = h.tracker.getIssue.bind(h.tracker);
    let down = true;
    h.tracker.getIssue = async (id: string) => {
      if (down) throw new Error('Linear unreachable');
      return getIssue(id);
    };
    const { raw, headers } = signedDelegation();
    // The answer is 200: the event is written; its processing fails afterwards.
    expect(await linearIngest((e) => h.orch.accept(e))(raw, headers)).toEqual({ status: 200 });
    await h.orch.drained();
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['ticket.delegated']);

    // Not retried in a loop by the same process: a later event leaves it pending.
    await h.orch.accept({ ...TRUSTED, id: 'ui:resume', type: 'control.resume', at: h.clock.now(), projectId: '*', payload: {} });
    await h.orch.drained();
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['ticket.delegated']);

    down = false;
    await h.restart();
    expect(await h.ticket()).toMatchObject({ delegated: true });
    expect(await delegations(h.store)).toHaveLength(1);
    expect(await h.store.pendingInbox(10)).toEqual([]);
    await h.restart();
    expect(await delegations(h.store)).toHaveLength(1);
  });

  it('writes the results of runs and checks to the inbox under attempt:<id>:finished and check:<id>', async () => {
    const h = createHarness({ preset: testPreset() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const ids = (await h.store.recentEvents(50, 'REL-1')).map((e) => e.id);
    expect(ids.filter((id) => /^(attempt|check):/.test(id))).toEqual([
      expect.stringMatching(/^check:.+$/),
      expect.stringMatching(/^attempt:.+:finished$/),
    ]);
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('keeps the later events of a ticket behind its failed event, and replays them in order at the next start', async () => {
    const h = createHarness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    const getIssue = h.tracker.getIssue.bind(h.tracker);
    let down = true;
    h.tracker.getIssue = async (id: string) => {
      if (down && id === 'REL-1') throw new Error('Linear unreachable');
      return getIssue(id);
    };
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // It carries its snapshot, so it needs no tracker read: processed alone, it would create the
    // ticket without its delegation.
    const issue = { title: 'Export CSV', logical: 'todo' as const, priority: 0 };
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'ajoute aussi le PDF', author: 'L', issue });
    // Another ticket is not held back.
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    expect(await h.ticket('REL-2')).toMatchObject({ delegated: true });
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['ticket.delegated', 'session.prompted']);

    down = false;
    await h.restart();
    expect(await h.ticket()).toMatchObject({ delegated: true });
    const types = (await h.store.recentEvents(50, 'REL-1')).map((e) => e.type).reverse();
    expect(types.filter((t) => t === 'ticket.delegated' || t === 'session.prompted')).toEqual(['ticket.delegated', 'session.prompted']);
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  it('frees the slot of a run whose result is held behind a failed event of its ticket', async () => {
    const inner = new SqliteStore(':memory:');
    let failNext = false;
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      putTicket: async (t: Parameters<SqliteStore['putTicket']>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error('database down');
        }
        return inner.putTicket(t);
      },
    });
    const h = createHarness({ store, projectYaml: stringify({ version: 1, limits: { parallel_sessions: 1 } }) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Import CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const [run] = h.runner.requests;
    failNext = true;
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'et le PDF ?', author: 'L' });
    h.runner.release(run!.runId);
    await h.orch.drained();
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['session.prompted', 'run.finished']);
    // The only dev slot is free again: another ticket starts its run.
    await h.send('ticket.delegated', { linearSessionId: 'ls-2' }, 'REL-2');
    expect(h.runner.requests).toHaveLength(2);
  });

  it('settles at the next start, with its real result, a run whose result was written but not processed', async () => {
    const inner = new SqliteStore(':memory:');
    let failNext = false;
    const store = Object.assign(Object.create(inner) as SqliteStore, {
      // The crash between the inbox write and the processing: the result is not journaled yet.
      recordEvent: async (e: Parameters<SqliteStore['recordEvent']>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error('database down');
        }
        return inner.recordEvent(e);
      },
    });
    const h = createHarness({ store, preset: testPreset() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    failNext = true;
    h.runner.release(h.runner.requests[0]!.runId);
    await h.orch.drained();
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['run.finished']);

    // recover() runs before the replay: it must not block the ticket and fence the result.
    await h.restart();
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });
    expect(await h.store.pendingInbox(10)).toEqual([]);
  });

  /** A SQLite store whose inbox write fails `failures` times for the ids matching `pattern`. */
  function flakyInbox(pattern: RegExp, failures: number): SqliteStore {
    const inner = new SqliteStore(':memory:');
    return Object.assign(Object.create(inner) as SqliteStore, {
      appendInbox: async (e: Parameters<SqliteStore['appendInbox']>[0]) => {
        if (pattern.test(e.id) && failures > 0) {
          failures--;
          throw new Error('database down');
        }
        return inner.appendInbox(e);
      },
    });
  }

  it('retries the inbox write of run and check results until it goes through', async () => {
    // The harness retries 3 times: two failures for the check, then two for the run result.
    const h = createHarness({ store: flakyInbox(/^check:/, 2), preset: testPreset() });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const ids = (await h.store.recentEvents(50, 'REL-1')).map((e) => e.id);
    expect(ids.filter((id) => /^(attempt|check):/.test(id))).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false });

    const h2 = createHarness({ store: flakyInbox(/^attempt:/, 2) });
    h2.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h2.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h2.store.recentEvents(50, 'REL-1')).map((e) => e.type)).toContain('run.finished');
  });

  it('gives up on a run result after the last attempt without throwing, and leaves the run unsettled', async () => {
    const h = createHarness({ store: flakyInbox(/^attempt:/, Infinity) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect((await h.store.recentEvents(50, 'REL-1')).map((e) => e.type)).not.toContain('run.finished');
    expect(await h.ticket()).toMatchObject({ activeRunId: expect.any(String) });
  });
});
