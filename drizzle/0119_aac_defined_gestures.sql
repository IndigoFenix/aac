-- Defined student gestures: array of { name, description?, meaning }.
-- The AAC Observer agent treats a recognized gesture toward the device as a
-- button press voicing `meaning` (Speaker reply + Board Manager rebuild).
ALTER TABLE "aac_settings" ADD COLUMN "defined_gestures" jsonb DEFAULT '[]'::jsonb;
