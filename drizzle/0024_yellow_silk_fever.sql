CREATE TABLE "aac_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"enabled" boolean DEFAULT false,
	"demo_mode" boolean DEFAULT false,
	"demo_scenario" text,
	"chat_agent_prompt" text,
	"model_override" text,
	"interpretation_level" integer DEFAULT 2,
	"startup_mode" integer DEFAULT 0,
	"voice_type" text,
	"student_voice_type" text,
	"custom_voice_id" varchar,
	"custom_student_voice_id" varchar,
	"elevenlabs_api_key" text,
	"elevenlabs_ai_voice_id" text,
	"elevenlabs_student_voice_id" text,
	"icon_text_ratio" integer DEFAULT 3,
	"use_pcs_symbols" boolean DEFAULT false,
	"sign_language_reading" boolean DEFAULT false,
	"multi_camera_mode" boolean DEFAULT false,
	"eyegaze_enabled" boolean DEFAULT false,
	"eyegaze_timeout" integer DEFAULT 2000,
	"eyegaze_provider" text,
	"known_people" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "aac_settings_student_id_unique" UNIQUE("student_id")
);
--> statement-breakpoint
ALTER TABLE "aac_settings" ADD CONSTRAINT "aac_settings_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_aac_settings_student_id" ON "aac_settings" USING btree ("student_id");--> statement-breakpoint
-- Migrate existing AAC data from students to the new aac_settings table
INSERT INTO "aac_settings" (
  "student_id",
  "enabled",
  "demo_mode",
  "demo_scenario",
  "chat_agent_prompt",
  "model_override",
  "interpretation_level",
  "startup_mode",
  "voice_type",
  "student_voice_type",
  "custom_voice_id",
  "custom_student_voice_id",
  "elevenlabs_api_key",
  "elevenlabs_ai_voice_id",
  "elevenlabs_student_voice_id",
  "icon_text_ratio",
  "use_pcs_symbols",
  "sign_language_reading",
  "multi_camera_mode",
  "eyegaze_enabled",
  "eyegaze_timeout",
  "known_people"
)
SELECT
  "id",
  COALESCE("aac_enabled", false),
  COALESCE("aac_demo_mode", false),
  "aac_demo_scenario",
  "aac_chat_agent_prompt",
  "aac_model_override",
  COALESCE("aac_interpretation_level", 2),
  COALESCE("aac_startup_mode", 0),
  "aac_voice_type",
  "aac_student_voice_type",
  "aac_custom_voice_id",
  "aac_custom_student_voice_id",
  "aac_elevenlabs_api_key",
  "aac_elevenlabs_ai_voice_id",
  "aac_elevenlabs_student_voice_id",
  COALESCE("aac_icon_text_ratio", 3),
  COALESCE("aac_use_pcs_symbols", false),
  COALESCE("aac_sign_language_reading", false),
  COALESCE("aac_multi_camera_mode", false),
  COALESCE("aac_eyegaze_enabled", false),
  COALESCE("aac_eyegaze_timeout", 2000),
  COALESCE("aac_known_people", '[]'::jsonb)
FROM "students";
--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_enabled";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_chat_agent_prompt";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_demo_mode";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_demo_scenario";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_use_pcs_symbols";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_sign_language_reading";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_multi_camera_mode";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_model_override";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_voice_type";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_student_voice_type";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_custom_voice_id";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_custom_student_voice_id";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_icon_text_ratio";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_interpretation_level";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_startup_mode";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_eyegaze_enabled";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_eyegaze_timeout";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_known_people";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_elevenlabs_api_key";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_elevenlabs_ai_voice_id";--> statement-breakpoint
ALTER TABLE "students" DROP COLUMN "aac_elevenlabs_student_voice_id";
