import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  deadLetteredEvent,
  deadLetterNotice,
  REPAIRED_STATUS,
  repairEvent,
  type DeadLetter,
  type DeadLetterStatus,
  type RepairAction,
} from '../../core/dead-letter.js';
import type { OutboxEffect } from '../../core/decision.js';
import { claims, holds } from '../../core/routing.js';
import { normalizeTicket, type FactoryEvent, type QueueName, type TicketState } from '../../core/types.js';
import { upcastTimer, type StoredEvent, type StoredTimer } from '../../core/upcast.js';
import {
  TicketHeldError,
  decidedOn,
  decisionRecord,
  effectResult,
  timerEvent,
  timerRowId,
  LEASE_MS,
  type DecisionOutcome,
  type DecisionRecord,
  type DecisionRequest,
  type EffectOutcome,
  type JournalEntry,
  type MeasureFacts,
  type OutboxRow,
  type QueueClaim,
  type QueueItem,
  type RunRecord,
  type SecurityLog,
  type SecurityStats,
  type TimerRecord,
  type WorkflowVersion,
} from '../types.js';
import * as schema from './schema.js';
import type { AsyncStore, DequeuedEffect, PutTicketOptions } from './types.js';

/** How long a `claim` keeps a row out of another worker's reach, by default (ORC-129: 60 s). */
export const OUTBOX_LEASE_MS = LEASE_MS;

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
 *
 * A checked-out client is not the pool's to hear (it takes its idle listener off on acquire): cut
 * between two queries (Postgres restarted, `pg_terminate_backend`), it would crash the daemon the same
 * way (ORC-290). Each client gets a listener of its own, which only speaks when nobody else listens:
 * an idle client's error goes through the pool's.
 */
export function listenForPoolErrors(pool: Pool, onError: (err: Error) => void): void {
  if (pool.listenerCount('error') === 0) pool.on('error', onError);
  pool.on('connect', (client) => {
    const own = (err: Error) => {
      if (client.listenerCount('error') === 1) onError(err);
    };
    client.on('error', own);
  });
}

const reportToStderr = (err: Error) => console.error(`[postgres] ${err.message}`);

const dateToMs = (value: Date | string | null): number => {
  if (value === null) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
};

const echoId = (key: string) => `echo:${key}`;

/**
 * Queue order of the SQLite store: priority 1 (urgent) first, 0 (none) after 4 (low), then age, then
 * arrival: `created_at` is the server's `clock_timestamp()` (as the inbox's `received_at`), so two
 * items enqueued at the same instant keep their order, whatever their ids (ORC-228).
 */
const QUEUE_ORDER = sql.raw(
  `case when (payload->>'priority')::int = 0 then 5 else coalesce((payload->>'priority')::int, 5) end, available_at, created_at, id`,
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
  /** The last failure of the effect (ORC-150). */
  error?: string;
}

/** Columns read for an outbox row. */
const OUTBOX_COLUMNS = sql.raw(`id, status, attempts, payload`);

type OutboxSqlRow = {
  id: string;
  status: OutboxRow['status'];
  attempts: number;
  payload: OutboxPayload;
};

type Tx = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

const outboxRow = ({ id, status, attempts, payload: p }: OutboxSqlRow): OutboxRow => ({
  id,
  projectId: p.projectId,
  ...(p.ticketId === undefined ? {} : { ticketId: p.ticketId }),
  eventId: p.eventId,
  seq: p.seq,
  i: p.i,
  effect: p.effect,
  status,
  attempts: Number(attempts),
  ...(p.error === undefined ? {} : { error: p.error }),
  ...(p.lease === undefined ? {} : { lease: p.lease }),
});

const DEAD_LETTER_COLUMNS = sql.raw(`event_id, reason, payload, ticket_id, status, failures, resolved_by`);

type DeadLetterPgRow = {
  event_id: string;
  reason: string;
  payload: StoredEvent;
  ticket_id: string | null;
  status: DeadLetterStatus;
  failures: number;
  resolved_by: string | null;
};

const deadLetterRow = (r: DeadLetterPgRow): DeadLetter => ({
  eventId: r.event_id,
  projectId: r.payload.projectId,
  ...(r.ticket_id === null ? {} : { ticketId: r.ticket_id }),
  event: r.payload,
  error: r.reason,
  failures: Number(r.failures),
  status: r.status,
  ...(r.resolved_by === null ? {} : { resolvedBy: r.resolved_by }),
});

/** An attempt's label column on update: kept once the attempt has labels, else the write's (ORC-226). */
const FIRST_LABELS = (column: string) =>
  sql.raw(`case when attempts.data ? 'labels' then attempts.${column} else excluded.${column} end`);

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
    const result = await db.execute<{ data: TicketState }>(sql`select data from tickets where project_id = ${projectId} and id = ${ticketId}`);
    const row = result.rows[0];
    return row && normalizeTicket(row.data);
  }

  /** Upserts the projection from the current ticket state. `tickets.id` is the ticket identifier: one copy per project (ORC-316). */
  async putTicket(ticket: TicketState, options: PutTicketOptions = {}): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(ticketLock(ticket.ticketId));
      await this.writeTicket(tx, ticket, options);
    });
  }

  private async refuseClaim(tx: Tx, peers: readonly string[], known: TicketState | undefined, next: TicketState): Promise<void> {
    if (peers.length === 0 || !claims(known, next)) return;
    const copies = await tx.execute<{ data: TicketState }>(sql`select data from tickets where id = ${next.ticketId} and project_id = any(${sql.param([...peers])}::text[])`);
    const holder = copies.rows.map((r) => normalizeTicket(r.data)).find(holds);
    if (holder) throw new TicketHeldError(next.ticketId, holder.projectId, next.projectId);
  }

  private async writeTicket(db: Tx | NodePgDatabase<typeof schema>, ticket: TicketState, options: PutTicketOptions = {}): Promise<void> {
    const t = normalizeTicket(ticket);
    const stepCursor = t.pendingJob?.job ?? null;
    const activeAttempts = (t.activeRunId ? 1 : 0) + (t.verifyingRunId ? 1 : 0);
    const now = this.now();
    await db.execute(sql`
      insert into tickets (
        project_id, id, status, step_cursor, active_attempts, human_inbox, workflow_hash, data, created_at, updated_at
      ) values (
        ${t.projectId}, ${t.ticketId}, ${t.logical}, ${stepCursor}, ${activeAttempts}, ${JSON.stringify(t.humanInbox)}::jsonb,
        ${options.workflowHash ?? t.workflowHash ?? null}, ${JSON.stringify(t)}::jsonb,
        to_timestamp(${now / 1000}), to_timestamp(${t.updatedAt / 1000})
      )
      on conflict (project_id, id) do update set
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
    const result = await this.db.execute<{ data: TicketState }>(sql`select data from tickets order by id, project_id`);
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
      return this.appendResult(tx, event);
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
      // Only results of done effects ahead: a stop may pass them, as it passes the effects in backoff.
      let jumped = false;
      if (firstId !== undefined && firstId !== event.id) {
        const ahead = await tx.execute<{ type: string }>(sql`
          select type from inbox
          where processed_at is null and payload->>'projectId' = ${event.projectId}
            and (payload->>'ticketId') is not distinct from ${ticketId}
            and (received_at, id) < (select received_at, id from inbox where id = ${event.id})
        `);
        if (!ahead.rows.every((r) => r.type === 'effect.done')) return { status: 'waiting', reason: `${firstId} comes first` };
        jumped = true;
      }
      // Locked: an executor claiming one of them right now finishes first, and is seen here.
      const open = await tx.execute<{ id: string; status: string; later: boolean }>(sql`
        select id, status, available_at > to_timestamp(${now / 1000}) as later from outbox
        where ticket_id = ${outboxTicket(ticketId)} and ${DECISION_ROW} and payload->>'projectId' = ${event.projectId}
          and status in ('pending', 'running')
        order by ${OUTBOX_ORDER}
        for update
      `);
      // Held back by its backoff (nothing running): a stop of the ticket's work may go first (ORC-150).
      const backedOff = open.rows.length > 0 && open.rows.every((r) => r.status === 'pending') && open.rows[0]!.later;
      if (open.rows[0] && !backedOff) return { status: 'waiting', reason: `effect ${open.rows[0].id} is unfinished` };
      if (jumped && !backedOff) return { status: 'waiting', reason: `${firstId} comes first` };
      const markProcessed = sql`update inbox set processed_at = to_timestamp(${now / 1000}) where id = ${event.id}`;
      if ((await tx.execute(sql`select 1 from journal where event_id = ${event.id} limit 1`)).rowCount) {
        await tx.execute(markProcessed);
        return { status: 'duplicate' };
      }

      const known = ticketId === null ? undefined : await this.readTicket(tx, event.projectId, ticketId);
      const frozen = known?.workflowHash && known.workflowHash !== req.workflow.hash ? await this.readWorkflow(tx, known.workflowHash) : req.workflow;
      if (!frozen) throw new Error(`workflow version ${known?.workflowHash} of ${ticketId} is not stored`);
      const plan = req.decide(known, frozen);
      const preempted = open.rows.map((r) => r.id);
      if (preempted.length > 0) {
        if (!plan.clearTimers) return { status: 'waiting', reason: `effect ${preempted[0]} waits for its retry`, backoff: true };
        await tx.execute(sql`
          update outbox set status = 'failed', updated_at = to_timestamp(${now / 1000}),
            payload = payload || jsonb_build_object('error', ${`cancelled by ${event.id}`}::text)
          where id = any(${sql.param(preempted)}::text[])
        `);
      }

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
      await tx.execute(sql`
        insert into decision_trace (id, ticket_id, event_id, decision, created_at)
        values (
          ${event.id}, ${outboxTicket(ticketId)}, ${event.id},
          ${JSON.stringify(decisionRecord(event, seq, known, decidedOn(req, frozen), plan))}::jsonb, to_timestamp(${now / 1000})
        )
      `);
      // Every version a decision ran on is kept, projection written or not: its replay needs it (ORC-174).
      if (req.workflow.hash !== '' && frozen.hash === req.workflow.hash) {
        await tx.execute(sql`
          insert into workflow_versions (id, hash, definition, created_at)
          values (${workflowId(req.workflow.hash)}, ${req.workflow.hash}, ${JSON.stringify(req.workflow.definition)}::jsonb, to_timestamp(${now / 1000}))
          on conflict do nothing
        `);
      }
      if (plan.ticket) {
        // Thrown, the whole decision rolls back, its journal row included.
        await this.refuseClaim(tx, req.peers ?? [], known, plan.ticket);
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
      return { status: 'committed', seq, effectIds, known, plan, preempted };
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

  async ticketJournal(projectId: string, ticketId?: string): Promise<JournalEntry[]> {
    const result = await this.db.execute<{ event: StoredEvent; decision: DecisionRecord | null }>(sql`
      select j.payload as event, d.decision from journal j
      left join decision_trace d on d.event_id = j.event_id
      where j.ticket_id is not distinct from ${ticketId ?? null} and j.payload->>'projectId' = ${projectId}
      order by j.seq
    `);
    return result.rows.map((r) => ({ event: r.event, ...(r.decision === null ? {} : { decision: r.decision }) }));
  }

  /**
   * The ticket's first unfinished decision row, claimed under a lease (ORC-150). The head row is
   * found without a lock, then locked with `FOR UPDATE SKIP LOCKED`: an executor never waits for
   * another one, and two never claim the same row. Locking the head itself (not "the first row I
   * can lock") keeps the ticket's effects in order: a locked head is `busy`, never skipped over.
   */
  async claimEffect(projectId: string, ticketId: string | undefined, leaseMs: number): Promise<OutboxRow | 'busy' | undefined> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const head = await tx.execute<{ id: string }>(sql`
        select id from outbox
        where ticket_id = ${outboxTicket(ticketId)} and ${DECISION_ROW} and payload->>'projectId' = ${projectId}
          and status in ('pending', 'running')
        order by ${OUTBOX_ORDER}
        limit 1
      `);
      const headId = head.rows[0]?.id;
      if (headId === undefined) return undefined;
      const locked = await tx.execute<OutboxSqlRow & { live: boolean; later: boolean }>(sql`
        select ${OUTBOX_COLUMNS},
          coalesce(lease_until >= to_timestamp(${now / 1000}), false) as live,
          available_at > to_timestamp(${now / 1000}) as later
        from outbox
        where id = ${headId}
        for update skip locked
      `);
      const row = locked.rows[0];
      // Another executor holds it right now (claiming or settling it): not ours to take.
      if (!row) return 'busy' as const;
      // Settled between the two reads: the next head is for the next claim.
      if (row.status !== 'pending' && row.status !== 'running') return 'busy' as const;
      if (row.status === 'running' && row.live) return 'busy' as const;
      if (row.status === 'pending' && row.later) return 'busy' as const;
      const lease = randomUUID();
      await tx.execute(sql`
        update outbox set status = 'running', attempts = attempts + 1,
          lease_until = to_timestamp(${(now + leaseMs) / 1000}), updated_at = to_timestamp(${now / 1000}),
          payload = payload || jsonb_build_object('lease', ${lease}::text)
        where id = ${row.id}
      `);
      return outboxRow({ ...row, status: 'running', attempts: Number(row.attempts) + 1, payload: { ...row.payload, lease } });
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

  /**
   * Settles a running row under its claim, in one transaction with what goes with it (`then`). The
   * ticket's lock is taken first, as `appendInbox` and `decide` do: the result event written to the
   * inbox gets its `received_at` in commit order, and no decision of the ticket reads in between.
   */
  private async settleHeld<T>(
    id: string,
    lease: string | undefined,
    then: (tx: Tx, row: OutboxSqlRow) => Promise<T>,
  ): Promise<T | false> {
    const ticket = await this.db.execute<{ ticket_id: string }>(sql`select ticket_id from outbox where id = ${id}`);
    const ticketId = ticket.rows[0]?.ticket_id;
    if (ticketId === undefined) return false;
    return this.db.transaction(async (tx) => {
      await tx.execute(ticketLock(ticketId === '*' ? null : ticketId));
      const owned = lease === undefined ? sql`true` : sql`payload->>'lease' = ${lease}`;
      const held = await tx.execute<OutboxSqlRow>(sql`
        select ${OUTBOX_COLUMNS} from outbox where id = ${id} and status = 'running' and ${owned} for update
      `);
      const row = held.rows[0];
      return row ? then(tx, row) : false;
    });
  }

  /**
   * Writes an inbox row under the ticket's lock taken by the caller's transaction; false when the id is already
   * there. Also an event the store writes itself (an effect's result, a dead letter's notice, a repair, a timer's firing).
   */
  private async appendResult(tx: Tx, event: FactoryEvent | StoredEvent): Promise<boolean> {
    const inserted = await tx.execute(sql`
      insert into inbox (id, event_id, type, payload, received_at, schema_version)
      values (${event.id}, ${event.id}, ${event.type}, ${JSON.stringify(event)}::jsonb, clock_timestamp(), ${event.schemaVersion ?? 1})
      on conflict do nothing
      returning id
    `);
    return (inserted.rowCount ?? 0) > 0;
  }

  async deadLetter(row: StoredEvent, error: string, at: number, holder?: string, attempts?: number): Promise<boolean> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx.execute(ticketLock(row.ticketId));
      const marked = await tx.execute(sql`
        update inbox set processed_at = to_timestamp(${now / 1000}) where id = ${row.id} and processed_at is null
      `);
      if ((marked.rowCount ?? 0) === 0) return false;
      const event = deadLetteredEvent(row);
      const upserted = await tx.execute<{ failures: number }>(sql`
        insert into dead_letter (id, event_id, reason, payload, ticket_id, status, failures, created_at, updated_at)
        values (
          ${event.id}, ${event.id}, ${error}, ${JSON.stringify(event)}::jsonb, ${event.ticketId ?? null}, 'open', 1,
          to_timestamp(${at / 1000}), to_timestamp(${at / 1000})
        )
        on conflict (id) do update set
          status = 'open', failures = dead_letter.failures + 1, reason = excluded.reason, updated_at = excluded.updated_at
        returning failures
      `);
      const failures = Number(upserted.rows[0]!.failures);
      const notice = deadLetterNotice({ event, error, failures }, at, holder, attempts);
      if (notice) await this.appendResult(tx, notice);
      return true;
    });
  }

  async deadLetters(ticketId?: string): Promise<DeadLetter[]> {
    const result = await this.db.execute<DeadLetterPgRow>(sql`
      select ${DEAD_LETTER_COLUMNS} from dead_letter
      where ${ticketId ?? null}::text is null or ticket_id = ${ticketId ?? null}
      order by status = 'open' desc, created_at, id
    `);
    return result.rows.map(deadLetterRow);
  }

  async getDeadLetter(eventId: string): Promise<DeadLetter | undefined> {
    const result = await this.db.execute<DeadLetterPgRow>(sql`select ${DEAD_LETTER_COLUMNS} from dead_letter where id = ${eventId}`);
    const row = result.rows[0];
    return row && deadLetterRow(row);
  }

  async repairDeadLetter(eventId: string, action: RepairAction, by: string, at: number): Promise<DeadLetter | undefined> {
    return this.db.transaction(async (tx) => {
      const found = await tx.execute<{ ticket_id: string | null }>(sql`select ticket_id from dead_letter where id = ${eventId} and status = 'open'`);
      if (!found.rows[0]) return undefined;
      // The ticket's lock, as `appendInbox`: the repair gets its `received_at` in commit order.
      await tx.execute(ticketLock(found.rows[0].ticket_id));
      const status = REPAIRED_STATUS[action];
      const updated = await tx.execute<DeadLetterPgRow>(sql`
        update dead_letter set status = ${status}, resolved_by = ${by}, updated_at = to_timestamp(${at / 1000})
        where id = ${eventId} and status = 'open'
        returning ${DEAD_LETTER_COLUMNS}
      `);
      const row = updated.rows[0];
      if (!row) return undefined;
      const dl = deadLetterRow(row);
      await this.appendResult(tx, repairEvent(dl, action, by, at));
      return dl;
    });
  }

  async completeEffect(id: string, lease?: string, at?: number, outcome?: EffectOutcome): Promise<boolean> {
    const now = this.now();
    return this.settleHeld(id, lease, async (tx, row) => {
      await tx.execute(sql`update outbox set status = 'done', lease_until = null, updated_at = to_timestamp(${now / 1000}) where id = ${id}`);
      // A decision row reports back to the inbox (ORC-150); a legacy queue row has nobody to tell.
      if (lease !== undefined && 'effect' in row.payload) await this.appendResult(tx, effectResult(outboxRow(row), at ?? now, undefined, outcome));
      return true;
    });
  }

  async retryEffect(id: string, lease: string, error: string, delayMs: number): Promise<boolean> {
    const now = this.now();
    const result = await this.db.execute(sql`
      update outbox set status = 'pending', lease_until = null,
        available_at = to_timestamp(${(now + delayMs) / 1000}), updated_at = to_timestamp(${now / 1000}),
        payload = (payload - 'lease') || jsonb_build_object('error', ${error}::text)
      where id = ${id} and status = 'running' and payload->>'lease' = ${lease}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  async failEffect(id: string, lease: string, error: string, at?: number): Promise<boolean> {
    const now = this.now();
    return this.settleHeld(id, lease, async (tx, row) => {
      const stamp = sql`to_timestamp(${now / 1000})`;
      await tx.execute(sql`
        update outbox set status = 'dead', lease_until = null, updated_at = ${stamp},
          payload = payload || jsonb_build_object('error', ${error}::text)
        where id = ${id}
      `);
      await tx.execute(sql`
        update outbox set status = 'failed', updated_at = ${stamp}
        where ${DECISION_ROW} and payload->>'eventId' = ${row.payload.eventId} and status = 'pending' and effect <> 'settle'
      `);
      await tx.execute(sql`delete from timers where status = 'pending' and payload->>'armedBy' = ${row.payload.eventId}`);
      await this.appendResult(tx, effectResult(outboxRow(row), at ?? now, error));
      return true;
    });
  }

  /** Tickets whose first unfinished row is claimable: pending past its backoff, or running under an expired lease. */
  async effectTickets(): Promise<{ projectId: string; ticketId?: string }[]> {
    const now = this.now();
    const result = await this.db.execute<{ project_id: string; ticket_id: string | null }>(sql`
      select project_id, ticket_id from (
        select distinct on (outbox.ticket_id, payload->>'projectId')
          payload->>'projectId' as project_id, payload->>'ticketId' as ticket_id, status, lease_until, available_at
        from outbox
        where ${DECISION_ROW} and status in ('pending', 'running')
        order by outbox.ticket_id, payload->>'projectId', ${OUTBOX_ORDER}
      ) head
      where (status = 'pending' and available_at <= to_timestamp(${now / 1000}))
        or (status = 'running' and coalesce(lease_until < to_timestamp(${now / 1000}), true))
    `);
    return result.rows.map((r) => ({ projectId: r.project_id, ...(r.ticket_id === null ? {} : { ticketId: r.ticket_id }) }));
  }

  async listEffects(projectId: string, ticketId?: string): Promise<OutboxRow[]> {
    const result = await this.db.execute<OutboxSqlRow>(sql`
      select ${OUTBOX_COLUMNS} from outbox
      where ticket_id = ${outboxTicket(ticketId)} and ${DECISION_ROW} and payload->>'projectId' = ${projectId}
      order by ${OUTBOX_ORDER}
    `);
    return result.rows.map(outboxRow);
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
    const l = run.labels;
    const fact = l?.deliveredFactIds == null ? null : JSON.stringify(l.deliveredFactIds);
    const tokens = run.tokens;
    // The first record with labels fixes them, in `data.labels` and in their columns alike: an
    // attempt's labels say what it was created with (ORC-226).
    await this.db.execute(sql`
      insert into attempts (
        id, ticket_id, step, model, effort, fingerprints, image, risk,
        factory_version, factory_commit, registry_commit, delivered_fact_ids,
        started_at, ended_at, status, data, cost_usd,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
      ) values (
        ${run.id}, ${run.ticketId}, ${run.job}, ${l?.model ?? null}, ${l?.effort ?? null},
        ${JSON.stringify(l?.fingerprints ?? {})}::jsonb, ${l?.image ?? null}, ${l?.risk ?? null},
        ${l?.factoryVersion ?? null}, ${l?.factoryCommit ?? null}, ${l?.registryCommit ?? null}, ${fact}::jsonb,
        to_timestamp(${run.startedAt / 1000}), ${endedAt}, ${run.status},
        ${JSON.stringify(run)}::jsonb, ${run.costUsd},
        ${tokens?.input ?? null}, ${tokens?.output ?? null}, ${tokens?.cacheRead ?? null}, ${tokens?.cacheCreation ?? null}
      )
      on conflict (id) do update set
        ticket_id = excluded.ticket_id,
        step = excluded.step,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        status = excluded.status,
        model = ${FIRST_LABELS('model')},
        effort = ${FIRST_LABELS('effort')},
        fingerprints = ${FIRST_LABELS('fingerprints')},
        image = ${FIRST_LABELS('image')},
        risk = ${FIRST_LABELS('risk')},
        factory_version = ${FIRST_LABELS('factory_version')},
        factory_commit = ${FIRST_LABELS('factory_commit')},
        registry_commit = ${FIRST_LABELS('registry_commit')},
        delivered_fact_ids = ${FIRST_LABELS('delivered_fact_ids')},
        data = case
          when attempts.data ? 'labels' then jsonb_set(excluded.data, '{labels}', attempts.data->'labels')
          else excluded.data
        end,
        cost_usd = excluded.cost_usd,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens
    `);
  }

  async renewRun(id: string, until: number): Promise<void> {
    await this.db.execute(sql`
      update attempts set data = jsonb_set(data, '{leaseUntil}', to_jsonb(${until}::bigint))
      where id = ${id} and status = 'running'
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

  async ticketRuns(projectId: string, ticketId: string): Promise<RunRecord[]> {
    const result = await this.db.execute<{ data: RunRecord }>(sql`
      select data from attempts where ticket_id = ${ticketId} and data->>'projectId' = ${projectId} order by started_at, id
    `);
    return result.rows.map((r) => r.data);
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

  async markAcked(eventId: string, at: number): Promise<void> {
    await this.db.execute(sql`update inbox set acked_at = to_timestamp(${at / 1000}) where id = ${eventId} and acked_at is null`);
  }

  /** Five reads side by side: the facts of a ticket for its measures, not a decision (no lock, no snapshot needed). */
  async measureFacts(projectId: string, ticketId: string): Promise<MeasureFacts> {
    const [events, runs, acked, ticket, effects] = await Promise.all([
      this.db.execute<{ payload: FactoryEvent }>(sql`
        select payload from journal where ticket_id = ${ticketId} and payload->>'projectId' = ${projectId} order by seq
      `),
      this.ticketRuns(projectId, ticketId),
      this.db.execute<{ id: string; at: string | number }>(sql`
        select id, round(extract(epoch from acked_at) * 1000) as at from inbox
        where acked_at is not null
          and id in (select event_id from journal where ticket_id = ${ticketId} and payload->>'projectId' = ${projectId})
      `),
      this.getTicket(projectId, ticketId),
      this.listEffects(projectId, ticketId),
    ]);
    return {
      devSession: ticket?.linearSessionId,
      events: events.rows.map((r) => r.payload),
      runs,
      effects,
      acks: Object.fromEntries(acked.rows.map((r) => [r.id, Number(r.at)])),
    };
  }

  async mergedPrOf(projectId: string, sha: string): Promise<{ ticketId: string; number: number } | undefined> {
    const result = await this.db.execute<{ ticket_id: string; number: string | number }>(sql`
      select ticket_id, payload->'payload'->>'number' as number from journal
      where type = 'pr.merged' and payload->>'projectId' = ${projectId} and ticket_id is not null
        and (payload->'payload'->>'mergeSha' = ${sha} or payload->'payload'->>'headSha' = ${sha})
      order by created_at, seq limit 1
    `);
    const row = result.rows[0];
    return row && { ticketId: row.ticket_id, number: Number(row.number) };
  }

  /** The log row and its entries in one transaction: a run's log is all there, or not at all. */
  async putSecurityLog(log: SecurityLog): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const head = await tx
        .insert(schema.securityLogs)
        .values({ runId: log.runId, projectId: log.projectId, ticketId: log.ticketId, readAt: new Date(log.at), skippedEgress: log.skipped.egress, skippedRefusals: log.skipped.refusals })
        .onConflictDoNothing()
        .returning({ runId: schema.securityLogs.runId });
      if (head.length === 0) return false;
      // Chunks under the 65 535 parameters of a statement: a busy run journals thousands of requests.
      for (let i = 0; i < log.egress.length; i += 1000) {
        await tx.insert(schema.egressRequests).values(
          log.egress.slice(i, i + 1000).map((e, k) => ({
            runId: log.runId, n: i + k, at: new Date(e.at), method: e.method, host: e.host, port: e.port ?? null, path: e.path ?? null, ok: e.ok, reason: e.reason ?? null, up: e.up, down: e.down,
          })),
        );
      }
      if (log.refusals.length) {
        await tx.insert(schema.refusals).values(log.refusals.map((r, n) => ({ runId: log.runId, n, at: new Date(r.at), tool: r.tool, rule: r.rule, command: r.command })));
      }
      return true;
    });
  }

  async securityLog(runId: string): Promise<SecurityLog | undefined> {
    const [head, egress, refusals] = await Promise.all([
      this.db.execute<{ project_id: string; ticket_id: string; at: string | number; skipped_egress: number; skipped_refusals: number }>(sql`
        select project_id, ticket_id, round(extract(epoch from read_at) * 1000) as at, skipped_egress, skipped_refusals from security_logs where run_id = ${runId}
      `),
      this.db.execute<{ at: string | number; method: string; host: string; port: number | null; path: string | null; ok: boolean; reason: string | null; up: string | number; down: string | number }>(sql`
        select round(extract(epoch from at) * 1000) as at, method, host, port, path, ok, reason, up, down from egress_requests where run_id = ${runId} order by n
      `),
      this.db.execute<{ at: string | number; tool: string; rule: string; command: string }>(sql`
        select round(extract(epoch from at) * 1000) as at, tool, rule, command from refusals where run_id = ${runId} order by n
      `),
    ]);
    const h = head.rows[0];
    if (!h) return undefined;
    return {
      runId,
      projectId: h.project_id,
      ticketId: h.ticket_id,
      at: Number(h.at),
      egress: egress.rows.map((e) => ({
        at: Number(e.at), method: e.method, host: e.host, ...(e.port === null ? {} : { port: e.port }), ...(e.path === null ? {} : { path: e.path }),
        ok: e.ok, ...(e.reason === null ? {} : { reason: e.reason }), up: Number(e.up), down: Number(e.down),
      })),
      refusals: refusals.rows.map((r) => ({ at: Number(r.at), tool: r.tool, rule: r.rule, command: r.command })),
      skipped: { egress: h.skipped_egress, refusals: h.skipped_refusals },
    };
  }

  async securityStats(since: number, until: number): Promise<SecurityStats> {
    const from = sql`to_timestamp(${since / 1000})`;
    const to = sql`to_timestamp(${until / 1000})`;
    const [hosts, rules] = await Promise.all([
      this.db.execute<{ host: string; requests: string | number; refused: string | number }>(sql`
        select host, count(*) as requests, count(*) filter (where not ok) as refused from egress_requests
        where at >= ${from} and at < ${to} group by host order by requests desc, host
      `),
      this.db.execute<{ rule: string; refusals: string | number }>(sql`
        select rule, count(*) as refusals from refusals where at >= ${from} and at < ${to} group by rule order by refusals desc, rule
      `),
    ]);
    return {
      hosts: hosts.rows.map((r) => ({ host: r.host, requests: Number(r.requests), refused: Number(r.refused) })),
      rules: rules.rows.map((r) => ({ rule: r.rule, refusals: Number(r.refusals) })),
    };
  }

  async putTimer(timer: TimerRecord): Promise<void> {
    await this.writeTimer(this.db, timer);
  }

  private async writeTimer(db: Tx | NodePgDatabase<typeof schema>, timer: TimerRecord): Promise<void> {
    await db.execute(sql`
      insert into timers (id, ticket_id, kind, due_at, payload, status, created_at)
      values (
        ${timerRowId(timer)}, ${timer.ticketId}, ${timer.kind}, to_timestamp(${timer.fireAt / 1000}),
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
   * Reads the due timers without changing them, as SQLite does: a timer stays due until `fireTimer`
   * fires it, so a pass cut before that (an error, a shutdown) finds it again on the next one. A
   * row written before ORC-161 (a job, `kind` = the job's name) reads as a `debounce` of that job.
   */
  async dueTimers(now: number): Promise<TimerRecord[]> {
    const result = await this.db.execute<{ payload: StoredTimer }>(sql`
      select payload
      from timers
      where status = 'pending' and due_at <= to_timestamp(${now / 1000})
        and not exists (
          select 1 from outbox o
          where o.payload->>'eventId' = timers.payload->>'armedBy' and o.status in ('pending', 'running')
        )
      order by due_at, id
    `);
    return result.rows.map((row) => upcastTimer(row.payload));
  }

  /**
   * Under the ticket's lock, as `appendInbox`: the firing gets its `received_at` in commit order
   * among the ticket's rows. The timer is deleted only as it was read (same `fireAt`).
   */
  async fireTimer(timer: TimerRecord, at: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(ticketLock(timer.ticketId));
      const armed = await tx.execute(sql`
        delete from timers
        where id = ${timerRowId(timer)} and status = 'pending' and (payload->>'fireAt')::double precision = ${timer.fireAt}
        returning id
      `);
      if ((armed.rowCount ?? 0) === 0) return false;
      return this.appendResult(tx, timerEvent(timer, at));
    });
  }

  async deleteTimersArmedBy(eventId: string): Promise<void> {
    await this.db.execute(sql`delete from timers where status = 'pending' and payload->>'armedBy' = ${eventId}`);
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
            and status = 'pending'
            and payload->>'queue' is not null
          order by created_at, id
          limit 1
          for update
        `,
      );
      const current = existing.rows[0];
      if (current) {
        // A deduped row keeps its place in line, as the SQLite queue keeps `enqueued_at`. A row being
        // handed out is not one: its claim's finish would remove the newer request with it.
        await tx.execute(sql`
          update outbox set payload = ${JSON.stringify(item)}::jsonb, updated_at = to_timestamp(${this.now() / 1000})
          where id = ${current.id}
        `);
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
          ${availableAt}, 0, clock_timestamp(), to_timestamp(${now / 1000})
        )
      `);
      return id;
    });
  }

  /**
   * The `Store` queue (ORC-150): hands out the next item of a queue under a lease, in the SQLite
   * order (priority, then age), with `FOR UPDATE SKIP LOCKED`: two daemons never take the same
   * item, and an item whose holder died is handed out again once its lease expires. The claim
   * token sits in `payload.lease` while the row is `running`.
   */
  async claimQueued(queue: QueueName, leaseMs: number): Promise<QueueClaim | undefined> {
    const lease = randomUUID();
    const row = await this.claim(queue, this.now(), leaseMs, lease);
    if (!row) return undefined;
    const item: QueueItem & { lease?: string } = { ...row.payload };
    delete item.lease;
    return { id: row.id, lease, item };
  }

  async renewQueued(claim: QueueClaim, leaseMs: number): Promise<boolean> {
    const now = this.now();
    const result = await this.db.execute(sql`
      update outbox set lease_until = to_timestamp(${(now + leaseMs) / 1000}), updated_at = to_timestamp(${now / 1000})
      where id = ${claim.id} and status = 'running' and payload->>'lease' = ${claim.lease}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  async finishQueued(claim: QueueClaim): Promise<boolean> {
    return this.settleQueued(claim, 'done');
  }

  async releaseQueued(claim: QueueClaim): Promise<boolean> {
    return this.settleQueued(claim, 'pending');
  }

  private async settleQueued(claim: QueueClaim, status: 'done' | 'pending'): Promise<boolean> {
    const result = await this.db.execute(sql`
      update outbox set status = ${status}, lease_until = null, payload = payload - 'lease', updated_at = to_timestamp(${this.now() / 1000})
      where id = ${claim.id} and status = 'running' and payload->>'lease' = ${claim.lease}
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Claims the next pending item of a queue with `FOR UPDATE SKIP LOCKED`, marks it `running` and
   * returns it with a lease (`leaseMs`, ORC-129: 60 s by default). An expired lease makes the row
   * claimable again; `completeEffect` (or `finishQueued` / `releaseQueued` under `token`) settles it.
   */
  async claim(queue: QueueName, now = this.now(), leaseMs = OUTBOX_LEASE_MS, token?: string): Promise<DequeuedEffect | undefined> {
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
      const leaseUntil = now + leaseMs;
      const withToken = token === undefined ? sql`payload` : sql`payload || jsonb_build_object('lease', ${token}::text)`;
      await tx.execute(sql`
        update outbox set
          status = 'running',
          attempts = ${attempts},
          lease_until = to_timestamp(${leaseUntil / 1000}),
          updated_at = to_timestamp(${now / 1000}),
          payload = ${withToken}
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

  /** Items in line: pending, or handed out under a lease that expired (their holder died), as SQLite lists them. */
  async listQueue(): Promise<QueueItem[]> {
    const result = await this.db.execute<{ payload: QueueItem }>(
      sql`
        select payload - 'lease' as payload from outbox
        where payload->>'queue' is not null
          and (status = 'pending' or (status = 'running' and coalesce(lease_until < to_timestamp(${this.now() / 1000}), true)))
        order by ${QUEUE_ORDER}
      `,
    );
    return result.rows.map((row) => row.payload);
  }

  /** Handed-out items too (a stop during their start): `releaseQueued` then finds nothing to put back. */
  async removeFromQueue(projectId: string, ticketId: string, queue?: QueueName): Promise<void> {
    const ofQueue = queue === undefined ? sql`` : sql`and payload->>'queue' = ${queue}`;
    await this.db.execute(
      sql`
        delete from outbox
        where ticket_id = ${ticketId} and status in ('pending', 'running') and payload->>'projectId' = ${projectId}
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
