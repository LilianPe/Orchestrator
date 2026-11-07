/**
 * Setup file of the `scenarios-pg` project (ORC-228): the scenarios of test/scenarios, run again
 * with each harness on a Postgres database of its own (cloned from a migrated template), the
 * worker, the outbox and the timers going through PgStore. Without DATABASE_URL, they are skipped.
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import type { Store } from '../../src/store/types.js';
import { useHarnessDatabases } from './harness.js';
import { createTestDatabase, PG_URL, queryOn } from './pg-database.js';

let template: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
interface Database {
  name: string;
  pool: Promise<Pool>;
  /** Set once its test is over. */
  closed: boolean;
  /** A connection lost while the test ran: the test fails on it once over. */
  lost?: Error;
}

/** The databases of the current test: dropped once it ends. */
let open: Database[] = [];
let n = 0;
const never = new Promise<never>(() => {});

/**
 * A store whose database is still being created: each call waits for it. Once the test is over,
 * calls left over by its background work (a run still streaming, a timer) never resolve, and
 * those under way never answer, rather than fail on a dropped database.
 */
function deferred(db: Database, store: Promise<Store>): Store {
  const settle = (v: unknown) => (db.closed ? never : v);
  return new Proxy({} as Store, {
    get(_, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => {
        if (db.closed) return never;
        return store
          .then((s) => (db.closed ? never : (s[prop as keyof Store] as (...a: unknown[]) => Promise<unknown>).apply(s, args)))
          .then(settle, (err: unknown) => (db.closed ? never : Promise.reject(err)));
      };
    },
  });
}

function pgDatabase() {
  if (!template) throw new Error('scenarios-pg: create the harness inside a test, once the template database exists');
  const from = template.name;
  const name = `${from}_${++n}`;
  const pool = queryOn(PG_URL, (c) => c.query(`create database "${name}" template "${from}"`)).then(() => {
    const u = new URL(PG_URL);
    u.pathname = `/${name}`;
    return new Pool({ connectionString: u.toString(), max: 4 });
  });
  const db: Database = { name, pool, closed: false };
  open.push(db);
  // One PgStore per database, reused by every life of the harness (its clock is the harness's).
  let store: Store | undefined;
  // PgStore hears every client, a checked-out one included (ORC-290). The forced drop at the end of the
  // test cuts those its background work still holds: expected. Before that, a lost connection fails the test.
  const onError = (err: Error) => {
    if (!db.closed) db.lost ??= err;
  };
  return (now: () => number): Store => (store ??= deferred(db, pool.then((p) => new PgStore({ pool: p, now, onError }))));
}

async function drop(db: Database): Promise<void> {
  try {
    // Forced first: it ends the connections still held by the test's background work.
    await queryOn(PG_URL, (c) => c.query(`drop database if exists "${db.name}" with (force)`));
  } finally {
    await db.pool.then((p) => p.end()).catch(() => {});
  }
}

if (PG_URL) {
  useHarnessDatabases('postgres', pgDatabase);

  beforeAll(async () => {
    template = await createTestDatabase('factory_h');
    const pool = new Pool({ connectionString: template.url, max: 1 });
    try {
      await migratePgStore(pool);
    } finally {
      await pool.end();
    }
  });

  afterEach(async () => {
    const dbs = open;
    open = [];
    for (const db of dbs) db.closed = true;
    await Promise.all(dbs.map(drop));
    const lost = dbs.find((db) => db.lost)?.lost;
    if (lost) throw new Error(`scenarios-pg: a connection was lost during the test: ${lost.message}`);
  });

  afterAll(async () => {
    await template?.drop();
  });
} else {
  beforeEach((ctx) => ctx.skip());
}
