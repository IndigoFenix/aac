-- Migration 0116: aac_settings.live_audio_speaker
--
-- Per-student opt-in to the Gemini Live native-audio Speaker path. When OFF
-- (the default) the Speaker runs as an HTTP completion + streaming TTS
-- (cheap, robust tool calling). When ON, the Coordinator instantiates the
-- legacy Gemini Live SpeakerAgent so the model speaks directly via native
-- audio. The ElevenLabs voice configuration is independent of this toggle:
-- when live audio is on the AI voice comes from Gemini (so the ElevenLabs
-- AI voice picker is hidden in the settings UI), but the student-press TTS
-- still uses whatever voice ElevenLabs is configured for.

ALTER TABLE "aac_settings" ADD COLUMN "live_audio_speaker" boolean DEFAULT false NOT NULL;
