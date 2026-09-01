ALTER TABLE "aac_settings" ADD COLUMN "local_neural_voice" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "aac_settings" ADD COLUMN "launch_on_boot" boolean DEFAULT false NOT NULL;