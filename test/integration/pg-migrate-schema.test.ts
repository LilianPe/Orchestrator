import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journalSchemaOf, migratePgStore } from '../../src/store/pg/migrate.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import { createTestSchema, PG_URL, queryOn, type TestSchema } from '../helpers/pg-database.js';

describe.skipIf(!PG_URL)('migrations in the schema of the search_path (ORC-334)', () => {
  let a: TestSchema;
  let b: TestSchema;

  beforeAll(async () => {
    [a, b] = await Promise.all([createTestSchema('factory_mig_a'), createTestSchema('factory_mig_b')]);
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

  it('keeps the journal of the public schema where it always was', () => {
    expect(journalSchemaOf('public')).toBe('drizzle');
    expect(journalSchemaOf('tenant')).toBe('tenant_drizzle');
  });

  it('migrates two schemas of one database each on its own, the journal beside each', async () => {
    for (const s of [a, b]) {
      expect(await tablesOf(s.name)).toEqual([...PG_TABLE_NAMES].sort());
      expect(await tablesOf(journalSchemaOf(s.name))).toEqual(['__drizzle_migrations']);
    }
  });

  it('has neither sequence nor foreign key: deleting the rows resets a schema (EMPTY_ALL)', async () => {
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
