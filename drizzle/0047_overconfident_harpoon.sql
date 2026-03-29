CREATE TYPE "public"."contact_message_type" AS ENUM('contact', 'bug_report', 'support_request');--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "message_type" "contact_message_type" DEFAULT 'contact' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "user_id" varchar;--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD CONSTRAINT "contact_inquiries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contact_inquiries_message_type" ON "contact_inquiries" USING btree ("message_type");