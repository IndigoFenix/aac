CREATE TABLE "session_cost_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"category" text NOT NULL,
	"credits" real NOT NULL,
	"model" varchar,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer,
	"cache_creation_tokens" integer,
	"label" text
);
--> statement-breakpoint
ALTER TABLE "session_cost_events" ADD CONSTRAINT "session_cost_events_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_session_cost_events_session_ts" ON "session_cost_events" USING btree ("session_id","timestamp");