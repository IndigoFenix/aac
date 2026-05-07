ALTER TYPE "public"."activity_event_type" ADD VALUE 'student_erasure_requested';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'student_erasure_cancelled';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'student_erasure_completed';--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "scheduled_hard_delete_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_students_scheduled_hard_delete_at" ON "students" USING btree ("scheduled_hard_delete_at");