CREATE TABLE "baselines" (
	"project_id" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"measure" text NOT NULL,
	"value" double precision,
	"over_count" integer NOT NULL,
	"left_out" integer NOT NULL,
	"no_source" boolean NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "baselines_project_id_since_until_measure_pk" PRIMARY KEY("project_id","since","until","measure")
);
