import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflow } from '../../src/config/load-workflow.js';
import { TRUSTED } from '../../src/core/types.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
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
    expect(await h.store.pendingInbox(10)).toEqual([]);
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
});
