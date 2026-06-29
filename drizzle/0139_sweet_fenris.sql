ALTER TABLE "aac_settings" ADD COLUMN "budget_tier" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "budget_meters" jsonb DEFAULT '{}'::jsonb;