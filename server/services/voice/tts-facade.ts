// server/services/voice/tts-facade.ts
// Routes TTS requests to the correct provider: ElevenLabs > Gemini > Google Cloud TTS

import { googleTtsService, type VoiceType } from "./google-tts-service";
import { geminiTtsService } from "./gemini-tts-service";
import { elevenlabsTtsService } from "./elevenlabs-tts-service";
import type { Voice } from "@shared/schema";

export interface ResolvedVoice {
  fallbackType: VoiceType; // man/woman/boy/girl — used when no custom voice
  customVoice: Voice | null; // from voices table — when set, use ElevenLabs
  language: string;
  elevenlabsApiKey?: string; // student-level ElevenLabs API key
  elevenlabsVoiceId?: string; // student-level ElevenLabs voice ID (direct, bypasses voices table)
  geminiVoiceName?: string; // Gemini prebuilt voice name (e.g. "Puck", "Kore")
}

/**
 * Synthesize text to a full audio buffer, routing to the correct TTS provider
 */
export async function synthesize(
  text: string,
  voice: ResolvedVoice
): Promise<Buffer> {
  // Student-level ElevenLabs voice (direct voice ID + API key)
  if (voice.elevenlabsVoiceId && voice.elevenlabsApiKey) {
    try {
      return await elevenlabsTtsService.synthesize(text, {
        voiceId: voice.elevenlabsVoiceId,
        apiKeyOverride: voice.elevenlabsApiKey,
        language: voice.language,
      });
    } catch (error: any) {
      console.error(
        `[TTSFacade] Student-level ElevenLabs failed (voice: ${voice.elevenlabsVoiceId}), falling back:`,
        error.message
      );
      // Fall through to admin custom voice or OpenAI
    }
  }

  // Admin-level custom voice from voices table
  if (voice.customVoice && voice.customVoice.active) {
    try {
      return await elevenlabsTtsService.synthesize(text, {
        voiceId: voice.customVoice.externalId,
        language: voice.language,
      });
    } catch (error: any) {
      console.error(
        `[TTSFacade] ElevenLabs failed for voice "${voice.customVoice.name}", falling back to OpenAI:`,
        error.message
      );
      // Fall through to OpenAI
    }
  }

  // Gemini voice configured — use Gemini TTS
  if (voice.geminiVoiceName) {
    try {
      return await geminiTtsService.synthesize(text, voice.language, {
        voiceName: voice.geminiVoiceName,
      });
    } catch (error: any) {
      console.error(`[TTSFacade] Gemini TTS failed (voice: ${voice.geminiVoiceName}), falling back to Google Cloud:`, error.message);
    }
  }

  return await googleTtsService.synthesize(text, voice.language, {
    voiceType: voice.fallbackType,
  });
}

/**
 * Synthesize text as a stream of audio chunks, routing to the correct TTS provider
 */
export async function* synthesizeStream(
  text: string,
  voice: ResolvedVoice
): AsyncGenerator<Buffer> {
  // Student-level ElevenLabs voice (direct voice ID + API key)
  if (voice.elevenlabsVoiceId && voice.elevenlabsApiKey) {
    try {
      yield* elevenlabsTtsService.synthesizeStream(text, {
        voiceId: voice.elevenlabsVoiceId,
        apiKeyOverride: voice.elevenlabsApiKey,
        language: voice.language,
      });
      return;
    } catch (error: any) {
      console.error(
        `[TTSFacade] Student-level ElevenLabs streaming failed (voice: ${voice.elevenlabsVoiceId}), falling back:`,
        error.message
      );
      // Fall through to admin custom voice or OpenAI
    }
  }

  // Admin-level custom voice from voices table
  if (voice.customVoice && voice.customVoice.active) {
    try {
      yield* elevenlabsTtsService.synthesizeStream(text, {
        voiceId: voice.customVoice.externalId,
        language: voice.language,
      });
      return;
    } catch (error: any) {
      console.error(
        `[TTSFacade] ElevenLabs streaming failed for voice "${voice.customVoice.name}", falling back to OpenAI:`,
        error.message
      );
      // Fall through to OpenAI
    }
  }

  // Gemini voice configured — use Gemini TTS
  if (voice.geminiVoiceName) {
    try {
      yield* geminiTtsService.synthesizeStream(text, voice.language, {
        voiceName: voice.geminiVoiceName,
      });
      return;
    } catch (error: any) {
      console.error(`[TTSFacade] Gemini TTS streaming failed (voice: ${voice.geminiVoiceName}), falling back to Google Cloud:`, error.message);
    }
  }

  yield* googleTtsService.synthesizeStream(text, voice.language, {
    voiceType: voice.fallbackType,
  });
}

export const ttsFacade = {
  synthesize,
  synthesizeStream,
};
