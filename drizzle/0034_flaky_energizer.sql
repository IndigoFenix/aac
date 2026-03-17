ALTER TABLE "aac_settings" ADD COLUMN "generate_symbols" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "aac_settings" ADD COLUMN "use_approved_symbols" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "aac_settings" ADD COLUMN "use_unapproved_symbols" boolean DEFAULT false NOT NULL;