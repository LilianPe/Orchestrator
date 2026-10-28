import { PgStore } from '../../src/store/pg/pg-store.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Store } from '../../src/store/types.js';

/**
 * The store a child process opens on `target`, a Postgres URL or a SQLite file (the crash helpers,
 * the chaos daemon and its driver), read on `now` (the store's own clock by default).
 */
export function storeAt(target: string, opts: { now?: () => number; max?: number } = {}): Store {
  return target.startsWith('postgres') ? new PgStore({ connectionString: target, now: opts.now, max: opts.max }) : new SqliteStore(target, opts.now);
}
