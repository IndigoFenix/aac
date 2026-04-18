CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "deep_analyses" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" varchar NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"model" varchar NOT NULL,
	"special_instructions" text,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"title" text,
	"summary" text,
	"report_markdown" text,
	"error" text,
	"thinking_tokens" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "deep_analyses" ADD CONSTRAINT "deep_analyses_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_analyses" ADD CONSTRAINT "deep_analyses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deep_analyses_student_id" ON "deep_analyses" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "idx_deep_analyses_created_at" ON "deep_analyses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_chat_mode_created" ON "chat_sessions" USING btree ("chat_mode","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_sessions_summary_trgm" ON "chat_sessions" USING gin ((coalesce("title",'') || ' ' || coalesce("summary",'')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_deep_analyses_summary_trgm" ON "deep_analyses" USING gin ((coalesce("title",'') || ' ' || coalesce("summary",'')) gin_trgm_ops);