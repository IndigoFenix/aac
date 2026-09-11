ALTER TABLE "consent_invitations" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD COLUMN "purpose" text DEFAULT 'sign' NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD COLUMN "target_consent_id" varchar;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_target_consent_id_student_consent_records_id_fk" FOREIGN KEY ("target_consent_id") REFERENCES "public"."student_consent_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_consent_invitations_target_consent" ON "consent_invitations" USING btree ("target_consent_id");