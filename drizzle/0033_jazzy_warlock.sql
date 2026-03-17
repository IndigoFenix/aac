ALTER TABLE "aac_settings" ADD COLUMN "local_storage_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "aac_settings" ADD COLUMN "remote_storage_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "aac_settings" ADD COLUMN "local_storage_encryption_key" text;