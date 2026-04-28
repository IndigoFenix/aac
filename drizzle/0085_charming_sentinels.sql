CREATE TYPE "public"."government_id_type" AS ENUM('national_id', 'passport', 'driver_license', 'other');--> statement-breakpoint
CREATE TYPE "public"."id_verification_source" AS ENUM('manual_entry', 'gov_sso', 'third_party_idv');--> statement-breakpoint
CREATE TYPE "public"."share_legal_basis" AS ENUM('guardian_consent', 'institutional_delegate', 'formal_release_of_information');--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'consent_signed';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'consent_revoked';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'consent_re_signed';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'guardian_id_verified';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'minor_threshold_crossed';--> statement-breakpoint
ALTER TYPE "public"."activity_subject_type" ADD VALUE 'consent_record';--> statement-breakpoint
CREATE TABLE "student_consent_records" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"signed_by_contact_id" varchar NOT NULL,
	"country" text NOT NULL,
	"age_at_signing_years" integer NOT NULL,
	"is_minor_enhanced_protection" boolean DEFAULT false NOT NULL,
	"enhanced_protection_regime" text,
	"consent_text_version" text NOT NULL,
	"consent_text_hash" text NOT NULL,
	"purpose_acknowledged" boolean NOT NULL,
	"voluntariness_acknowledged" boolean NOT NULL,
	"third_party_transfers_acknowledged" boolean NOT NULL,
	"third_party_recipients" jsonb NOT NULL,
	"opt_in_model_training" boolean DEFAULT false NOT NULL,
	"opt_in_advertising" boolean DEFAULT false NOT NULL,
	"opt_in_third_party_research" boolean DEFAULT false NOT NULL,
	"opt_in_marketing_comms" boolean DEFAULT false NOT NULL,
	"opt_ins_forced_off" boolean DEFAULT false NOT NULL,
	"identity_verification_method" text NOT NULL,
	"identity_verification_evidence" jsonb NOT NULL,
	"non_repudiation_method" text NOT NULL,
	"non_repudiation_evidence" jsonb NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_from_ip" text,
	"signed_from_user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "government_id_number" text;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "government_id_type" "government_id_type";--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "government_id_country" text;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "government_id_verified_via" "id_verification_source";--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "government_id_verification_provider" text;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "government_id_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "is_legal_guardian" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "co_guardian_acknowledged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "student_contacts" ADD COLUMN "legal_guardian_declared_at" timestamp;--> statement-breakpoint
ALTER TABLE "student_share_invites" ADD COLUMN "legal_basis" "share_legal_basis" DEFAULT 'guardian_consent' NOT NULL;--> statement-breakpoint
ALTER TABLE "student_consent_records" ADD CONSTRAINT "student_consent_records_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_consent_records" ADD CONSTRAINT "student_consent_records_signed_by_contact_id_student_contacts_id_fk" FOREIGN KEY ("signed_by_contact_id") REFERENCES "public"."student_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_consent_records" ADD CONSTRAINT "student_consent_records_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_consent_records_student" ON "student_consent_records" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_consent_records_signed_by_contact" ON "student_consent_records" USING btree ("signed_by_contact_id");--> statement-breakpoint
CREATE INDEX "idx_consent_records_active" ON "student_consent_records" USING btree ("student_id") WHERE revoked_at IS NULL;