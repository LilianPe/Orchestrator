import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { createTestDatabase, PG_URL } from '../helpers/pg-database.js';

const DRIZZLE = join(import.meta.dirname, '../../drizzle');

/** `drizzle/` as it was up to the migration `tag`, included: a database migrated by an older daemon. */
function migrationsUpTo(tag: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'factory-drizzle-')), 'drizzle');
  cpSync(DRIZZLE, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((e) => e.tag === tag);
  expect(last).toBeGreaterThanOrEqual(0);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }));
  return dir;
}

describe.skipIf(!PG_URL)('the deliveries a database kept in its meta rows before their table (ORC-355)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('factory_deliveries');
    pool = new Pool({ connectionString: db.url, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('moves the kept and the set-aside deliveries to their table, in the order received, and leaves the other meta rows', async () => {
    await migratePgStore(pool, migrationsUpTo('0010_baselines'));
    // As `receiveDelivery`, `asideDelivery` and `setMeta` wrote them before ORC-355.
    const meta = (id: string, key: string, value: string, at: number) =>
      pool.query(`insert into workflow_versions (id, hash, definition, created_at) values ($1, $2, $3::jsonb, to_timestamp($4))`, [id, `h-${id}`, JSON.stringify({ key, value }), at]);
    await meta('meta:delivery:Comment:comment:c2', 'delivery:Comment:comment:c2', '{"raw":"2","at":2}', 20);
    await meta('meta:delivery:AgentSessionEvent:activity:a1', 'delivery:AgentSessionEvent:activity:a1', '{"raw":"1","at":1}', 10);
    await meta('meta:delivery-aside:bad', 'delivery-aside:bad', '{broken', 5);
    await meta('meta:paused', 'paused', '1', 1);

    await migratePgStore(pool);

    const store = new PgStore({ pool, now: () => 0 });
    expect(await store.pendingDeliveries()).toEqual([
      { key: 'AgentSessionEvent:activity:a1', value: '{"raw":"1","at":1}' },
      { key: 'Comment:comment:c2', value: '{"raw":"2","at":2}' },
    ]);
    expect(await store.asideDeliveries()).toEqual([{ key: 'bad', value: '{broken' }]);
    const left = await pool.query<{ id: string }>(`select id from workflow_versions order by id`);
    expect(left.rows.map((r) => r.id)).toEqual(['meta:paused']);
    expect(await store.getMeta('paused')).toBe('1');
  });
});
