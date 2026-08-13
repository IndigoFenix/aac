ALTER TABLE "aac_settings" ADD COLUMN "auto_add_contacts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "auto_added" boolean DEFAULT false NOT NULL;