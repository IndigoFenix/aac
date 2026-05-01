CREATE TABLE "crm_potential_customers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"country_code" varchar(2),
	"region" text,
	"chat_memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "crm_potential_customer_id" varchar;--> statement-breakpoint
CREATE INDEX "idx_crm_potential_customers_ip_hash" ON "crm_potential_customers" USING btree ("ip_hash");--> statement-breakpoint
CREATE INDEX "idx_crm_potential_customers_last_seen_at" ON "crm_potential_customers" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_crm_potential_customers_is_blocked" ON "crm_potential_customers" USING btree ("is_blocked");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_crm_customer" ON "chat_sessions" USING btree ("crm_potential_customer_id");