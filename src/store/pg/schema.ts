import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { FactoryEvent, FeedbackItem } from '../../core/types.js';
import type { ChangelogEntry } from '../types.js';

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
    /** First sign of life the factory gave for the event: the ack of its webhook (ORC-235). */
    ackedAt: timestamp('acked_at', { withTimezone: true, mode: 'date' }),
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
    projectId: text('project_id').notNull(),
    /** The ticket's identifier: a Linear team with several repos may have a copy of it per project (ORC-316). */
    id: text('id').notNull(),
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
    primaryKey({ columns: [t.projectId, t.id] }),
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

/**
 * Events whose decision threw (ORC-175), set aside instead of retried: `payload` is the inbox event,
 * `reason` the error of its last failed decision. `status` stays `open` until `factory run repair`
 * replays, skips or forces it; a replay that throws again reopens it and counts one more `failures`.
 */
export const deadLetter = pgTable(
  'dead_letter',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    reason: text('reason').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    ticketId: text('ticket_id'),
    status: text('status').notNull().default('open'),
    failures: integer('failures').notNull().default(1),
    resolvedBy: text('resolved_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('dead_letter_event_id_uq').on(t.eventId),
    index('dead_letter_created_at_idx').on(t.createdAt),
    index('dead_letter_ticket_status_idx').on(t.ticketId, t.status),
    check('dead_letter_status_check', sql`${t.status} in ('open', 'replayed', 'skipped', 'forced')`),
    check('dead_letter_failures_check', sql`${t.failures} >= 1`),
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
    /** Tokens `claude -p` reported for the attempt (ORC-235); null when it reported none. */
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }),
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

/**
 * The findings of the AI review (ORC-183), one row each: `attempt_id` the lens's run, `kind` its lens, `body` the explanation,
 * on the ticket's published commit (`sha`), `n` in the lens's order. A lens run again on the commit replaces its rows.
 */
export const findings = pgTable(
  'findings',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
    projectId: text('project_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    sha: text('sha').notNull(),
    n: integer('n').notNull(),
    file: text('file').notNull(),
    line: integer('line').notNull(),
    suggestion: text('suggestion').notNull(),
    fact: text('fact'),
  },
  (t) => [
    index('findings_attempt_id_idx').on(t.attemptId),
    index('findings_severity_idx').on(t.severity),
    index('findings_commit_idx').on(t.projectId, t.ticketId, t.sha),
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

/**
 * A sandboxed run's security log (ORC-296): read from its two journals when its sandbox is destroyed,
 * once (the run is the key); the lines left out, malformed or forged, counted. Its entries below,
 * numbered in journal order (`n`).
 */
export const securityLogs = pgTable(
  'security_logs',
  {
    runId: text('run_id').primaryKey(),
    projectId: text('project_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }).notNull(),
    skippedEgress: integer('skipped_egress').notNull(),
    skippedRefusals: integer('skipped_refusals').notNull(),
  },
  (t) => [index('security_logs_ticket_id_idx').on(t.ticketId)],
);

/** Every request of a run through the egress proxy (ORC-213), allowed or refused. */
export const egressRequests = pgTable(
  'egress_requests',
  {
    runId: text('run_id').notNull(),
    n: integer('n').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    method: text('method').notNull(),
    host: text('host').notNull(),
    port: integer('port'),
    ok: boolean('ok').notNull(),
    up: bigint('up', { mode: 'number' }).notNull(),
    down: bigint('down', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.n] }), index('egress_requests_at_idx').on(t.at)],
);

/** The refusals of the pack's PreToolUse hook (ORC-285), from the agent's log: rule checked, never the command. */
export const refusals = pgTable(
  'refusals',
  {
    runId: text('run_id').notNull(),
    n: integer('n').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    tool: text('tool').notNull(),
    rule: text('rule').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.n] }), index('refusals_at_idx').on(t.at)],
);

/** A project's known flaky tests (ORC-164), a human's list: one row per test, as `verify` names it. */
export const knownFlakyTests = pgTable(
  'known_flaky_tests',
  {
    projectId: text('project_id').notNull(),
    test: text('test').notNull(),
    coversFrozen: boolean('covers_frozen').notNull(),
    reason: text('reason').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.test] })],
);

/** The changelog (ORC-197), append-only: one row per `after_merge` step, by the id of its effect, the entry whole in `entry`. */
export const changelog = pgTable(
  'changelog',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull(),
    entry: jsonb('entry').$type<ChangelogEntry>().notNull(),
  },
  (t) => [index('changelog_at_idx').on(t.at)],
);

/**
 * A project's baseline over 90 days (ORC-230), frozen by `factory baseline`: one row per measure and period. `value` null
 * when there is nothing to compute it over, or no source (`no_source`); `over_count` and `left_out`, what it counts and leaves out.
 */
export const baselines = pgTable(
  'baselines',
  {
    projectId: text('project_id').notNull(),
    since: timestamp('since', { withTimezone: true, mode: 'date' }).notNull(),
    until: timestamp('until', { withTimezone: true, mode: 'date' }).notNull(),
    measure: text('measure').notNull(),
    value: doublePrecision('value'),
    overCount: integer('over_count').notNull(),
    leftOut: integer('left_out').notNull(),
    noSource: boolean('no_source').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.since, t.until, t.measure] })],
);

/** The public tables, in migration order: the twelve of ORC-132, the security log's (ORC-296), the known flaky tests (ORC-164), the changelog (ORC-197), the baselines (ORC-230). */
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
  securityLogs,
  egressRequests,
  refusals,
  knownFlakyTests,
  changelog,
  baselines,
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
  'security_logs',
  'egress_requests',
  'refusals',
  'known_flaky_tests',
  'changelog',
  'baselines',
] as const;

export type PgTableName = (typeof PG_TABLE_NAMES)[number];
