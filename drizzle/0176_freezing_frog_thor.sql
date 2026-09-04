ALTER TABLE "aac_settings" ADD COLUMN "presence_ledger" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "presence_ledger" jsonb;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "provenance" jsonb;