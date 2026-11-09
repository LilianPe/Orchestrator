CREATE TABLE "changelog" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"entry" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "changelog_at_idx" ON "changelog" USING btree ("at");