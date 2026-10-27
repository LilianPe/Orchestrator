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

  it("reads a decision's rows through indexes, not by scanning the tables (ORC-149)", () => {
    const db = (new SqliteStore(':memory:') as unknown as { db: DatabaseSync }).db;
    const plan = (query: string, ...args: (string | null)[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as { detail: string }[]).map((r) => r.detail).join('; ');
    expect(
      plan("SELECT id FROM inbox WHERE processed_at IS NULL AND json_extract(data, '$.projectId') = ? AND json_extract(data, '$.ticketId') IS ? ORDER BY seq LIMIT 1", 'p', 'REL-1'),
    ).toContain('inbox_pending_ticket');
    expect(plan('SELECT COUNT(*) AS n FROM events WHERE ticket_id IS ?', 'REL-1')).toContain('events_ticket');
    expect(plan("SELECT 1 FROM outbox WHERE event_id = ? AND status IN ('pending', 'running')", 'e1')).toContain('outbox_event');
  });
});
