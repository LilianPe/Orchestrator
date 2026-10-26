import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import { createHarness } from '../helpers/harness.js';
import { createTestDatabase, PG_URL } from '../helpers/pg-database.js';
import { testPreset } from '../helpers/test-preset.js';

const TRUNCATE = `truncate table ${PG_TABLE_NAMES.map((name) => `"${name}"`).join(', ')} restart identity cascade`;

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
    await pool.query(TRUNCATE);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  const harness = (opts: Parameters<typeof createHarness>[0] = {}) => createHarness({ ...opts, store: new PgStore({ pool }) });

  it('takes a delegated ticket through a failed then a passing check to human review', async () => {
    const h = harness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, verifyAttempts: 0 });
    expect(await h.store.runsByStatus('success')).toHaveLength(2);
    const journal = await pool.query<{ type: string }>(`select type from journal where ticket_id = 'REL-1' order by seq`);
    expect(journal.rows.map((r) => r.type)).toEqual(['ticket.delegated', 'run.finished', 'verify.failed', 'run.finished', 'verify.passed']);
    const projection = await pool.query<{ status: string; active_attempts: number }>(`select status, active_attempts from tickets where id = 'REL-1'`);
    expect(projection.rows[0]).toEqual({ status: 'human_review', active_attempts: 0 });
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
    await h.orch.idle();
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]!.cwd).toBe('/tmp/factory-fake/p/REL-2');
    const outbox = await pool.query<{ status: string }>(`select status from outbox`);
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
    await h.orch.submit({ id: 'pause', type: 'control.pause', at: h.clock.now(), projectId: '*', payload: {} });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(0);
    expect(await h.orch.isPaused()).toBe(true);
    await h.orch.submit({ id: 'resume', type: 'control.resume', at: h.clock.now(), projectId: '*', payload: {} });
    await h.orch.idle();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.orch.isPaused()).toBe(false);
  });
});
