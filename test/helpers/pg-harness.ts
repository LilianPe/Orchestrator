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
/** The databases of the current test: dropped once it ends. */
let open: { name: string; pool: Promise<Pool> }[] = [];
let closed = false;
let n = 0;
const never = new Promise<never>(() => {});

/**
 * A store whose database is still being created: each call waits for it. Once the test is over,
 * calls left over by its background work (a run still streaming, a timer) never resolve, rather
 * than fail on a dropped database.
 */
function deferred(store: Promise<Store>): Store {
  return new Proxy({} as Store, {
    get(_, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => {
        if (closed) return never;
        return store.then((s) => (closed ? never : (s[prop as keyof Store] as (...a: unknown[]) => Promise<unknown>).apply(s, args)));
      };
    },
  });
}

function pgDatabase() {
  const name = `${template!.name}_${++n}`;
  const pool = queryOn(PG_URL, (c) => c.query(`create database "${name}" template "${template!.name}"`)).then(() => {
    const u = new URL(PG_URL);
    u.pathname = `/${name}`;
    return new Pool({ connectionString: u.toString(), max: 4 });
  });
  open.push({ name, pool });
  return (now: () => number): Store => deferred(pool.then((p) => new PgStore({ pool: p, now })));
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

  beforeEach(() => {
    closed = false;
  });

  afterEach(async () => {
    closed = true;
    const dbs = open;
    open = [];
    for (const db of dbs) {
      await (await db.pool).end();
      await queryOn(PG_URL, (c) => c.query(`drop database if exists "${db.name}" with (force)`));
    }
  });

  afterAll(async () => {
    await template?.drop();
  });
} else {
  beforeEach((ctx) => ctx.skip());
}
