-- Experiment: glyph input translation.
-- When on, text directed at the student (AI replies + heard speech) is mirrored
-- back as a glyph strip in the AAC header; the Board Manager fills
-- rebuild_board's `input_glyphs` param with that translation. Clinician-only.
ALTER TABLE "aac_settings" ADD COLUMN "glyph_input_translation" boolean DEFAULT false NOT NULL;
