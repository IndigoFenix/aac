-- Migration 0121: aac_settings prompt fields → jsonb arrays of rules
--
-- The two per-student AAC prompt fields (chat_agent_prompt = CUSTOM,
-- auto_aac_prompt = AUTO) were single free-text columns. Because each was one
-- string, the clinician AI rewrote the WHOLE field with a `set` whenever it
-- wanted to add one instruction, silently discarding everything else.
--
-- They are now jsonb ARRAYS of strings — one entry per request/note — so the
-- AI appends (`add`) and only removes (`delete`) an entry when a newer one
-- contradicts it or it becomes irrelevant.
--
-- Existing non-empty text is preserved as a single-element array; empty/null
-- becomes an empty array. Runtime readers also normalize string | string[]
-- defensively for any stale values arriving from device external storage.

ALTER TABLE "aac_settings"
  ALTER COLUMN "chat_agent_prompt" TYPE jsonb USING (
    CASE
      WHEN "chat_agent_prompt" IS NULL OR btrim("chat_agent_prompt") = ''
        THEN '[]'::jsonb
      ELSE jsonb_build_array("chat_agent_prompt")
    END
  );

ALTER TABLE "aac_settings"
  ALTER COLUMN "auto_aac_prompt" TYPE jsonb USING (
    CASE
      WHEN "auto_aac_prompt" IS NULL OR btrim("auto_aac_prompt") = ''
        THEN '[]'::jsonb
      ELSE jsonb_build_array("auto_aac_prompt")
    END
  );
