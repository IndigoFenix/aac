ALTER TABLE "chat_sessions" ADD COLUMN "cost_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL;
