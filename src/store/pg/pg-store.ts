import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { normalizeTicket, type FactoryEvent, type QueueName, type TicketState } from '../../core/types.js';
import type { QueueItem, RunRecord, TimerRecord } from '../types.js';
import * as schema from './schema.js';
import type { AsyncStore, DequeuedEffect, PutTicketOptions } from './types.js';

/** How long a `claim` keeps a row out of another worker's reach. */
export const OUTBOX_LEASE_MS = 30_000;

export interface PgStoreOptions {
  connectionString?: string;
  /** Inject a pool to share connections (tests); the caller then owns `pool.end()`. */
  pool?: Pool;
  max?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Where an idle client's error goes (Postgres restarted, connection cut). Default: stderr. */
  onError?: (err: Error) => void;
}

/**
 * A pool emits `error` when an idle client loses its connection; unheard, Node throws it and the
 * daemon dies. The pool reconnects on the next query, so the error is only reported. An injected
 * pool that already has a listener keeps it.
 */
export function listenForPoolErrors(pool: Pool, onError: (err: Error) => void): void {
  if (pool.listenerCount('error') === 0) pool.on('error', onError);
}

const reportToStderr = (err: Error) => console.error(`[postgres] ${err.message}`);

const dateToMs = (value: Date | string | null): number => {
  if (value === null) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
};

const echoId = (key: string) => `echo:${key}`;

/** Queue order of the SQLite store: priority 1 (urgent) first, 0 (none) after 4 (low), then age. */
const QUEUE_ORDER = sql.raw(
  `case when (payload->>'priority')::int = 0 then 5 else coalesce((payload->>'priority')::int, 5) end, available_at, id`,
);

/** Key/value metadata kept in `workflow_versions` under a reserved id prefix, until ORC-178 removes it. */
const metaId = (key: string) => `meta:${key}`;

export class PgStore implements AsyncStore {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly ownsPool: boolean;
  private readonly clock: () => number;

  constructor(options: PgStoreOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      const connectionString = options.connectionString ?? process.env['DATABASE_URL'];
      if (!connectionString) throw new Error('PgStore requires DATABASE_URL, connectionString, or a Pool');
      this.pool = new Pool({ connectionString, max: options.max ?? 10 });
      this.ownsPool = true;
    }
    this.db = drizzle(this.pool, { schema });
    this.clock = options.now ?? (() => Date.now());
    listenForPoolErrors(this.pool, options.onError ?? reportToStderr);
  }

  private now(): number {
    return this.clock();
  }

  async getTicket(projectId: string, ticketId: string): Promise<TicketState | undefined> {
    const result = await this.db.execute<{ data: TicketState }>(
      sql`select data from tickets where id = ${ticketId} limit 1`,
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const ticket = normalizeTicket(row.data);
    return ticket.projectId === projectId ? ticket : undefined;
  }

  /**
   * Upserts the projection from the current ticket state. `tickets.id` is the ticket identifier
   * (the schema is single-project, unlike the old `(project_id, ticket_id)` key).
   */
  async putTicket(ticket: TicketState, options: PutTicketOptions = {}): Promise<void> {
    const t = normalizeTicket(ticket);
    const stepCursor = t.pendingJob?.job ?? null;
    const activeAttempts = (t.activeRunId ? 1 : 0) + (t.verifyingRunId ? 1 : 0);
    const now = this.now();
    await this.db.execute(sql`
      insert into tickets (
        id, status, step_cursor, active_attempts, human_inbox, workflow_hash, data, created_at, updated_at
      ) values (
        ${t.ticketId}, ${t.logical}, ${stepCursor}, ${activeAttempts}, ${JSON.stringify(t.pendingFeedback)}::jsonb,
        ${options.workflowHash ?? null}, ${JSON.stringify(t)}::jsonb,
        to_timestamp(${now / 1000}), to_timestamp(${t.updatedAt / 1000})
      )
      on conflict (id) do update set
        status = excluded.status,
        step_cursor = excluded.step_cursor,
        active_attempts = excluded.active_attempts,
        human_inbox = excluded.human_inbox,
        workflow_hash = coalesce(excluded.workflow_hash, tickets.workflow_hash),
        data = excluded.data,
        updated_at = excluded.updated_at
    `);
  }

  async listTickets(): Promise<TicketState[]> {
    const result = await this.db.execute<{ data: TicketState }>(sql`select data from tickets order by id`);
    return result.rows.map((row) => normalizeTicket(row.data));
  }

  /**
   * Appends to `inbox` and `journal` in one transaction. The second call for the same event id
   * returns `false` without touching the journal (the ORC-147 idempotency contract). The inbox row
   * is written processed: the event is handled as it is journaled, and an inbox replay (ORC-147)
   * must not take these rows for unprocessed ones.
   *
   * The per-ticket journal sequence is allocated under a transaction-scoped advisory lock, so two
   * workers cannot pick the same `seq` for a ticket.
   */
  async recordEvent(event: FactoryEvent): Promise<boolean> {
    const now = this.now();
    // A row without a version predates versioning: version 1, as `upcast` reads it.
    const version = event.schemaVersion ?? 1;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(
        sql`
          insert into inbox (id, event_id, type, payload, received_at, processed_at, schema_version)
          values (
            ${event.id}, ${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb,
            to_timestamp(${now / 1000}), to_timestamp(${now / 1000}), ${version}
          )
          on conflict do nothing
          returning id
        `,
      );
      if ((inserted.rowCount ?? 0) === 0) return false;

      const ticketId = event.ticketId ?? null;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId ?? '__global__'}))`);
      const seqResult = await tx.execute<{ seq: number }>(
        sql`
          select coalesce(max(seq), 0) + 1 as seq
          from journal
          where ticket_id is not distinct from ${ticketId}
        `,
      );
      const seq = Number(seqResult.rows[0]?.seq ?? 1);
      await tx.execute(sql`
        insert into journal (id, ticket_id, event_id, seq, type, payload, schema_version, created_at)
        values (
          ${event.id}, ${ticketId}, ${event.id}, ${seq}, ${event.type},
          ${JSON.stringify(event)}::jsonb, ${version}, to_timestamp(${now / 1000})
        )
      `);
      return true;
    });
  }

  /**
   * Newest recorded first, on the indexed `created_at` (the event's own `at` has no index); `seq`
   * orders a ticket's events recorded in the same millisecond.
   */
  async recentEvents(limit: number, ticketId?: string): Promise<FactoryEvent[]> {
    const result = ticketId
      ? await this.db.execute<{ payload: FactoryEvent }>(
          sql`
            select payload from journal
            where ticket_id = ${ticketId}
            order by created_at desc, seq desc
            limit ${limit}
          `,
        )
      : await this.db.execute<{ payload: FactoryEvent }>(
          sql`select payload from journal order by created_at desc, seq desc limit ${limit}`,
        );
    return result.rows.map((row) => row.payload);
  }

  /**
   * Runs are stored as attempts for now: the new schema has no `runs` table, and `attempts` is
   * where an agent execution belongs. The full legacy record lives in `attempts.data`, so the
   * async port can return it unchanged until the run/attempt split lands.
   */
  async putRun(run: RunRecord): Promise<void> {
    const endedAt = run.endedAt === undefined ? null : new Date(run.endedAt);
    await this.db.execute(sql`
      insert into attempts (
        id, ticket_id, step, model, effort, fingerprints, image, risk,
        started_at, ended_at, status, data, cost_usd
      ) values (
        ${run.id}, ${run.ticketId}, ${run.job}, null, null, '{}'::jsonb, null, null,
        to_timestamp(${run.startedAt / 1000}), ${endedAt}, ${run.status},
        ${JSON.stringify(run)}::jsonb, ${run.costUsd}
      )
      on conflict (id) do update set
        ticket_id = excluded.ticket_id,
        step = excluded.step,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        status = excluded.status,
        data = excluded.data,
        cost_usd = excluded.cost_usd
    `);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const result = await this.db.execute<{ data: RunRecord }>(
      sql`select data from attempts where id = ${id} limit 1`,
    );
    return result.rows[0]?.data;
  }

  async runsByStatus(status: RunRecord['status']): Promise<RunRecord[]> {
    const result = await this.db.execute<{ data: RunRecord }>(
      sql`select data from attempts where status = ${status} order by started_at, id`,
    );
    return result.rows.map((row) => row.data);
  }

  async findRunByToken(token: string): Promise<RunRecord | undefined> {
    const result = await this.db.execute<{ data: RunRecord }>(
      sql`select data from attempts where data->>'token' = ${token} limit 1`,
    );
    return result.rows[0]?.data;
  }

  async costSince(ts: number): Promise<number> {
    const result = await this.db.execute<{ total: number | string }>(
      sql`
        select coalesce(sum(cost_usd), 0) as total
        from attempts
        where started_at >= to_timestamp(${ts / 1000})
      `,
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async putTimer(timer: TimerRecord): Promise<void> {
    await this.db.execute(sql`
      insert into timers (id, ticket_id, kind, due_at, payload, status, created_at)
      values (
        ${timer.key}, ${timer.ticketId}, ${timer.job}, to_timestamp(${timer.fireAt / 1000}),
        ${JSON.stringify(timer)}::jsonb, 'pending', to_timestamp(${this.now() / 1000})
      )
      on conflict (id) do update set
        ticket_id = excluded.ticket_id,
        kind = excluded.kind,
        due_at = excluded.due_at,
        payload = excluded.payload,
        status = 'pending'
    `);
  }

  /**
   * Reads the due timers without changing them, as SQLite does: a timer stays due until
   * `deleteTimer` removes it, so a pass cut before that (an error, a shutdown) fires it again on
   * the next one. Its event id (`timer:<key>:<fireAt>`) makes the second firing a no-op.
   */
  async dueTimers(now: number): Promise<TimerRecord[]> {
    const result = await this.db.execute<{ payload: TimerRecord }>(sql`
      select payload
      from timers
      where status = 'pending' and due_at <= to_timestamp(${now / 1000})
      order by due_at, id
    `);
    return result.rows.map((row) => row.payload);
  }

  async deleteTimer(key: string, fireAt?: number): Promise<void> {
    const armedAt = fireAt === undefined ? sql`` : sql`and (payload->>'fireAt')::double precision = ${fireAt}`;
    await this.db.execute(sql`delete from timers where id = ${key} and status = 'pending' ${armedAt}`);
  }

  async deleteTimersFor(projectId: string, ticketId: string): Promise<void> {
    await this.db.execute(
      sql`delete from timers where ticket_id = ${ticketId} and payload->>'projectId' = ${projectId}`,
    );
  }

  /**
   * Enqueues an outbox effect, id `ticket:seq:i`. `seq` is the latest journal sequence for the
   * ticket (`0` before the first event) and `i` is the next index within that sequence.
   */
  async enqueue(item: QueueItem): Promise<string> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${item.ticketId}))`);

      // The synchronous queue deduped by ticket + job; keep that contract for queue-shaped rows.
      const existing = await tx.execute<{ id: string; status: string }>(
        sql`
          select id, status from outbox
          where ticket_id = ${item.ticketId}
            and effect = ${item.job}
            and status in ('pending', 'running')
            and payload->>'queue' is not null
          order by created_at, id
          limit 1
          for update
        `,
      );
      const current = existing.rows[0];
      if (current) {
        // A deduped row keeps its place in line, as the SQLite queue keeps `enqueued_at`.
        if (current.status === 'pending') {
          await tx.execute(sql`
            update outbox set payload = ${JSON.stringify(item)}::jsonb, updated_at = to_timestamp(${this.now() / 1000})
            where id = ${current.id}
          `);
        }
        return current.id;
      }

      const seqResult = await tx.execute<{ seq: number | null }>(
        sql`select max(seq) as seq from journal where ticket_id = ${item.ticketId}`,
      );
      const seq = Number(seqResult.rows[0]?.seq ?? 0);
      const indexResult = await tx.execute<{ next_i: number }>(
        sql`
          select coalesce(max(nullif(split_part(id, ':', 3), '')::int), 0) + 1 as next_i
          from outbox
          where ticket_id = ${item.ticketId} and id like ${`${item.ticketId}:${seq}:%`}
        `,
      );
      const i = Number(indexResult.rows[0]?.next_i ?? 1);
      const id = `${item.ticketId}:${seq}:${i}`;
      const availableAt = new Date(item.enqueuedAt > 0 ? item.enqueuedAt : this.now());
      const now = this.now();
      await tx.execute(sql`
        insert into outbox (
          id, ticket_id, effect, payload, status, available_at, attempts, created_at, updated_at
        ) values (
          ${id}, ${item.ticketId}, ${item.job}, ${JSON.stringify(item)}::jsonb, 'pending',
          ${availableAt}, 0, to_timestamp(${now / 1000}), to_timestamp(${now / 1000})
        )
      `);
      return id;
    });
  }

  /**
   * The `Store` queue: takes the next pending item of a queue out for good (status `done`), in the
   * SQLite order (priority, then age). Not gated by `available_at`: the legacy queue has no delay.
   * `FOR UPDATE SKIP LOCKED` keeps two daemons from taking the same item.
   */
  async dequeue(queue: QueueName): Promise<QueueItem | undefined> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string; payload: QueueItem }>(sql`
        select id, payload from outbox
        where status = 'pending' and payload->>'queue' = ${queue}
        order by ${QUEUE_ORDER}
        limit 1
        for update skip locked
      `);
      const row = result.rows[0];
      if (!row) return undefined;
      await tx.execute(sql`
        update outbox set status = 'done', attempts = attempts + 1, lease_until = null,
          updated_at = to_timestamp(${now / 1000})
        where id = ${row.id}
      `);
      return row.payload;
    });
  }

  /**
   * Claims the next pending effect for a queue with `FOR UPDATE SKIP LOCKED`, marks it `running`
   * and returns it with a lease. An expired lease makes the row claimable again; `completeEffect`
   * settles it. Not used by the orchestrator yet: the outbox executors arrive with ORC-150.
   */
  async claim(queue: QueueName, now = this.now()): Promise<DequeuedEffect | undefined> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{
        id: string;
        ticket_id: string;
        effect: string;
        payload: QueueItem;
        attempts: number;
        available_at: Date;
      }>(
        sql`
          select id, ticket_id, effect, payload, attempts, available_at
          from outbox
          where (
              status = 'pending'
              or (status = 'running' and lease_until is not null and lease_until < to_timestamp(${now / 1000}))
            )
            and available_at <= to_timestamp(${now / 1000})
            and (lease_until is null or lease_until < to_timestamp(${now / 1000}))
            and payload->>'queue' = ${queue}
          order by ${QUEUE_ORDER}
          limit 1
          for update skip locked
        `,
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const attempts = Number(row.attempts) + 1;
      const leaseUntil = now + OUTBOX_LEASE_MS;
      await tx.execute(sql`
        update outbox set
          status = 'running',
          attempts = ${attempts},
          lease_until = to_timestamp(${leaseUntil / 1000}),
          updated_at = to_timestamp(${now / 1000})
        where id = ${row.id}
      `);
      return {
        id: row.id,
        ticketId: row.ticket_id,
        effect: row.effect,
        payload: row.payload,
        status: 'running' as const,
        attempts,
        availableAt: dateToMs(row.available_at),
        leaseUntil,
      };
    });
  }

  async completeEffect(id: string): Promise<void> {
    await this.db.execute(sql`
      update outbox set status = 'done', lease_until = null, updated_at = to_timestamp(${this.now() / 1000})
      where id = ${id}
    `);
  }

  async listQueue(): Promise<QueueItem[]> {
    const result = await this.db.execute<{ payload: QueueItem }>(
      sql`
        select payload from outbox
        where status = 'pending' and payload->>'queue' is not null
        order by ${QUEUE_ORDER}
      `,
    );
    return result.rows.map((row) => row.payload);
  }

  async removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): Promise<void> {
    const ofQueue = queue === undefined ? sql`` : sql`and payload->>'queue' = ${queue}`;
    await this.db.execute(
      sql`
        delete from outbox
        where ticket_id = ${ticketId} and status = 'pending' and payload->>'projectId' = ${projectId} ${ofQueue}
      `,
    );
  }

  /**
   * An echo is a time-bounded marker. It lives in `timers` with `kind = 'echo'` and status `echo`,
   * which keeps `dueTimers` from firing it. Only the existing echo API uses this row shape.
   */
  async putEcho(key: string, until: number): Promise<void> {
    const ticketId = key.split(':')[1] ?? key;
    const now = this.now();
    await this.db.execute(sql`
      insert into timers (id, ticket_id, kind, due_at, payload, status, created_at)
      values (
        ${echoId(key)}, ${ticketId}, 'echo', to_timestamp(${until / 1000}),
        ${JSON.stringify({ key, until })}::jsonb, 'echo', to_timestamp(${now / 1000})
      )
      on conflict (id) do update set
        ticket_id = excluded.ticket_id,
        due_at = excluded.due_at,
        payload = excluded.payload,
        status = 'echo'
    `);
  }

  async isEcho(key: string, now: number): Promise<boolean> {
    const result = await this.db.execute<{ found: boolean }>(
      sql`
        select exists(
          select 1 from timers
          where id = ${echoId(key)} and status = 'echo' and due_at >= to_timestamp(${now / 1000})
        ) as found
      `,
    );
    return result.rows[0]?.found ?? false;
  }

  async getMeta(key: string): Promise<string | undefined> {
    const result = await this.db.execute<{ value: string | null }>(
      sql`select definition->>'value' as value from workflow_versions where id = ${metaId(key)} limit 1`,
    );
    return result.rows[0]?.value ?? undefined;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const id = metaId(key);
    const hash = createHash('sha256').update(`${id}\0${value}`).digest('hex');
    await this.db.execute(sql`
      insert into workflow_versions (id, hash, definition, created_at)
      values (
        ${id}, ${hash}, ${JSON.stringify({ key, value })}::jsonb, to_timestamp(${this.now() / 1000})
      )
      on conflict (id) do update set hash = excluded.hash, definition = excluded.definition
    `);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
