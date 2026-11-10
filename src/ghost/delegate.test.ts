import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTracker } from '../adapters/tracker/fake.js';
import { mayCheck } from '../core/engine.js';
import type { FactoryEvent } from '../core/types.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { HOST_RUNS_REFUSED, Replays, replayDelegationId } from './delegate.js';
import type { GhostReplay, GhostTicket } from './replay.js';
import { loadWorkflow } from '../config/load-workflow.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** When the start commit of each ticket was made: what the tickets' comments and links are kept before. */
const START = 1_700_000_000_000;
const NOW = START + 30 * 86_400_000;

const replay = (id: string, tickets: string[], at = NOW): GhostReplay => ({ id, projectId: 'ghost', threshold: 0.6, memory: true, seed: 's', tickets, startedAt: at, startedBy: 'armand' });
const ticket = (replayId: string, ticketId: string, over: Partial<GhostTicket> = {}): GhostTicket => ({
  replayId, ticketId, humanPr: { number: 12, url: 'https://github.test/pr/12', author: 'lilian' }, mergeSha: 'merge12', start: 'start-sha-of-' + ticketId,
  env: 'unchecked', outcome: 'pending', costUsd: 0, assumptions: 0, at: NOW, ...over,
});

async function withReplays(o: { sandboxes?: boolean } = {}) {
  const store = new SqliteStore(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'ghost-delegate-'));
  dirs.push(dir);
  const tracker = new FakeTracker();
  tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits as CSV from their list.', createdAt: START - 86_400_000, stateName: 'Done', stateType: 'completed' });
  tracker.addIssue({ identifier: 'REL-2', title: 'Audit list', description: 'The list of the audits.', createdAt: START - 2 * 86_400_000 });
  tracker.addIssue({ identifier: 'REL-9', title: 'Follow-up', description: 'Opened after the PR.', createdAt: START + 86_400_000 });
  tracker.addComment('REL-1', 'CSV, not XLSX.', START - 3_600_000);
  tracker.addComment('REL-1', 'Fixed by PR #12.', START + 3_600_000);
  tracker.addComment('REL-2', 'Paginated by 50.', START - 3_600_000);
  tracker.relate('REL-1', 'REL-2');
  tracker.relate('REL-1', 'REL-9');
  const accepted: FactoryEvent[] = [];
  const logs: string[] = [];
  const replays = new Replays({
    store, tracker, dir, projects: ['ghost'], sandboxes: o.sandboxes ?? true,
    accept: async (e) => {
      accepted.push(e);
      return store.appendInbox(e);
    },
    now: () => NOW,
    log: (_level, m) => void logs.push(m),
    startTime: async () => START,
  });
  const rebuilt = async (r: GhostReplay, ...tickets: GhostTicket[]) => {
    await store.putGhostReplay(r);
    for (const t of tickets) {
      mkdirSync(join(dir, r.id, t.ticketId, 'repo'), { recursive: true });
      await store.putGhostTicket(t);
    }
  };
  return { store, dir, tracker, replays, accepted, logs, rebuilt };
}

describe('the daemon delegates each replayed ticket to the replay\'s project (ORC-376)', () => {
  it('once each, a replay\'s delegation, no human, its ticket to do as when the human started', async () => {
    const { replays, accepted, rebuilt } = await withReplays();
    await rebuilt(replay('g1', ['REL-1']), ticket('g1', 'REL-1'));
    await replays.delegate();
    await replays.delegate();
    expect(accepted).toEqual([
      expect.objectContaining({ id: replayDelegationId('g1', 'REL-1'), type: 'ticket.delegated', projectId: 'ghost', ticketId: 'REL-1', taint: 'trusted', payload: { replay: 'g1', issue: { title: 'Export CSV', logical: 'todo', priority: 0 } } }),
    ]);
    expect(accepted[0]!.actor).toBeUndefined();
    // No human to check: the matrix never refuses the replay's own delegation.
    expect(mayCheck(accepted[0]!, loadWorkflow({ packDir: join(import.meta.dirname, '../../packs/standard') }))).toBe(false);
  });

  it('its run reads the ticket, its thread and its linked tickets as they were at the start, on its clone', async () => {
    const { replays, rebuilt, dir } = await withReplays();
    expect(await replays.of('ghost', 'REL-1')).toBeUndefined();
    await rebuilt(replay('g1', ['REL-1']), ticket('g1', 'REL-1'));
    // The knowledge base at transaction time, as `start` rebuilt it with memory on.
    mkdirSync(join(dir, 'g1', 'REL-1', 'knowledge'));
    await replays.delegate();
    const r = await replays.of('ghost', 'REL-1');
    expect(r).toMatchObject({ repoPath: join(dir, 'g1', 'REL-1', 'repo'), knowledge: join(dir, 'g1', 'REL-1', 'knowledge'), issue: { identifier: 'REL-1', title: 'Export CSV', description: 'Export the audits as CSV from their list.', teamKey: 'REL' } });
    expect(r!.issue.url).not.toContain('linear.app');
    expect(r!.history).toContain('CSV, not XLSX.');
    expect(r!.history).toContain('### REL-2 — Audit list');
    expect(r!.history).toContain('Paginated by 50.');
    for (const later of ['Fixed by PR #12.', 'REL-9']) expect(r!.history).not.toContain(later);
    // Read once, at the delegation: kept beside the clone.
    expect(JSON.parse(readFileSync(join(dir, 'g1', 'REL-1', 'ticket.json'), 'utf8'))).toMatchObject({ issue: { identifier: 'REL-1' } });
    // Another project's ticket, the same identifier: no replay of its own.
    expect(await replays.of('live', 'REL-1')).toBeUndefined();
  });

  it('a ticket whose environment failed, or already collected, is not delegated', async () => {
    const { replays, accepted, rebuilt } = await withReplays();
    await rebuilt(replay('g1', ['REL-1', 'REL-2']), ticket('g1', 'REL-1', { env: 'failed', envReason: 'fetch refused' }), ticket('g1', 'REL-2', { outcome: 'pr', factoryPr: 'kept:x' }));
    await replays.delegate();
    expect(accepted).toEqual([]);
  });

  it('ORC-376 criterion 2: a daemon without sandboxes delegates no replayed ticket, and says why once', async () => {
    const { replays, accepted, rebuilt, logs } = await withReplays({ sandboxes: false });
    await rebuilt(replay('g1', ['REL-1']), ticket('g1', 'REL-1'));
    await replays.delegate();
    await replays.delegate();
    expect(accepted).toEqual([]);
    expect(logs).toEqual([`replay g1 not run: ${HOST_RUNS_REFUSED}`]);
  });

  it('a ticket replays once per project: a later replay of it, even written before the first ran, is not delegated, and says why once', async () => {
    const { replays, accepted, rebuilt, logs, dir } = await withReplays();
    // Both written while the daemon was down: the first delegation not processed yet when the second is looked at.
    await rebuilt(replay('g1', ['REL-1'], NOW - 1000), ticket('g1', 'REL-1'));
    await rebuilt(replay('g2', ['REL-1']), ticket('g2', 'REL-1'));
    await replays.delegate();
    await replays.delegate();
    expect(accepted.map((e) => e.id)).toEqual([replayDelegationId('g1', 'REL-1')]);
    expect((await replays.of('ghost', 'REL-1'))!.repoPath).toBe(join(dir, 'g1', 'REL-1', 'repo'));
    expect(logs.filter((l) => l.includes('replays once per project'))).toEqual(['REL-1 of replay g2 not run: ghost replayed it already for g1, a ticket replays once per project']);
  });
});
