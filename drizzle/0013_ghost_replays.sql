CREATE TABLE "ghost_judgments" (
	"replay_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"side" text NOT NULL,
	"grade" text NOT NULL,
	"judge" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "ghost_judgments_replay_id_ticket_id_side_pk" PRIMARY KEY("replay_id","ticket_id","side")
);
--> statement-breakpoint
CREATE TABLE "ghost_replays" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"threshold" double precision NOT NULL,
	"memory" boolean NOT NULL,
	"seed" text NOT NULL,
	"tickets" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ghost_tickets" (
	"replay_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "ghost_tickets_replay_id_ticket_id_pk" PRIMARY KEY("replay_id","ticket_id")
);
