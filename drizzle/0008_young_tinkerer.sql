CREATE TYPE "public"."aac_session_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TABLE "aac_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"user_id" varchar,
	"context" jsonb DEFAULT '{}'::jsonb,
	"conversation_history" jsonb DEFAULT '[]'::jsonb,
	"credits_used" real DEFAULT 0 NOT NULL,
	"status" "aac_session_status" DEFAULT 'active' NOT NULL,
	"started" timestamp DEFAULT now() NOT NULL,
	"last_activity" timestamp DEFAULT now() NOT NULL,
	"ended" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_chat_agent_prompt" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_demo_mode" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_demo_scenario" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_use_pcs_symbols" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_sign_language_reading" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_multi_camera_mode" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_model_override" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_voice_type" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_known_people" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "aac_sessions" ADD CONSTRAINT "aac_sessions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aac_sessions" ADD CONSTRAINT "aac_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_aac_sessions_student_id" ON "aac_sessions" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_aac_sessions_user_id" ON "aac_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_aac_sessions_status" ON "aac_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_aac_sessions_last_activity" ON "aac_sessions" USING btree ("last_activity");