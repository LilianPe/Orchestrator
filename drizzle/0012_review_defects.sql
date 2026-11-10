CREATE TABLE "review_defects" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"pr_number" integer NOT NULL,
	"description" text NOT NULL,
	"finding_id" text,
	"file" text,
	"line" integer,
	"definition" text,
	"entered_by" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "review_defects_entered_at_idx" ON "review_defects" USING btree ("entered_at");--> statement-breakpoint
CREATE INDEX "review_defects_ticket_idx" ON "review_defects" USING btree ("project_id","ticket_id");