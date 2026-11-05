CREATE TABLE "egress_requests" (
	"run_id" text NOT NULL,
	"n" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"host" text NOT NULL,
	"port" integer,
	"path" text,
	"ok" boolean NOT NULL,
	"reason" text,
	"up" bigint NOT NULL,
	"down" bigint NOT NULL,
	CONSTRAINT "egress_requests_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "refusals" (
	"run_id" text NOT NULL,
	"n" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"tool" text NOT NULL,
	"rule" text NOT NULL,
	"command" text NOT NULL,
	CONSTRAINT "refusals_run_id_n_pk" PRIMARY KEY("run_id","n")
);
--> statement-breakpoint
CREATE TABLE "security_logs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"skipped_egress" integer NOT NULL,
	"skipped_refusals" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "egress_requests_at_idx" ON "egress_requests" USING btree ("at");--> statement-breakpoint
CREATE INDEX "refusals_at_idx" ON "refusals" USING btree ("at");--> statement-breakpoint
CREATE INDEX "security_logs_ticket_id_idx" ON "security_logs" USING btree ("ticket_id");