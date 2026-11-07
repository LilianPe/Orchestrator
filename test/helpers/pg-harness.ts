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
    const p = new Pool({ connectionString: u.toString(), max: 4 });
    // A client still checked out when the test ends (a transaction whose callback called the store, which
    // never answers once closed) is cut by the forced drop: the pool listens to idle clients only, and an
    // 'error' nobody listens to is an uncaught exception that fails the whole run (ORC-290).
    p.on('connect', (client) => client.on('error', onError));
    return p;
  });
  const db: Database = { name, pool, closed: false };
  open.push(db);
  // One PgStore per database, reused by every life of the harness (its clock is the harness's).
  let store: Store | undefined;
  function onError(err: Error): void {
    if (!db.closed) console.error(`scenarios-pg ${name}: ${err.message}`);
  }
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

  /**
   * The drops under way, each settled with its error if any. A drop forces an immediate checkpoint of the
   * whole server: on a loaded machine one took more than the hook's 60 s (ORC-290). Not awaited by the test
   * that made the database, they go on beside the next tests, and drops at the same time share a checkpoint.
   */
  const dropping: Promise<unknown>[] = [];

  afterEach(() => {
    const dbs = open;
    open = [];
    for (const db of dbs) db.closed = true;
    dropping.push(...dbs.map((db) => drop(db).catch((err: unknown) => err)));
  });

  afterAll(async () => {
    const failed = (await Promise.all(dropping)).find((err) => err !== undefined);
    await template?.drop();
    if (failed) throw failed;
  });
} else {
  beforeEach((ctx) => ctx.skip());
}
