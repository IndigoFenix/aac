// server/services/voice/tts-facade.ts
// Routes TTS requests to the correct provider: ElevenLabs > Gemini > Google Cloud TTS

import { googleTtsService, type VoiceType } from "./google-tts-service";
import { geminiTtsService } from "./gemini-tts-service";
import { elevenlabsTtsService } from "./elevenlabs-tts-service";
import type { GeminiLiveTtsSession } from "./gemini-live-tts-service";
import type { Voice } from "@shared/schema";
import type { TtsProvider } from "../chat/cost-helpers";

export type { TtsProvider } from "../chat/cost-helpers";

/** Per-synthesis usage report — fired exactly once per call after the
 *  facade has committed to a provider (and the request has not been
 *  fallen-through to the next branch). Callers wire this to credit
 *  tracking. Characters = input text length. */
export interface TtsUsageReport {
  provider: TtsProvider;
  characters: number;
}

export interface ResolvedVoice {
  fallbackType: VoiceType; // man/woman/boy/girl — used when no custom voice
  customVoice: Voice | null; // from voices table — when set, use ElevenLabs
  language: string;
  elevenlabsApiKey?: string; // student-level ElevenLabs API key
  elevenlabsVoiceId?: string; // student-level ElevenLabs voice ID (direct, bypasses voices table)
  geminiVoiceName?: string; // Gemini prebuilt voice name (e.g. "Puck", "Kore")
  // Persistent Gemini Live TTS session owned by the caller (e.g. LiveRelay).
  // When set, streaming TTS goes through this session — no per-call HTTP
  // connection overhead. Ignored by synthesize() (buffered path).
  geminiLiveSession?: GeminiLiveTtsSession;
}

/**
 * Synthesize text to a full audio buffer, routing to the correct TTS provider.
 * Reports the resolved provider + char count via `onUsage` after the chosen
 * branch returns successfully (used for credit tracking).
 */
export async function synthesize(
  text: string,
  voice: ResolvedVoice,
  onUsage?: (usage: TtsUsageReport) => void,
): Promise<Buffer> {
  const chars = text.length;
  // Student-level ElevenLabs voice (direct voice ID + API key)
  if (voice.elevenlabsVoiceId && voice.elevenlabsApiKey) {
    try {
      const buf = await elevenlabsTtsService.synthesize(text, {
        voiceId: voice.elevenlabsVoiceId,
        apiKeyOverride: voice.elevenlabsApiKey,
        language: voice.language,
      });
      onUsage?.({ provider: "elevenlabs", characters: chars });
      return buf;
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
      const buf = await elevenlabsTtsService.synthesize(text, {
        voiceId: voice.customVoice.externalId,
        language: voice.language,
      });
      onUsage?.({ provider: "elevenlabs", characters: chars });
      return buf;
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
      const buf = await geminiTtsService.synthesize(text, voice.language, {
        voiceName: voice.geminiVoiceName,
      });
      onUsage?.({ provider: "gemini", characters: chars });
      return buf;
    } catch (error: any) {
      console.error(`[TTSFacade] Gemini TTS failed (voice: ${voice.geminiVoiceName}), falling back to Google Cloud:`, error.message);
    }
  }

  const buf = await googleTtsService.synthesize(text, voice.language, {
    voiceType: voice.fallbackType,
  });
  onUsage?.({ provider: "google", characters: chars });
  return buf;
}

/**
 * Synthesize text as a stream of audio chunks, routing to the correct TTS provider.
 * If `signal` is provided, the persistent Gemini Live session honors it for
 * mid-stream cancellation — other providers don't currently support cancel.
 *
 * `onUsage` fires once for the branch that produced audio (after the
 * generator finishes successfully). Fallback chains report only the final
 * provider, not the failed branches. Aborted streams report nothing —
 * we don't know how many chars actually rendered before the abort, so
 * billing 0 is the honest default.
 */
export async function* synthesizeStream(
  text: string,
  voice: ResolvedVoice,
  signal?: AbortSignal,
  onUsage?: (usage: TtsUsageReport) => void,
): AsyncGenerator<Buffer> {
  const chars = text.length;
  // Student-level ElevenLabs voice (direct voice ID + API key)
  if (voice.elevenlabsVoiceId && voice.elevenlabsApiKey) {
    try {
      yield* elevenlabsTtsService.synthesizeStream(text, {
        voiceId: voice.elevenlabsVoiceId,
        apiKeyOverride: voice.elevenlabsApiKey,
        language: voice.language,
      });
      onUsage?.({ provider: "elevenlabs", characters: chars });
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
      onUsage?.({ provider: "elevenlabs", characters: chars });
      return;
    } catch (error: any) {
      console.error(
        `[TTSFacade] ElevenLabs streaming failed for voice "${voice.customVoice.name}", falling back to OpenAI:`,
        error.message
      );
      // Fall through to OpenAI
    }
  }

  // Persistent Gemini Live session — preferred for student voice (no
  // per-call connection overhead, native Gemini voice quality)
  if (voice.geminiLiveSession) {
    try {
      yield* voice.geminiLiveSession.synthesizeStream(text, signal);
      if (!signal?.aborted) onUsage?.({ provider: "gemini-live", characters: chars });
      return;
    } catch (error: any) {
      if (signal?.aborted) return;
      console.error(`[TTSFacade] Gemini Live TTS streaming failed, falling back:`, error.message);
    }
  }

  // Gemini voice configured — use Gemini TTS
  if (voice.geminiVoiceName) {
    try {
      yield* geminiTtsService.synthesizeStream(text, voice.language, {
        voiceName: voice.geminiVoiceName,
      });
      onUsage?.({ provider: "gemini", characters: chars });
      return;
    } catch (error: any) {
      console.error(`[TTSFacade] Gemini TTS streaming failed (voice: ${voice.geminiVoiceName}), falling back to Google Cloud:`, error.message);
    }
  }

  yield* googleTtsService.synthesizeStream(text, voice.language, {
    voiceType: voice.fallbackType,
  });
  onUsage?.({ provider: "google", characters: chars });
}

export const ttsFacade = {
  synthesize,
  synthesizeStream,
};
