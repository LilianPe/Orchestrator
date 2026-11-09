import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { createTestDatabase, migrationsUpTo, PG_URL } from '../helpers/pg-database.js';

describe.skipIf(!PG_URL)('the security log of a database migrated before the rule and host only (ORC-296)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('factory_seclog');
    pool = new Pool({ connectionString: db.url, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it("loses the commands, request paths and proxy's reasons it kept, and keeps the rules and the hosts", async () => {
    await migratePgStore(pool, migrationsUpTo('0006_review_findings'));
    await pool.query(`insert into security_logs (run_id, project_id, ticket_id, read_at, skipped_egress, skipped_refusals) values ('r1', 'p', 'REL-1', to_timestamp(5), 0, 0)`);
    await pool.query(`insert into egress_requests (run_id, n, at, method, host, path, ok, reason, up, down) values ('r1', 0, to_timestamp(1), 'POST', 'api.example', '/bot1:s3cret/send', false, 'POST api.example/bot1:s3cret/send refused', 0, 0)`);
    await pool.query(`insert into refusals (run_id, n, at, tool, rule, command) values ('r1', 0, to_timestamp(2), 'Bash', 'push', 'git push https://x:s3cret@github.com/o/r')`);

    await migratePgStore(pool);

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('egress_requests', 'refusals')`,
    );
    const names = columns.rows.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).not.toContain('refusals.command');
    expect(names).not.toContain('egress_requests.path');
    expect(names).not.toContain('egress_requests.reason');
    const log = await new PgStore({ pool, now: () => 0 }).securityLog('r1');
    expect(log).toEqual({
      runId: 'r1', projectId: 'p', ticketId: 'REL-1', at: 5000,
      egress: [{ at: 1000, method: 'POST', host: 'api.example', ok: false, up: 0, down: 0 }],
      refusals: [{ at: 2000, tool: 'Bash', rule: 'push' }],
      skipped: { egress: 0, refusals: 0 },
    });
  });
});
