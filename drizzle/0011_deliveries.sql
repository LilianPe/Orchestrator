CREATE TABLE "deliveries" (
	"key" text NOT NULL,
	"aside" boolean NOT NULL,
	"value" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deliveries_key_aside_pk" PRIMARY KEY("key","aside")
);
--> statement-breakpoint
-- ORC-355: the deliveries kept before in the meta rows of workflow_versions, pending and set aside, move to their table.
-- A row without its value keeps its definition whole: unreadable, the ingest sets it aside rather than the migration failing.
INSERT INTO "deliveries" ("key", "aside", "value", "received_at")
SELECT substr("id", length('meta:delivery:') + 1), false, coalesce("definition"->>'value', "definition"::text), "created_at" FROM "workflow_versions" WHERE starts_with("id", 'meta:delivery:');
--> statement-breakpoint
INSERT INTO "deliveries" ("key", "aside", "value", "received_at")
SELECT substr("id", length('meta:delivery-aside:') + 1), true, coalesce("definition"->>'value', "definition"::text), "created_at" FROM "workflow_versions" WHERE starts_with("id", 'meta:delivery-aside:');
--> statement-breakpoint
DELETE FROM "workflow_versions" WHERE starts_with("id", 'meta:delivery:') OR starts_with("id", 'meta:delivery-aside:');
