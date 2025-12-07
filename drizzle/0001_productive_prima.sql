CREATE TYPE "public"."chat_mode" AS ENUM('none', 'board', 'interpret');--> statement-breakpoint
CREATE TYPE "public"."chat_session_status" AS ENUM('open', 'paused', 'closed');--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"aac_user_id" varchar,
	"user_aac_user_id" varchar,
	"chat_mode" "chat_mode" DEFAULT 'none' NOT NULL,
	"started" timestamp DEFAULT now() NOT NULL,
	"last_update" timestamp DEFAULT now() NOT NULL,
	"state" jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp,
	"credits_used" real DEFAULT 0 NOT NULL,
	"priority" real DEFAULT 0 NOT NULL,
	"status" "chat_session_status" DEFAULT 'open' NOT NULL,
	"use_responses_api" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "chat_memory" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "chat_credits_used" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "aac_users" ADD COLUMN "chat_credits_updated" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_aac_users" ADD COLUMN "chat_memory" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "user_aac_users" ADD COLUMN "chat_credits_used" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_aac_users" ADD COLUMN "chat_credits_updated" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_memory" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_credits_used" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_credits_updated" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_aac_user_id_aac_users_id_fk" FOREIGN KEY ("aac_user_id") REFERENCES "public"."aac_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_aac_user_id_user_aac_users_id_fk" FOREIGN KEY ("user_aac_user_id") REFERENCES "public"."user_aac_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_user_id" ON "chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_aac_user_id" ON "chat_sessions" USING btree ("aac_user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_status" ON "chat_sessions" USING btree ("status");