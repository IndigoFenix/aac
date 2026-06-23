CREATE TABLE "call_participants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" varchar NOT NULL,
	"person_id" varchar NOT NULL,
	"role" text,
	"media_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"joined_at" timestamp,
	"left_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "call_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" varchar NOT NULL,
	"institute_id" varchar NOT NULL,
	"initiated_by_person_id" varchar NOT NULL,
	"mode" text DEFAULT 'aac_caretaker' NOT NULL,
	"status" text DEFAULT 'ringing' NOT NULL,
	"media" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"ended_reason" text
);
--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_call_sessions_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_room_id_person_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."person_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_initiated_by_person_id_persons_id_fk" FOREIGN KEY ("initiated_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_call_participants_call_person" ON "call_participants" USING btree ("call_id","person_id");--> statement-breakpoint
CREATE INDEX "idx_call_participants_person_id" ON "call_participants" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "idx_call_sessions_room_started" ON "call_sessions" USING btree ("room_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_call_sessions_status" ON "call_sessions" USING btree ("status");