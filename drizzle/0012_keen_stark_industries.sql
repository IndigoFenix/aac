CREATE TABLE "voices" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"external_id" text NOT NULL,
	"source" text DEFAULT 'elevenlabs' NOT NULL,
	"description" text,
	"sample_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_student_voice_type" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_custom_voice_id" varchar;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_custom_student_voice_id" varchar;--> statement-breakpoint
CREATE INDEX "idx_voices_active" ON "voices" USING btree ("active");--> statement-breakpoint
CREATE INDEX "idx_voices_source" ON "voices" USING btree ("source");