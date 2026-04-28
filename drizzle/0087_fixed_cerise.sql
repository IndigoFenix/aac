CREATE TABLE "consent_invitations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"contact_id" varchar NOT NULL,
	"source_institute_id" varchar,
	"code_hash" text NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"channel" text NOT NULL,
	"sent_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"signed_consent_id" varchar,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_contact_id_student_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."student_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_signed_consent_id_student_consent_records_id_fk" FOREIGN KEY ("signed_consent_id") REFERENCES "public"."student_consent_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_invitations" ADD CONSTRAINT "consent_invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_consent_invitations_student" ON "consent_invitations" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_consent_invitations_contact" ON "consent_invitations" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_consent_invitations_code_hash" ON "consent_invitations" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_consent_invitations_pending" ON "consent_invitations" USING btree ("student_id") WHERE redeemed_at IS NULL AND revoked_at IS NULL;