ALTER TABLE "students" ADD COLUMN "legacy_consent_deadline" timestamp with time zone;--> statement-breakpoint
-- Pre-existing students get a 90-day grace window. New rows default to NULL
-- (must collect consent before PHI ops).
UPDATE "students" SET "legacy_consent_deadline" = now() + interval '90 days' WHERE "legacy_consent_deadline" IS NULL;