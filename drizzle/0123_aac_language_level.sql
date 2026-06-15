-- Migration 0123: aac_settings.language_level
--
-- General AAC "language level" — how long/complex the AI's sentences are,
-- matched to the student's receptive language. Integer 1..5 mapping to the
-- LANGUAGE_LEVELS tiers in shared/aac-language-level.ts
-- (1=single_words, 2=short_phrases, 3=simple_sentences, 4=full_sentences,
-- 5=complex). Default 4 = full_sentences (current behavior — a no-op backfill).
-- Drives both the companion Speaker's register and the social-trainer peer's
-- default. Sentence-length focused; no separate vocabulary dial.

ALTER TABLE "aac_settings" ADD COLUMN "language_level" integer DEFAULT 4 NOT NULL;
