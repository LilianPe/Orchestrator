import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newTicketState, TRUSTED, type FactoryEvent } from '../../src/core/types.js';
import { OutboxExecutor } from '../../src/runtime/outbox.js';
import { migratePgStore } from '../../src/store/pg/migrate.js';
import { PgStore } from '../../src/store/pg/pg-store.js';
import { PG_TABLE_NAMES } from '../../src/store/pg/schema.js';
import type { DecisionOutcome, DecisionRequest, Store } from '../../src/store/types.js';
import { CRASH_WORKFLOW, crashAfterDecision } from '../helpers/crash-workflow.js';
import { createHarness } from '../helpers/harness.js';
import { createTestDatabase, PG_URL } from '../helpers/pg-database.js';

const TRUNCATE = `truncate table ${PG_TABLE_NAMES.map((name) => `"${name}"`).join(', ')} restart identity cascade`;

/** Each event of a ticket decides one comment; a prompt appends its body to the ticket's feedback. */
const COMMENTS = `
version: 1
on:
  ticket.delegated:
    - { comment: "délégué" }
  session.prompted:
    - { comment: "noté" }
`;

// ORC-149 on Postgres: the decision transaction under the ticket's advisory lock, a crash after the
// commit, and two workers (two daemons) on the same database.
describe.skipIf(!PG_URL)('worker on PgStore', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDatabase('factory_worker');
    pool = new Pool({ connectionString: db.url, max: 4 });
    await migratePgStore(pool);
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE);
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it.each([
    { killAt: 0, done: [] as string[], label: 'before its commit: nothing written' },
    { killAt: 1, done: [] as string[], label: 'after its commit, before any effect' },
    { killAt: 2, done: ['REL-1:1:1'], label: 'after its commit and its first effect' },
  ])('loses no event and doubles no effect of a decision killed with SIGKILL $label', async ({ killAt, done }) => {
    const { completed } = crashAfterDecision(db.url, killAt);
    expect(completed).toEqual(done);
    const journal = async () => (await pool.query<{ id: string; seq: number }>(`select id, seq from journal where ticket_id = 'REL-1' order by seq`)).rows;
    const outbox = async () =>
      (await pool.query<{ id: string; status: string }>(`select id, status from outbox where ticket_id = 'REL-1' order by (payload->>'seq')::int, (payload->>'i')::int`)).rows;
    if (killAt === 0) {
      expect(await journal()).toEqual([]);
      expect(await outbox()).toEqual([]);
      expect((await pool.query(`select 1 from tickets`)).rowCount).toBe(0);
      expect((await pool.query(`select 1 from inbox where processed_at is null`)).rowCount).toBe(1);
    } else {
      expect((await journal()).map((r) => r.seq)).toEqual([1]);
      expect((await outbox()).map((r) => r.id)).toEqual(['REL-1:1:1', 'REL-1:1:2', 'REL-1:1:3']);
      // Pending: only the result of each effect done before the kill, written with its row (ORC-150).
      expect((await pool.query<{ id: string }>(`select id from inbox where processed_at is null`)).rows.map((r) => r.id)).toEqual(
        done.map((id) => `effect:${id}`),
      );
    }

    const h = createHarness({ store: new PgStore({ pool }), projectYaml: CRASH_WORKFLOW });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.restart();
    expect((await outbox()).slice(0, 3)).toEqual([
      { id: 'REL-1:1:1', status: 'done' },
      { id: 'REL-1:1:2', status: 'done' },
      { id: 'REL-1:1:3', status: 'done' },
    ]);
    expect(h.tracker.calls.filter((c) => c.method === 'setLabels')).toHaveLength(killAt === 2 ? 0 : 1);
    expect(h.tracker.calls.filter((c) => c.method === 'comment')).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
    expect((await journal()).filter((r) => r.seq === 1)).toHaveLength(1);
  });

  it('takes up an effect cut by SIGKILL after it acted once its lease expires, and settles it once (ORC-150, criterion 2)', async () => {
    const { completed } = crashAfterDecision(db.url, 'acted:1', 300);
    expect(completed).toEqual([]);
    const head = async () => (await pool.query<{ status: string; attempts: number }>(`select status, attempts from outbox where id = 'REL-1:1:1'`)).rows[0];
    expect(await head()).toEqual({ status: 'running', attempts: 1 });

    const h = createHarness({ store: new PgStore({ pool }), projectYaml: CRASH_WORKFLOW, effectLeaseMs: 300 });
    h.tracker.addIssue({ identifier: 'REL-1', title: 'Export CSV' });
    await h.restart();
    const open = async () => (await pool.query(`select 1 from outbox where ticket_id = 'REL-1' and status <> 'done'`)).rowCount;
    for (let i = 0; i < 100 && (await open()) !== 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await h.orch.drained();
    }
    expect(await head()).toEqual({ status: 'done', attempts: 2 });
    // At least once: the labels are set again by the new claim (idempotency per effect: ORC-162).
    expect(h.tracker.calls.filter((c) => c.method === 'setLabels')).toHaveLength(1);
    expect(h.tracker.calls.filter((c) => c.method === 'comment')).toHaveLength(1);
    expect(h.runner.requests).toHaveLength(1);
    expect((await pool.query(`select 1 from journal where event_id = 'effect:REL-1:1:1'`)).rowCount).toBe(1);
    h.orch.stopAll();
    await h.orch.drained();
  });

  /** Writes `n` decisions of `effects` comments each per ticket, through the decision transaction. */
  async function seedEffects(store: PgStore, tickets: string[], effects: number): Promise<void> {
    for (const t of tickets) {
      const event: FactoryEvent = { ...TRUSTED, id: `d:${t}`, type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: t, payload: { linearSessionId: `ls-${t}` } };
      await store.appendInbox(event);
      await store.decide({
        event,
        workflow: { hash: 'h', definition: {} },
        decide: () => ({
          ticket: newTicketState('p', t, t, 'todo', 1),
          effects: Array.from({ length: effects }, (_, k) => ({ kind: 'comment' as const, body: `${t}#${k}` })),
          timers: [],
          clearTimers: false,
        }),
      });
    }
  }

  it('claims with FOR UPDATE SKIP LOCKED: an executor does not wait for a row another one holds (ORC-150, criterion 1)', async () => {
    const store = new PgStore({ pool });
    await seedEffects(store, ['REL-1'], 2);
    const holder = await pool.connect();
    try {
      // Another executor is claiming or settling REL-1's head row right now.
      await holder.query('begin');
      await holder.query(`select 1 from outbox where id = 'REL-1:1:1' for update`);
      const started = Date.now();
      const claim = await Promise.race([store.claimEffect('p', 'REL-1', 60_000), new Promise((r) => setTimeout(() => r('blocked'), 3_000))]);
      // Not blocked, and not the next row either: the ticket's effects stay in order.
      expect(claim).toBe('busy');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await store.claimEffect('p', 'REL-1', 60_000)).toMatchObject({ id: 'REL-1:1:1', attempts: 1 });
  });

  it('never runs the same row in two executors, and keeps each ticket in order (ORC-150, criterion 1)', async () => {
    const tickets = ['REL-1', 'REL-2', 'REL-3', 'REL-4'];
    const perTicket = 6;
    await seedEffects(new PgStore({ pool }), tickets, perTicket);
    const ran: string[] = [];
    const executor = () => {
      const store = new PgStore({ connectionString: db.url, max: 4 });
      const exec = new OutboxExecutor({
        store,
        log: () => {},
        retryIn: () => {},
        execute: async (row) => {
          ran.push(row.id);
          await new Promise((r) => setTimeout(r, Math.random() * 5));
        },
      });
      const loop = async () => {
        for (;;) {
          const due = await store.effectTickets();
          const open = (await pool.query(`select 1 from outbox where status in ('pending', 'running')`)).rowCount;
          if (open === 0) return;
          // Both executors go after the same tickets, in the same order: they race on every row.
          for (const t of due) await exec.runTicket(t.projectId, t.ticketId);
          if (due.length === 0) await new Promise((r) => setTimeout(r, 2));
        }
      };
      return { store, loop };
    };
    const a = executor();
    const b = executor();
    await Promise.all([a.loop(), b.loop()]);
    expect([...ran].sort()).toEqual(tickets.flatMap((t) => Array.from({ length: perTicket }, (_, k) => `${t}:1:${k + 1}`)).sort());
    for (const t of tickets) {
      expect(ran.filter((id) => id.startsWith(`${t}:`))).toEqual(Array.from({ length: perTicket }, (_, k) => `${t}:1:${k + 1}`));
    }
    expect((await pool.query(`select 1 from outbox where status <> 'done' or attempts <> 1`)).rowCount).toBe(0);
    // One result per row in the inbox.
    expect((await pool.query(`select 1 from inbox where id like 'effect:%'`)).rowCount).toBe(tickets.length * perTicket);
    await Promise.all([a.store.close(), b.store.close()]);
  });

  it('takes the ticket advisory lock before reading anything: a held lock holds that ticket only (criterion 1)', async () => {
    const seed = new PgStore({ pool });
    for (const t of ['REL-1', 'REL-2']) {
      const issue = { title: t, logical: 'todo' as const, priority: 0 };
      await seed.appendInbox({ ...TRUSTED, id: `d:${t}`, type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: t, payload: { linearSessionId: `ls-${t}`, issue } });
    }
    // Another session (another daemon in its decision) holds REL-1's lock.
    const holder = await pool.connect();
    await holder.query(`select pg_advisory_lock(hashtext('REL-1'))`);
    const inner = new PgStore({ connectionString: db.url, max: 4 });
    const h = createHarness({ store: inner, projectYaml: COMMENTS });
    for (const t of ['REL-1', 'REL-2']) h.tracker.addIssue({ identifier: t, title: t });
    const journaled = async (t: string) => (await pool.query(`select 1 from journal where ticket_id = $1`, [t])).rowCount;
    try {
      await h.orch.replayInbox();
      for (let i = 0; i < 500 && !(await journaled('REL-2')); i++) await new Promise((r) => setTimeout(r, 10));
      expect(await journaled('REL-2')).toBe(1);
      // REL-1's transaction waits on the lock: nothing of it read or written.
      const waiting = await pool.query(`select 1 from pg_locks where locktype = 'advisory' and not granted`);
      expect(waiting.rowCount).toBe(1);
      expect(await journaled('REL-1')).toBe(0);
      expect(await seed.getTicket('p', 'REL-1')).toBeUndefined();
    } finally {
      await holder.query(`select pg_advisory_unlock(hashtext('REL-1'))`);
      holder.release();
    }
    await h.orch.drained();
    expect(await seed.getTicket('p', 'REL-1')).toMatchObject({ delegated: true });
    h.orch.stopAll();
    await inner.close();
  });

  it('never decides a ticket in two workers at once, and keeps its events in arrival order', async () => {
    const tickets = ['REL-1', 'REL-2', 'REL-3'];
    const prompts = 12;
    const seed = new PgStore({ pool });
    const order = new Map<string, string[]>(tickets.map((t) => [t, []]));
    const write = async (e: FactoryEvent) => {
      await seed.appendInbox(e);
      order.get(e.ticketId!)!.push(e.id);
    };
    for (const t of tickets) {
      const issue = { title: t, logical: 'todo' as const, priority: 0 };
      await write({ ...TRUSTED, id: `d:${t}`, type: 'ticket.delegated', at: 1, projectId: 'p', ticketId: t, payload: { linearSessionId: `ls-${t}`, issue } });
    }
    for (let k = 0; k < prompts; k++) {
      for (const t of tickets) {
        await write({ ...TRUSTED, id: `m:${t}:${k}`, type: 'session.prompted', at: 2 + k, projectId: 'p', ticketId: t, payload: { linearSessionId: `ls-${t}`, body: `${t}#${k}`, author: 'L' } });
      }
    }

    // Two daemons: their own pool, store, orchestrator and fakes, on the same database.
    const outcomes: DecisionOutcome['status'][] = [];
    const worker = () => {
      const inner = new PgStore({ connectionString: db.url, max: 4 });
      const store = Object.assign(Object.create(inner) as Store, {
        decide: async (req: DecisionRequest) => {
          const outcome = await inner.decide(req);
          outcomes.push(outcome.status);
          return outcome;
        },
      });
      const h = createHarness({ store, projectYaml: COMMENTS, effectLeaseMs: 5_000 });
      for (const t of tickets) h.tracker.addIssue({ identifier: t, title: t });
      return { inner, h };
    };
    const a = worker();
    const b = worker();
    try {
      await Promise.all([a.h.orch.startWorker(5), b.h.orch.startWorker(5)]);
      const pending = async () =>
        Number(
          (
            await pool.query<{ n: string }>(
              `select (select count(*) from inbox where processed_at is null) + (select count(*) from outbox where status in ('pending', 'running')) as n`,
            )
          ).rows[0]!.n,
        );
      for (let i = 0; i < 1000 && (await pending()) > 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(await pending()).toBe(0);
    } finally {
      a.h.orch.stopAll();
      b.h.orch.stopAll();
      await Promise.all([a.h.orch.drained(), b.h.orch.drained()]);
    }

    // Each event, and the result of its one comment (ORC-150).
    expect(outcomes.filter((s) => s === 'committed')).toHaveLength(2 * tickets.length * (prompts + 1));
    expect((await pool.query(`select 1 from outbox where status <> 'done'`)).rowCount).toBe(0);
    for (const t of tickets) {
      // A lost update (two decisions on the same projection) or a reordering would show here.
      const ticket = await seed.getTicket('p', t);
      expect(ticket!.humanInbox.map((f) => f.body)).toEqual(Array.from({ length: prompts }, (_, k) => `${t}#${k}`));
      const journal = await pool.query<{ event_id: string; seq: number }>(`select event_id, seq from journal where ticket_id = $1 order by seq`, [t]);
      expect(journal.rows.map((r) => r.event_id).filter((id) => !id.startsWith('effect:'))).toEqual(order.get(t));
      expect(journal.rows.map((r) => r.seq)).toEqual(Array.from({ length: 2 * (prompts + 1) }, (_, k) => k + 1));
      const comments = [...a.h.tracker.calls, ...b.h.tracker.calls].filter((c) => c.method === 'comment' && c.args[0] === t);
      expect(comments).toHaveLength(prompts + 1);
    }
    await Promise.all([a.inner.close(), b.inner.close()]);
  });
});
