ALTER TABLE "licenses" ADD COLUMN "price_amount" integer;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "price_currency" text DEFAULT 'USD';--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "paddle_transaction_id" text;