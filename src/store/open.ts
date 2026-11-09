import { Pool } from 'pg';
import { migratePgStore } from './pg/migrate.js';
import { listenForPoolErrors, PgStore } from './pg/pg-store.js';
import { SqliteStore } from './sqlite-store.js';
import type { Store } from './types.js';

/** Read by `factory up` and `factory plan`: the Postgres connection string. Unset keeps SQLite. */
export const DATABASE_URL_ENV = 'FACTORY_DATABASE_URL';
/** `sqlite`: SQLite chosen on purpose, the only way to run on it in production (ORC-350). */
export const STORE_ENV = 'FACTORY_STORE';

export interface OpenStoreOptions {
  env: NodeJS.ProcessEnv;
  /** The SQLite file used when no Postgres URL is configured (ORC-178 retires it). */
  sqlitePath: string;
  /** The `drizzle/` folder of this checkout or image. */
  migrationsFolder: string;
  /** Reports a lost Postgres connection; the store reconnects on its next query. */
  log?: (m: string) => void;
  /** `false` opens Postgres as it is, for a read-only command (`factory plan`): the daemon migrates. */
  migrate?: boolean;
}

export interface OpenedStore {
  store: Store;
  kind: 'postgres' | 'sqlite';
}

/**
 * Opens the store the instance is configured for: Postgres when `FACTORY_DATABASE_URL` is set,
 * after bringing its schema to the latest Drizzle migration (unless `migrate: false`), SQLite otherwise.
 * In production (`NODE_ENV=production`, the image's), a missing URL refuses to start unless `FACTORY_STORE=sqlite`
 * chooses SQLite (ORC-350): a variable lost in a deployment never starts the factory on an empty database.
 */
export async function openStore(o: OpenStoreOptions): Promise<OpenedStore> {
  const url = o.env[DATABASE_URL_ENV]?.trim();
  if (!url) {
    if (o.env['NODE_ENV'] === 'production' && o.env[STORE_ENV] !== 'sqlite') {
      throw new Error(
        `${DATABASE_URL_ENV} is not set: in production the factory does not start on an empty SQLite file. Set it to the Postgres URL, or set ${STORE_ENV}=sqlite to choose SQLite.`,
      );
    }
    return { store: new SqliteStore(o.sqlitePath), kind: 'sqlite' };
  }
  const onError = (err: Error) => (o.log ?? console.error)(`postgres : ${err.message}`);
  if (o.migrate !== false) {
    const pool = new Pool({ connectionString: url, max: 1 });
    listenForPoolErrors(pool, onError);
    try {
      await migratePgStore(pool, o.migrationsFolder);
    } finally {
      await pool.end();
    }
  }
  return { store: new PgStore({ connectionString: url, onError }), kind: 'postgres' };
}
