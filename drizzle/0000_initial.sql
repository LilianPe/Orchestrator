CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"attempt_id" text,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"step" text NOT NULL,
	"model" text,
	"effort" text,
	"fingerprints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"image" text,
	"risk" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "attempts_status_check" CHECK ("attempts"."status" in ('running', 'interrupted', 'success', 'failure', 'stopped', 'limit')),
	CONSTRAINT "attempts_cost_usd_check" CHECK ("attempts"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dead_letter" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_trace" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"event_id" text NOT NULL,
	"decision" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freezes" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"path" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inbox_schema_version_check" CHECK ("inbox"."schema_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text,
	"event_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_seq_check" CHECK ("journal"."seq" >= 1),
	CONSTRAINT "journal_schema_version_check" CHECK ("journal"."schema_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"effect" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_attempts_check" CHECK ("outbox"."attempts" >= 0),
	CONSTRAINT "outbox_status_check" CHECK ("outbox"."status" in ('pending', 'running', 'done', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"step_cursor" text,
	"active_attempts" integer DEFAULT 0 NOT NULL,
	"human_inbox" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workflow_hash" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_active_attempts_check" CHECK ("tickets"."active_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "timers" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timers_status_check" CHECK ("timers"."status" in ('pending', 'fired', 'cancelled', 'echo'))
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artifacts_ticket_id_idx" ON "artifacts" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "artifacts_attempt_id_idx" ON "artifacts" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "artifacts_sha256_idx" ON "artifacts" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "attempts_ticket_id_idx" ON "attempts" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "attempts_status_idx" ON "attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "attempts_started_at_idx" ON "attempts" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dead_letter_event_id_uq" ON "dead_letter" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "dead_letter_created_at_idx" ON "dead_letter" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "decision_trace_ticket_id_idx" ON "decision_trace" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "decision_trace_event_id_idx" ON "decision_trace" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "findings_attempt_id_idx" ON "findings" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "findings_severity_idx" ON "findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "freezes_ticket_id_idx" ON "freezes" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "freezes_path_idx" ON "freezes" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_event_id_uq" ON "inbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "inbox_received_at_idx" ON "inbox" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "inbox_pending_idx" ON "inbox" USING btree ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_event_id_uq" ON "journal" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_ticket_seq_uq" ON "journal" USING btree ("ticket_id","seq");--> statement-breakpoint
CREATE INDEX "journal_ticket_id_idx" ON "journal" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "journal_created_at_idx" ON "journal" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbox_ticket_id_idx" ON "outbox" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "outbox_status_idx" ON "outbox" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbox_available_at_idx" ON "outbox" USING btree ("available_at");--> statement-breakpoint
CREATE INDEX "outbox_lease_until_idx" ON "outbox" USING btree ("lease_until");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_updated_at_idx" ON "tickets" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "timers_ticket_id_idx" ON "timers" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "timers_due_at_idx" ON "timers" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "timers_status_idx" ON "timers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_hash_uq" ON "workflow_versions" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "workflow_versions_created_at_idx" ON "workflow_versions" USING btree ("created_at");