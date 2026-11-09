CREATE TABLE "deliveries" (
	"key" text NOT NULL,
	"aside" boolean NOT NULL,
	"value" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deliveries_key_aside_pk" PRIMARY KEY("key","aside")
);
--> statement-breakpoint
-- ORC-355: the deliveries kept before in the meta rows of workflow_versions, pending and set aside, move to their table.
INSERT INTO "deliveries" ("key", "aside", "value", "received_at")
SELECT substr("id", length('meta:delivery:') + 1), false, "definition"->>'value', "created_at" FROM "workflow_versions" WHERE starts_with("id", 'meta:delivery:');
--> statement-breakpoint
INSERT INTO "deliveries" ("key", "aside", "value", "received_at")
SELECT substr("id", length('meta:delivery-aside:') + 1), true, "definition"->>'value', "created_at" FROM "workflow_versions" WHERE starts_with("id", 'meta:delivery-aside:');
--> statement-breakpoint
DELETE FROM "workflow_versions" WHERE starts_with("id", 'meta:delivery:') OR starts_with("id", 'meta:delivery-aside:');
