CREATE TYPE "public"."aac_utterance_source" AS ENUM('board_press', 'live_speech', 'monitor_synth');--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'aac_sleep_state_change';--> statement-breakpoint
CREATE TABLE "aac_utterance_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"chat_session_id" varchar,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"word_count" integer NOT NULL,
	"unique_word_count" integer NOT NULL,
	"source" "aac_utterance_source" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institutes" ADD COLUMN "timezone" text;--> statement-breakpoint
CREATE INDEX "idx_aac_utterance_events_student" ON "aac_utterance_events" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_aac_utterance_events_session" ON "aac_utterance_events" USING btree ("chat_session_id");--> statement-breakpoint
CREATE INDEX "idx_aac_utterance_events_recorded_at" ON "aac_utterance_events" USING btree ("recorded_at");