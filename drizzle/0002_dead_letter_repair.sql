ALTER TABLE "dead_letter" ADD COLUMN "ticket_id" text;--> statement-breakpoint
ALTER TABLE "dead_letter" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "dead_letter" ADD COLUMN "failures" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dead_letter" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "dead_letter" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "dead_letter_ticket_status_idx" ON "dead_letter" USING btree ("ticket_id","status");--> statement-breakpoint
ALTER TABLE "dead_letter" ADD CONSTRAINT "dead_letter_status_check" CHECK ("dead_letter"."status" in ('open', 'replayed', 'skipped', 'forced'));--> statement-breakpoint
ALTER TABLE "dead_letter" ADD CONSTRAINT "dead_letter_failures_check" CHECK ("dead_letter"."failures" >= 1);