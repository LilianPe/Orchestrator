import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATABASE_URL_ENV, oldDatabaseWarnings, openStore } from './open.js';

describe('openStore', () => {
  it.each([{}, { [DATABASE_URL_ENV]: '' }, { [DATABASE_URL_ENV]: '  ' }, { NODE_ENV: 'production', FACTORY_STORE: 'sqlite' }])(
    'refuses to open without a Postgres URL, whatever else is set: Postgres is the only store (ORC-178) (%o)',
    async (env) => {
      await expect(openStore({ env, migrationsFolder: '/nowhere' })).rejects.toThrow(
        `${DATABASE_URL_ENV} is not set: the factory keeps its state in Postgres only. Set it to the Postgres URL.`,
      );
    },
  );

  it('fails to start when Postgres is unreachable', async () => {
    const env = { [DATABASE_URL_ENV]: 'postgres://nobody:secret@127.0.0.1:1/none' };
    await expect(openStore({ env, migrationsFolder: join(import.meta.dirname, '../../drizzle') })).rejects.toThrow();
  });
});

describe('oldDatabaseWarnings', () => {
  it('names each SQLite file left in the home, by its presence alone, and nothing in a home without one (ORC-178)', () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-old-db-'));
    expect(oldDatabaseWarnings(home)).toEqual([]);
    writeFileSync(join(home, 'relais.db'), 'not a database'); // transition, à retirer
    writeFileSync(join(home, 'factory.db'), '');
    expect(oldDatabaseWarnings(home)).toEqual([
      'relais.db: left from the SQLite store, not read (ORC-178): archive it off the server, then delete it (docs/operations.md)', // transition, à retirer
      'factory.db: left from the SQLite store, not read (ORC-178): archive it off the server, then delete it (docs/operations.md)',
    ]);
  });
});
