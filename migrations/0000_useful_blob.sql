CREATE TABLE "aac_user_schedules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aac_user_id" text NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"activity_name" text NOT NULL,
	"topic_tags" text[],
	"is_repeating_weekly" boolean DEFAULT true NOT NULL,
	"date_override" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aac_users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"aac_user_id" text NOT NULL,
	"alias" text NOT NULL,
	"gender" text,
	"age" integer,
	"disability_or_syndrome" text,
	"background_context" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "aac_users_aac_user_id_unique" UNIQUE("aac_user_id")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" varchar PRIMARY KEY NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"role" text DEFAULT 'admin',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "analytics_aggregates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_date" varchar NOT NULL,
	"aggregate_type" text NOT NULL,
	"total_prompts" integer DEFAULT 0,
	"total_boards" integer DEFAULT 0,
	"total_pages" integer DEFAULT 0,
	"total_downloads" integer DEFAULT 0,
	"unique_users" integer DEFAULT 0,
	"success_rate" integer DEFAULT 0,
	"avg_processing_time" integer DEFAULT 0,
	"avg_pages_per_board" integer DEFAULT 0,
	"topic_breakdown" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "api_calls" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" varchar NOT NULL,
	"endpoint" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"tokens_used" integer,
	"units_used" integer,
	"cost_usd" numeric(20, 6) NOT NULL,
	"response_time_ms" integer,
	"user_id" varchar,
	"session_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"prompt_id" varchar
);
--> statement-breakpoint
CREATE TABLE "api_provider_pricing" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"endpoint" text,
	"pricing_type" text NOT NULL,
	"input_price_per_unit" varchar(20),
	"output_price_per_unit" varchar(20),
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_until" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "api_providers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency_code" text DEFAULT 'USD' NOT NULL,
	"pricing_json" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"ir_data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "credit_packages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"credits" integer NOT NULL,
	"price" real NOT NULL,
	"bonus_credits" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"amount" integer NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"related_interpretation_id" varchar,
	"stripe_payment_intent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dropbox_backups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"board_name" text NOT NULL,
	"file_type" text NOT NULL,
	"file_name" text NOT NULL,
	"dropbox_path" text NOT NULL,
	"dropbox_file_id" text,
	"shareable_url" text,
	"file_size_bytes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"upload_duration_ms" integer,
	"is_auto_backup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "dropbox_connections" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"dropbox_account_id" text NOT NULL,
	"dropbox_email" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"token_expires_at" timestamp NOT NULL,
	"backup_folder_path" text DEFAULT '/Apps/SyntAACx/Backups' NOT NULL,
	"auto_backup_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "interpretations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"original_input" text NOT NULL,
	"interpreted_meaning" text NOT NULL,
	"analysis" text[] NOT NULL,
	"confidence" real NOT NULL,
	"suggested_response" text NOT NULL,
	"input_type" text NOT NULL,
	"language" text DEFAULT 'he',
	"context" text,
	"image_data" text,
	"aac_user_id" text,
	"aac_user_alias" text,
	"caregiver_feedback" text,
	"aac_user_wpm" real,
	"schedule_activity" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_code_redemptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_code_id" varchar NOT NULL,
	"redeemed_by_user_id" varchar NOT NULL,
	"aac_user_id" text NOT NULL,
	"redeemed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"aac_user_id" text NOT NULL,
	"redemption_limit" integer DEFAULT 1,
	"times_redeemed" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "plan_changes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"from_plan" text,
	"to_plan" text NOT NULL,
	"change_type" text NOT NULL,
	"change_reason" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar NOT NULL,
	"name" text NOT NULL,
	"monthly_generations" integer NOT NULL,
	"monthly_downloads" integer NOT NULL,
	"stored_boards" integer NOT NULL,
	"features" jsonb DEFAULT '{}',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "prompt_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"event_data" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "prompt_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"prompt" text NOT NULL,
	"prompt_excerpt" text,
	"topic" text,
	"language" text DEFAULT 'en',
	"model" text DEFAULT 'gemini-2.5-flash',
	"output_format" text DEFAULT 'gridset',
	"generated_board_name" text,
	"generated_board_id" varchar,
	"pages_generated" integer DEFAULT 1,
	"prompt_length" integer,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"error_type" text,
	"processing_time_ms" integer,
	"downloaded" boolean DEFAULT false,
	"downloaded_at" timestamp,
	"user_feedback" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "revenuecat_products" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"package_type" text,
	"entitlement_ids" text[],
	"credits_granted" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"price" real,
	"currency" text DEFAULT 'USD',
	"duration" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "revenuecat_products_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "revenuecat_subscriptions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"revenuecat_app_user_id" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"product_id" text NOT NULL,
	"entitlement_ids" text[],
	"purchase_date" timestamp NOT NULL,
	"expiration_date" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"environment" text NOT NULL,
	"store" text NOT NULL,
	"price" real,
	"currency" text DEFAULT 'USD',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "revenuecat_subscriptions_original_transaction_id_unique" UNIQUE("original_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "revenuecat_webhook_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"revenuecat_app_user_id" text NOT NULL,
	"original_transaction_id" text,
	"product_id" text,
	"entitlement_ids" text[],
	"event_timestamp" timestamp NOT NULL,
	"environment" text NOT NULL,
	"price" real,
	"currency" text,
	"raw_payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_locations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"alias" text NOT NULL,
	"location_type" text NOT NULL,
	"location_name" text NOT NULL,
	"latitude" real,
	"longitude" real,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"price" real NOT NULL,
	"credits" integer NOT NULL,
	"duration" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"features" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "system_prompt" (
	"id" varchar PRIMARY KEY DEFAULT 'system_prompt' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	"updated_by" varchar
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "system_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "usage_windows" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"window_start" timestamp NOT NULL,
	"generations" integer DEFAULT 0,
	"downloads" integer DEFAULT 0,
	"stored_boards" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_cohorts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_period" varchar NOT NULL,
	"cohort_type" text NOT NULL,
	"total_users" integer NOT NULL,
	"retention_data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"session_id" varchar,
	"event_type" text NOT NULL,
	"event_category" text NOT NULL,
	"event_data" jsonb,
	"feature_tags" jsonb DEFAULT '[]',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"session_start" timestamp NOT NULL,
	"session_end" timestamp,
	"duration_ms" integer,
	"platform" text DEFAULT 'web',
	"user_agent" text,
	"ip_address" text,
	"country" text,
	"region" text,
	"acquisition_source" text,
	"campaign_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"google_id" text,
	"profile_image_url" text,
	"password" text,
	"auth_provider" text DEFAULT 'email',
	"user_type" text DEFAULT 'Caregiver' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"credits" integer DEFAULT 10 NOT NULL,
	"subscription_type" text DEFAULT 'free',
	"subscription_expires_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_active_at" timestamp DEFAULT now(),
	"onboarding_step" integer DEFAULT 0 NOT NULL,
	"referral_code" text,
	"referred_by_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"gen_cap_override" integer,
	"dl_cap_override" integer,
	"stored_boards_cap" integer,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id"),
	CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
ALTER TABLE "aac_user_schedules" ADD CONSTRAINT "aac_user_schedules_aac_user_id_aac_users_aac_user_id_fk" FOREIGN KEY ("aac_user_id") REFERENCES "public"."aac_users"("aac_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aac_users" ADD CONSTRAINT "aac_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_provider_id_api_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."api_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_related_interpretation_id_interpretations_id_fk" FOREIGN KEY ("related_interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropbox_backups" ADD CONSTRAINT "dropbox_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dropbox_connections" ADD CONSTRAINT "dropbox_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_aac_user_id_aac_users_aac_user_id_fk" FOREIGN KEY ("aac_user_id") REFERENCES "public"."aac_users"("aac_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "public"."invite_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_aac_user_id_aac_users_aac_user_id_fk" FOREIGN KEY ("aac_user_id") REFERENCES "public"."aac_users"("aac_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_aac_user_id_aac_users_aac_user_id_fk" FOREIGN KEY ("aac_user_id") REFERENCES "public"."aac_users"("aac_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenuecat_subscriptions" ADD CONSTRAINT "revenuecat_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_locations" ADD CONSTRAINT "saved_locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_prompt" ADD CONSTRAINT "system_prompt_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_id_users_id_fk" FOREIGN KEY ("referred_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");