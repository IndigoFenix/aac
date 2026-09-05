CREATE TABLE "paddle_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "credit_packages" ADD COLUMN "paddle_price_id" text;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "paddle_customer_id" text;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "paddle_subscription_id" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "paddle_price_id" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "license_type" text;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
CREATE INDEX "idx_paddle_events_event_type" ON "paddle_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_paddle_events_occurred_at" ON "paddle_events" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "credit_packages" ADD CONSTRAINT "credit_packages_paddle_price_id_unique" UNIQUE("paddle_price_id");--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_paddle_price_id_unique" UNIQUE("paddle_price_id");