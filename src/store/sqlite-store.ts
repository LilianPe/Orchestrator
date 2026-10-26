import { DatabaseSync } from 'node:sqlite';
import { normalizeTicket, type QueueName, type FactoryEvent, type TicketState } from '../core/types.js';
import type { QueueItem, RunRecord, Store, TimerRecord } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (project_id TEXT, ticket_id TEXT, data TEXT NOT NULL, PRIMARY KEY (project_id, ticket_id));
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, ticket_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, token TEXT NOT NULL, started_at INTEGER NOT NULL, cost_usd REAL NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS timers (key TEXT PRIMARY KEY, fire_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (project_id TEXT, ticket_id TEXT, job TEXT, queue TEXT NOT NULL, rank INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (project_id, ticket_id, job));
CREATE TABLE IF NOT EXISTS echoes (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const rank = (priority: number) => (priority === 0 ? 5 : priority);

/** The SQLite store, kept until ORC-178: synchronous `node:sqlite` calls behind the async `Store` port. */
export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  async getTicket(projectId: string, ticketId: string): Promise<TicketState | undefined> {
    const row = this.db.prepare('SELECT data FROM tickets WHERE project_id = ? AND ticket_id = ?').get(projectId, ticketId) as
      | { data: string }
      | undefined;
    return row ? normalizeTicket(JSON.parse(row.data) as TicketState) : undefined;
  }

  async putTicket(t: TicketState): Promise<void> {
    this.db
      .prepare('INSERT INTO tickets (project_id, ticket_id, data) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET data = excluded.data')
      .run(t.projectId, t.ticketId, JSON.stringify(t));
  }

  async listTickets(): Promise<TicketState[]> {
    return (this.db.prepare('SELECT data FROM tickets').all() as { data: string }[]).map((r) => normalizeTicket(JSON.parse(r.data) as TicketState));
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
    this.db
      .prepare('INSERT INTO timers (key, fire_at, data) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET fire_at = excluded.fire_at, data = excluded.data')
      .run(t.key, t.fireAt, JSON.stringify(t));
  }

  async dueTimers(now: number): Promise<TimerRecord[]> {
    return (this.db.prepare('SELECT data FROM timers WHERE fire_at <= ? ORDER BY fire_at').all(now) as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }

  async deleteTimer(key: string, fireAt?: number): Promise<void> {
    if (fireAt === undefined) this.db.prepare('DELETE FROM timers WHERE key = ?').run(key);
    else this.db.prepare('DELETE FROM timers WHERE key = ? AND fire_at = ?').run(key, fireAt);
  }

  async deleteTimersFor(projectId: string, ticketId: string): Promise<void> {
    for (const t of await this.dueTimers(Number.MAX_SAFE_INTEGER)) {
      if (t.projectId === projectId && t.ticketId === ticketId) await this.deleteTimer(t.key);
    }
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

  async dequeue(queue: QueueName): Promise<QueueItem | undefined> {
    const row = this.db
      .prepare('SELECT project_id, ticket_id, job, data FROM queue WHERE queue = ? ORDER BY rank, enqueued_at LIMIT 1')
      .get(queue) as { project_id: string; ticket_id: string; job: string; data: string } | undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM queue WHERE project_id = ? AND ticket_id = ? AND job = ?').run(row.project_id, row.ticket_id, row.job);
    return JSON.parse(row.data);
  }

  async listQueue(): Promise<QueueItem[]> {
    return (this.db.prepare('SELECT data FROM queue ORDER BY rank, enqueued_at').all() as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
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
