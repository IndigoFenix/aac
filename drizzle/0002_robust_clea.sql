ALTER TABLE "chat_sessions" ALTER COLUMN "chat_mode" SET DATA TYPE varchar;--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "chat_mode" SET DEFAULT 'chat';--> statement-breakpoint
DROP TYPE "public"."chat_mode";