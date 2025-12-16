CREATE TYPE "public"."accommodation_type" AS ENUM('visual_support', 'aac_device', 'modified_materials', 'extended_time', 'simplified_language', 'environmental_modification', 'other');--> statement-breakpoint
CREATE TYPE "public"."assessment_source_type" AS ENUM('standardized_test', 'structured_observation', 'parent_questionnaire', 'teacher_input', 'curriculum_based', 'behavioral_records');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('initial_evaluation', 'reevaluation', 'placement', 'release_of_information', 'service_provision');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('draft', 'active', 'achieved', 'modified', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."intervention_level" AS ENUM('activity', 'function', 'participation');--> statement-breakpoint
CREATE TYPE "public"."meeting_type" AS ENUM('initial_evaluation', 'annual_review', 'reevaluation', 'amendment', 'transition_planning', 'progress_review');--> statement-breakpoint
CREATE TYPE "public"."objective_status" AS ENUM('not_started', 'in_progress', 'achieved', 'modified', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."profile_domain_type" AS ENUM('cognitive_academic', 'communication_language', 'social_emotional_behavioral', 'motor_sensory', 'life_skills_preparation', 'other');--> statement-breakpoint
CREATE TYPE "public"."program_framework" AS ENUM('tala', 'us_iep');--> statement-breakpoint
CREATE TYPE "public"."program_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."progress_status" AS ENUM('significant_progress', 'making_progress', 'limited_progress', 'no_progress', 'regression', 'goal_met');--> statement-breakpoint
CREATE TYPE "public"."service_delivery_model" AS ENUM('direct', 'consultation', 'collaborative', 'indirect');--> statement-breakpoint
CREATE TYPE "public"."service_frequency_period" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."service_setting" AS ENUM('general_education', 'resource_room', 'self_contained', 'home', 'community', 'therapy_room');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('speech_language_therapy', 'occupational_therapy', 'physical_therapy', 'counseling', 'specialized_instruction', 'consultation', 'aac_support', 'other');--> statement-breakpoint
CREATE TYPE "public"."team_member_role" AS ENUM('parent_guardian', 'student', 'homeroom_teacher', 'special_education_teacher', 'general_education_teacher', 'speech_language_pathologist', 'occupational_therapist', 'physical_therapist', 'psychologist', 'administrator', 'case_manager', 'external_provider', 'other');--> statement-breakpoint
CREATE TYPE "public"."transition_area" AS ENUM('education', 'employment', 'independent_living', 'community');--> statement-breakpoint
CREATE TABLE "accommodations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" varchar,
	"program_id" varchar,
	"accommodation_type" "accommodation_type" NOT NULL,
	"custom_type_name" text,
	"description" text NOT NULL,
	"settings" text[],
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_sources" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_domain_id" varchar NOT NULL,
	"source_type" "assessment_source_type" NOT NULL,
	"instrument_name" text,
	"assessed_at" date,
	"summary" text,
	"results_data" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baseline_measurements" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_domain_id" varchar NOT NULL,
	"skill_description" text NOT NULL,
	"measurement_method" text NOT NULL,
	"value" text NOT NULL,
	"numeric_value" real,
	"unit" text,
	"assessed_at" date,
	"assessed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_forms" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"consent_type" "consent_type" NOT NULL,
	"requested_date" date,
	"response_date" date,
	"consent_given" boolean,
	"signed_by" text,
	"notes" text,
	"document_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_points" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_progress_entry_id" varchar,
	"goal_id" varchar,
	"objective_id" varchar,
	"recorded_at" timestamp NOT NULL,
	"value" text NOT NULL,
	"numeric_value" real,
	"context" text,
	"collected_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_progress_entries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"progress_report_id" varchar NOT NULL,
	"goal_id" varchar NOT NULL,
	"current_performance" text,
	"progress_status" "progress_status" NOT NULL,
	"narrative" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"profile_domain_id" varchar,
	"goal_statement" text NOT NULL,
	"smart_specific" jsonb DEFAULT '{}'::jsonb,
	"smart_measurable" jsonb DEFAULT '{}'::jsonb,
	"smart_achievable" jsonb DEFAULT '{}'::jsonb,
	"smart_relevant" jsonb DEFAULT '{}'::jsonb,
	"smart_time_bound" jsonb DEFAULT '{}'::jsonb,
	"target_behavior" text,
	"criteria" text,
	"criteria_percentage" integer,
	"measurement_method" text,
	"conditions" text,
	"relevance" text,
	"target_date" date,
	"intervention_level" "intervention_level",
	"status" "goal_status" DEFAULT 'draft' NOT NULL,
	"progress" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"meeting_type" "meeting_type" NOT NULL,
	"scheduled_date" timestamp,
	"actual_date" timestamp,
	"location" text,
	"attendee_ids" text[],
	"parent_attended" boolean,
	"student_attended" boolean,
	"agenda" text,
	"notes" text,
	"decisions" text[],
	"parent_concerns" text,
	"parent_priorities" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "objectives" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" varchar NOT NULL,
	"objective_statement" text NOT NULL,
	"sequence_order" integer DEFAULT 1 NOT NULL,
	"criterion" text,
	"context" text,
	"target_date" date,
	"status" "objective_status" DEFAULT 'not_started' NOT NULL,
	"achieved_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_domains" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"domain_type" "profile_domain_type" NOT NULL,
	"custom_name" text,
	"strengths" text,
	"needs" text,
	"impact_statement" text,
	"adverse_effect_statement" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"framework" "program_framework" NOT NULL,
	"program_year" text NOT NULL,
	"title" text,
	"status" "program_status" DEFAULT 'draft' NOT NULL,
	"start_date" date,
	"end_date" date,
	"due_date" date,
	"approval_date" date,
	"least_restrictive_environment" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"report_date" date NOT NULL,
	"reporting_period" text,
	"overall_summary" text,
	"recommended_changes" text,
	"shared_with_parents" boolean DEFAULT false,
	"shared_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_goals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" varchar NOT NULL,
	"goal_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"service_type" "service_type" NOT NULL,
	"custom_service_name" text,
	"description" text,
	"provider_id" varchar,
	"provider_name" text,
	"frequency_count" integer DEFAULT 1 NOT NULL,
	"frequency_period" "service_frequency_period" DEFAULT 'weekly' NOT NULL,
	"session_duration" integer NOT NULL,
	"setting" "service_setting",
	"setting_description" text,
	"delivery_model" "service_delivery_model" DEFAULT 'direct',
	"start_date" date,
	"end_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"user_id" varchar,
	"name" text NOT NULL,
	"role" "team_member_role" NOT NULL,
	"custom_role" text,
	"organization" text,
	"contact_email" text,
	"contact_phone" text,
	"responsibilities" text[],
	"is_coordinator" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transition_goals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transition_plan_id" varchar NOT NULL,
	"area" "transition_area" NOT NULL,
	"goal_statement" text NOT NULL,
	"activities_services" text,
	"responsible_party" text,
	"timeline" text,
	"status" "goal_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transition_plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" varchar NOT NULL,
	"post_secondary_education" text,
	"employment" text,
	"independent_living" text,
	"community_participation" text,
	"transition_assessment_summary" text,
	"agency_linkages" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_aggregates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_changes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plans" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prompt_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_compliance_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_goals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_phases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_progress_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_schedules" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_service_recommendations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "system_prompt" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_windows" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_cohorts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "analytics_aggregates" CASCADE;--> statement-breakpoint
DROP TABLE "plan_changes" CASCADE;--> statement-breakpoint
DROP TABLE "plans" CASCADE;--> statement-breakpoint
DROP TABLE "prompt_events" CASCADE;--> statement-breakpoint
DROP TABLE "student_compliance_items" CASCADE;--> statement-breakpoint
DROP TABLE "student_goals" CASCADE;--> statement-breakpoint
DROP TABLE "student_phases" CASCADE;--> statement-breakpoint
DROP TABLE "student_progress_entries" CASCADE;--> statement-breakpoint
DROP TABLE "student_schedules" CASCADE;--> statement-breakpoint
DROP TABLE "student_service_recommendations" CASCADE;--> statement-breakpoint
DROP TABLE "system_prompt" CASCADE;--> statement-breakpoint
DROP TABLE "usage_windows" CASCADE;--> statement-breakpoint
DROP TABLE "user_cohorts" CASCADE;--> statement-breakpoint
DROP TABLE "user_events" CASCADE;--> statement-breakpoint
DROP TABLE "user_sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "students" RENAME COLUMN "system_type" TO "framework";--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "student_id" varchar;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "language" text DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "additional_diagnoses" text[];--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "primary_language" text DEFAULT 'he';--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "additional_languages" text[];--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "educational_setting" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "classroom" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "disability_classification" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "least_restrictive_environment" text;--> statement-breakpoint
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_sources" ADD CONSTRAINT "assessment_sources_profile_domain_id_profile_domains_id_fk" FOREIGN KEY ("profile_domain_id") REFERENCES "public"."profile_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_measurements" ADD CONSTRAINT "baseline_measurements_profile_domain_id_profile_domains_id_fk" FOREIGN KEY ("profile_domain_id") REFERENCES "public"."profile_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_forms" ADD CONSTRAINT "consent_forms_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_goal_progress_entry_id_goal_progress_entries_id_fk" FOREIGN KEY ("goal_progress_entry_id") REFERENCES "public"."goal_progress_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress_entries" ADD CONSTRAINT "goal_progress_entries_progress_report_id_progress_reports_id_fk" FOREIGN KEY ("progress_report_id") REFERENCES "public"."progress_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress_entries" ADD CONSTRAINT "goal_progress_entries_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_profile_domain_id_profile_domains_id_fk" FOREIGN KEY ("profile_domain_id") REFERENCES "public"."profile_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_domains" ADD CONSTRAINT "profile_domains_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_reports" ADD CONSTRAINT "progress_reports_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_goals" ADD CONSTRAINT "service_goals_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_goals" ADD CONSTRAINT "service_goals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_provider_id_team_members_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_goals" ADD CONSTRAINT "transition_goals_transition_plan_id_transition_plans_id_fk" FOREIGN KEY ("transition_plan_id") REFERENCES "public"."transition_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_plans" ADD CONSTRAINT "transition_plans_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accommodations_service_id" ON "accommodations" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "idx_accommodations_program_id" ON "accommodations" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_assessment_sources_domain_id" ON "assessment_sources" USING btree ("profile_domain_id");--> statement-breakpoint
CREATE INDEX "idx_baseline_measurements_domain_id" ON "baseline_measurements" USING btree ("profile_domain_id");--> statement-breakpoint
CREATE INDEX "idx_consent_forms_program_id" ON "consent_forms" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_consent_forms_consent_type" ON "consent_forms" USING btree ("consent_type");--> statement-breakpoint
CREATE INDEX "idx_data_points_progress_entry_id" ON "data_points" USING btree ("goal_progress_entry_id");--> statement-breakpoint
CREATE INDEX "idx_data_points_goal_id" ON "data_points" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_data_points_objective_id" ON "data_points" USING btree ("objective_id");--> statement-breakpoint
CREATE INDEX "idx_data_points_recorded_at" ON "data_points" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_goal_progress_entries_report_id" ON "goal_progress_entries" USING btree ("progress_report_id");--> statement-breakpoint
CREATE INDEX "idx_goal_progress_entries_goal_id" ON "goal_progress_entries" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_goals_program_id" ON "goals" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_goals_domain_id" ON "goals" USING btree ("profile_domain_id");--> statement-breakpoint
CREATE INDEX "idx_goals_status" ON "goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_meetings_program_id" ON "meetings" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_meetings_meeting_type" ON "meetings" USING btree ("meeting_type");--> statement-breakpoint
CREATE INDEX "idx_meetings_scheduled_date" ON "meetings" USING btree ("scheduled_date");--> statement-breakpoint
CREATE INDEX "idx_objectives_goal_id" ON "objectives" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_objectives_status" ON "objectives" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_profile_domains_program_id" ON "profile_domains" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_profile_domains_domain_type" ON "profile_domains" USING btree ("domain_type");--> statement-breakpoint
CREATE INDEX "idx_programs_student_id" ON "programs" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_programs_status" ON "programs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_programs_framework" ON "programs" USING btree ("framework");--> statement-breakpoint
CREATE INDEX "idx_progress_reports_program_id" ON "progress_reports" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_progress_reports_report_date" ON "progress_reports" USING btree ("report_date");--> statement-breakpoint
CREATE INDEX "idx_service_goals_service_id" ON "service_goals" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "idx_service_goals_goal_id" ON "service_goals" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_services_program_id" ON "services" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_services_service_type" ON "services" USING btree ("service_type");--> statement-breakpoint
CREATE INDEX "idx_services_is_active" ON "services" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_team_members_program_id" ON "team_members" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_team_members_user_id" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_team_members_role" ON "team_members" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_transition_goals_plan_id" ON "transition_goals" USING btree ("transition_plan_id");--> statement-breakpoint
CREATE INDEX "idx_transition_goals_area" ON "transition_goals" USING btree ("area");--> statement-breakpoint
CREATE INDEX "idx_transition_plans_program_id" ON "transition_plans" USING btree ("program_id");--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_students_framework" ON "students" USING btree ("framework");--> statement-breakpoint
CREATE INDEX "idx_students_is_active" ON "students" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "next_deadline";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "overall_progress";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "current_phase";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "progress_data";