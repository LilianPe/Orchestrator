import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { storeContract } from '../../test/helpers/store-suite.js';
import { SqliteStore } from './sqlite-store.js';

// The six cases live in the shared Store contract, also run on PgStore (test/integration/pg-store.test.ts).
describe('SqliteStore', () => {
  storeContract(() => new SqliteStore(':memory:'));

  it('stamps the inbox rows with its clock', async () => {
    let now = 1_000;
    const s = new SqliteStore(':memory:', () => now);
    await s.appendInbox({ id: 'e1', type: 'control.pause', at: 1, projectId: 'p', payload: {} } as never);
    now = 2_000;
    await s.markInboxProcessed('e1');
    const db = (s as unknown as { db: DatabaseSync }).db;
    expect({ ...db.prepare('SELECT received_at, processed_at FROM inbox').get() }).toEqual({ received_at: 1_000, processed_at: 2_000 });
  });
});
