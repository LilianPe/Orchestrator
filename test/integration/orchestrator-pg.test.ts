import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { createHarness } from '../helpers/harness.js';
import { createTestDatabase, PG_URL, TRUNCATE_ALL } from '../helpers/pg-database.js';
import { expectFirstRunMeasures, firstRun } from '../helpers/measures-scenario.js';
import { testPreset } from '../helpers/test-preset.js';

// The orchestrator on PgStore, through the scenario harness: the daemon's path once
// FACTORY_DATABASE_URL is set. The full harness moves to Postgres with ORC-228.
describe.skipIf(!PG_URL)('orchestrator on PgStore', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('factory_orch');
    pool = new Pool({ connectionString: db.url, max: 4 });
    await migratePgStore(pool);
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_ALL);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  const harness = (opts: Parameters<typeof createHarness>[0] = {}) => createHarness({ ...opts, store: new PgStore({ pool }) });

  it('writes the measures of the first run, the same as on SQLite (ORC-235)', async () => {
    expectFirstRunMeasures(await firstRun(harness()));
    const attempts = await pool.query<{ step: string; input_tokens: string | null }>(`select step, input_tokens from attempts order by started_at, id`);
    expect(attempts.rows.filter((r) => r.input_tokens !== null).map((r) => r.step).sort()).toEqual(['ask', 'dev', 'review']);
    const acked = await pool.query(`select type from inbox where acked_at is not null order by type`);
    expect(acked.rows.map((r) => r.type)).toEqual(['session.mentioned', 'ticket.delegated']);
  });

  it('takes a delegated ticket through a failed then a passing check to human review', async () => {
    const h = harness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, verifyAttempts: 0 });
    expect(await h.store.runsByStatus('success')).toHaveLength(2);
    const journal = await pool.query<{ type: string }>(`select type from journal where ticket_id = 'REL-1' order by seq`);
    // The results of the effects (ORC-150) are journaled too: left out here.
    expect(journal.rows.map((r) => r.type).filter((t) => !t.startsWith('effect.'))).toEqual([
      'ticket.delegated', 'run.finished', 'verify.failed', 'run.finished', 'verify.passed',
    ]);
    expect(journal.rows.map((r) => r.type)).not.toContain('effect.failed');
    const projection = await pool.query<{ status: string; active_attempts: number }>(`select status, active_attempts from tickets where id = 'REL-1'`);
    expect(projection.rows[0]).toEqual({ status: 'human_review', active_attempts: 0 });
  });

  it('starts a queued item whose holder died before its start, once its lease expired (ORC-150)', async () => {
    const h = harness({ projectYaml: 'version: 1\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Un' });
    await h.store.setMeta('paused', '1');
    await h.send('ticket.delegated', { linearSessionId: 'a' });
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-1']);
    // Another daemon took it, then died: its lease is already over.
    expect(await h.store.claimQueued('dev', -1)).toBeDefined();
    await h.store.setMeta('paused', '0');
    await h.orch.tick();
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toEqual([]);
    expect((await pool.query(`select status from outbox where payload ? 'queue'`)).rows).toEqual([{ status: 'done' }]);
  });

  it('respects the parallel cap and drains the queue through the outbox', async () => {
    const h = harness({ projectYaml: 'version: 1\nlimits: { parallel_sessions: 1 }\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Un' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Deux' });
    h.runner.enqueue({ hold: true }, {});
    await h.send('ticket.delegated', { linearSessionId: 'a' }, 'REL-1');
    await h.send('ticket.delegated', { linearSessionId: 'b' }, 'REL-2');
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toHaveLength(1);
    h.runner.release((await h.ticket('REL-1')).activeRunId!);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]!.cwd).toBe('/tmp/factory-fake/p/REL-2');
    // The queue item; the decisions' own outbox rows (ORC-149) are not queue rows.
    const outbox = await pool.query<{ status: string }>(`select status from outbox where payload ? 'queue'`);
    expect(outbox.rows).toEqual([{ status: 'done' }]);
  });

  it('blocks a ticket whose run a restart cut, and resumes it on a reply', async () => {
    const h = harness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    await h.restart();
    expect((await h.store.getRun(runId))!.status).toBe('stopped');
    expect(await h.ticket()).toMatchObject({ blocked: true, logical: 'dev' });
    expect(h.tracker.activities('ls-1').at(-1)).toMatchObject({ type: 'elicitation', body: expect.stringContaining('redémarré') });
    h.runner.enqueue({ events: [{ kind: 'text', text: 'Repris.' }] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'reprends', author: 'L' });
    expect(h.runner.requests[1]).toMatchObject({ resume: true, claudeSessionId: h.runner.requests[0]!.claudeSessionId });
    expect((await h.ticket()).blocked).toBe(false);
  });

  it('pauses the queue through meta and drains it on resume', async () => {
    const h = harness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.orch.accept({ id: 'pause', type: 'control.pause', at: h.clock.now(), projectId: '*', payload: {} });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(0);
    expect(await h.orch.isPaused()).toBe(true);
    await h.orch.accept({ id: 'resume', type: 'control.resume', at: h.clock.now(), projectId: '*', payload: {} });
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.orch.isPaused()).toBe(false);
  });
});
