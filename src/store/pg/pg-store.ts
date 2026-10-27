import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { OutboxEffect } from '../../core/decision.js';
import { normalizeTicket, type FactoryEvent, type QueueName, type TicketState } from '../../core/types.js';
import type { StoredEvent } from '../../core/upcast.js';
import type { DecisionOutcome, DecisionRequest, OutboxRow, QueueItem, RunRecord, TimerRecord, WorkflowVersion } from '../types.js';
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

/** A workflow version a ticket is frozen on (ORC-149), in `workflow_versions` beside the meta rows. */
const workflowId = (hash: string) => `wf:${hash}`;

/**
 * The key of a ticket's advisory lock, shared by every writer of its journal, projection and
 * outbox: the decision transaction, `updateTicket`, `recordEvent` and `enqueue`.
 */
const ticketLock = (ticketId: string | undefined | null) => sql`select pg_advisory_xact_lock(hashtext(${ticketId ?? '__global__'}))`;

/** The `outbox.ticket_id` of a decision row: the ticket, or `*` for an event without one. */
const outboxTicket = (ticketId: string | undefined | null) => ticketId ?? '*';

/** Decision rows (ORC-149) carry `payload.effect`; the legacy queue rows carry `payload.queue`. */
const DECISION_ROW = sql.raw(`payload ? 'effect'`);
const OUTBOX_ORDER = sql.raw(`(payload->>'seq')::int, (payload->>'i')::int`);

interface OutboxPayload {
  projectId: string;
  ticketId?: string;
  eventId: string;
  seq: number;
  i: number;
  effect: OutboxEffect;
  /** Claim token of the running row (`claimEffect`). */
  lease?: string;
}

type Tx = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

const outboxRow = (id: string, status: OutboxRow['status'], p: OutboxPayload): OutboxRow => ({
  id,
  projectId: p.projectId,
  ...(p.ticketId === undefined ? {} : { ticketId: p.ticketId }),
  eventId: p.eventId,
  seq: p.seq,
  i: p.i,
  effect: p.effect,
  status,
  ...(p.lease === undefined ? {} : { lease: p.lease }),
});

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
    return this.readTicket(this.db, projectId, ticketId);
  }

  private async readTicket(db: Tx | NodePgDatabase<typeof schema>, projectId: string, ticketId: string): Promise<TicketState | undefined> {
    const result = await db.execute<{ data: TicketState }>(sql`select data from tickets where id = ${ticketId} limit 1`);
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
    await this.writeTicket(this.db, ticket, options);
  }

  private async writeTicket(db: Tx | NodePgDatabase<typeof schema>, ticket: TicketState, options: PutTicketOptions = {}): Promise<void> {
    const t = normalizeTicket(ticket);
    const stepCursor = t.pendingJob?.job ?? null;
    const activeAttempts = (t.activeRunId ? 1 : 0) + (t.verifyingRunId ? 1 : 0);
    const now = this.now();
    await db.execute(sql`
      insert into tickets (
        id, status, step_cursor, active_attempts, human_inbox, workflow_hash, data, created_at, updated_at
      ) values (
        ${t.ticketId}, ${t.logical}, ${stepCursor}, ${activeAttempts}, ${JSON.stringify(t.pendingFeedback)}::jsonb,
        ${options.workflowHash ?? t.workflowHash ?? null}, ${JSON.stringify(t)}::jsonb,
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
   * Writes an event to `inbox`, committed before the call resolves (ORC-147). `on conflict do
   * nothing` on the event id: a delivery received twice returns `false` the second time.
   *
   * Under the ticket's advisory lock, `received_at` is the server's `clock_timestamp()` (ORC-149):
   * the rows of a ticket get their time in the order they commit, whatever process writes them,
   * and a decision of the ticket (same lock) never runs while one of its rows is being written.
   * The worker decides a ticket's rows in that order, so a later row cannot pass an earlier one
   * that was still uncommitted.
   */
  async appendInbox(event: FactoryEvent | StoredEvent): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(ticketLock(event.ticketId));
      const inserted = await tx.execute(sql`
        insert into inbox (id, event_id, type, payload, received_at, schema_version)
        values (
          ${event.id}, ${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb,
          clock_timestamp(), ${event.schemaVersion ?? 1}
        )
        on conflict do nothing
        returning id
      `);
      return (inserted.rowCount ?? 0) > 0;
    });
  }

  async pendingInbox(limit: number, exclude: readonly string[] = []): Promise<StoredEvent[]> {
    const result = await this.db.execute<{ payload: StoredEvent }>(sql`
      select payload from inbox
      where processed_at is null and not (id = any(${sql.param([...exclude])}::text[]))
      order by received_at, id
      limit ${limit}
    `);
    return result.rows.map((row) => row.payload);
  }

  async markInboxProcessed(id: string): Promise<void> {
    await this.db.execute(sql`
      update inbox set processed_at = to_timestamp(${this.now() / 1000})
      where id = ${id} and processed_at is null
    `);
  }

  /**
   * The decision transaction (ORC-149), in one `BEGIN … COMMIT`:
   *
   * 1. `pg_advisory_xact_lock` on the ticket, before anything is read: two workers (two daemons)
   *    never decide the same ticket at once;
   * 2. the inbox row must still be pending (`for update`), be the oldest pending row of its ticket
   *    and find no unfinished outbox row of the ticket, or nothing happens (`processed`, `waiting`):
   *    the ticket's events are decided in arrival order, each after the effects of the previous one;
   * 3. the projection and the workflow version the ticket is frozen on are read, `decide` runs;
   * 4. journal (next `seq` of the ticket), projection, timers, outbox rows `ticket:seq:i` and the
   *    inbox mark are written. A throw anywhere rolls all of it back: the row stays pending.
   */
  async decide(req: DecisionRequest): Promise<DecisionOutcome> {
    const { event } = req;
    const ticketId = event.ticketId ?? null;
    const now = this.now();
    return this.db.transaction(async (tx): Promise<DecisionOutcome> => {
      await tx.execute(ticketLock(ticketId));
      const row = await tx.execute<{ processed: boolean }>(
        sql`select processed_at is not null as processed from inbox where id = ${event.id} for update`,
      );
      if (!row.rows[0]) throw new Error(`event ${event.id} is not in the inbox`);
      if (row.rows[0].processed) return { status: 'processed' };
      const first = await tx.execute<{ id: string }>(sql`
        select id from inbox
        where processed_at is null and payload->>'projectId' = ${event.projectId}
          and (payload->>'ticketId') is not distinct from ${ticketId}
        order by received_at, id
        limit 1
      `);
      const firstId = first.rows[0]?.id;
      if (firstId !== undefined && firstId !== event.id) return { status: 'waiting', reason: `${firstId} comes first` };
      const open = await tx.execute<{ id: string }>(sql`
        select id from outbox
        where ticket_id = ${outboxTicket(ticketId)} and ${DECISION_ROW} and payload->>'projectId' = ${event.projectId}
          and status in ('pending', 'running')
        limit 1
      `);
      if (open.rows[0]) return { status: 'waiting', reason: `effect ${open.rows[0].id} is unfinished` };
      const markProcessed = sql`update inbox set processed_at = to_timestamp(${now / 1000}) where id = ${event.id}`;
      if ((await tx.execute(sql`select 1 from journal where event_id = ${event.id} limit 1`)).rowCount) {
        await tx.execute(markProcessed);
        return { status: 'duplicate' };
      }

      const known = ticketId === null ? undefined : await this.readTicket(tx, event.projectId, ticketId);
      const frozen = known?.workflowHash && known.workflowHash !== req.workflow.hash ? await this.readWorkflow(tx, known.workflowHash) : req.workflow;
      if (!frozen) throw new Error(`workflow version ${known?.workflowHash} of ${ticketId} is not stored`);
      const plan = req.decide(known, frozen);

      const seqResult = await tx.execute<{ seq: number }>(
        sql`select coalesce(max(seq), 0) + 1 as seq from journal where ticket_id is not distinct from ${ticketId}`,
      );
      const seq = Number(seqResult.rows[0]?.seq ?? 1);
      await tx.execute(sql`
        insert into journal (id, ticket_id, event_id, seq, type, payload, schema_version, created_at)
        values (
          ${event.id}, ${ticketId}, ${event.id}, ${seq}, ${event.type},
          ${JSON.stringify(event)}::jsonb, ${event.schemaVersion ?? 1}, to_timestamp(${now / 1000})
        )
      `);
      if (plan.ticket) {
        if (plan.ticket.workflowHash === req.workflow.hash) {
          await tx.execute(sql`
            insert into workflow_versions (id, hash, definition, created_at)
            values (${workflowId(req.workflow.hash)}, ${req.workflow.hash}, ${JSON.stringify(req.workflow.definition)}::jsonb, to_timestamp(${now / 1000}))
            on conflict do nothing
          `);
        }
        await this.writeTicket(tx, plan.ticket);
      }
      if (plan.clearTimers && ticketId !== null) {
        await tx.execute(sql`delete from timers where ticket_id = ${ticketId} and payload->>'projectId' = ${event.projectId}`);
      }
      for (const t of plan.timers) await this.writeTimer(tx, t);
      const effectIds: string[] = [];
      for (const [k, effect] of plan.effects.entries()) {
        const id = `${outboxTicket(ticketId)}:${seq}:${k + 1}`;
        const payload: OutboxPayload = { projectId: event.projectId, ...(ticketId === null ? {} : { ticketId }), eventId: event.id, seq, i: k + 1, effect };
        await tx.execute(sql`
          insert into outbox (id, ticket_id, effect, payload, status, available_at, attempts, created_at, updated_at)
          values (
            ${id}, ${outboxTicket(ticketId)}, ${effect.kind}, ${JSON.stringify(payload)}::jsonb, 'pending',
            to_timestamp(${now / 1000}), 0, to_timestamp(${now / 1000}), to_timestamp(${now / 1000})
          )
        `);
        effectIds.push(id);
      }
      await tx.execute(markProcessed);
      return { status: 'committed', seq, effectIds, known, plan };
    });
  }

  private async readWorkflow(db: Tx | NodePgDatabase<typeof schema>, hash: string): Promise<WorkflowVersion | undefined> {
    const result = await db.execute<{ definition: unknown }>(sql`select definition from workflow_versions where id = ${workflowId(hash)} limit 1`);
    const row = result.rows[0];
    return row ? { hash, definition: row.definition } : undefined;
  }

  getWorkflowVersion(hash: string): Promise<WorkflowVersion | undefined> {
    return this.readWorkflow(this.db, hash);
  }

  /**
   * The ticket's first unfinished decision row, claimed under a lease (`for update`: two workers
   * never claim the same row). `busy` while another worker's lease on it is live.
   */
  async claimEffect(projectId: string, ticketId: string | undefined, leaseMs: number): Promise<OutboxRow | 'busy' | undefined> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string; status: OutboxRow['status']; live: boolean; payload: OutboxPayload }>(sql`
        select id, status, coalesce(lease_until >= to_timestamp(${now / 1000}), false) as live, payload
        from outbox
        where ticket_id = ${outboxTicket(ticketId)} and ${DECISION_ROW} and payload->>'projectId' = ${projectId}
          and status in ('pending', 'running')
        order by ${OUTBOX_ORDER}
        limit 1
        for update
      `);
      const row = result.rows[0];
      if (!row) return undefined;
      if (row.status === 'running' && row.live) return 'busy' as const;
      const lease = randomUUID();
      await tx.execute(sql`
        update outbox set status = 'running', attempts = attempts + 1,
          lease_until = to_timestamp(${(now + leaseMs) / 1000}), updated_at = to_timestamp(${now / 1000}),
          payload = payload || jsonb_build_object('lease', ${lease}::text)
        where id = ${row.id}
      `);
      return outboxRow(row.id, 'running', { ...row.payload, lease });
    });
  }

  async renewEffect(id: string, lease: string, leaseMs: number): Promise<boolean> {
    const now = this.now();
    const result = await this.db.execute(sql`
      update outbox set lease_until = to_timestamp(${(now + leaseMs) / 1000}), updated_at = to_timestamp(${now / 1000})
      where id = ${id} and status = 'running' and payload->>'lease' = ${lease}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  async failEffect(id: string, lease: string): Promise<boolean> {
    return this.settleEffect(id, 'failed', lease);
  }

  /** Settles a running row, only under its claim token when one is given (decision rows). */
  private async settleEffect(id: string, status: 'done' | 'failed', lease: string | undefined): Promise<boolean> {
    const owned = lease === undefined ? sql`true` : sql`payload->>'lease' = ${lease}`;
    const result = await this.db.execute(sql`
      update outbox set status = ${status}, lease_until = null, updated_at = to_timestamp(${this.now() / 1000})
      where id = ${id} and status = 'running' and ${owned}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /** Tickets whose first unfinished row is claimable: pending, or running under an expired lease. */
  async effectTickets(): Promise<{ projectId: string; ticketId?: string }[]> {
    const now = this.now();
    const result = await this.db.execute<{ project_id: string; ticket_id: string | null }>(sql`
      select project_id, ticket_id from (
        select distinct on (outbox.ticket_id, payload->>'projectId')
          payload->>'projectId' as project_id, payload->>'ticketId' as ticket_id, status, lease_until
        from outbox
        where ${DECISION_ROW} and status in ('pending', 'running')
        order by outbox.ticket_id, payload->>'projectId', ${OUTBOX_ORDER}
      ) head
      where status = 'pending' or coalesce(lease_until < to_timestamp(${now / 1000}), true)
    `);
    return result.rows.map((r) => ({ projectId: r.project_id, ...(r.ticket_id === null ? {} : { ticketId: r.ticket_id }) }));
  }

  async listEffects(projectId: string, ticketId?: string): Promise<OutboxRow[]> {
    const result = await this.db.execute<{ id: string; status: OutboxRow['status']; payload: OutboxPayload }>(sql`
      select id, status, payload from outbox
      where ticket_id = ${outboxTicket(ticketId)} and ${DECISION_ROW} and payload->>'projectId' = ${projectId}
      order by ${OUTBOX_ORDER}
    `);
    return result.rows.map((r) => outboxRow(r.id, r.status, r.payload));
  }

  /** Read-modify-write of the projection under the ticket's advisory lock. */
  async updateTicket(projectId: string, ticketId: string, f: (t: TicketState) => TicketState): Promise<TicketState | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(ticketLock(ticketId));
      const t = await this.readTicket(tx, projectId, ticketId);
      if (!t) return undefined;
      const next = f(t);
      await this.writeTicket(tx, next);
      return next;
    });
  }

  /**
   * Appends to `journal`; every event reaches it from its inbox row (`appendInbox`, ORC-147). The
   * second call for the same event id returns `false` without touching the journal: the journal's
   * unique event id is the dedup key.
   *
   * The per-ticket journal sequence is allocated under a transaction-scoped advisory lock, so two
   * workers cannot pick the same `seq` for a ticket.
   */
  async recordEvent(event: FactoryEvent): Promise<boolean> {
    const now = this.now();
    // A row without a version predates versioning: version 1, as `upcast` reads it.
    const version = event.schemaVersion ?? 1;
    return this.db.transaction(async (tx) => {
      const ticketId = event.ticketId ?? null;
      // Taken before the insert: a second call for the same event (same ticket) waits for the first
      // to commit, then meets its journal row on the unique event id.
      await tx.execute(ticketLock(ticketId));
      const inserted = await tx.execute(sql`
        insert into journal (id, ticket_id, event_id, seq, type, payload, schema_version, created_at)
        select
          ${event.id}, ${ticketId}, ${event.id}, coalesce(max(seq), 0) + 1, ${event.type},
          ${JSON.stringify(event)}::jsonb, ${version}, to_timestamp(${now / 1000})
        from journal
        where ticket_id is not distinct from ${ticketId}
        on conflict (event_id) do nothing
      `);
      return (inserted.rowCount ?? 0) > 0;
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
    await this.writeTimer(this.db, timer);
  }

  private async writeTimer(db: Tx | NodePgDatabase<typeof schema>, timer: TimerRecord): Promise<void> {
    await db.execute(sql`
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
      await tx.execute(ticketLock(item.ticketId));

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

  async completeEffect(id: string, lease?: string): Promise<boolean> {
    return this.settleEffect(id, 'done', lease);
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
        where ticket_id = ${ticketId} and status = 'pending' and payload->>'projectId' = ${projectId}
          and payload->>'queue' is not null ${ofQueue}
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
