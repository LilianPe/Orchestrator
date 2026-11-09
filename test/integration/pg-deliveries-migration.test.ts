import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { createTestDatabase, migrationsUpTo, PG_URL } from '../helpers/pg-database.js';

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
    // The meta rows as written before ORC-355, `setMeta`'s shape; their time, the order received.
    let now = 0;
    const old = new PgStore({ pool, now: () => now });
    const meta = async (key: string, value: string, at: number) => {
      now = at * 1000;
      await old.setMeta(key, value);
    };
    await meta('delivery:Comment:comment:c2', '{"raw":"2","at":2}', 20);
    await meta('delivery:AgentSessionEvent:activity:a1', '{"raw":"1","at":1}', 10);
    await meta('delivery-aside:bad', '{broken', 5);
    await meta('paused', '1', 1);
    // Without its value: moved whole, for the ingest to set aside as unreadable, rather than the migration failing.
    await pool.query(`insert into workflow_versions (id, hash, definition, created_at) values ('meta:delivery:odd', 'h-odd', '{"key":"delivery:odd"}'::jsonb, to_timestamp(30))`);

    await migratePgStore(pool);

    const store = new PgStore({ pool, now: () => 0 });
    expect(await store.pendingDeliveries()).toEqual([
      { key: 'AgentSessionEvent:activity:a1', value: '{"raw":"1","at":1}' },
      { key: 'Comment:comment:c2', value: '{"raw":"2","at":2}' },
      { key: 'odd', value: '{"key": "delivery:odd"}' },
    ]);
    expect(await store.asideDeliveries()).toEqual([{ key: 'bad', value: '{broken' }]);
    const left = await pool.query<{ id: string }>(`select id from workflow_versions order by id`);
    expect(left.rows.map((r) => r.id)).toEqual(['meta:paused']);
    expect(await store.getMeta('paused')).toBe('1');
  });
});
