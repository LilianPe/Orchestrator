CREATE TABLE "known_flaky_tests" (
	"project_id" text NOT NULL,
	"test" text NOT NULL,
	"covers_frozen" boolean NOT NULL,
	"reason" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "known_flaky_tests_project_id_test_pk" PRIMARY KEY("project_id","test")
);
