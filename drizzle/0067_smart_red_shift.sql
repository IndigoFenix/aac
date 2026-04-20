ALTER TABLE "chat_sessions" ADD COLUMN "institute_id" varchar;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "institute_user_id" varchar;--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_institute_id" ON "chat_sessions" USING btree ("institute_id");