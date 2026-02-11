CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_elevenlabs_api_key" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_elevenlabs_ai_voice_id" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_elevenlabs_student_voice_id" text;