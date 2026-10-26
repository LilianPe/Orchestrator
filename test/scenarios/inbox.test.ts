import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    await h.orch.idle();
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
    await h.orch.idle();
    expect(await h.store.getTicket('p', 'REL-1')).toBeUndefined();
    expect((await h.store.pendingInbox(10)).map((e) => e.type)).toEqual(['ticket.delegated']);

    // Not retried in a loop by the same process: a later event leaves it pending.
    await h.orch.submit({ ...TRUSTED, id: 'ui:resume', type: 'control.resume', at: h.clock.now(), projectId: '*', payload: {} });
    await h.orch.idle();
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
});
