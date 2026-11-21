import { PgStore } from '../../src/store/pg/pg-store.js';
import type { Store } from '../../src/store/types.js';

/**
 * The store a child process opens on `target`, a Postgres URL (the crash helpers,
 * the chaos daemon and its driver), read on `now` (the store's own clock by default).
 */
export function storeAt(target: string, opts: { now?: () => number; max?: number } = {}): Store {
  return new PgStore({ connectionString: target, now: opts.now, max: opts.max });
}
