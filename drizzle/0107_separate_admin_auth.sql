-- Migration 0107: separate admin auth from users
--
-- admin_users becomes a fully self-contained identity. The legacy `users` row
-- for each admin is dropped — login (password + Google + MFA) now reads/writes
-- admin_users directly. Before dropping the users rows we also clean up the
-- auth-scaffolding tables (recovery + reset tokens, external identity links)
-- whose FK would otherwise block the DELETE.
--
-- If the DELETE step trips on FK refs from other tables (e.g. an admin issued
-- invites, created licenses, etc.), the whole migration rolls back. The fix
-- in that case is to reassign or null those refs before re-running — see the
-- "FK fallout" note in the PR description.

ALTER TABLE "admin_users" ADD COLUMN "password" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "auth_provider" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "google_id" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_google_id_unique" UNIQUE("google_id");--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_enforced_by_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "last_active_at" timestamp;--> statement-breakpoint

-- Backfill auth state from the legacy users row (matched by shared id). This
-- is a no-op for any admin_users row that lacks a paired users row (e.g. an
-- admin added via the new management UI on a fresh environment).
UPDATE "admin_users" a SET
  password = u.password,
  auth_provider = COALESCE(u.auth_provider, 'email'),
  google_id = u.google_id,
  mfa_enabled = COALESCE(u.mfa_enabled, false),
  mfa_secret = u.mfa_secret,
  mfa_enforced_by_admin = COALESCE(u.mfa_enforced_by_admin, false),
  last_active_at = u.last_active_at,
  updated_at = now()
FROM "users" u WHERE u.id = a.id;--> statement-breakpoint

-- Clean up FK refs that would otherwise block deleting the users rows. These
-- are pure auth scaffolding — tokens belonging to an admin who is being
-- migrated off the users table are no longer meaningful.
DELETE FROM "mfa_recovery_tokens" WHERE user_id IN (SELECT id FROM "admin_users");--> statement-breakpoint
DELETE FROM "password_reset_tokens" WHERE user_id IN (SELECT id FROM "admin_users");--> statement-breakpoint
DELETE FROM "user_external_identities" WHERE user_id IN (SELECT id FROM "admin_users");--> statement-breakpoint

-- Drop the legacy users row for every admin. If this fails on an FK
-- constraint, that constraint points at a table that still considers the
-- admin a "user" (e.g. created_by_user_id on a license). Resolve by either
-- (a) repointing/nullifying those refs first, or (b) accepting CASCADE on
-- the offending FK — then re-run the migration.
DELETE FROM "users" WHERE id IN (SELECT id FROM "admin_users");
