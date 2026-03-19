ALTER TABLE "licenses" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "invite_email" text;--> statement-breakpoint
CREATE INDEX "idx_licenses_invite_email" ON "licenses" USING btree ("invite_email");