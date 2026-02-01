ALTER TABLE "chat_sessions" ADD COLUMN "pending_messages" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "interactive_prompt" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "monitor_busy" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "thinking_mode" boolean DEFAULT false;