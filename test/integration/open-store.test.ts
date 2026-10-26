import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFactory } from '../../src/app/bootstrap.js';
import { saveInstance } from '../../src/config/instance.js';
import { DATABASE_URL_ENV, openStore } from '../../src/store/open.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import { createTestDatabase, PG_URL, queryOn } from '../helpers/pg-database.js';

const migrationsFolder = join(import.meta.dirname, '../../drizzle');

describe.skipIf(!PG_URL)('openStore and the daemon on Postgres', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    db = await createTestDatabase('factory_open');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('applies the migrations to an empty database, then again without change', async () => {
    const env = { [DATABASE_URL_ENV]: db.url };
    const sqlitePath = join(mkdtempSync(join(tmpdir(), 'factory-store-')), 'factory.db');
    for (let i = 0; i < 2; i++) {
      const { store, kind } = await openStore({ env, sqlitePath, migrationsFolder });
      expect(kind).toBe('postgres');
      expect(store).toBeInstanceOf(PgStore);
      expect(await store.listTickets()).toEqual([]);
      await store.close();
    }
    const tables = await queryOn(db.url, async (c) =>
      (await c.query<{ name: string }>(`select table_name as name from information_schema.tables where table_schema = 'public'`)).rows.map((r) => r.name),
    );
    expect(tables.sort()).toEqual([...PG_TABLE_NAMES].sort());
  });

  it('starts the daemon on Postgres when FACTORY_DATABASE_URL is set, and serves its state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'factory-boot-pg-'));
    saveInstance(home, { port: 4187, host: '127.0.0.1', relay: { kind: 'none' }, projects: [], limits: {} });
    const logs: string[] = [];
    const app = await startFactory({ home, fakeRunner: true, log: (m) => void logs.push(m), env: { [DATABASE_URL_ENV]: db.url } });
    try {
      const state = await (await fetch('http://127.0.0.1:4187/api/state')).json();
      expect(state).toMatchObject({ paused: false, tickets: [], queue: [], activeRuns: [], costTodayUsd: 0 });
    } finally {
      await app.stop();
    }
    expect(logs).toContain('store : Postgres (migrations Drizzle appliquées)');
    expect(logs.join('\n')).not.toContain(new URL(db.url).password);
  });
});
