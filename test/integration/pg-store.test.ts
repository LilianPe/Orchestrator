import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newTicketState, SCHEMA_VERSION, TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { OUTBOX_LEASE_MS, PgStore } from '../../src/store/pg/pg-store.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import type { QueueItem, RunRecord } from '../../src/store/types.js';
import { createTestDatabase, PG_URL, TRUNCATE_ALL as TRUNCATE } from '../helpers/pg-database.js';
import { storeContract } from '../helpers/store-suite.js';

const url = PG_URL;

function queueItem(patch: Partial<QueueItem>): QueueItem {
  return {
    projectId: 'p',
    ticketId: 'REL-1',
    job: 'dev',
    queue: 'dev',
    priority: 0,
    enqueuedAt: 1,
    ...patch,
  };
}

function runRecord(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    projectId: 'p',
    ticketId: 'REL-1',
    job: 'dev',
    queue: 'dev',
    status: 'running',
    claudeSessionId: 'c1',
    startedAt: 100,
    costUsd: 0.5,
    turns: 0,
    lastText: '',
    token: 't1',
    cwd: '/tmp',
    ...patch,
  };
}

describe.skipIf(!url)('PgStore integration', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let store: PgStore;

  beforeAll(async () => {
    db = await createTestDatabase('factory_pgstore');
    pool = new Pool({ connectionString: db.url, max: 4 });
    await migratePgStore(pool);
    store = new PgStore({ pool, now: () => 1_000_000 });
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('applies the migration to an empty database and creates exactly the twelve tables', async () => {
    const migrations = await pool.query<{ n: number }>(
      `select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(migrations.rows[0]?.n).toBeGreaterThanOrEqual(1);

    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...PG_TABLE_NAMES].sort());

    for (const table of PG_TABLE_NAMES) {
      const key = await pool.query<{ n: number }>(
        `select count(*)::int as n from information_schema.table_constraints
         where table_schema = 'public' and table_name = $1 and constraint_type = 'PRIMARY KEY'`,
        [table],
      );
      expect(key.rows[0]?.n, `primary key on ${table}`).toBe(1);
    }
  });

  it('creates the ticket, status, due and availability indexes', async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const names = new Set(indexes.rows.map((row) => row.indexname));
    for (const expected of [
      'inbox_event_id_uq',
      'journal_event_id_uq',
      'journal_ticket_seq_uq',
      'tickets_status_idx',
      'outbox_ticket_id_idx',
      'outbox_status_idx',
      'outbox_available_at_idx',
      'timers_ticket_id_idx',
      'timers_due_at_idx',
      'dead_letter_event_id_uq',
      'workflow_versions_hash_uq',
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
  });

  it('stores payloads as jsonb and all timestamps with a time zone', async () => {
    const jsonColumns = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public'
         and column_name in ('payload', 'data', 'decision', 'definition', 'human_inbox', 'fingerprints')`,
    );
    expect(jsonColumns.rows.length).toBeGreaterThanOrEqual(11);
    expect(jsonColumns.rows.every((row) => row.data_type === 'jsonb')).toBe(true);

    const badTimestamps = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and column_name in ('created_at', 'updated_at', 'received_at', 'processed_at', 'due_at', 'available_at', 'started_at', 'ended_at')
         and data_type <> 'timestamp with time zone'`,
    );
    expect(badTimestamps.rows).toEqual([]);
  });

  it('enforces the inbox event_id uniqueness constraint', async () => {
    await pool.query(
      `insert into inbox (id, event_id, type, payload) values ('i1', 'delivery-1', 'control.pause', '{}'::jsonb)`,
    );
    await expect(
      pool.query(
        `insert into inbox (id, event_id, type, payload) values ('i2', 'delivery-1', 'control.pause', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('round-trips a ticket and fills the projection columns', async () => {
    const ticket = {
      ...newTicketState('p', 'REL-1', 'Ticket', 'dev', 1_000, 2),
      pendingJob: { job: 'dev-feedback' },
      activeRunId: 'r1',
      pendingFeedback: [{ author: 'a', body: 'b', at: 2, source: 'session' as const }],
      updatedAt: 1_500,
    };
    await store.putTicket(ticket, { workflowHash: 'wf-1' });

    expect(await store.getTicket('p', 'REL-1')).toEqual(ticket);
    expect(await store.getTicket('other', 'REL-1')).toBeUndefined();
    expect(await store.listTickets()).toEqual([ticket]);

    const projection = await pool.query<{
      status: string;
      step_cursor: string;
      active_attempts: number;
      human_inbox: unknown;
      workflow_hash: string;
    }>('select status, step_cursor, active_attempts, human_inbox, workflow_hash from tickets where id = $1', [
      'REL-1',
    ]);
    expect(projection.rows[0]).toMatchObject({
      status: 'dev',
      step_cursor: 'dev-feedback',
      active_attempts: 1,
      workflow_hash: 'wf-1',
      human_inbox: ticket.pendingFeedback,
    });

    await store.putTicket({ ...ticket, logical: 'human_review' });
    expect(await store.getTicket('p', 'REL-1')).toMatchObject({ logical: 'human_review' });
    const kept = await pool.query<{ workflow_hash: string }>(
      'select workflow_hash from tickets where id = $1',
      ['REL-1'],
    );
    expect(kept.rows[0]?.workflow_hash).toBe('wf-1');
  });

  it('deduplicates events and writes inbox + journal in one transaction', async () => {
    const first = {
      id: 'e1',
      type: 'control.pause',
      at: 1_000,
      projectId: 'p',
      ticketId: 'REL-1',
      payload: {},
    } as FactoryEvent;
    const second = {
      id: 'e2',
      type: 'control.resume',
      at: 1_001,
      projectId: 'p',
      ticketId: 'REL-1',
      payload: {},
    } as FactoryEvent;

    expect(await store.recordEvent(first)).toBe(true);
    expect(await store.recordEvent(first)).toBe(false);
    expect(await store.recordEvent(second)).toBe(true);

    const counts = await pool.query<{ inbox: number; journal: number }>(
      `select (select count(*) from inbox)::int as inbox, (select count(*) from journal)::int as journal`,
    );
    expect(counts.rows[0]).toEqual({ inbox: 2, journal: 2 });
    // Journaled means handled: no inbox row is left for a replay to take as unprocessed.
    const pending = await pool.query('select id from inbox where processed_at is null');
    expect(pending.rows).toEqual([]);

    const journal = await pool.query<{ event_id: string; seq: number; type: string }>(
      'select event_id, seq, type from journal where ticket_id = $1 order by seq',
      ['REL-1'],
    );
    expect(journal.rows).toEqual([
      { event_id: 'e1', seq: 1, type: 'control.pause' },
      { event_id: 'e2', seq: 2, type: 'control.resume' },
    ]);
    expect(await store.recentEvents(10)).toEqual([second, first]);
    expect(await store.recentEvents(1, 'REL-1')).toEqual([second]);
  });

  it('lists recent events newest recorded first, whatever their own `at`', async () => {
    let now = 2_000_000;
    const ticking = new PgStore({ pool, now: () => (now += 1_000) });
    const a = { id: 'a', type: 'control.pause', at: 5_000, projectId: 'p', ticketId: 'REL-1', payload: {} } as FactoryEvent;
    const b = { id: 'b', type: 'control.resume', at: 1.5, projectId: 'p', ticketId: 'REL-2', payload: {} } as FactoryEvent;
    await ticking.recordEvent(a);
    await ticking.recordEvent(b);
    expect(await ticking.recentEvents(10)).toEqual([b, a]);
  });

  it('records the schema version the event carries in the inbox and journal columns', async () => {
    await store.recordEvent({ ...TRUSTED, id: 'e-v2', type: 'control.pause', at: 1_000, projectId: 'p', ticketId: 'REL-1', payload: {} });
    const rows = await pool.query<{ inbox: number; journal: number }>(
      `select (select schema_version from inbox where event_id = 'e-v2') as inbox,
              (select schema_version from journal where event_id = 'e-v2') as journal`,
    );
    expect(rows.rows[0]).toEqual({ inbox: SCHEMA_VERSION, journal: SCHEMA_VERSION });
  });

  it('rolls the inbox insert back when the journal insert fails', async () => {
    await pool.query(
      `insert into journal (id, ticket_id, event_id, seq, type, payload, created_at)
       values ('seed', 'REL-1', 'e-rollback', 1, 'control.pause', '{}'::jsonb, now())`,
    );
    await expect(
      store.recordEvent({
        id: 'e-rollback',
        type: 'control.pause',
        at: 1_000,
        projectId: 'p',
        ticketId: 'REL-1',
        payload: {},
      } as FactoryEvent),
    ).rejects.toThrow();

    const inbox = await pool.query<{ n: number }>(
      `select count(*)::int as n from inbox where event_id = 'e-rollback'`,
    );
    expect(inbox.rows[0]?.n).toBe(0);
  });

  it('stores runs as attempts and computes cost since a timestamp', async () => {
    await store.putRun(runRecord());
    await store.putRun(runRecord({ id: 'r2', token: 't2', status: 'success', costUsd: 1.5, startedAt: 200 }));

    expect(await store.getRun('r1')).toEqual(runRecord());
    expect((await store.findRunByToken('t2'))?.id).toBe('r2');
    expect((await store.runsByStatus('running')).map((run) => run.id)).toEqual(['r1']);
    expect((await store.runsByStatus('success')).map((run) => run.id)).toEqual(['r2']);
    expect(await store.costSince(150)).toBe(1.5);
    expect(await store.costSince(0)).toBe(2);
  });

  it('reads due timers without consuming them, and supports deletion', async () => {
    const timer = { key: 'REL-1:dev-feedback', projectId: 'p', ticketId: 'REL-1', job: 'dev-feedback', fireAt: 5_000 };
    await store.putTimer(timer);

    expect(await store.dueTimers(4_999)).toEqual([]);
    expect(await store.dueTimers(5_000)).toEqual([timer]);
    // A pass cut before deleteTimer (an error, a shutdown) finds the timer again.
    expect(await store.dueTimers(10_000)).toEqual([timer]);

    const pending = await pool.query<{ status: string }>('select status from timers where id = $1', [timer.key]);
    expect(pending.rows[0]?.status).toBe('pending');

    await store.putTimer({ ...timer, fireAt: 9_000 });
    await store.deleteTimer(timer.key);
    expect(await store.dueTimers(10_000)).toEqual([]);

    await store.putTimer({ key: 'REL-2:x', projectId: 'p', ticketId: 'REL-2', job: 'x', fireAt: 1_000 });
    await store.putTimer({ key: 'REL-3:y', projectId: 'other', ticketId: 'REL-3', job: 'y', fireAt: 1_000 });
    await store.deleteTimersFor('p', 'REL-2');
    expect((await store.dueTimers(10_000)).map((t) => t.key)).toEqual(['REL-3:y']);
  });

  it('dedupes queue-shaped outbox rows by ticket and job', async () => {
    const first = await store.enqueue(queueItem({ ticketId: 'DUP', job: 'dev', enqueuedAt: 1_000 }));
    const second = await store.enqueue(queueItem({ ticketId: 'DUP', job: 'dev', enqueuedAt: 2_000 }));
    expect(second).toBe(first);
    expect((await store.listQueue()).filter((item) => item.ticketId === 'DUP')).toHaveLength(1);

    const otherJob = await store.enqueue(queueItem({ ticketId: 'DUP', job: 'ask', enqueuedAt: 2_000 }));
    expect(otherJob).not.toBe(first);
    expect((await store.listQueue()).filter((item) => item.ticketId === 'DUP')).toHaveLength(2);
  });

  it('claims the outbox by available_at and marks claimed effects running', async () => {
    const idA = await store.enqueue(queueItem({ ticketId: 'A', enqueuedAt: 1_000 }));
    const idB = await store.enqueue(queueItem({ ticketId: 'B', enqueuedAt: 3_000 }));
    const idC = await store.enqueue(queueItem({ ticketId: 'C', enqueuedAt: 2_000 }));

    expect(idA).toMatch(/^A:\d+:\d+$/);
    expect(idB).toMatch(/^B:\d+:\d+$/);
    expect(idC).toMatch(/^C:\d+:\d+$/);
    expect(await store.listQueue()).toHaveLength(3);

    const first = await store.claim('dev', 4_000);
    expect(first).toMatchObject({ id: idA, ticketId: 'A', effect: 'dev', status: 'running', attempts: 1 });
    expect(first?.leaseUntil).toBe(4_000 + OUTBOX_LEASE_MS);
    expect((await store.claim('dev', 4_000))?.ticketId).toBe('C');
    expect((await store.claim('dev', 4_000))?.ticketId).toBe('B');
    expect(await store.claim('dev', 4_000)).toBeUndefined();

    const statuses = await pool.query<{ status: string }>('select status from outbox order by id');
    expect(statuses.rows.map((row) => row.status)).toEqual(['running', 'running', 'running']);
  });

  it('reclaims an outbox effect once its lease expires', async () => {
    const id = await store.enqueue(queueItem({ ticketId: 'LEASE', enqueuedAt: 1_000 }));
    expect((await store.claim('dev', 2_000))?.attempts).toBe(1);
    expect(await store.claim('dev', 2_000 + OUTBOX_LEASE_MS - 1)).toBeUndefined();

    const reclaimed = await store.claim('dev', 2_000 + OUTBOX_LEASE_MS + 1);
    expect(reclaimed).toMatchObject({ id, ticketId: 'LEASE', attempts: 2 });
  });

  it('removes queued work for a ticket', async () => {
    await store.enqueue(queueItem({ ticketId: 'D', enqueuedAt: 1_000 }));
    await store.enqueue(queueItem({ ticketId: 'E', enqueuedAt: 1_000 }));
    await store.removeFromQueue('p', 'D');
    expect((await store.listQueue()).map((item) => item.ticketId)).toEqual(['E']);
  });

  it('expires echoes and persists meta across store instances', async () => {
    await store.putEcho('state:REL-1:Done', 100);
    expect(await store.isEcho('state:REL-1:Done', 99)).toBe(true);
    expect(await store.isEcho('state:REL-1:Done', 101)).toBe(false);
    expect(await store.isEcho('state:REL-2:Done', 99)).toBe(false);

    await store.setMeta('paused', '1');
    expect(await store.getMeta('paused')).toBe('1');
    expect(await store.getMeta('missing')).toBeUndefined();

    const other = new PgStore({ pool });
    expect(await other.getMeta('paused')).toBe('1');
    await other.setMeta('paused', '0');
    expect(await store.getMeta('paused')).toBe('0');
  });

  it('accepts rows in the decision, dead-letter, workflow and evidence tables', async () => {
    await store.putRun(runRecord());
    await pool.query(
      `insert into decision_trace (id, ticket_id, event_id, decision)
       values ('dt1', 'REL-1', 'e1', '{"kind":"run"}'::jsonb)`,
    );
    await pool.query(
      `insert into dead_letter (id, event_id, reason, payload)
       values ('dl1', 'e2', 'bad-event', '{"type":"x"}'::jsonb)`,
    );
    await pool.query(
      `insert into workflow_versions (id, hash, definition) values ('wv1', 'hash-1', '{"version":1}'::jsonb)`,
    );
    await pool.query(
      `insert into findings (id, attempt_id, kind, severity, body)
       values ('f1', 'r1', 'review', 'warning', 'body')`,
    );
    await pool.query(
      `insert into freezes (id, ticket_id, path, hash) values ('fz1', 'REL-1', 'src/a.ts', 'sha')`,
    );
    await pool.query(
      `insert into artifacts (id, ticket_id, attempt_id, kind, path, sha256)
       values ('a1', 'REL-1', 'r1', 'log', '/tmp/log', 'sha')`,
    );

    const counts = await pool.query<Record<string, number>>(
      `select
         (select count(*) from decision_trace)::int as decision_trace,
         (select count(*) from dead_letter)::int as dead_letter,
         (select count(*) from workflow_versions)::int as workflow_versions,
         (select count(*) from findings)::int as findings,
         (select count(*) from freezes)::int as freezes,
         (select count(*) from artifacts)::int as artifacts`,
    );
    expect(counts.rows[0]).toEqual({
      decision_trace: 1,
      dead_letter: 1,
      workflow_versions: 1,
      findings: 1,
      freezes: 1,
      artifacts: 1,
    });
  });
});

describe.skipIf(!url)('PgStore, Store contract', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('factory_contract');
    pool = new Pool({ connectionString: db.url, max: 4 });
    await migratePgStore(pool);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  storeContract(async () => {
    await pool.query(TRUNCATE);
    return new PgStore({ pool });
  });

  it('takes a dequeued item out for good: no lease brings it back', async () => {
    await pool.query(TRUNCATE);
    const store = new PgStore({ pool, now: () => 1_000 });
    const id = await store.enqueue(queueItem({ ticketId: 'ONCE', enqueuedAt: 500 }));
    expect((await store.dequeue('dev'))?.ticketId).toBe('ONCE');
    expect(await store.claim('dev', 1_000 + 10 * OUTBOX_LEASE_MS)).toBeUndefined();
    expect(await store.dequeue('dev')).toBeUndefined();
    const row = await pool.query<{ status: string }>('select status from outbox where id = $1', [id]);
    expect(row.rows[0]?.status).toBe('done');
  });

  it('settles a claimed effect with completeEffect', async () => {
    await pool.query(TRUNCATE);
    const store = new PgStore({ pool, now: () => 1_000 });
    const id = await store.enqueue(queueItem({ ticketId: 'DONE', enqueuedAt: 500 }));
    expect((await store.claim('dev', 1_000))?.id).toBe(id);
    await store.completeEffect(id);
    expect(await store.claim('dev', 1_000 + 10 * OUTBOX_LEASE_MS)).toBeUndefined();
  });
});
