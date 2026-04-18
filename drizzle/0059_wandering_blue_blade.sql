ALTER TABLE "deep_analyses" ADD COLUMN "messages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deep_analyses" ADD COLUMN "scratch" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deep_analyses" ADD COLUMN "step_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deep_analyses" ADD COLUMN "resume_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deep_analyses" ADD COLUMN "last_activity_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_deep_analyses_status" ON "deep_analyses" USING btree ("status");