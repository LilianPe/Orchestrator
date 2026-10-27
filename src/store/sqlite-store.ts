import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { OutboxEffect } from '../core/decision.js';
import { normalizeTicket, type QueueName, type FactoryEvent, type TicketState } from '../core/types.js';
import type { StoredEvent } from '../core/upcast.js';
import {
  effectResult,
  type DecisionOutcome,
  type DecisionRequest,
  type OutboxRow,
  type QueueClaim,
  type QueueItem,
  type RunRecord,
  type Store,
  type TimerRecord,
  type WorkflowVersion,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (project_id TEXT, ticket_id TEXT, data TEXT NOT NULL, PRIMARY KEY (project_id, ticket_id));
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, ticket_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS events_ticket ON events (ticket_id);
CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL, processed_at INTEGER, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox (processed_at, seq);
CREATE INDEX IF NOT EXISTS inbox_pending_ticket ON inbox (json_extract(data, '$.projectId'), json_extract(data, '$.ticketId'), seq) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, token TEXT NOT NULL, started_at INTEGER NOT NULL, cost_usd REAL NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS timers (key TEXT PRIMARY KEY, fire_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (project_id TEXT, ticket_id TEXT, job TEXT, queue TEXT NOT NULL, rank INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (project_id, ticket_id, job));
CREATE TABLE IF NOT EXISTS echoes (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, ticket_id TEXT, event_id TEXT NOT NULL, seq INTEGER NOT NULL, i INTEGER NOT NULL, status TEXT NOT NULL, lease_until INTEGER, lease TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_open ON outbox (project_id, ticket_id, status, seq, i);
CREATE INDEX IF NOT EXISTS outbox_event ON outbox (event_id);
CREATE TABLE IF NOT EXISTS workflow_versions (hash TEXT PRIMARY KEY, definition TEXT NOT NULL);
`;

/** Columns added after their table was first created (ORC-150): `ALTER TABLE` on an older file. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ['outbox', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['outbox', 'available_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['outbox', 'error', 'TEXT'],
  ['queue', 'lease', 'TEXT'],
  ['queue', 'lease_until', 'INTEGER'],
];

interface OutboxSqlRow {
  id: string;
  project_id: string;
  ticket_id: string | null;
  event_id: string;
  seq: number;
  i: number;
  status: OutboxRow['status'];
  lease_until: number | null;
  lease: string | null;
  attempts: number;
  available_at: number;
  error: string | null;
  data: string;
}

function outboxRow(r: OutboxSqlRow): OutboxRow {
  return {
    id: r.id,
    projectId: r.project_id,
    ...(r.ticket_id === null ? {} : { ticketId: r.ticket_id }),
    eventId: r.event_id,
    seq: Number(r.seq),
    i: Number(r.i),
    effect: JSON.parse(r.data) as OutboxEffect,
    status: r.status,
    attempts: Number(r.attempts),
    ...(r.error === null ? {} : { error: r.error }),
    ...(r.lease === null ? {} : { lease: r.lease }),
  };
}

const rank = (priority: number) => (priority === 0 ? 5 : priority);

/** The SQLite store, kept until ORC-178: synchronous `node:sqlite` calls behind the async `Store` port. */
export class SqliteStore implements Store {
  private db: DatabaseSync;

  /** `now` stamps the inbox rows, like PgStore's injectable clock. */
  constructor(
    path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  /** Runs `f` in one transaction (`node:sqlite` is synchronous: nothing interleaves with it). */
  private atomically<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = f();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async getTicket(projectId: string, ticketId: string): Promise<TicketState | undefined> {
    return this.ticketRow(projectId, ticketId);
  }

  async putTicket(t: TicketState): Promise<void> {
    this.writeTicket(t);
  }

  async listTickets(): Promise<TicketState[]> {
    return (this.db.prepare('SELECT data FROM tickets').all() as { data: string }[]).map((r) => normalizeTicket(JSON.parse(r.data) as TicketState));
  }

  /** The inbox (ORC-147): `seq` keeps the arrival order, the unique id dedups. */
  async appendInbox(e: FactoryEvent | StoredEvent): Promise<boolean> {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO inbox (id, received_at, data) VALUES (?, ?, ?)')
      .run(e.id, this.now(), JSON.stringify(e));
    return Number(res.changes) === 1;
  }

  async pendingInbox(limit: number, exclude: readonly string[] = []): Promise<StoredEvent[]> {
    const skip = new Set(exclude);
    const rows = this.db
      .prepare('SELECT id, data FROM inbox WHERE processed_at IS NULL ORDER BY seq LIMIT ?')
      .all(limit + skip.size) as { id: string; data: string }[];
    return rows
      .filter((r) => !skip.has(r.id))
      .slice(0, limit)
      .map((r) => JSON.parse(r.data) as StoredEvent);
  }

  async markInboxProcessed(id: string): Promise<void> {
    this.db.prepare('UPDATE inbox SET processed_at = ? WHERE id = ? AND processed_at IS NULL').run(this.now(), id);
  }

  /**
   * The decision transaction (ORC-149). `node:sqlite` is synchronous and the store serves one
   * process: no await between BEGIN and COMMIT, so nothing of another ticket interleaves with it,
   * and the in-process worker keeps one task per ticket (the lock of the single process).
   */
  async decide(req: DecisionRequest): Promise<DecisionOutcome> {
    return this.atomically(() => this.decideIn(req, req.event.ticketId ?? null));
  }

  private decideIn(req: DecisionRequest, ticketId: string | null): DecisionOutcome {
    const { event } = req;
    const row = this.db.prepare('SELECT processed_at FROM inbox WHERE id = ?').get(event.id) as { processed_at: number | null } | undefined;
    if (!row) throw new Error(`event ${event.id} is not in the inbox`);
    if (row.processed_at !== null) return { status: 'processed' };
    const first = this.db
      .prepare(
        `SELECT id FROM inbox WHERE processed_at IS NULL AND json_extract(data, '$.projectId') = ? AND json_extract(data, '$.ticketId') IS ?
         ORDER BY seq LIMIT 1`,
      )
      .get(event.projectId, ticketId) as { id: string } | undefined;
    if (first && first.id !== event.id) return { status: 'waiting', reason: `${first.id} comes first` };
    const open = this.db
      .prepare(`SELECT id FROM outbox WHERE project_id = ? AND ticket_id IS ? AND status IN ('pending', 'running') LIMIT 1`)
      .get(event.projectId, ticketId) as { id: string } | undefined;
    if (open) return { status: 'waiting', reason: `effect ${open.id} is unfinished` };
    if (this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(event.id)) {
      this.db.prepare('UPDATE inbox SET processed_at = ? WHERE id = ?').run(this.now(), event.id);
      return { status: 'duplicate' };
    }

    const known = ticketId === null ? undefined : this.ticketRow(event.projectId, ticketId);
    const plan = req.decide(known, this.frozenWorkflow(known, req.workflow));

    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE ticket_id IS ?').get(ticketId) as { n: number };
    const seq = Number(n) + 1;
    this.db.prepare('INSERT INTO events (id, at, ticket_id, data) VALUES (?, ?, ?, ?)').run(event.id, event.at, ticketId, JSON.stringify(event));
    if (plan.ticket) {
      if (plan.ticket.workflowHash === req.workflow.hash) {
        this.db
          .prepare('INSERT OR IGNORE INTO workflow_versions (hash, definition) VALUES (?, ?)')
          .run(req.workflow.hash, JSON.stringify(req.workflow.definition));
      }
      this.writeTicket(plan.ticket);
    }
    if (plan.clearTimers && ticketId !== null) this.clearTimers(event.projectId, ticketId);
    for (const t of plan.timers) this.writeTimer(t);
    const effectIds = plan.effects.map((effect, k) => {
      const id = `${ticketId ?? '*'}:${seq}:${k + 1}`;
      this.db
        .prepare(
          `INSERT INTO outbox (id, project_id, ticket_id, event_id, seq, i, status, attempts, available_at, data) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)`,
        )
        .run(id, event.projectId, ticketId, event.id, seq, k + 1, JSON.stringify(effect));
      return id;
    });
    this.db.prepare('UPDATE inbox SET processed_at = ? WHERE id = ?').run(this.now(), event.id);
    return { status: 'committed', seq, effectIds, known, plan };
  }

  private frozenWorkflow(known: TicketState | undefined, current: WorkflowVersion): WorkflowVersion {
    const hash = known?.workflowHash;
    if (!hash || hash === current.hash) return current;
    const row = this.db.prepare('SELECT definition FROM workflow_versions WHERE hash = ?').get(hash) as { definition: string } | undefined;
    if (!row) throw new Error(`workflow version ${hash} of ${known.ticketId} is not stored`);
    return { hash, definition: JSON.parse(row.definition) as unknown };
  }

  async getWorkflowVersion(hash: string): Promise<WorkflowVersion | undefined> {
    const row = this.db.prepare('SELECT definition FROM workflow_versions WHERE hash = ?').get(hash) as { definition: string } | undefined;
    return row ? { hash, definition: JSON.parse(row.definition) as unknown } : undefined;
  }

  async claimEffect(projectId: string, ticketId: string | undefined, leaseMs: number): Promise<OutboxRow | 'busy' | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM outbox WHERE project_id = ? AND ticket_id IS ? AND status IN ('pending', 'running') ORDER BY seq, i LIMIT 1`)
      .get(projectId, ticketId ?? null) as OutboxSqlRow | undefined;
    if (!row) return undefined;
    const now = Date.now();
    if (row.status === 'running' && (row.lease_until ?? 0) >= now) return 'busy';
    // Waiting for its retry: the ticket's later rows wait behind it.
    if (row.status === 'pending' && Number(row.available_at) > now) return 'busy';
    const lease = randomUUID();
    this.db
      .prepare(`UPDATE outbox SET status = 'running', lease_until = ?, lease = ?, attempts = attempts + 1 WHERE id = ?`)
      .run(now + leaseMs, lease, row.id);
    return { ...outboxRow(row), status: 'running', attempts: Number(row.attempts) + 1, lease };
  }

  async renewEffect(id: string, lease: string, leaseMs: number): Promise<boolean> {
    const res = this.db
      .prepare(`UPDATE outbox SET lease_until = ? WHERE id = ? AND status = 'running' AND lease = ?`)
      .run(Date.now() + leaseMs, id, lease);
    return Number(res.changes) === 1;
  }

  /** The running row under `lease` (any running row without one), or undefined: the guard of every settlement. */
  private heldRow(id: string, lease: string | undefined): OutboxSqlRow | undefined {
    return this.db
      .prepare(`SELECT * FROM outbox WHERE id = ? AND status = 'running' AND (? IS NULL OR lease = ?)`)
      .get(id, lease ?? null, lease ?? null) as OutboxSqlRow | undefined;
  }

  async completeEffect(id: string, lease?: string, at = Date.now()): Promise<boolean> {
    return this.atomically(() => {
      const row = this.heldRow(id, lease);
      if (!row) return false;
      this.db.prepare(`UPDATE outbox SET status = 'done', lease_until = NULL WHERE id = ?`).run(id);
      this.appendResult(effectResult(outboxRow(row), at));
      return true;
    });
  }

  async retryEffect(id: string, lease: string, error: string, delayMs: number): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE outbox SET status = 'pending', lease = NULL, lease_until = NULL, available_at = ?, error = ? WHERE id = ? AND status = 'running' AND lease = ?`,
      )
      .run(Date.now() + delayMs, error, id, lease);
    return Number(res.changes) === 1;
  }

  async failEffect(id: string, lease: string, error: string, at = Date.now()): Promise<boolean> {
    return this.atomically(() => {
      const row = this.heldRow(id, lease);
      if (!row) return false;
      this.db.prepare(`UPDATE outbox SET status = 'dead', lease_until = NULL, error = ? WHERE id = ?`).run(error, id);
      this.db
        .prepare(`UPDATE outbox SET status = 'failed' WHERE event_id = ? AND status = 'pending' AND json_extract(data, '$.kind') <> 'settle'`)
        .run(row.event_id);
      for (const r of this.db.prepare('SELECT key, data FROM timers').all() as { key: string; data: string }[]) {
        if ((JSON.parse(r.data) as TimerRecord).armedBy === row.event_id) this.db.prepare('DELETE FROM timers WHERE key = ?').run(r.key);
      }
      this.appendResult(effectResult(outboxRow(row), at, error));
      return true;
    });
  }

  /** The result of an effect, to the inbox in the transaction that settles its row. */
  private appendResult(e: FactoryEvent): void {
    this.db.prepare('INSERT OR IGNORE INTO inbox (id, received_at, data) VALUES (?, ?, ?)').run(e.id, Date.now(), JSON.stringify(e));
  }

  async effectTickets(): Promise<{ projectId: string; ticketId?: string }[]> {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT o.project_id, o.ticket_id FROM outbox o
         WHERE ((o.status = 'pending' AND o.available_at <= ?) OR (o.status = 'running' AND COALESCE(o.lease_until, 0) < ?))
           AND NOT EXISTS (
             SELECT 1 FROM outbox p
             WHERE p.project_id = o.project_id AND p.ticket_id IS o.ticket_id AND p.status IN ('pending', 'running')
               AND (p.seq < o.seq OR (p.seq = o.seq AND p.i < o.i))
           )`,
      )
      .all(now, now) as { project_id: string; ticket_id: string | null }[];
    return rows.map((r) => ({ projectId: r.project_id, ...(r.ticket_id === null ? {} : { ticketId: r.ticket_id }) }));
  }

  async listEffects(projectId: string, ticketId?: string): Promise<OutboxRow[]> {
    const rows = this.db
      .prepare('SELECT * FROM outbox WHERE project_id = ? AND ticket_id IS ? ORDER BY seq, i')
      .all(projectId, ticketId ?? null) as unknown as OutboxSqlRow[];
    return rows.map(outboxRow);
  }

  async updateTicket(projectId: string, ticketId: string, f: (t: TicketState) => TicketState): Promise<TicketState | undefined> {
    const t = this.ticketRow(projectId, ticketId);
    if (!t) return undefined;
    const next = f(t);
    this.writeTicket(next);
    return next;
  }

  private ticketRow(projectId: string, ticketId: string): TicketState | undefined {
    const row = this.db.prepare('SELECT data FROM tickets WHERE project_id = ? AND ticket_id = ?').get(projectId, ticketId) as
      | { data: string }
      | undefined;
    return row ? normalizeTicket(JSON.parse(row.data) as TicketState) : undefined;
  }

  private writeTicket(t: TicketState): void {
    this.db
      .prepare('INSERT INTO tickets (project_id, ticket_id, data) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET data = excluded.data')
      .run(t.projectId, t.ticketId, JSON.stringify(t));
  }

  private writeTimer(t: TimerRecord): void {
    this.db
      .prepare('INSERT INTO timers (key, fire_at, data) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET fire_at = excluded.fire_at, data = excluded.data')
      .run(t.key, t.fireAt, JSON.stringify(t));
  }

  private clearTimers(projectId: string, ticketId: string): void {
    this.db
      .prepare("DELETE FROM timers WHERE json_extract(data, '$.projectId') = ? AND json_extract(data, '$.ticketId') = ?")
      .run(projectId, ticketId);
  }

  async recordEvent(e: FactoryEvent): Promise<boolean> {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO events (id, at, ticket_id, data) VALUES (?, ?, ?, ?)')
      .run(e.id, e.at, e.ticketId ?? null, JSON.stringify(e));
    return Number(res.changes) === 1;
  }

  async recentEvents(limit: number, ticketId?: string): Promise<FactoryEvent[]> {
    const rows = (
      ticketId
        ? this.db.prepare('SELECT data FROM events WHERE ticket_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(ticketId, limit)
        : this.db.prepare('SELECT data FROM events ORDER BY at DESC, rowid DESC LIMIT ?').all(limit)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async putRun(r: RunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (id, status, token, started_at, cost_usd, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET status = excluded.status, cost_usd = excluded.cost_usd, data = excluded.data`,
      )
      .run(r.id, r.status, r.token, r.startedAt, r.costUsd, JSON.stringify(r));
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  async runsByStatus(status: RunRecord['status']): Promise<RunRecord[]> {
    return (this.db.prepare('SELECT data FROM runs WHERE status = ? ORDER BY started_at').all(status) as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }

  async findRunByToken(token: string): Promise<RunRecord | undefined> {
    const row = this.db.prepare('SELECT data FROM runs WHERE token = ?').get(token) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  async putTimer(t: TimerRecord): Promise<void> {
    this.writeTimer(t);
  }

  async dueTimers(now: number): Promise<TimerRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT data FROM timers WHERE fire_at <= ? AND NOT EXISTS (
           SELECT 1 FROM outbox WHERE outbox.event_id = json_extract(timers.data, '$.armedBy') AND outbox.status IN ('pending', 'running')
         ) ORDER BY fire_at`,
      )
      .all(now) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async deleteTimer(key: string, fireAt?: number): Promise<void> {
    if (fireAt === undefined) this.db.prepare('DELETE FROM timers WHERE key = ?').run(key);
    else this.db.prepare('DELETE FROM timers WHERE key = ? AND fire_at = ?').run(key, fireAt);
  }

  async deleteTimersFor(projectId: string, ticketId: string): Promise<void> {
    this.clearTimers(projectId, ticketId);
  }

  async deleteTimersArmedBy(eventId: string): Promise<void> {
    this.db.prepare("DELETE FROM timers WHERE json_extract(data, '$.armedBy') = ?").run(eventId);
  }

  async enqueue(item: QueueItem): Promise<string> {
    this.db
      .prepare(
        `INSERT INTO queue (project_id, ticket_id, job, queue, rank, enqueued_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET data = excluded.data, rank = excluded.rank`,
      )
      .run(item.projectId, item.ticketId, item.job, item.queue, rank(item.priority), item.enqueuedAt, JSON.stringify(item));
    return `${item.projectId}:${item.ticketId}:${item.job}`;
  }

  /** One process serves the SQLite store: the lease only brings back an item lost by a crash. */
  async claimQueued(queue: QueueName, leaseMs: number): Promise<QueueClaim | undefined> {
    const now = Date.now();
    const row = this.db
      .prepare(
        'SELECT project_id, ticket_id, job, data FROM queue WHERE queue = ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY rank, enqueued_at LIMIT 1',
      )
      .get(queue, now) as { project_id: string; ticket_id: string; job: string; data: string } | undefined;
    if (!row) return undefined;
    const lease = randomUUID();
    this.db
      .prepare('UPDATE queue SET lease = ?, lease_until = ? WHERE project_id = ? AND ticket_id = ? AND job = ?')
      .run(lease, now + leaseMs, row.project_id, row.ticket_id, row.job);
    return { id: `${row.project_id}:${row.ticket_id}:${row.job}`, lease, item: JSON.parse(row.data) as QueueItem };
  }

  async renewQueued(claim: QueueClaim, leaseMs: number): Promise<boolean> {
    const { projectId, ticketId, job } = claim.item;
    const res = this.db
      .prepare('UPDATE queue SET lease_until = ? WHERE project_id = ? AND ticket_id = ? AND job = ? AND lease = ?')
      .run(Date.now() + leaseMs, projectId, ticketId, job, claim.lease);
    return Number(res.changes) === 1;
  }

  async finishQueued(claim: QueueClaim): Promise<boolean> {
    const { projectId, ticketId, job } = claim.item;
    const res = this.db
      .prepare('DELETE FROM queue WHERE project_id = ? AND ticket_id = ? AND job = ? AND lease = ?')
      .run(projectId, ticketId, job, claim.lease);
    return Number(res.changes) === 1;
  }

  async releaseQueued(claim: QueueClaim): Promise<boolean> {
    const { projectId, ticketId, job } = claim.item;
    const res = this.db
      .prepare('UPDATE queue SET lease = NULL, lease_until = NULL WHERE project_id = ? AND ticket_id = ? AND job = ? AND lease = ?')
      .run(projectId, ticketId, job, claim.lease);
    return Number(res.changes) === 1;
  }

  async listQueue(): Promise<QueueItem[]> {
    const rows = this.db
      .prepare('SELECT data FROM queue WHERE lease_until IS NULL OR lease_until < ? ORDER BY rank, enqueued_at')
      .all(Date.now()) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  async removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): Promise<void> {
    this.db.prepare('DELETE FROM queue WHERE project_id = ? AND ticket_id = ? AND (? IS NULL OR queue = ?)').run(projectId, ticketId, queue ?? null, queue ?? null);
  }

  async putEcho(key: string, until: number): Promise<void> {
    this.db.prepare('INSERT INTO echoes (key, until) VALUES (?, ?) ON CONFLICT DO UPDATE SET until = excluded.until').run(key, until);
  }

  async isEcho(key: string, now: number): Promise<boolean> {
    const row = this.db.prepare('SELECT until FROM echoes WHERE key = ?').get(key) as { until: number } | undefined;
    return !!row && row.until >= now;
  }

  async costSince(ts: number): Promise<number> {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE started_at >= ?').get(ts) as { total: number };
    return row.total;
  }

  async getMeta(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value').run(key, value);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
