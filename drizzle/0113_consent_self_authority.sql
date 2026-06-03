-- Migration 0113: per-student consent authority (guardian vs. self) + self-consent path.
--
-- Distinguishes students who need parental approval from those who don't. The
-- default is age-of-majority based (guardian below, self at/above); the
-- consent_authority override handles an adult under legal guardianship
-- ("guardian_required" + a documented guardianship_basis) or a self-consenting
-- minor ("self"). Consent records and invitations gain a signer/recipient type
-- so a student can sign for themselves (no guardian contact).
-- See planning-docs/student-consent-onboarding-plan.md.

-- students: consent-authority determination
ALTER TABLE "students" ADD COLUMN "consent_authority" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "guardianship_basis" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "guardianship_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "guardianship_review_date" date;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "consent_authority_set_by_user_id" varchar;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "consent_authority_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_consent_authority_set_by_user_id_users_id_fk" FOREIGN KEY ("consent_authority_set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- student_consent_records: signer type + self-sign support
ALTER TABLE "student_consent_records" ALTER COLUMN "signed_by_contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "student_consent_records" ADD COLUMN "signer_type" text DEFAULT 'guardian' NOT NULL;--> statement-breakpoint
ALTER TABLE "student_consent_records" ADD COLUMN "signed_by_user_id" varchar;--> statement-breakpoint
ALTER TABLE "student_consent_records" ADD COLUMN "consent_authority_basis" text;--> statement-breakpoint
ALTER TABLE "student_consent_records" ADD CONSTRAINT "student_consent_records_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- consent_invitations: recipient type + self-invitation support
ALTER TABLE "consent_invitations" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD COLUMN "recipient_type" text DEFAULT 'guardian' NOT NULL;--> statement-breakpoint

-- activity-log event types for the consent-authority lifecycle
ALTER TYPE "public"."activity_event_type" ADD VALUE 'consent_authority_set';--> statement-breakpoint
ALTER TYPE "public"."activity_event_type" ADD VALUE 'consent_authority_review_required';
