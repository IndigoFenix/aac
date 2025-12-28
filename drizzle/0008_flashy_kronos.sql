CREATE TYPE "public"."audit_action" AS ENUM('read', 'create', 'update', 'delete', 'export', 'login', 'logout', 'login_failed', 'access_denied');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('draft', 'pending_review', 'final', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."sensitivity_category" AS ENUM('medical', 'psychological', 'behavioral', 'educational', 'legal', 'financial');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" varchar,
	"actor_ip_hash" text,
	"action" "audit_action" NOT NULL,
	"resource_type" text,
	"resource_id" varchar,
	"institute_id" varchar,
	"session_id" text,
	"changed_fields" text[],
	"request_path" text,
	"request_method" text,
	"success" boolean NOT NULL,
	"status_code" integer,
	"error_code" text,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "educational_reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"institute_id" varchar,
	"program_id" varchar,
	"is_sensitive" boolean DEFAULT true NOT NULL,
	"sensitivity_category" "sensitivity_category" DEFAULT 'educational' NOT NULL,
	"report_type" text NOT NULL,
	"report_title" text,
	"report_date" date NOT NULL,
	"grading_period" text,
	"academic_year" text,
	"author_user_id" varchar,
	"author_name" text,
	"academic_performance" jsonb DEFAULT '{}'::jsonb,
	"standards_progress" jsonb DEFAULT '[]'::jsonb,
	"test_scores" jsonb DEFAULT '[]'::jsonb,
	"classroom_behavior" text,
	"participation_level" text,
	"social_interactions" text,
	"attendance_summary" jsonb DEFAULT '{}'::jsonb,
	"teacher_notes" text,
	"areas_of_strength" text,
	"areas_for_growth" text,
	"recommended_supports" text,
	"shared_with_guardians" boolean DEFAULT false,
	"shared_at" timestamp,
	"guardian_acknowledged_at" timestamp,
	"status" "report_status" DEFAULT 'draft' NOT NULL,
	"finalized_at" timestamp,
	"document_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "functional_reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"institute_id" varchar,
	"program_id" varchar,
	"is_sensitive" boolean DEFAULT true NOT NULL,
	"sensitivity_category" "sensitivity_category" DEFAULT 'behavioral' NOT NULL,
	"report_type" text NOT NULL,
	"report_title" text,
	"report_date" date NOT NULL,
	"evaluation_period_start" date,
	"evaluation_period_end" date,
	"author_user_id" varchar,
	"author_name" text,
	"author_credentials" text,
	"referral_reason" text,
	"referral_source" text,
	"background_context" text,
	"relevant_history" text,
	"assessment_methods" text[],
	"instruments_used" text[],
	"assessment_scores" jsonb DEFAULT '{}'::jsonb,
	"observation_data" jsonb DEFAULT '{}'::jsonb,
	"findings" text,
	"strengths" text,
	"areas_of_concern" text,
	"functional_limitations" text,
	"recommendations" text,
	"recommended_services" jsonb DEFAULT '[]'::jsonb,
	"recommended_goals" jsonb DEFAULT '[]'::jsonb,
	"status" "report_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp,
	"reviewed_by" varchar,
	"reviewed_at" timestamp,
	"finalized_at" timestamp,
	"finalized_by" varchar,
	"document_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_records" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"institute_id" varchar,
	"is_sensitive" boolean DEFAULT true NOT NULL,
	"sensitivity_category" "sensitivity_category" DEFAULT 'medical' NOT NULL,
	"primary_diagnosis" text,
	"primary_diagnosis_code" text,
	"diagnosis_date" date,
	"diagnostician" text,
	"secondary_diagnoses" jsonb DEFAULT '[]'::jsonb,
	"idea_classification" text,
	"classification_date" date,
	"allergies" jsonb DEFAULT '[]'::jsonb,
	"medications" jsonb DEFAULT '[]'::jsonb,
	"medical_equipment" text[],
	"dietary_restrictions" text[],
	"emergency_plan" text,
	"seizure_protocol" text,
	"hospital_preference" text,
	"primary_physician" jsonb DEFAULT '{}'::jsonb,
	"specialists" jsonb DEFAULT '[]'::jsonb,
	"last_accessed_by" varchar,
	"last_accessed_at" timestamp,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "educational_setting" text;--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "school" text;--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "grade" text;--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "classroom" text;--> statement-breakpoint
ALTER TABLE "institute_students" ADD COLUMN "id_number" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "user_students" ADD COLUMN "has_educational_rights" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_students" ADD COLUMN "has_medical_rights" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor_user_id" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_institute_id" ON "audit_logs" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_student_id" ON "educational_reports" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_institute_id" ON "educational_reports" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_program_id" ON "educational_reports" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_status" ON "educational_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_student_id" ON "functional_reports" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_institute_id" ON "functional_reports" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_program_id" ON "functional_reports" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_report_type" ON "functional_reports" USING btree ("report_type");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_status" ON "functional_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_medical_records_student_id" ON "medical_records" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_medical_records_institute_id" ON "medical_records" USING btree ("institute_id");--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "diagnosis";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "additional_diagnoses";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "background_context";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "educational_setting";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "school";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "grade";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "classroom";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "id_number";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "disability_classification";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "least_restrictive_environment";