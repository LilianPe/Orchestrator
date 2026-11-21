CREATE TABLE "dry_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sha" text NOT NULL,
	"target" text NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dry_runs_project_idx" ON "dry_runs" USING btree ("project_id","ended_at");