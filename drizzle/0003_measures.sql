ALTER TABLE "attempts" ADD COLUMN "input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "cache_read_tokens" bigint;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "cache_creation_tokens" bigint;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "acked_at" timestamp with time zone;