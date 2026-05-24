-- Migration 0107: separate admin auth from users (revised)
--
-- admin_users becomes a fully self-contained identity for *authentication*:
-- password, MFA secret, auth_provider, and google_id all live on the admin row.
-- LocalStrategy / Google strategy / MFA / recovery all read and write here.
--
-- The legacy `users` row is intentionally **kept** as an empty "shell": it
-- anchors FK references from chat_sessions, audit logs, and anything created
-- while an admin is in customer-support mode acting on behalf of a tenant.
-- We just NULL out the auth fields so the shell cannot be used for login —
-- belt-and-braces, since LocalStrategy already short-circuits on admin_users.
--
-- New admins that don't have a paired users row get a dummy one created on
-- first login (see ensureAdminShellUser in adminAuthService).

ALTER TABLE "admin_users" ADD COLUMN "password" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "auth_provider" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "google_id" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_google_id_unique" UNIQUE("google_id");--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_enforced_by_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "last_active_at" timestamp;--> statement-breakpoint

-- Backfill auth state from the legacy users row (matched by shared id).
-- No-op for any admin_users row without a paired users row.
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

-- Clear auth-bearing fields on the admin's users shell row. Nothing on this
-- row can be used to log in any longer — admin login goes through admin_users.
-- The row itself stays so existing FK references survive.
UPDATE "users" SET
  password = NULL,
  google_id = NULL,
  mfa_enabled = false,
  mfa_secret = NULL,
  mfa_enforced_by_admin = false,
  updated_at = now()
WHERE id IN (SELECT id FROM "admin_users");
