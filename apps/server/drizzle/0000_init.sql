CREATE TYPE "public"."device_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('clerk', 'nurse', 'charge', 'admin');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"audit_id" bigserial PRIMARY KEY NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_id" text,
	"device_id" uuid,
	"action" text NOT NULL,
	"event_id" uuid,
	"outcome" text NOT NULL,
	"code" text,
	"request_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"public_key" "bytea" NOT NULL,
	"fingerprint" text NOT NULL,
	"temp_prefix" text,
	"label" text NOT NULL,
	"status" "device_status" DEFAULT 'pending' NOT NULL,
	"last_device_seq" integer DEFAULT 0 NOT NULL,
	"last_clock_offset_ms" integer,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "devices_temp_prefix_unique" UNIQUE("temp_prefix"),
	CONSTRAINT "public_key_length" CHECK (octet_length("devices"."public_key") = 32)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"server_seq" bigint PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"device_seq" integer NOT NULL,
	"staff_id" text NOT NULL,
	"type" text NOT NULL,
	"body" jsonb NOT NULL,
	"body_sha256" "bytea" NOT NULL,
	"client_time" timestamp with time zone NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "events_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "events_hash_unique" UNIQUE("hash"),
	CONSTRAINT "events_device_seq" UNIQUE("device_id","device_seq"),
	CONSTRAINT "body_size" CHECK (octet_length("events"."body"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "log_head" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_hash" "bytea" NOT NULL,
	CONSTRAINT "log_head_singleton" CHECK ("log_head"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"staff_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"staff_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"pin_hash" "bytea" NOT NULL,
	"pin_salt" "bytea" NOT NULL,
	"status" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "staff_id_format" CHECK ("staff"."staff_id" ~ '^S-[0-9]{4}$'),
	CONSTRAINT "staff_status" CHECK ("staff"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_approved_by_staff_staff_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff"("staff_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_staff_id_staff_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("staff_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staff_id_staff_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("staff_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;