CREATE TABLE "ward_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"hospital_name" text,
	"accent" text,
	"logo" "bytea",
	"logo_type" text,
	"bays" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "ward_settings_singleton" CHECK ("ward_settings"."id" = 1),
	CONSTRAINT "ward_settings_logo_size" CHECK (octet_length("ward_settings"."logo") <= 204800),
	CONSTRAINT "ward_settings_logo_type" CHECK ("ward_settings"."logo_type" IN ('image/png', 'image/jpeg'))
);
--> statement-breakpoint
ALTER TABLE "ward_settings" ADD CONSTRAINT "ward_settings_updated_by_staff_staff_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff"("staff_id") ON DELETE no action ON UPDATE no action;