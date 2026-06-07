-- Migration 0115: chat_sessions.title_manual
--
-- Marks a session whose title was set manually by a clinician (rename). The
-- session summarizer (sessionSummary.ts) then refreshes summary/importance on
-- close but never overwrites a human-chosen title.

ALTER TABLE "chat_sessions" ADD COLUMN "title_manual" boolean DEFAULT false NOT NULL;
