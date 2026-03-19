CREATE TYPE "public"."event_attendee_type" AS ENUM('user', 'student', 'classroom', 'institute');--> statement-breakpoint
CREATE TYPE "public"."event_repeat" AS ENUM('none', 'daily', 'weekly');--> statement-breakpoint
CREATE TABLE "calendar_event_attendees" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" varchar NOT NULL,
	"attendee_type" "event_attendee_type" NOT NULL,
	"attendee_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"repeat_type" "event_repeat" DEFAULT 'none' NOT NULL,
	"repeat_days" jsonb,
	"repeat_end_date" timestamp,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_event_attendees_event_id" ON "calendar_event_attendees" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendees_type_id" ON "calendar_event_attendees" USING btree ("attendee_type","attendee_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_start_time" ON "calendar_events" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_end_time" ON "calendar_events" USING btree ("end_time");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_created_by" ON "calendar_events" USING btree ("created_by_user_id");