ALTER TABLE "tickets" DROP CONSTRAINT "tickets_pkey";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "project_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_id_pk" PRIMARY KEY("project_id","id");
