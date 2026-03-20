ALTER TABLE "licenses" ALTER COLUMN "subscription_type" SET DEFAULT 'monthly';--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "is_trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "trial_expires_at" timestamp;--> statement-breakpoint
UPDATE "licenses" SET "is_trial" = true, "license_type" = 'standard' WHERE "license_type" = 'trial';--> statement-breakpoint
UPDATE "licenses" SET "subscription_type" = 'monthly' WHERE "subscription_type" = 'free';