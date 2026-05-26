-- Migration 0110: email-channel secondary-factor gate for consent invitations.
--
-- Adds a knowledge-based verification leg for the email path: the parent must
-- enter the last 4 digits of the child's institute ID before signing. This is
-- the email analogue of the SMS phone-OTP gate. id_verify_attempts caps brute
-- force; once exhausted the gate locks until the clinician re-issues the link.
ALTER TABLE "consent_invitations" ADD COLUMN "id_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD COLUMN "id_verify_attempts" integer DEFAULT 0 NOT NULL;
