ALTER TABLE "students" ADD COLUMN "aac_eyegaze_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "aac_eyegaze_timeout" integer DEFAULT 2000;