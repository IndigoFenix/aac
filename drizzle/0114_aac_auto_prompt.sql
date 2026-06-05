-- Migration 0114: aac_settings.auto_aac_prompt
--
-- Splits the per-student AAC prompt into two distinct fields. The existing
-- chat_agent_prompt now holds the CUSTOM prompt (specific behaviors caretakers
-- have explicitly requested — rigid, changed only on request). This new column
-- holds the AUTO prompt: a digest the clinician AI generates and keeps current
-- as it learns about the student ("what the AAC needs to know about this
-- student"). The custom prompt takes priority over the auto prompt, except
-- where it clashes with safety protocols. Both are written ONLY during
-- clinician interactions; the live AAC moderator can never write either.

ALTER TABLE "aac_settings" ADD COLUMN "auto_aac_prompt" text;
