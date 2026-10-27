ALTER TABLE "attempts" ADD COLUMN "factory_version" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "factory_commit" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "registry_commit" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "delivered_fact_ids" jsonb;