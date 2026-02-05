// server/services/voice/tts-facade.ts
// Routes TTS requests to the correct provider (OpenAI fallback or ElevenLabs custom)

import { openaiTtsService, type VoiceType } from "./openai-tts-service";
import { elevenlabsTtsService } from "./elevenlabs-tts-service";
import type { Voice } from "@shared/schema";

export interface ResolvedVoice {
  fallbackType: VoiceType; // man/woman/boy/girl — used when no custom voice
  customVoice: Voice | null; // from voices table — when set, use ElevenLabs
  language: string;
}

/**
 * Synthesize text to a full audio buffer, routing to the correct TTS provider
 */
export async function synthesize(
  text: string,
  voice: ResolvedVoice
): Promise<Buffer> {
  if (voice.customVoice && voice.customVoice.active) {
    try {
      return await elevenlabsTtsService.synthesize(text, {
        voiceId: voice.customVoice.externalId,
      });
    } catch (error: any) {
      console.error(
        `[TTSFacade] ElevenLabs failed for voice "${voice.customVoice.name}", falling back to OpenAI:`,
        error.message
      );
      // Fall through to OpenAI
    }
  }

  return await openaiTtsService.synthesize(text, voice.language, {
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
  if (voice.customVoice && voice.customVoice.active) {
    try {
      yield* elevenlabsTtsService.synthesizeStream(text, {
        voiceId: voice.customVoice.externalId,
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

  yield* openaiTtsService.synthesizeStream(text, voice.language, {
    voiceType: voice.fallbackType,
  });
}

export const ttsFacade = {
  synthesize,
  synthesizeStream,
};
