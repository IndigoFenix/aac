-- Migration 0112: aac_settings.single_glyph_buttons
--
-- Per-student toggle that constrains AI-generated buttons to a single GLYPH
-- each (modifiers still allowed). When on, the live system prompt, tool
-- descriptions, and prompt enhancer strip every `+`-joined SENTENCE example
-- so the model never sees a multi-glyph button shape. The sentence builder
-- and interpret() path are unaffected.

ALTER TABLE "aac_settings" ADD COLUMN "single_glyph_buttons" boolean DEFAULT false NOT NULL;
