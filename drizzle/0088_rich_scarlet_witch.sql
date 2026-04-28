CREATE TABLE "phone_otp_codes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"scope_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"consumed_at" timestamp with time zone,
	"send_count" integer DEFAULT 0 NOT NULL,
	"last_provider_message_id" text,
	"last_provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_phone_otp_codes_active" ON "phone_otp_codes" USING btree ("purpose","scope_id","phone") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_phone_otp_codes_expires_at" ON "phone_otp_codes" USING btree ("expires_at");