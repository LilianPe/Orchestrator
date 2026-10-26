import { Pool } from 'pg';
import { migratePgStore } from './pg/migrate.js';
import { PgStore } from './pg/pg-store.js';
import { SqliteStore } from './sqlite-store.js';
import type { Store } from './types.js';

/** Read by `factory up` and `factory plan`: the Postgres connection string. Unset keeps SQLite. */
export const DATABASE_URL_ENV = 'FACTORY_DATABASE_URL';

export interface OpenStoreOptions {
  env: NodeJS.ProcessEnv;
  /** The SQLite file used when no Postgres URL is configured (ORC-178 retires it). */
  sqlitePath: string;
  /** The `drizzle/` folder of this checkout or image. */
  migrationsFolder: string;
}

export interface OpenedStore {
  store: Store;
  kind: 'postgres' | 'sqlite';
}

/**
 * Opens the store the instance is configured for: Postgres when `FACTORY_DATABASE_URL` is set,
 * after bringing its schema to the latest Drizzle migration, SQLite otherwise.
 */
export async function openStore(o: OpenStoreOptions): Promise<OpenedStore> {
  const url = o.env[DATABASE_URL_ENV]?.trim();
  if (!url) return { store: new SqliteStore(o.sqlitePath), kind: 'sqlite' };
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migratePgStore(pool, o.migrationsFolder);
  } finally {
    await pool.end();
  }
  return { store: new PgStore({ connectionString: url }), kind: 'postgres' };
}
