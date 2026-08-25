-- Symbol generation is no longer a clinician choice.
--
-- The "Symbol Generation" section was removed from the AAC settings page, so
-- there is nothing left that can turn these flags back on. Any student whose
-- row still carries the old opt-out (the panel used to seed the toggles to
-- false, so a save from the old UI wrote false) would silently lose button
-- artwork forever. The column defaults are already `true` for new rows; this
-- brings the existing ones in line.
--
-- Idempotent and re-runnable: the WHERE clause makes a second run a no-op.
UPDATE "aac_settings"
SET "generate_symbols" = true,
    "use_approved_symbols" = true,
    "use_unapproved_symbols" = true
WHERE "generate_symbols" = false
   OR "use_approved_symbols" = false
   OR "use_unapproved_symbols" = false;
