import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRepair } from '../../src/cli/repair.js';
import type { TicketState } from '../../src/core/types.js';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { exportJournal, replayJournal } from '../../src/runtime/replay.js';
import { createHarness, loadTestWorkflow, trackHarnesses } from '../helpers/harness.js';
import { createTestSchema, type TestSchema, PG_URL, EMPTY_ALL } from '../helpers/pg-database.js';
import { expectFirstRunMeasures, firstRun } from '../helpers/measures-scenario.js';
import { testPreset } from '../helpers/test-preset.js';

// The orchestrator on PgStore, through the scenario harness: the daemon's path once
// FACTORY_DATABASE_URL is set. Every scenario of test/scenarios also runs on Postgres (the
// `scenarios-pg` project, ORC-228); these check the tables themselves.
describe.skipIf(!PG_URL)('orchestrator on PgStore', () => {
  let db: TestSchema;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestSchema('factory_orch');
    pool = new Pool({ connectionString: db.url, max: 4 });
    await migratePgStore(pool);
  });

  beforeEach(async () => {
    await pool.query(EMPTY_ALL);
  });

  // The harnesses of the test, shut down before the next one empties the schema (ORC-290).
  afterEach(trackHarnesses());

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  const harness = (opts: Parameters<typeof createHarness>[0] = {}) => createHarness({ ...opts, store: new PgStore({ pool }) });

  it('writes the measures of the first run, the same as on SQLite (ORC-235)', async () => {
    expectFirstRunMeasures(await firstRun(harness()));
    const attempts = await pool.query<{ step: string; input_tokens: string | null }>(`select step, input_tokens from attempts order by started_at, id`);
    expect(attempts.rows.filter((r) => r.input_tokens !== null).map((r) => r.step).sort()).toEqual(['ask', 'dev', 'review']);
    const acked = await pool.query(`select type from inbox where acked_at is not null order by type`);
    expect(acked.rows.map((r) => r.type)).toEqual(['session.mentioned', 'ticket.delegated']);
  });

  it('takes a delegated ticket through a failed then a passing check to human review', async () => {
    const h = harness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(2);
    expect(await h.ticket()).toMatchObject({ logical: 'human_review', blocked: false, verifyAttempts: 0 });
    expect(await h.store.runsByStatus('success')).toHaveLength(2);
    const journal = await pool.query<{ type: string }>(`select type from journal where ticket_id = 'REL-1' order by seq`);
    // The results of the effects (ORC-150) are journaled too: left out here.
    expect(journal.rows.map((r) => r.type).filter((t) => !t.startsWith('effect.'))).toEqual([
      'ticket.delegated', 'run.finished', 'verify.failed', 'run.finished', 'verify.passed',
    ]);
    expect(journal.rows.map((r) => r.type)).not.toContain('effect.failed');
    const projection = await pool.query<{ status: string; active_attempts: number }>(`select status, active_attempts from tickets where id = 'REL-1'`);
    expect(projection.rows[0]).toEqual({ status: 'human_review', active_attempts: 0 });
  });

  it('starts a queued item whose holder died before its start, once its lease expired (ORC-150)', async () => {
    const h = harness({ projectYaml: 'version: 1\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Un' });
    await h.store.setMeta('paused', '1');
    await h.send('ticket.delegated', { linearSessionId: 'a' });
    expect((await h.store.listQueue()).map((q) => q.ticketId)).toEqual(['REL-1']);
    // Another daemon took it, then died: its lease is already over.
    expect(await h.store.claimQueued('dev', -1)).toBeDefined();
    await h.store.setMeta('paused', '0');
    await h.orch.tick();
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toEqual([]);
    expect((await pool.query(`select status from outbox where payload ? 'queue'`)).rows).toEqual([{ status: 'done' }]);
  });

  it('respects the parallel cap and drains the queue through the outbox', async () => {
    const h = harness({ projectYaml: 'version: 1\nlimits: { parallel_sessions: 1 }\n' });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Un' });
    h.tracker.addIssue({ identifier: 'REL-2', title: 'Deux' });
    h.runner.enqueue({ hold: true }, {});
    await h.send('ticket.delegated', { linearSessionId: 'a' }, 'REL-1');
    await h.send('ticket.delegated', { linearSessionId: 'b' }, 'REL-2');
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.store.listQueue()).toHaveLength(1);
    h.runner.release((await h.ticket('REL-1')).activeRunId!);
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(2);
    expect(h.runner.requests[1]!.cwd).toBe('/tmp/factory-fake/p/REL-2');
    // The queue item; the decisions' own outbox rows (ORC-149) are not queue rows.
    const outbox = await pool.query<{ status: string }>(`select status from outbox where payload ? 'queue'`);
    expect(outbox.rows).toEqual([{ status: 'done' }]);
  });

  // Was: blocked, then resumed on a reply. Since ORC-220 nobody has to reply.
  it('takes up a ticket whose run a restart cut, on its session', async () => {
    const h = harness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true }, { events: [{ kind: 'text', text: 'Repris.' }] });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    const runId = (await h.ticket()).activeRunId!;
    // A shutdown leaves the run going (ORC-344): this one is gone by the next start.
    h.runner.forget(runId);
    await h.restart();
    expect((await h.store.getRun(runId))!.status).toBe('failure');
    expect(h.runner.requests[1]).toMatchObject({ resume: true, claudeSessionId: h.runner.requests[0]!.claudeSessionId });
    expect(await h.ticket()).toMatchObject({ blocked: false, logical: 'human_review' });
  });

  it('dead-letters an event whose reduce throws, blocks the ticket, and replays it with factory run repair (ORC-175)', async () => {
    const h = harness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.runner.enqueue({ hold: true });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    // A corrupt projection: recording a reply in it throws, every time.
    const good = await h.ticket();
    await h.store.putTicket({ ...good, humanInbox: null as unknown as TicketState['humanInbox'] });
    await h.send('session.prompted', { linearSessionId: 'ls-1', body: 'et le mobile ?', author: 'L' });
    const dead = await pool.query<{ event_id: string; status: string; failures: number; ticket_id: string }>(
      `select event_id, status, failures, ticket_id from dead_letter`,
    );
    expect(dead.rows).toEqual([{ event_id: 't-2', status: 'open', failures: 1, ticket_id: 'REL-1' }]);
    expect(await h.ticket()).toMatchObject({ blocked: true, blockReason: expect.stringMatching(/^Event t-2 set aside \(session\.prompted\)/) });
    expect(await h.store.pendingInbox(10)).toEqual([]);

    await h.store.putTicket({ ...(await h.ticket()), humanInbox: [] });
    expect(await runRepair({ store: h.store, target: 'REL-1', action: 'replay', by: 'armand', now: h.clock.now(), print: () => {} })).toBe(0);
    await h.orch.drained();
    expect(await h.ticket()).toMatchObject({ blocked: false, humanInbox: [expect.objectContaining({ body: 'et le mobile ?' })] });
    const journal = await pool.query<{ event_id: string; type: string }>(
      `select event_id, type from journal where ticket_id = 'REL-1' and type like 'dead_letter.%' order by seq`,
    );
    expect(journal.rows).toEqual([
      { event_id: 'dead-letter:t-2:1', type: 'dead_letter.added' },
      { event_id: 'repair:t-2:1', type: 'dead_letter.repaired' },
    ]);
    expect((await pool.query(`select status, resolved_by from dead_letter`)).rows).toEqual([{ status: 'replayed', resolved_by: 'armand' }]);
  });

  it('pauses the queue through meta and drains it on resume', async () => {
    const h = harness();
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.orch.accept({ id: 'pause', type: 'control.pause', at: h.clock.now(), projectId: '*', payload: {} });
    // Right behind the pause, decided side by side with it: the pause still wins (ORC-335).
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    expect(h.runner.requests).toHaveLength(0);
    expect(await h.orch.isPaused()).toBe(true);
    await h.orch.accept({ id: 'resume', type: 'control.resume', at: h.clock.now(), projectId: '*', payload: {} });
    await h.orch.drained();
    expect(h.runner.requests).toHaveLength(1);
    expect(await h.orch.isPaused()).toBe(false);
  });

  it('journals the roles a human event was decided on, and answers a refusal once across a restart (ORC-186)', async () => {
    const h = harness({ authz: { githubLogins: { 'user-dev': 'dev-gh' } } });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    h.tracker.setTeamMembers('REL', ['user-dev', 'user-member']);
    h.forge.setRepoPermission('dev-gh', 'write');
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-member' });
    expect(h.runner.requests).toEqual([]);
    expect(h.tracker.activities('ls-1')).toEqual([{ type: 'response', body: expect.stringMatching(/^Refused:/) }]);
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' }, 'REL-1', { actor: 'user-dev' });
    expect(h.runner.requests).toHaveLength(1);
    const journal = await pool.query<{ payload: { actor?: string; roles?: string[] } }>(
      `select payload from journal where ticket_id = 'REL-1' and type = 'ticket.delegated' order by seq`,
    );
    expect(journal.rows.map((r) => [r.payload.actor, r.payload.roles])).toEqual([
      ['user-member', ['team_member']],
      ['user-dev', ['team_member', 'repo_writer', 'repo_merger']],
    ]);
    await h.restart();
    const refusals = h.tracker.activities('ls-1').filter((a) => 'body' in a && a.body.startsWith('Refused:'));
    expect(refusals).toHaveLength(1);
    expect(await h.ticket()).toMatchObject({ initiatorId: 'user-dev' });
  });

  it('records each decision in decision_trace: the exported journal replays bit for bit, and diverges under another preset (ORC-174)', async () => {
    const h = harness({ preset: testPreset() });
    h.checks.failNext('1 failed');
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.send('ticket.delegated', { linearSessionId: 'ls-1' });
    await h.send('label.changed', { label: 'agent:stop', change: 'added' });
    const journal = await exportJournal(h.store, 'p', 'REL-1');
    const traced = await pool.query<{ n: string }>(`select count(*) as n from decision_trace where ticket_id = 'REL-1'`);
    expect(journal.entries.length).toBe(Number(traced.rows[0]!.n));
    expect(journal.entries.every((e) => e.decision)).toBe(true);
    expect(replayJournal(journal)).toMatchObject({ replayed: journal.entries.length, divergences: [] });
    const whatIf = replayJournal(journal, { mode: 'what-if', workflow: loadTestWorkflow(testPreset({ verifyAttempts: 1 }).yaml) });
    expect(whatIf.divergences[0]).toMatchObject({ eventType: 'verify.failed' });
  });
});
