import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATABASE_URL_ENV, openStore } from './open.js';
import { SqliteStore } from './sqlite-store.js';

describe('openStore', () => {
  it.each([{}, { [DATABASE_URL_ENV]: '' }, { [DATABASE_URL_ENV]: '  ' }])('keeps SQLite without a Postgres URL (%o)', async (env) => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'factory-store-')), 'factory.db');
    const { store, kind } = await openStore({ env, sqlitePath, migrationsFolder: '/nowhere' });
    expect(kind).toBe('sqlite');
    expect(store).toBeInstanceOf(SqliteStore);
    await store.close();
  });

  it('fails to start rather than fall back to SQLite when Postgres is unreachable', async () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'factory-store-')), 'factory.db');
    const env = { [DATABASE_URL_ENV]: 'postgres://nobody:secret@127.0.0.1:1/none' };
    await expect(openStore({ env, sqlitePath, migrationsFolder: join(import.meta.dirname, '../../drizzle') })).rejects.toThrow();
  });
});
