CREATE TABLE "session_debug_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"seq" serial NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"section" text NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_debug_logs" ADD CONSTRAINT "session_debug_logs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_debug_logs_session_seq" ON "session_debug_logs" USING btree ("session_id","seq");