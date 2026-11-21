import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migratePgStore } from './pg/migrate.js';
import { listenForPoolErrors, PgStore } from './pg/pg-store.js';
import type { Store } from './types.js';

/** Read by `factory up`, `factory init` and the commands on the store: the Postgres connection string. */
export const DATABASE_URL_ENV = 'FACTORY_DATABASE_URL';

export interface OpenStoreOptions {
  env: NodeJS.ProcessEnv;
  /** The `drizzle/` folder of this checkout or image. */
  migrationsFolder: string;
  /** Reports a lost Postgres connection; the store reconnects on its next query. */
  log?: (m: string) => void;
  /** `false` opens Postgres as it is, for a read-only command (`factory plan`): the daemon migrates. */
  migrate?: boolean;
}

/**
 * Opens the instance's Postgres store (`FACTORY_DATABASE_URL`), after bringing its schema to the latest Drizzle migration
 * (unless `migrate: false`). Postgres is the only store (ORC-178): without the URL nothing starts, so a variable lost in a
 * deployment never starts the factory on an empty database, nor on a SQLite file left from before.
 */
export async function openStore(o: OpenStoreOptions): Promise<Store> {
  const url = o.env[DATABASE_URL_ENV]?.trim();
  if (!url) throw new Error(`${DATABASE_URL_ENV} is not set: the factory keeps its state in Postgres only. Set it to the Postgres URL.`);
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
  return new PgStore({ connectionString: url, onError });
}

/** The SQLite files of the stores before Postgres, Relais's and the factory's: never opened again (ORC-178; transition, à retirer). */
export const OLD_DATABASES = ['relais.db', 'factory.db']; // transition, à retirer

/**
 * What a start says of each SQLite file still in `home`: not read, its data not taken into Postgres, to archive off the
 * server then delete (docs/operations.md). Only its presence is looked at.
 */
export function oldDatabaseWarnings(home: string): string[] {
  return OLD_DATABASES.filter((name) => existsSync(join(home, name))).map(
    (name) => `${name}: left from the SQLite store, not read (ORC-178): archive it off the server, then delete it (docs/operations.md)`,
  );
}
