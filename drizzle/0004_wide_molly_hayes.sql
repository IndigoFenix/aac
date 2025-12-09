CREATE TYPE "public"."institute_type" AS ENUM('school', 'hospital');--> statement-breakpoint
CREATE TABLE "institute_students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"enrollment_date" date,
	"data" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institute_users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'staff',
	"data" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institutes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "institute_type" NOT NULL,
	"description" text,
	"address" text,
	"phone" text,
	"email" text,
	"website" text,
	"logo_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar,
	"user_id" varchar,
	"name" text,
	"license_type" text DEFAULT 'standard' NOT NULL,
	"subscription_type" text DEFAULT 'free',
	"subscription_expires_at" timestamp,
	"credits" integer DEFAULT 0 NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"activated_at" timestamp,
	"suspended_at" timestamp,
	"suspension_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_settings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "system_settings" CASCADE;--> statement-breakpoint
ALTER TABLE "aac_user_schedules" RENAME TO "student_schedules";--> statement-breakpoint
ALTER TABLE "aac_users" RENAME TO "students";--> statement-breakpoint
ALTER TABLE "user_aac_users" RENAME TO "user_students";--> statement-breakpoint
ALTER TABLE "student_schedules" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "boards" RENAME COLUMN "ir_data" TO "description";--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME COLUMN "user_aac_user_id" TO "user_student_id";--> statement-breakpoint
ALTER TABLE "interpretations" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "interpretations" RENAME COLUMN "aac_user_name" TO "student_name";--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "invite_codes" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "invite_codes" RENAME COLUMN "redemption_limit" TO "max_redemptions";--> statement-breakpoint
ALTER TABLE "student_compliance_items" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "student_goals" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "student_phases" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "student_progress_entries" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "student_service_recommendations" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "user_students" RENAME COLUMN "aac_user_id" TO "student_id";--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_code_unique";--> statement-breakpoint
ALTER TABLE "student_schedules" DROP CONSTRAINT "aac_user_schedules_aac_user_id_aac_users_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_aac_user_id_aac_users_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_user_aac_user_id_user_aac_users_id_fk";
--> statement-breakpoint
ALTER TABLE "interpretations" DROP CONSTRAINT "interpretations_aac_user_id_aac_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" DROP CONSTRAINT "invite_code_redemptions_aac_user_id_aac_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invite_codes" DROP CONSTRAINT "invite_codes_aac_user_id_aac_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_students" DROP CONSTRAINT "user_aac_users_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_students" DROP CONSTRAINT "user_aac_users_aac_user_id_aac_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_chat_sessions_aac_user_id";--> statement-breakpoint
DROP INDEX "idx_compliance_items_aac_user_id";--> statement-breakpoint
DROP INDEX "idx_student_goals_aac_user_id";--> statement-breakpoint
DROP INDEX "idx_student_phases_aac_user_id";--> statement-breakpoint
DROP INDEX "idx_progress_entries_aac_user_id";--> statement-breakpoint
DROP INDEX "idx_service_recs_aac_user_id";--> statement-breakpoint
DROP INDEX "idx_user_aac_users_user_id";--> statement-breakpoint
DROP INDEX "idx_user_aac_users_aac_user_id";--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_codes" ALTER COLUMN "code" SET DATA TYPE varchar;--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_history" ALTER COLUMN "language" SET DEFAULT 'he';--> statement-breakpoint
ALTER TABLE "usage_windows" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "interpretations" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "credits" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "price" real NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_history" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "prompt_history" ADD COLUMN "tone" text;--> statement-breakpoint
ALTER TABLE "prompt_history" ADD COLUMN "age_group" text;--> statement-breakpoint
ALTER TABLE "prompt_history" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "prompt_history" ADD COLUMN "goals" text[];--> statement-breakpoint
ALTER TABLE "usage_windows" ADD COLUMN "window_end" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_windows" ADD COLUMN "request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_students" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_students_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_students_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_users" ADD CONSTRAINT "institute_users_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_users" ADD CONSTRAINT "institute_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_institute_students_institute_id" ON "institute_students" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_institute_students_student_id" ON "institute_students" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_institute_users_institute_id" ON "institute_users" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_institute_users_user_id" ON "institute_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_institutes_type" ON "institutes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_institutes_is_active" ON "institutes" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_licenses_institute_id" ON "licenses" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_licenses_user_id" ON "licenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_licenses_is_active" ON "licenses" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "student_schedules" ADD CONSTRAINT "student_schedules_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_student_id_user_students_id_fk" FOREIGN KEY ("user_student_id") REFERENCES "public"."user_students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_history" ADD CONSTRAINT "prompt_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_history" ADD CONSTRAINT "prompt_history_generated_board_id_boards_id_fk" FOREIGN KEY ("generated_board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_windows" ADD CONSTRAINT "usage_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_students" ADD CONSTRAINT "user_students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_students" ADD CONSTRAINT "user_students_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_student_id" ON "chat_sessions" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_compliance_items_student_id" ON "student_compliance_items" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_student_goals_student_id" ON "student_goals" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_student_phases_student_id" ON "student_phases" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_progress_entries_student_id" ON "student_progress_entries" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_service_recs_student_id" ON "student_service_recommendations" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_user_students_user_id" ON "user_students" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_students_student_id" ON "user_students" USING btree ("student_id");--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "disability_or_syndrome";--> statement-breakpoint
ALTER TABLE "interpretations" DROP COLUMN "caregiver_feedback";--> statement-breakpoint
ALTER TABLE "interpretations" DROP COLUMN "aac_user_wpm";--> statement-breakpoint
ALTER TABLE "interpretations" DROP COLUMN "schedule_activity";--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" DROP COLUMN "redeemed_at";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "monthly_generations";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "monthly_downloads";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "stored_boards";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "features";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "updated_at";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "prompt_excerpt";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "topic";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "output_format";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "generated_board_name";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "pages_generated";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "prompt_length";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "success";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "error_message";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "error_type";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "processing_time_ms";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "downloaded";--> statement-breakpoint
ALTER TABLE "prompt_history" DROP COLUMN "downloaded_at";--> statement-breakpoint
ALTER TABLE "usage_windows" DROP COLUMN "generations";--> statement-breakpoint
ALTER TABLE "usage_windows" DROP COLUMN "downloads";--> statement-breakpoint
ALTER TABLE "usage_windows" DROP COLUMN "stored_boards";