CREATE TABLE "exports" (
	"export_id" uuid PRIMARY KEY NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"up_to_seq" bigint NOT NULL,
	"formats" text[] NOT NULL,
	"encrypted" boolean NOT NULL,
	"sha256" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_created_by_staff_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("staff_id") ON DELETE no action ON UPDATE no action;