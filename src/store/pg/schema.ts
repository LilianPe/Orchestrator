import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { FactoryEvent, FeedbackItem } from '../../core/types.js';

/** Every timestamp is `timestamptz`, so Postgres stores it in UTC and returns it in the session zone. */
const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/**
 * ORC-132, part 1: the twelve Postgres tables of the store.
 *
 * `inbox` and `journal` are append-only. `tickets` is a projection of the journal, kept in the
 * same transaction as the event that changed it (part 2). `outbox` is the transactional effect
 * queue: an effect id has the shape `ticket:seq:i` (ORC-129). The remaining tables are the
 * workflow, attempt, evidence and artifact tables the engine will fill in later tickets.
 *
 * Legacy compatibility columns (`attempts.data`, `attempts.token`) keep the current `Store`
 * methods (`putRun`, `getRun`, `costSince`) working while SQLite is still the wired store. They
 * go away with those methods.
 */
export const inbox = pgTable(
  'inbox',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    /** The full event, so replay and the webhook route do not need another read. */
    payload: jsonb('payload').$type<FactoryEvent>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('inbox_event_id_uq').on(t.eventId),
    index('inbox_received_at_idx').on(t.receivedAt),
    index('inbox_pending_idx').on(t.processedAt),
    check('inbox_schema_version_check', sql`${t.schemaVersion} >= 1`),
  ],
);

export const journal = pgTable(
  'journal',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id'),
    eventId: text('event_id').notNull(),
    /** Contiguous per-ticket sequence, allocated under an advisory lock. */
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    /** The full event, matching the ORC-129 journal and allowing a deterministic replay. */
    payload: jsonb('payload').$type<FactoryEvent>().notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('journal_event_id_uq').on(t.eventId),
    uniqueIndex('journal_ticket_seq_uq').on(t.ticketId, t.seq),
    index('journal_ticket_id_idx').on(t.ticketId),
    index('journal_created_at_idx').on(t.createdAt),
    check('journal_seq_check', sql`${t.seq} >= 1`),
    check('journal_schema_version_check', sql`${t.schemaVersion} >= 1`),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(),
    /** Last step the workflow reached; `null` before the first job is pending. */
    stepCursor: text('step_cursor'),
    activeAttempts: integer('active_attempts').notNull().default(0),
    humanInbox: jsonb('human_inbox').$type<FeedbackItem[]>().notNull().default(sql`'[]'::jsonb`),
    workflowHash: text('workflow_hash'),
    /** Full `TicketState`, so the async port can round-trip without lossy columns. */
    data: jsonb('data').$type<unknown>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tickets_status_idx').on(t.status),
    index('tickets_updated_at_idx').on(t.updatedAt),
    check('tickets_active_attempts_check', sql`${t.activeAttempts} >= 0`),
  ],
);

export const outbox = pgTable(
  'outbox',
  {
    /** ORC-129 effect id: `ticket:seq:i`. */
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').notNull(),
    effect: text('effect').notNull(),
    /** The queued item / effect arguments. */
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: text('status').notNull().default('pending'),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('outbox_ticket_id_idx').on(t.ticketId),
    index('outbox_status_idx').on(t.status),
    index('outbox_available_at_idx').on(t.availableAt),
    index('outbox_lease_until_idx').on(t.leaseUntil),
    check('outbox_attempts_check', sql`${t.attempts} >= 0`),
    check('outbox_status_check', sql`${t.status} in ('pending', 'running', 'done', 'failed', 'dead')`),
  ],
);

export const timers = pgTable(
  'timers',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').notNull(),
    kind: text('kind').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    payload: jsonb('payload').$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    index('timers_ticket_id_idx').on(t.ticketId),
    index('timers_due_at_idx').on(t.dueAt),
    index('timers_status_idx').on(t.status),
    check('timers_status_check', sql`${t.status} in ('pending', 'fired', 'cancelled', 'echo')`),
  ],
);

export const decisionTrace = pgTable(
  'decision_trace',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').notNull(),
    eventId: text('event_id').notNull(),
    decision: jsonb('decision').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('decision_trace_ticket_id_idx').on(t.ticketId),
    index('decision_trace_event_id_idx').on(t.eventId),
  ],
);

export const deadLetter = pgTable(
  'dead_letter',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    reason: text('reason').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('dead_letter_event_id_uq').on(t.eventId),
    index('dead_letter_created_at_idx').on(t.createdAt),
  ],
);

export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: text('id').primaryKey(),
    hash: text('hash').notNull(),
    definition: jsonb('definition').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('workflow_versions_hash_uq').on(t.hash),
    index('workflow_versions_created_at_idx').on(t.createdAt),
  ],
);

export const attempts = pgTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').notNull(),
    step: text('step').notNull(),
    model: text('model'),
    effort: text('effort'),
    fingerprints: jsonb('fingerprints').$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    image: text('image'),
    risk: text('risk'),
    /** Attempt labels (ORC-226): the first labels a run is stored with, never rewritten after. */
    factoryVersion: text('factory_version'),
    factoryCommit: text('factory_commit'),
    registryCommit: text('registry_commit'),
    deliveredFactIds: jsonb('delivered_fact_ids').$type<string[]>(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    status: text('status').notNull(),
    /** Legacy `RunRecord` payload, removed with the synchronous store (ORC-178). */
    data: jsonb('data').$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    /** Legacy run cost, queried by `costSince` until cost moves to attempts. */
    costUsd: doublePrecision('cost_usd').notNull().default(0),
  },
  (t) => [
    index('attempts_ticket_id_idx').on(t.ticketId),
    index('attempts_status_idx').on(t.status),
    index('attempts_started_at_idx').on(t.startedAt),
    check(
      'attempts_status_check',
      sql`${t.status} in ('running', 'interrupted', 'success', 'failure', 'stopped', 'limit')`,
    ),
    check('attempts_cost_usd_check', sql`${t.costUsd} >= 0`),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('findings_attempt_id_idx').on(t.attemptId),
    index('findings_severity_idx').on(t.severity),
  ],
);

export const freezes = pgTable(
  'freezes',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').notNull(),
    path: text('path').notNull(),
    hash: text('hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('freezes_ticket_id_idx').on(t.ticketId), index('freezes_path_idx').on(t.path)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id').notNull(),
    attemptId: text('attempt_id'),
    kind: text('kind').notNull(),
    path: text('path').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('artifacts_ticket_id_idx').on(t.ticketId),
    index('artifacts_attempt_id_idx').on(t.attemptId),
    index('artifacts_sha256_idx').on(t.sha256),
  ],
);

/** The twelve public tables, in migration order. */
export const PG_TABLES = {
  inbox,
  journal,
  tickets,
  outbox,
  timers,
  decisionTrace,
  deadLetter,
  workflowVersions,
  attempts,
  findings,
  freezes,
  artifacts,
} as const;

export const PG_TABLE_NAMES = [
  'inbox',
  'journal',
  'tickets',
  'outbox',
  'timers',
  'decision_trace',
  'dead_letter',
  'workflow_versions',
  'attempts',
  'findings',
  'freezes',
  'artifacts',
] as const;

export type PgTableName = (typeof PG_TABLE_NAMES)[number];
