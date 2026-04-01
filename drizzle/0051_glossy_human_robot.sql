CREATE TYPE "public"."activity_event_type" AS ENUM('create', 'update', 'delete', 'link', 'unlink', 'view', 'finalize', 'revision');--> statement-breakpoint
CREATE TYPE "public"."activity_subject_type" AS ENUM('student', 'classroom', 'institute', 'user', 'board', 'custom_symbol', 'program', 'goal', 'objective', 'service', 'accommodation', 'progress_report', 'data_point', 'team_member', 'meeting', 'medical_record', 'functional_report', 'educational_report', 'profile_domain', 'invite', 'consent_form', 'transition_plan', 'transition_goal');--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" varchar,
	"user_id" varchar,
	"event_type" "activity_event_type" NOT NULL,
	"subject_type_1" "activity_subject_type" NOT NULL,
	"subject_id_1" varchar,
	"subject_type_2" "activity_subject_type",
	"subject_id_2" varchar,
	"details" jsonb,
	"is_ai_initiated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_activity_logs_institute" ON "activity_logs" USING btree ("institute_id");--> statement-breakpoint
CREATE INDEX "idx_activity_logs_user" ON "activity_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_activity_logs_event_type" ON "activity_logs" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_activity_logs_subject_type" ON "activity_logs" USING btree ("subject_type_1");--> statement-breakpoint
CREATE INDEX "idx_activity_logs_created_at" ON "activity_logs" USING btree ("created_at");