ALTER TYPE "public"."identity_provider_protocol" ADD VALUE 'saml';--> statement-breakpoint
ALTER TABLE "identity_providers" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ALTER COLUMN "client_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_entity_id" text;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_sso_url" text;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_slo_url" text;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_x509_cert" text;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_name_id_format" text DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_sign_authn_requests" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_want_assertions_signed" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_sp_entity_id" text;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_sp_private_key" text;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "saml_sp_certificate" text;