import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

const DEFAULT_MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

/**
 * Where Drizzle keeps the journal of the migrations applied to `schema`: `drizzle`, its default, for
 * `public`, so an instance already migrated keeps its journal; beside the schema otherwise, so two
 * schemas of one database each have theirs (ORC-334).
 */
export function journalSchemaOf(schema: string): string {
  return schema === 'public' ? 'drizzle' : `${schema}_drizzle`;
}

/** Applies `drizzle/` to an empty schema, the first of the search_path (or brings it to the latest migration). */
export async function migratePgStore(pool: Pool, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): Promise<void> {
  const { rows } = await pool.query<{ schema: string | null }>('select current_schema() as schema');
  const schema = rows[0]?.schema;
  if (!schema) throw new Error('migratePgStore: no schema of the search_path exists');
  await migrate(drizzle(pool), { migrationsFolder, migrationsSchema: journalSchemaOf(schema) });
}
