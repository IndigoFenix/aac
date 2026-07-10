-- Migration 0142: session_cost_events (per-charge cost time-series)
--
-- The aggregate columns on chat_sessions (credits_used, cost_breakdown,
-- cost_modality_breakdown) only tell you the running TOTAL for a session. This
-- table records ONE ROW PER CREDIT CHARGE as it lands in the ledger, timestamped,
-- so admins can reconstruct how a session's spend accrued OVER TIME (per turn /
-- per interval), not just the final number.
--
-- Written unconditionally from server/services/credit-ledger.ts
-- (chargeCreditsToLedger) — unlike session_debug_logs it is NOT gated on
-- debugMode, so normal production sessions are covered. Token columns are
-- populated for model-usage charges and left null for character-billed charges
-- (TTS/STT). For Live-API turns the per-modality tokens are folded into
-- prompt (input) / completion (output).
--
-- Higher-volume than the aggregate columns: it cascades on session delete and is
-- pruned alongside session_debug_logs by the admin "delete old logs" action.
CREATE TABLE IF NOT EXISTS "session_cost_events" (
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
ALTER TABLE "session_cost_events"
  ADD CONSTRAINT "session_cost_events_session_id_chat_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id")
  ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_cost_events_session_ts"
  ON "session_cost_events" ("session_id", "timestamp");
