ALTER TABLE "caption_projects" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "caption_projects" ADD COLUMN "student_id" varchar;--> statement-breakpoint
ALTER TABLE "caption_projects" ADD COLUMN "credits_used" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caption_projects" ADD COLUMN "cost_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_caption_projects_institute_id" ON "caption_projects" USING btree ("institute_id");