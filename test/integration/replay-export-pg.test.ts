import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReplayCommand } from '../../src/cli/replay.js';
import { saveInstance } from '../../src/config/instance.js';
import { DATABASE_URL_ENV } from '../../src/store/open.js';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { createHarness } from '../helpers/harness.js';
import { createTestSchema, type TestSchema, PG_URL } from '../helpers/pg-database.js';

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const code = await runReplayCommand(args, { print: (l) => out.push(l), env });
  return { code, out: out.join('\n') };
}

// `factory replay --export` (ORC-174) on the instance's store, Postgres only since ORC-178.
describe.skipIf(!PG_URL)('factory replay --export on PgStore', () => {
  let db: TestSchema;
  let pool: Pool;
  let home: string;

  beforeAll(async () => {
    db = await createTestSchema('factory_replay_export');
    pool = new Pool({ connectionString: db.url, max: 2 });
    await migratePgStore(pool);
    home = mkdtempSync(join(tmpdir(), 'factory-replay-'));
    saveInstance(home, { port: 4100, host: '127.0.0.1', relay: { kind: 'none' }, projects: [{ id: 'p', github: 'acme/app', linearTeamKey: 'REL' }] });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('writes the journal of a ticket of the instance, which then replays; refuses a ticket it has not journaled', async () => {
    const h = createHarness({ store: new PgStore({ pool }) });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    h.orch.stopAll();
    await h.orch.drained();

    const env = { FACTORY_HOME: home, [DATABASE_URL_ENV]: db.url };
    const file = join(home, 'REL-1.json');
    expect(await run(['--export', 'REL-1', '--out', file], env)).toEqual({ code: 0, out: `Journal of REL-1 written to ${file}.` });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 1, projectId: 'p', ticketId: 'REL-1' });
    expect((await run([file])).code).toBe(0);
    await expect(run(['--export', 'REL-999'], env)).rejects.toThrow(/no event journaled for REL-999/);
  });
});
