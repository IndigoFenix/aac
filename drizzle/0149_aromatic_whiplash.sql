ALTER TABLE "aac_settings" ADD COLUMN "auto_audio_scan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "aac_settings" ADD COLUMN "auto_audio_scan_delay" integer DEFAULT 15000 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "slp_mode" boolean DEFAULT false NOT NULL;