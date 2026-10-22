import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

const DEFAULT_MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

/** Applies `drizzle/` to an empty database (or brings it to the latest migration). */
export async function migratePgStore(pool: Pool, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder });
}
