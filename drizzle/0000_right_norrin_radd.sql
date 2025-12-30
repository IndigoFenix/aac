CREATE TYPE "public"."accommodation_type" AS ENUM('visual_support', 'aac_device', 'modified_materials', 'extended_time', 'simplified_language', 'environmental_modification', 'other');--> statement-breakpoint
CREATE TYPE "public"."api_type" AS ENUM('llm', 'tts', 'stt', 'embedding', 'image', 'vector', 'moderation', 'tool', 'other');--> statement-breakpoint
CREATE TYPE "public"."assessment_source_type" AS ENUM('standardized_test', 'structured_observation', 'parent_questionnaire', 'teacher_input', 'curriculum_based', 'behavioral_records');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('read', 'create', 'update', 'delete', 'export', 'login', 'logout', 'login_failed', 'access_denied');--> statement-breakpoint
CREATE TYPE "public"."chat_session_status" AS ENUM('open', 'paused', 'closed');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('initial_evaluation', 'reevaluation', 'placement', 'release_of_information', 'service_provision');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('draft', 'active', 'achieved', 'modified', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."institute_type" AS ENUM('school', 'hospital');--> statement-breakpoint
CREATE TYPE "public"."intervention_level" AS ENUM('activity', 'function', 'participation');--> statement-breakpoint
CREATE TYPE "public"."meeting_type" AS ENUM('initial_evaluation', 'annual_review', 'reevaluation', 'amendment', 'transition_planning', 'progress_review');--> statement-breakpoint
CREATE TYPE "public"."objective_status" AS ENUM('not_started', 'in_progress', 'achieved', 'modified', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."profile_domain_type" AS ENUM('cognitive_academic', 'communication_language', 'social_emotional_behavioral', 'motor_sensory', 'life_skills_preparation', 'other');--> statement-breakpoint
CREATE TYPE "public"."program_framework" AS ENUM('tala', 'us_iep');--> statement-breakpoint
CREATE TYPE "public"."program_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."progress_status" AS ENUM('significant_progress', 'making_progress', 'limited_progress', 'no_progress', 'regression', 'goal_met');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('draft', 'pending_review', 'final', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."sensitivity_category" AS ENUM('medical', 'psychological', 'behavioral', 'educational', 'legal', 'financial');--> statement-breakpoint
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
CREATE TABLE "admin_users" (
	"id" varchar PRIMARY KEY NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"role" text DEFAULT 'admin',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "api_calls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" varchar NOT NULL,
	"api_type" "api_type" DEFAULT 'llm' NOT NULL,
	"endpoint" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"units_used" integer,
	"characters" integer,
	"seconds" integer,
	"requests" integer DEFAULT 1,
	"input_cost_usd" numeric(20, 6) NOT NULL,
	"output_cost_usd" numeric(20, 6) NOT NULL,
	"total_cost_usd" numeric(20, 6) NOT NULL,
	"response_time_ms" integer,
	"response_metadata" jsonb,
	"request_data" jsonb,
	"duration_ms" integer,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"user_id" varchar,
	"session_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_provider_pricing" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"endpoint" text,
	"pricing_type" text NOT NULL,
	"input_price_per_unit" varchar(20),
	"output_price_per_unit" varchar(20),
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_until" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "api_providers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"pricing_json" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_providers_name_unique" UNIQUE("name")
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
CREATE TABLE "boards" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"student_id" varchar,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"ir_data" jsonb,
	"language" text DEFAULT 'en',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"loaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"student_id" varchar,
	"user_student_id" varchar,
	"chat_mode" varchar DEFAULT 'chat' NOT NULL,
	"started" timestamp DEFAULT now() NOT NULL,
	"last_update" timestamp DEFAULT now() NOT NULL,
	"state" jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp,
	"credits_used" real DEFAULT 0 NOT NULL,
	"priority" real DEFAULT 0 NOT NULL,
	"status" "chat_session_status" DEFAULT 'open' NOT NULL,
	"use_responses_api" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "credit_packages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"credits" integer NOT NULL,
	"price" real NOT NULL,
	"bonus_credits" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"amount" integer NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"related_interpretation_id" varchar,
	"stripe_payment_intent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "dropbox_backups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"board_name" text NOT NULL,
	"file_type" text NOT NULL,
	"file_name" text NOT NULL,
	"dropbox_path" text NOT NULL,
	"dropbox_file_id" text,
	"shareable_url" text,
	"file_size_bytes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"upload_duration_ms" integer,
	"is_auto_backup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "dropbox_connections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"dropbox_account_id" text NOT NULL,
	"dropbox_email" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"token_expires_at" timestamp NOT NULL,
	"backup_folder_path" text DEFAULT '/Apps/SyntAACx/Backups' NOT NULL,
	"auto_backup_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
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
CREATE TABLE "institute_students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"enrollment_date" date,
	"educational_setting" text,
	"school" text,
	"grade" text,
	"classroom" text,
	"id_number" text,
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
CREATE TABLE "interpretations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"original_input" text NOT NULL,
	"interpreted_meaning" text NOT NULL,
	"analysis" text[] NOT NULL,
	"confidence" real NOT NULL,
	"suggested_response" text NOT NULL,
	"input_type" text NOT NULL,
	"language" text DEFAULT 'he',
	"context" text,
	"image_data" text,
	"student_id" varchar,
	"student_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_code_redemptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_code_id" varchar NOT NULL,
	"redeemed_by_user_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"expires_at" timestamp,
	"times_redeemed" integer DEFAULT 0 NOT NULL,
	"max_redemptions" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_code_unique" UNIQUE("code")
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
CREATE TABLE "password_reset_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_unique" UNIQUE("token")
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
	"institute_id" varchar,
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
CREATE TABLE "revenuecat_products" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"package_type" text,
	"entitlement_ids" text[],
	"credits_granted" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"price" real,
	"currency" text DEFAULT 'USD',
	"duration" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "revenuecat_products_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "revenuecat_subscriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"revenuecat_app_user_id" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"product_id" text NOT NULL,
	"entitlement_ids" text[],
	"purchase_date" timestamp NOT NULL,
	"expiration_date" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"environment" text NOT NULL,
	"store" text NOT NULL,
	"price" real,
	"currency" text DEFAULT 'USD',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "revenuecat_subscriptions_original_transaction_id_unique" UNIQUE("original_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "revenuecat_webhook_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"revenuecat_app_user_id" text NOT NULL,
	"original_transaction_id" text,
	"product_id" text,
	"entitlement_ids" text[],
	"event_timestamp" timestamp NOT NULL,
	"environment" text NOT NULL,
	"price" real,
	"currency" text,
	"raw_payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"alias" text NOT NULL,
	"location_type" text NOT NULL,
	"location_name" text NOT NULL,
	"latitude" real,
	"longitude" real,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"gender" text,
	"birth_date" date,
	"framework" "program_framework" DEFAULT 'tala',
	"country" text DEFAULT 'IL',
	"primary_language" text DEFAULT 'he',
	"additional_languages" text[],
	"chat_memory" jsonb DEFAULT '{}'::jsonb,
	"chat_credits_used" real DEFAULT 0 NOT NULL,
	"chat_credits_updated" timestamp DEFAULT now(),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"price" real NOT NULL,
	"credits" integer NOT NULL,
	"duration" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"features" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_name_unique" UNIQUE("name")
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
CREATE TABLE "user_students" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"student_id" varchar NOT NULL,
	"role" text DEFAULT 'caregiver',
	"data" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"has_educational_rights" boolean DEFAULT true NOT NULL,
	"has_medical_rights" boolean DEFAULT true NOT NULL,
	"chat_memory" jsonb DEFAULT '{}'::jsonb,
	"chat_credits_used" real DEFAULT 0 NOT NULL,
	"chat_credits_updated" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"google_id" text,
	"profile_image_url" text,
	"password" text,
	"auth_provider" text DEFAULT 'email',
	"user_type" text DEFAULT 'Caregiver' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"credits" integer DEFAULT 10 NOT NULL,
	"subscription_type" text DEFAULT 'free',
	"subscription_expires_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_active_at" timestamp DEFAULT now(),
	"onboarding_step" integer DEFAULT 0 NOT NULL,
	"referral_code" text,
	"referred_by_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"gen_cap_override" integer,
	"dl_cap_override" integer,
	"stored_boards_cap" integer,
	"chat_memory" jsonb DEFAULT '{}'::jsonb,
	"chat_credits_used" real DEFAULT 0 NOT NULL,
	"chat_credits_updated" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id"),
	CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_provider_id_api_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."api_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_sources" ADD CONSTRAINT "assessment_sources_profile_domain_id_profile_domains_id_fk" FOREIGN KEY ("profile_domain_id") REFERENCES "public"."profile_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_measurements" ADD CONSTRAINT "baseline_measurements_profile_domain_id_profile_domains_id_fk" FOREIGN KEY ("profile_domain_id") REFERENCES "public"."profile_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_student_id_user_students_id_fk" FOREIGN KEY ("user_student_id") REFERENCES "public"."user_students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_forms" ADD CONSTRAINT "consent_forms_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_related_interpretation_id_interpretations_id_fk" FOREIGN KEY ("related_interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_goal_progress_entry_id_goal_progress_entries_id_fk" FOREIGN KEY ("goal_progress_entry_id") REFERENCES "public"."goal_progress_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_points" ADD CONSTRAINT "data_points_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropbox_backups" ADD CONSTRAINT "dropbox_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropbox_connections" ADD CONSTRAINT "dropbox_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress_entries" ADD CONSTRAINT "goal_progress_entries_progress_report_id_progress_reports_id_fk" FOREIGN KEY ("progress_report_id") REFERENCES "public"."progress_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress_entries" ADD CONSTRAINT "goal_progress_entries_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_profile_domain_id_profile_domains_id_fk" FOREIGN KEY ("profile_domain_id") REFERENCES "public"."profile_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_students_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_students_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_users" ADD CONSTRAINT "institute_users_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_users" ADD CONSTRAINT "institute_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "public"."invite_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_domains" ADD CONSTRAINT "profile_domains_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_reports" ADD CONSTRAINT "progress_reports_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenuecat_subscriptions" ADD CONSTRAINT "revenuecat_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_locations" ADD CONSTRAINT "saved_locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_goals" ADD CONSTRAINT "service_goals_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_goals" ADD CONSTRAINT "service_goals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_provider_id_team_members_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_goals" ADD CONSTRAINT "transition_goals_transition_plan_id_transition_plans_id_fk" FOREIGN KEY ("transition_plan_id") REFERENCES "public"."transition_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_plans" ADD CONSTRAINT "transition_plans_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_students" ADD CONSTRAINT "user_students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_students" ADD CONSTRAINT "user_students_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_id_users_id_fk" FOREIGN KEY ("referred_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accommodations_service_id" ON "accommodations" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "idx_accommodations_program_id" ON "accommodations" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_assessment_sources_domain_id" ON "assessment_sources" USING btree ("profile_domain_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor_user_id" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_institute_id" ON "audit_logs" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_baseline_measurements_domain_id" ON "baseline_measurements" USING btree ("profile_domain_id");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_user_id" ON "chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_student_id" ON "chat_sessions" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_status" ON "chat_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_consent_forms_program_id" ON "consent_forms" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_consent_forms_consent_type" ON "consent_forms" USING btree ("consent_type");--> statement-breakpoint
CREATE INDEX "idx_data_points_progress_entry_id" ON "data_points" USING btree ("goal_progress_entry_id");--> statement-breakpoint
CREATE INDEX "idx_data_points_goal_id" ON "data_points" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_data_points_objective_id" ON "data_points" USING btree ("objective_id");--> statement-breakpoint
CREATE INDEX "idx_data_points_recorded_at" ON "data_points" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_student_id" ON "educational_reports" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_institute_id" ON "educational_reports" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_program_id" ON "educational_reports" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_educational_reports_status" ON "educational_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_student_id" ON "functional_reports" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_institute_id" ON "functional_reports" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_program_id" ON "functional_reports" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_report_type" ON "functional_reports" USING btree ("report_type");--> statement-breakpoint
CREATE INDEX "idx_functional_reports_status" ON "functional_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_goal_progress_entries_report_id" ON "goal_progress_entries" USING btree ("progress_report_id");--> statement-breakpoint
CREATE INDEX "idx_goal_progress_entries_goal_id" ON "goal_progress_entries" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_goals_program_id" ON "goals" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_goals_domain_id" ON "goals" USING btree ("profile_domain_id");--> statement-breakpoint
CREATE INDEX "idx_goals_status" ON "goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_institute_students_institute_id" ON "institute_students" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_institute_students_student_id" ON "institute_students" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_institute_users_institute_id" ON "institute_users" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_institute_users_user_id" ON "institute_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_institutes_type" ON "institutes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_institutes_is_active" ON "institutes" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_licenses_institute_id" ON "licenses" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_licenses_user_id" ON "licenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_licenses_is_active" ON "licenses" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_medical_records_student_id" ON "medical_records" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_medical_records_institute_id" ON "medical_records" USING btree ("institute_id");--> statement-breakpoint
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
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "idx_students_framework" ON "students" USING btree ("framework");--> statement-breakpoint
CREATE INDEX "idx_students_is_active" ON "students" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_team_members_program_id" ON "team_members" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_team_members_user_id" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_team_members_role" ON "team_members" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_transition_goals_plan_id" ON "transition_goals" USING btree ("transition_plan_id");--> statement-breakpoint
CREATE INDEX "idx_transition_goals_area" ON "transition_goals" USING btree ("area");--> statement-breakpoint
CREATE INDEX "idx_transition_plans_program_id" ON "transition_plans" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_user_students_user_id" ON "user_students" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_students_student_id" ON "user_students" USING btree ("student_id");