-- Migration 0108: admin-specific token tables for password reset + MFA recovery.
--
-- Admins live in admin_users (since 0107) with no users row, so the existing
-- password_reset_tokens / mfa_recovery_tokens tables (FK to users.id) can't
-- hold admin tokens. These parallel tables FK to admin_users.id with
-- ON DELETE CASCADE so removing an admin row also drops their pending tokens.

CREATE TABLE "admin_password_reset_tokens" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_user_id" varchar NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "admin_password_reset_tokens" ADD CONSTRAINT "admin_password_reset_tokens_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_password_reset_tokens_admin_user_id" ON "admin_password_reset_tokens" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "idx_admin_password_reset_tokens_expires_at" ON "admin_password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint

CREATE TABLE "admin_mfa_recovery_tokens" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_user_id" varchar NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "admin_mfa_recovery_tokens" ADD CONSTRAINT "admin_mfa_recovery_tokens_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_mfa_recovery_tokens_admin_user_id" ON "admin_mfa_recovery_tokens" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "idx_admin_mfa_recovery_tokens_expires_at" ON "admin_mfa_recovery_tokens" USING btree ("expires_at");
