import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { createHarness } from '../helpers/harness.js';
import { crashAfterAck, linearIngest, signedDelegation } from '../helpers/linear-webhook.js';
import { createTestDatabase, PG_URL } from '../helpers/pg-database.js';

// ORC-147 on Postgres: the webhook answers once the inbox row is committed, and a daemon killed
// with SIGKILL right after the answer loses nothing.
describe.skipIf(!PG_URL)('inbox on PgStore', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('factory_inbox');
    pool = new Pool({ connectionString: db.url, max: 4 });
    await migratePgStore(pool);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('processes once, after a restart, a delegation acked by a daemon killed with SIGKILL before processing it', async () => {
    const { response, exited } = crashAfterAck(db.url);
    expect(response).toEqual({ status: 200 });
    expect(exited.status === 0 && exited.signal === null).toBe(false);

    const inbox = await pool.query<{ type: string; processed: boolean }>(
      `select type, processed_at is not null as processed from inbox where id like 'linear:%'`,
    );
    expect(inbox.rows).toEqual([{ type: 'ticket.delegated', processed: false }]);
    expect((await pool.query(`select 1 from journal`)).rowCount).toBe(0);

    const h = createHarness({ store: new PgStore({ pool }) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.restart();
    expect(await h.ticket()).toMatchObject({ delegated: true });
    const journal = async () =>
      (await pool.query<{ type: string }>(`select type from journal where ticket_id = 'REL-1' and type = 'ticket.delegated'`)).rows;
    expect(await journal()).toHaveLength(1);
    expect((await pool.query(`select 1 from inbox where processed_at is null`)).rowCount).toBe(0);
    const runs = h.runner.requests.length;
    expect(runs).toBeGreaterThan(0);

    // Exactly once: another start, then Linear sending the same webhook again.
    await h.restart();
    const acks: string[] = [];
    const { raw, headers } = signedDelegation();
    expect(await linearIngest((e) => h.orch.accept(e), acks)(raw, headers)).toEqual({ status: 200 });
    await h.orch.idle();
    expect(acks).toEqual([]);
    expect(await journal()).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(runs);
  });

  it('answers 500 when the database is unreachable, so Linear sends the webhook again', async () => {
    const down = new PgStore({ connectionString: 'postgres://factory:factory@127.0.0.1:1/factory', onError: () => {} });
    try {
      const { raw, headers } = signedDelegation();
      expect(await linearIngest((e) => down.appendInbox(e))(raw, headers)).toEqual({ status: 500 });
    } finally {
      await down.close();
    }
  });
});
