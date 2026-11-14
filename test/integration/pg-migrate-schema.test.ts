import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journalSchemaOf, migratePgStore } from '../../src/store/pg/migrate.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import { createTestSchema, PG_URL, queryOn, type TestSchema } from '../helpers/pg-database.js';

function withSearchPath(url: string, path: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${path}`);
  return u.toString();
}

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

      // An empty schema placed before the migrated one (a schema named after the role, `"$user", public`):
      // the engine's tables still resolve to the migrated one, so nothing is applied to it, as before ORC-334.
      const before = await createTestSchema('factory_mig_user');
      const behind = new Pool({ connectionString: withSearchPath(before.url, `${before.name},${legacy.name}`), max: 1 });
      try {
        await migratePgStore(behind);
        expect(await tablesOf(before.name)).toEqual([]);
        expect(await tablesOf(journalSchemaOf(before.name))).toEqual([]);
      } finally {
        await behind.end();
        await before.drop();
      }

      // A schema that holds a table of its own but not the engine's: a schema to migrate, journal beside it.
      const foreign = await createTestSchema('factory_mig_foreign');
      const fresh = new Pool({ connectionString: foreign.url, max: 1 });
      try {
        await fresh.query('create table unrelated (id int)');
        await migratePgStore(fresh);
        expect(await tablesOf(foreign.name)).toEqual([...PG_TABLE_NAMES, 'unrelated'].sort());
        expect(await tablesOf(journalSchemaOf(foreign.name))).toEqual(['__drizzle_migrations']);
      } finally {
        await fresh.end();
        await foreign.drop();
      }

      // A name too long for a journal beside it: migrated before ORC-334, it keeps the journal in drizzle.
      const long = `factory_mig_long_${'x'.repeat(40)}`;
      await queryOn(PG_URL, (c) => c.query(`create schema "${long}"`));
      const longPool = new Pool({ connectionString: withSearchPath(PG_URL, long), max: 1 });
      try {
        // drizzle already holds a full journal: its tables come through a journal dropped right after.
        await migrate(drizzle(longPool), { migrationsFolder: 'drizzle', migrationsSchema: `${long}_tmp` });
        await queryOn(PG_URL, (c) => c.query(`drop schema "${long}_tmp" cascade`));
        await expect(migratePgStore(longPool)).resolves.toBeUndefined();
      } finally {
        await longPool.end();
        await queryOn(PG_URL, (c) => c.query(`drop schema if exists "${long}", "${long}_tmp" cascade`));
      }
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
        // pg_class rather than information_schema.sequences, which leaves out those of identity columns.
        `select 'sequence' as kind, relname as name from pg_class where relkind = 'S' and relnamespace = $1::regnamespace
         union all
         select 'foreign key', constraint_name from information_schema.table_constraints where table_schema = $1 and constraint_type = 'FOREIGN KEY'`,
        [a.name],
      ),
    );
    expect(rows).toEqual([]);
  });
});
