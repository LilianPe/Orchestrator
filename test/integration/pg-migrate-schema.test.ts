import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journalSchemaOf, migratePgStore } from '../../src/store/pg/migrate.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import { createTestSchema, PG_URL, queryOn, type TestSchema } from '../helpers/pg-database.js';

describe.skipIf(!PG_URL)('migrations in the schema of the search_path (ORC-334)', () => {
  let a: TestSchema;
  let b: TestSchema;

  beforeAll(async () => {
    // Each assigned as soon as made: if the other fails, afterAll still drops it.
    await Promise.all([createTestSchema('factory_mig_a').then((s) => (a = s)), createTestSchema('factory_mig_b').then((s) => (b = s))]);
    for (const s of [a, b]) {
      const pool = new Pool({ connectionString: s.url, max: 1 });
      await migratePgStore(pool).finally(() => pool.end());
    }
  });

  afterAll(async () => {
    await Promise.all([a?.drop(), b?.drop()]);
  });

  const tablesOf = (schema: string) =>
    queryOn(PG_URL, async (c) =>
      (await c.query<{ name: string }>(`select table_name as name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE'`, [schema])).rows
        .map((r) => r.name)
        .sort(),
    );

  it('migrates two schemas of one database each on its own, the journal beside each', async () => {
    for (const s of [a, b]) {
      expect(await tablesOf(s.name)).toEqual([...PG_TABLE_NAMES].sort());
      expect(await tablesOf(journalSchemaOf(s.name))).toEqual(['__drizzle_migrations']);
    }
  });

  it('keeps the journal of a schema migrated before ORC-334, left in drizzle', async () => {
    const legacy = await createTestSchema('factory_mig_legacy');
    const hadDrizzle = await queryOn(PG_URL, async (c) => (await c.query(`select 1 from pg_namespace where nspname = 'drizzle'`)).rowCount === 1);
    const pool = new Pool({ connectionString: legacy.url, max: 1 });
    try {
      // A journal already in drizzle (a run killed here) would make the legacy migration below a no-op.
      expect(hadDrizzle, 'a drizzle schema left in the test database').toBe(false);
      // As migratePgStore did before ORC-334: the journal in drizzle, whatever the search_path.
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
      await migratePgStore(pool);
      expect(await tablesOf(legacy.name)).toEqual([...PG_TABLE_NAMES].sort());
      expect(await tablesOf(journalSchemaOf(legacy.name))).toEqual([]);
    } finally {
      await pool.end();
      await legacy.drop();
      if (!hadDrizzle) await queryOn(PG_URL, (c) => c.query('drop schema if exists drizzle cascade'));
    }
  });

  // A sequence or a foreign key is fine for the store, but EMPTY_ALL would then have to reset or order them.
  it('has neither sequence nor foreign key, which EMPTY_ALL relies on to reset a test schema', async () => {
    const { rows } = await queryOn(PG_URL, (c) =>
      c.query<{ kind: string; name: string }>(
        `select 'sequence' as kind, sequence_name as name from information_schema.sequences where sequence_schema = $1
         union all
         select 'foreign key', constraint_name from information_schema.table_constraints where table_schema = $1 and constraint_type = 'FOREIGN KEY'`,
        [a.name],
      ),
    );
    expect(rows).toEqual([]);
  });
});
