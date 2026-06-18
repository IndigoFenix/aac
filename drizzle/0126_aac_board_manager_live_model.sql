-- Migration 0126: aac_settings.board_manager_live_model
--
-- Experimental per-student toggle. When ON, the Board Manager agent runs on a
-- Gemini Live session (warm, TEXT modality + function calling) instead of
-- stateless HTTP completions, to test board-generation latency. Behavior is
-- identical; live text rates are higher, so this trades cost for latency.
-- Cost is billed accurately under the "board-manager" bucket at the live
-- model's rates. Off by default. See server/services/dual-agent/live-board-manager-agent.ts.
ALTER TABLE "aac_settings" ADD COLUMN IF NOT EXISTS "board_manager_live_model" boolean DEFAULT false NOT NULL;
