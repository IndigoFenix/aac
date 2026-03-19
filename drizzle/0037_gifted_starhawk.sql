ALTER TABLE "licenses" ADD COLUMN "invite_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_licenses_invite_token" ON "licenses" USING btree ("invite_token");