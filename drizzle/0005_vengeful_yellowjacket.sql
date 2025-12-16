ALTER TABLE "prompt_history" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "prompt_history" CASCADE;--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "ir_data" jsonb;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "loaded_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "api_calls" DROP COLUMN "prompt_id";