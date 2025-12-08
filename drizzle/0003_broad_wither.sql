CREATE TABLE "student_compliance_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aac_user_id" varchar NOT NULL,
	"phase_id" varchar,
	"item_key" text NOT NULL,
	"item_label" text NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"completed_by" varchar,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_goals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aac_user_id" varchar NOT NULL,
	"phase_id" varchar,
	"title" text NOT NULL,
	"description" text,
	"goal_type" text DEFAULT 'general' NOT NULL,
	"target_behavior" text,
	"criteria" text,
	"criteria_percentage" integer,
	"measurement_method" text,
	"conditions" text,
	"relevance" text,
	"target_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"progress" integer DEFAULT 0,
	"baseline_data" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_phases" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aac_user_id" varchar NOT NULL,
	"phase_id" text NOT NULL,
	"phase_name" text NOT NULL,
	"phase_order" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_date" date,
	"completed_at" timestamp,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_progress_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aac_user_id" varchar NOT NULL,
	"goal_id" varchar,
	"phase_id" varchar,
	"entry_type" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"metrics" jsonb DEFAULT '{}'::jsonb,
	"recorded_by" varchar,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_service_recommendations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aac_user_id" varchar NOT NULL,
	"service_name" text NOT NULL,
	"service_type" text DEFAULT 'direct' NOT NULL,
	"duration_minutes" integer NOT NULL,
	"frequency" text NOT NULL,
	"frequency_count" integer DEFAULT 1 NOT NULL,
	"start_date" date,
	"end_date" date,
	"provider" text,
	"location" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "system_type" text DEFAULT 'tala';--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "country" text DEFAULT 'IL';--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "school" text;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "grade" text;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "diagnosis" text;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "id_number" text;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "next_deadline" date;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "overall_progress" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "current_phase" text;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "progress_data" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "idx_compliance_items_aac_user_id" ON "student_compliance_items" USING btree ("aac_user_id");--> statement-breakpoint
CREATE INDEX "idx_student_goals_aac_user_id" ON "student_goals" USING btree ("aac_user_id");--> statement-breakpoint
CREATE INDEX "idx_student_goals_status" ON "student_goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_student_phases_aac_user_id" ON "student_phases" USING btree ("aac_user_id");--> statement-breakpoint
CREATE INDEX "idx_student_phases_status" ON "student_phases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_progress_entries_aac_user_id" ON "student_progress_entries" USING btree ("aac_user_id");--> statement-breakpoint
CREATE INDEX "idx_progress_entries_recorded_at" ON "student_progress_entries" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_service_recs_aac_user_id" ON "student_service_recommendations" USING btree ("aac_user_id");