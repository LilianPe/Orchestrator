ALTER TABLE "findings" ADD COLUMN "project_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "ticket_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "sha" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "n" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "file" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "line" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "suggestion" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fact" text;--> statement-breakpoint
CREATE INDEX "findings_commit_idx" ON "findings" USING btree ("project_id","ticket_id","sha");