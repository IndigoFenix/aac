ALTER TABLE "aac_settings" ADD COLUMN "dynamic_boards_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "is_generated" boolean DEFAULT false NOT NULL;