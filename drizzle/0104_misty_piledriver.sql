ALTER TABLE "admin_users" ADD COLUMN "permissions" jsonb DEFAULT '["*"]'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill: copy existing system admins from users into admin_users. The user
-- row stays untouched so password + MFA verification continues to work against
-- it; admin_users becomes the source of truth for *identity* on login. Using
-- the same id keeps activity_log, audit, and any other userId references stable.
INSERT INTO "admin_users" ("id", "email", "first_name", "last_name", "profile_image_url", "role", "permissions", "created_at", "updated_at")
SELECT "id", "email", "first_name", "last_name", "profile_image_url", 'admin', '["*"]'::jsonb, now(), now()
FROM "users"
WHERE "is_system_admin" = true
ON CONFLICT ("email") DO NOTHING;