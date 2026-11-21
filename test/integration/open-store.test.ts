import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFactory } from '../../src/app/bootstrap.js';
import { saveInstance } from '../../src/config/instance.js';
import { DATABASE_URL_ENV, OLD_DATABASES, oldDatabaseWarnings, openStore } from '../../src/store/open.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import { createTestSchema, type TestSchema, PG_URL, queryOn } from '../helpers/pg-database.js';

const migrationsFolder = join(import.meta.dirname, '../../drizzle');

describe.skipIf(!PG_URL)('openStore and the daemon on Postgres', () => {
  let db: TestSchema;
  /** Left unmigrated. */
  let other: TestSchema;

  beforeAll(async () => {
    // Each assigned as soon as made: if the other fails, afterAll still drops it.
    await Promise.all([createTestSchema('factory_open').then((d) => (db = d)), createTestSchema('factory_nomigrate').then((d) => (other = d))]);
  });

  afterAll(async () => {
    const made: (TestSchema | undefined)[] = [db, other];
    await Promise.all(made.map((d) => d?.drop()));
  });

  const tablesOf = (url: string) =>
    queryOn(url, async (c) =>
      (await c.query<{ name: string }>(`select table_name as name from information_schema.tables where table_schema = current_schema()`)).rows.map((r) => r.name),
    );

  it('opens Postgres without migrating it with `migrate: false` (factory plan)', async () => {
    const store = await openStore({ env: { [DATABASE_URL_ENV]: other.url }, migrationsFolder, migrate: false });
    expect(store).toBeInstanceOf(PgStore);
    await store.close();
    expect(await tablesOf(other.url)).toEqual([]);
  });

  it('applies the migrations to an empty database, then again without change', async () => {
    const env = { [DATABASE_URL_ENV]: db.url };
    for (let i = 0; i < 2; i++) {
      const store = await openStore({ env, migrationsFolder });
      expect(store).toBeInstanceOf(PgStore);
      expect(await store.listTickets()).toEqual([]);
      await store.close();
    }
    expect((await tablesOf(db.url)).sort()).toEqual([...PG_TABLE_NAMES].sort());
  });

  it('starts the daemon on Postgres when FACTORY_DATABASE_URL is set, and serves its state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-pg-'));
    saveInstance(home, { port: 4187, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: { [DATABASE_URL_ENV]: db.url } });
    try {
      const state = await (await fetch('http://127.0.0.1:4187/api/state')).json();
      expect(state).toMatchObject({ paused: false, tickets: [], queue: [], activeRuns: [] });
      expect(state).not.toHaveProperty('costTodayUsd');
    } finally {
      await app.stop();
    }
    expect(logs).toContain('store: Postgres (Drizzle migrations applied)');
    // The password alone can be a common word (it is `factory` in CI), so look for the credentials as written in a URL.
    const { username, password } = new URL(db.url);
    expect(logs.join('\n')).not.toContain(db.url);
    expect(logs.join('\n')).not.toContain(`${username}:${password}@`);
  });

  it('starts on Postgres beside a relais.db and a factory.db left from SQLite, neither read nor changed (ORC-178)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-pg-'));
    saveInstance(home, { port: 4188, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    // Not SQLite files: a start that opened one would fail on it.
    for (const name of OLD_DATABASES) writeFileSync(join(home, name), `not a database: ${name}`);
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: { [DATABASE_URL_ENV]: db.url } });
    try {
      expect(await (await fetch('http://127.0.0.1:4188/api/state')).json()).toMatchObject({ paused: false, tickets: [] });
    } finally {
      await app.stop();
    }
    expect(logs).toEqual(expect.arrayContaining([...oldDatabaseWarnings(home), 'store: Postgres (Drizzle migrations applied)']));
    for (const name of OLD_DATABASES) expect(readFileSync(join(home, name), 'utf8')).toBe(`not a database: ${name}`);
  });
});
