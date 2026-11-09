import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it("drops the commands, request paths and proxy's reasons a security log of an older file kept, once, when it opens (ORC-296)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'factory-sqlite-')), 'relais.db');
    const old = new SqliteStore(path);
    const kept = {
      runId: 'r1', projectId: 'p', ticketId: 'REL-1', at: 5,
      egress: [{ at: 1, method: 'POST', host: 'api.example', path: '/bot1:s3cret/send', ok: false, reason: 'POST api.example/bot1:s3cret/send refused', up: 0, down: 0 }],
      refusals: [{ at: 2, tool: 'Bash', rule: 'push', command: 'git push https://x:s3cret@github.com/o/r' }],
      skipped: { egress: 0, refusals: 0 },
    };
    const oldDb = (old as unknown as { db: DatabaseSync }).db;
    oldDb.prepare('INSERT INTO security_logs (run_id, data) VALUES (?, ?)').run('r1', JSON.stringify(kept));
    // A row no one can read: it neither stops the store from opening nor stays.
    oldDb.prepare('INSERT INTO security_logs (run_id, data) VALUES (?, ?)').run('r2', '{"command":"s3cret');
    oldDb.prepare("DELETE FROM meta WHERE key = 'security-log-kept'").run();
    await old.close();
    const s = new SqliteStore(path);
    const db = (s as unknown as { db: DatabaseSync }).db;
    const raw = db.prepare('SELECT data FROM security_logs').all() as { data: string }[];
    expect(raw.map((r) => r.data).join()).not.toContain('s3cret');
    expect(readFileSync(path, 'latin1')).not.toContain('s3cret');
    expect(await s.securityLog('r1')).toEqual({
      ...kept,
      egress: [{ at: 1, method: 'POST', host: 'api.example', ok: false, up: 0, down: 0 }],
      refusals: [{ at: 2, tool: 'Bash', rule: 'push' }],
    });
    // Once: a row written afterwards, as only an older daemon would, is not read again at the next opening.
    db.prepare('INSERT INTO security_logs (run_id, data) VALUES (?, ?)').run('r3', JSON.stringify({ ...kept, runId: 'r3' }));
    await s.close();
    const again = new SqliteStore(path);
    expect(JSON.stringify(await again.securityLog('r3'))).toContain('s3cret');
    await again.close();
  });
});
