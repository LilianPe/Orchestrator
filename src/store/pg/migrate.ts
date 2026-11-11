import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

const DEFAULT_MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');
const JOURNAL = '__drizzle_migrations';
/** Postgres's bound for an identifier: past it, `<schema>_drizzle` would be truncated without a word. */
const MAX_IDENTIFIER = 63;

/**
 * Where Drizzle keeps the journal of the migrations applied to `schema`: `drizzle`, its default, for
 * `public`; beside the schema otherwise, so two schemas of one database each have theirs (ORC-334).
 */
export function journalSchemaOf(schema: string): string {
  if (schema === 'public') return 'drizzle';
  const journal = `${schema}_drizzle`;
  if (Buffer.byteLength(journal) > MAX_IDENTIFIER) throw new Error(`schema name too long for its migration journal: ${schema}`);
  return journal;
}

/**
 * The journal of `schema` as found in the database: before ORC-334 it was in `drizzle` whatever the
 * search_path, so a schema already migrated with no journal beside it keeps that one.
 */
async function journalSchema(pool: Pool, schema: string): Promise<string> {
  const own = journalSchemaOf(schema);
  if (own === 'drizzle') return own;
  const { rows } = await pool.query<{ own: string | null; legacy: string | null; tables: number }>(
    `select to_regclass(format('%I.%I', $1::text, $3::text)) as own, to_regclass(format('%I.%I', 'drizzle', $3::text)) as legacy,
            (select count(*)::int from information_schema.tables where table_schema = $2) as tables`,
    [own, schema, JOURNAL],
  );
  const found = rows[0];
  return !found?.own && found?.legacy && found.tables > 0 ? 'drizzle' : own;
}

/** Applies `drizzle/` to an empty schema, the first of the search_path (or brings it to the latest migration). */
export async function migratePgStore(pool: Pool, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): Promise<void> {
  const { rows } = await pool.query<{ schema: string | null }>('select current_schema() as schema');
  const schema = rows[0]?.schema;
  if (!schema) throw new Error('migratePgStore: no schema of the search_path exists');
  await migrate(drizzle(pool), { migrationsFolder, migrationsSchema: await journalSchema(pool, schema) });
}
