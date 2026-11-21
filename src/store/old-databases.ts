import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The SQLite files of the stores before Postgres, Relais's and the factory's: never opened again (ORC-178; transition, à retirer). */
export const OLD_DATABASES = ['relais.db', 'factory.db']; // transition, à retirer

/**
 * What the start and `factory doctor` say of each SQLite file still in `home`: not read, its data not taken into Postgres, to archive off the
 * server then delete (docs/operations.md). Only its presence is looked at.
 */
export function oldDatabaseWarnings(home: string): string[] {
  return OLD_DATABASES.filter((name) => existsSync(join(home, name))).map(
    (name) => `${name}: left from the SQLite store, not read (ORC-178): archive it off the server, then delete it (docs/operations.md)`,
  );
}
