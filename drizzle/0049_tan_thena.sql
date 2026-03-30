ALTER TYPE "public"."event_repeat" ADD VALUE 'monthly_date';--> statement-breakpoint
ALTER TYPE "public"."event_repeat" ADD VALUE 'monthly_weekday';--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "repeat_interval" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "repeat_month_week" integer;