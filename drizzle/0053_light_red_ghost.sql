CREATE TYPE "public"."identity_provider_protocol" AS ENUM('oidc', 'oauth2');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'pending', 'verified');--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"protocol" "identity_provider_protocol" NOT NULL,
	"discovery_url" text,
	"authorization_url" text,
	"token_url" text,
	"userinfo_url" text,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"scopes" text DEFAULT 'openid email profile',
	"claim_mappings" jsonb DEFAULT '{}'::jsonb,
	"institute_id_type" text,
	"reverification_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_external_identities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"provider_id" varchar NOT NULL,
	"external_id" text NOT NULL,
	"email" text,
	"claims" jsonb DEFAULT '{}'::jsonb,
	"verified_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institutes" ADD COLUMN "verification_status" "verification_status" DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_external_identities" ADD CONSTRAINT "user_external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_external_identities" ADD CONSTRAINT "user_external_identities_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_uei_provider_external_id" ON "user_external_identities" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_uei_user_id" ON "user_external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_uei_provider_id" ON "user_external_identities" USING btree ("provider_id");