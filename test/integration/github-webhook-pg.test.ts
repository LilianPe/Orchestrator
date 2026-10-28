import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { BRANCH, crashAfterGithubAck, githubDelivery, githubIngest, pullRequestBody } from '../helpers/github-webhook.js';
import { createHarness } from '../helpers/harness.js';
import { createTestDatabase, PG_URL } from '../helpers/pg-database.js';

// ORC-134 on Postgres: a GitHub webhook answered 200 is in the inbox, and a daemon killed with
// SIGKILL right after the answer loses nothing.
describe.skipIf(!PG_URL)('GitHub webhook inbox on PgStore', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('factory_gh_inbox');
    pool = new Pool({ connectionString: db.url, max: 4 });
    await migratePgStore(pool);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('processes once, after a restart, a merge acked by a daemon killed with SIGKILL before processing it', async () => {
    const h = createHarness({ store: new PgStore({ pool }) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV', description: 'Exporter les audits en CSV depuis la liste des audits.' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', branch: BRANCH });

    const { response, exited } = crashAfterGithubAck(db.url, 'pull_request', pullRequestBody('closed', { merged: true }));
    expect(response).toEqual({ status: 200 });
    expect(exited.status === 0 && exited.signal === null).toBe(false);
    const inbox = await pool.query<{ id: string; processed: boolean }>(
      `select id, processed_at is not null as processed from inbox where id like 'pr:%' order by id`,
    );
    expect(inbox.rows).toEqual([
      { id: 'pr:REL-1:3:merged', processed: false },
      { id: 'pr:REL-1:3:opened', processed: false },
    ]);

    await h.restart();
    expect(await h.ticket()).toMatchObject({ logical: 'done', prState: 'MERGED', prNumber: 3 });
    expect((await pool.query(`select 1 from inbox where processed_at is null`)).rowCount).toBe(0);

    // GitHub redelivering the same body: nothing more.
    const { raw, headers } = githubDelivery('pull_request', pullRequestBody('closed', { merged: true }));
    expect(await githubIngest(h.store, (e) => h.orch.accept(e))(raw, headers)).toEqual({ status: 200 });
    await h.orch.drained();
    const merged = await pool.query(`select 1 from journal where ticket_id = 'REL-1' and type = 'pr.merged'`);
    expect(merged.rowCount).toBe(1);
  });
});
