CREATE TYPE "public"."incident_severity" AS ENUM('low', 'moderate', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."incident_type" AS ENUM('medical', 'functional');--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"type" "incident_type" NOT NULL,
	"severity" "incident_severity" NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"context" text,
	"collected_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_incidents_student_id" ON "incidents" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_incidents_recorded_at" ON "incidents" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_incidents_type" ON "incidents" USING btree ("type");