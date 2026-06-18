-- Migration 0125: aac_settings.full_attention_mode
--
-- Per-student perception/cost dial. When ON, the AAC streams camera + mic to
-- the live model continuously while awake (heartbeat frame every ~15s plus
-- continuous audio). When OFF (the default), the client applies the resting
-- input filter even while awake — no heartbeat frames and VAD-gated mic, so
-- only motion frames and actual speech/sound stream. Off by default to save
-- live-API I/O cost. Surfaced to the client as the inverse `awakeDataSaver`
-- flag in the session `clientConfig`.
ALTER TABLE "aac_settings" ADD COLUMN "full_attention_mode" boolean DEFAULT false NOT NULL;
