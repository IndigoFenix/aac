CREATE TABLE "mfa_recovery_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enforced_by_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mfa_recovery_tokens" ADD CONSTRAINT "mfa_recovery_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mfa_recovery_tokens_user_id" ON "mfa_recovery_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_mfa_recovery_tokens_expires_at" ON "mfa_recovery_tokens" USING btree ("expires_at");