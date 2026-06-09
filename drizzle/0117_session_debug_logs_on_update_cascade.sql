-- Migration 0117: session_debug_logs FK ON UPDATE CASCADE
--
-- Lets chat_sessions.id be re-keyed without orphaning debug-log rows. The AAC
-- backfill (scripts/fix-aac-session-ids.ts) rewrites legacy aac-<timestamp>
-- session ids to UUIDs; with ON UPDATE CASCADE the parent-id change propagates
-- automatically to session_debug_logs.session_id instead of violating the FK.

ALTER TABLE "session_debug_logs" DROP CONSTRAINT "session_debug_logs_session_id_chat_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "session_debug_logs" ADD CONSTRAINT "session_debug_logs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE cascade;
