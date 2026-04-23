ALTER TABLE "calendar_event_attendees" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "start_time" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "end_time" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "repeat_end_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;