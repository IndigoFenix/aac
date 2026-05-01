ALTER TABLE "topics" ADD COLUMN "crm_accessible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_topics_crm_accessible" ON "topics" USING btree ("crm_accessible");