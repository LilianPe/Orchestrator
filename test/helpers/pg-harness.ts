/**
 * Setup file of the `scenarios-pg` project (ORC-228): the scenarios of test/scenarios, run again
 * with each harness on a Postgres schema of its own (ORC-334), migrated, the worker, the outbox
 * and the timers going through PgStore. Without DATABASE_URL, they are skipped.
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import type { Store } from '../../src/store/types.js';
import { useHarnessDatabases } from './harness.js';
import { createTestSchema, EMPTY_ALL, endConnections, PG_URL, queryOn, type TestSchema } from './pg-database.js';

interface Database {
  /** Its schema, once taken. */
  schema: Promise<TestSchema>;
  pool: Promise<Pool>;
  /** Set once its test is over. */
  closed: boolean;
  /** A connection lost while the test ran: the test fails on it once over. */
  lost?: Error;
}

/** The databases of the current test: their schemas are emptied and given back once it ends. */
let open: Database[] = [];
/**
 * This file's migrated schemas that no test holds, empty. Migrating a schema is ~0.8 s of DDL on a
 * Docker Desktop Postgres, emptying it ~3 ms (ORC-334): a schema serves the tests one after the other.
 */
const free: TestSchema[] = [];

async function takeSchema(): Promise<TestSchema> {
  const reused = free.pop();
  if (reused) return reused;
  const schema = await createTestSchema('factory_h');
  const pool = new Pool({ connectionString: schema.url, max: 1 });
  try {
    await migratePgStore(pool);
  } catch (err) {
    await pool.end();
    await schema.drop();
    throw err;
  }
  await pool.end();
  return schema;
}

const never = new Promise<never>(() => {});

/**
 * A store whose schema is still being created: each call waits for it. Once the test is over,
 * calls left over by its background work (a run still streaming, a timer) never resolve, and
 * those under way never answer, rather than fail on connections ended.
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
  const schema = takeSchema();
  const pool = schema.then((s) => new Pool({ connectionString: s.url, max: 4 }));
  const db: Database = { schema, pool, closed: false };
  open.push(db);
  // One PgStore per schema, reused by every life of the harness (its clock is the harness's).
  let store: Store | undefined;
  // PgStore hears every client, a checked-out one included (ORC-290). The end of the test ends the
  // connections its background work still holds: expected. Before that, a lost connection fails the test.
  const onError = (err: Error) => {
    if (!db.closed) db.lost ??= err;
  };
  return (now: () => number): Store => (store ??= deferred(db, pool.then((p) => new PgStore({ pool: p, now, onError }))));
}

/** Gives the schema back, emptied, once nothing of the test can write to it any more; dropped if that fails. */
async function release(db: Database): Promise<void> {
  // Its pool comes from its schema: with no schema, there is no pool either.
  const schema = await db.schema.catch(() => undefined);
  if (!schema) return;
  try {
    // First: the connections still held by the test's background work, whose writes would reach the next test.
    await endConnections(schema.name);
    await db.pool.then((p) => p.end());
    await queryOn(schema.url, (c) => c.query(EMPTY_ALL));
    free.push(schema);
  } catch {
    await db.pool.then((p) => p.end()).catch(() => {});
    await schema.drop();
  }
}

if (PG_URL) {
  useHarnessDatabases('postgres', pgDatabase);

  afterEach(async () => {
    const dbs = open;
    open = [];
    for (const db of dbs) db.closed = true;
    await Promise.all(dbs.map(release));
    const lost = dbs.find((db) => db.lost)?.lost;
    if (lost) throw new Error(`scenarios-pg: a connection was lost during the test: ${lost.message}`);
  });

  afterAll(async () => {
    await Promise.all(free.splice(0).map((s) => s.drop()));
  });
} else {
  beforeEach((ctx) => ctx.skip());
}
