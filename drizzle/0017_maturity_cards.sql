CREATE TABLE "maturity_cards" (
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"value" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	CONSTRAINT "maturity_cards_project_id_key_pk" PRIMARY KEY("project_id","key")
);
