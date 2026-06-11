-- Migration 0118: AAC device registration per student
--
-- Each row in student_devices is one AAC installation registered to a student.
-- The number of rows a student may hold is capped by the license permission
-- maxDevicesPerStudent (JSONB, no column needed) summed across all institutes
-- the student actively belongs to. device_id is a client-generated
-- installation id persisted in the device's localStorage.

CREATE TABLE "student_devices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"device_id" varchar NOT NULL,
	"device_name" text,
	"registered_by_user_id" varchar,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_devices" ADD CONSTRAINT "student_devices_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_devices" ADD CONSTRAINT "student_devices_registered_by_user_id_users_id_fk" FOREIGN KEY ("registered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_student_devices_student_id" ON "student_devices" ("student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_student_devices_student_device" ON "student_devices" ("student_id","device_id");
--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'device_registered';
--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'device_deregistered';
