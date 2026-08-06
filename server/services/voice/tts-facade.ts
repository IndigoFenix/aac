// server/services/voice/tts-facade.ts
// Routes TTS requests to the correct provider: ElevenLabs > Gemini > Google Cloud TTS

import { googleTtsService, type VoiceType } from "./google-tts-service";
// geminiTtsService is kept available for future use; not part of the
// active route. See the comment in synthesize/synthesizeStream below.
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
  /** Natural-language style hint for Chirp 3 HD voices (Google TTS).
   *  Adds warmth/intonation control without changing the voice itself.
   *  Ignored on non-Chirp paths. */
  prompt?: string;
  // Persistent Gemini Live TTS session owned by the caller (e.g. LiveRelay).
  // When set, streaming TTS goes through this session — no per-call HTTP
  // connection overhead. Ignored by synthesize() (buffered path).
  geminiLiveSession?: GeminiLiveTtsSession;
}

/**
 * Drop ElevenLabs API keys that the API is guaranteed to reject. ElevenLabs
 * retired its legacy key format — every live key starts with "sk_", and the
 * API refuses anything else outright ("API key must start with 'sk_'"). A
 * stale stored key would otherwise fail EVERY synthesis: a wasted round trip
 * per press on the server path, and dead silence on the client-direct path.
 * Voice resolvers run stored keys through this so the rest of the stack
 * simply sees "no student key" and uses the fallback providers.
 */
export function sanitizeElevenLabsApiKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  if (!key.startsWith("sk_")) {
    console.warn(
      `[TTSFacade] Ignoring stored ElevenLabs API key (…${key.slice(-4)}): legacy format the API no longer accepts.`,
    );
    return undefined;
  }
  return key;
}

/**
 * True when this voice can be synthesized BY THE CLIENT: the student supplied
 * their own ElevenLabs key and voice ID, so handing those to the device costs
 * only that family's own quota.
 *
 * The shared/admin key (`customVoice` → env ELEVENLABS_API_KEY) deliberately
 * fails this check — it must never leave the server. A key in the retired
 * pre-"sk_" format also fails it: the client has no fallback provider of its
 * own, so a known-dead key must stay on the server path where the facade can
 * fall through to Google.
 */
export function isClientSideTtsVoice(voice: ResolvedVoice): boolean {
  return !!(sanitizeElevenLabsApiKey(voice.elevenlabsApiKey) && voice.elevenlabsVoiceId);
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
  const studentKey = sanitizeElevenLabsApiKey(voice.elevenlabsApiKey);
  // Student-level ElevenLabs voice (direct voice ID + API key)
  if (voice.elevenlabsVoiceId && studentKey) {
    try {
      const buf = await elevenlabsTtsService.synthesize(text, {
        voiceId: voice.elevenlabsVoiceId,
        apiKeyOverride: studentKey,
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

  // Gemini TTS (`gemini-2.5-flash-preview-tts` via HTTP) supports a
  // style prompt but is slower than Chirp 3 HD and burns Gemini quota
  // fast. Currently disabled — kept here behind `force-gemini-tts`
  // (unused for now) for future experimentation. The default Google
  // Chirp 3 HD path delivers the same voice names with sub-second
  // first-audio latency.

  // Google TTS — Chirp 3 HD when a Gemini-style voice name is set
  // (same voice library), otherwise language-mapped Neural2/Standard.
  const buf = await googleTtsService.synthesize(text, voice.language, {
    voiceType: voice.fallbackType,
    voiceName: voice.geminiVoiceName,
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
  // Once a provider has yielded audio the listener has started hearing the
  // sentence — falling through to the next provider at that point would
  // REPLAY it from the top (half a sentence, then the whole thing again).
  // A mid-stream failure therefore ends the stream; only failures BEFORE
  // first audio may fall through.
  let yielded = false;
  const studentKey = sanitizeElevenLabsApiKey(voice.elevenlabsApiKey);
  // Student-level ElevenLabs voice (direct voice ID + API key)
  if (voice.elevenlabsVoiceId && studentKey) {
    try {
      for await (const chunk of elevenlabsTtsService.synthesizeStream(text, {
        voiceId: voice.elevenlabsVoiceId,
        apiKeyOverride: studentKey,
        language: voice.language,
      })) {
        yielded = true;
        yield chunk;
      }
      onUsage?.({ provider: "elevenlabs", characters: chars });
      return;
    } catch (error: any) {
      console.error(
        `[TTSFacade] Student-level ElevenLabs streaming failed (voice: ${voice.elevenlabsVoiceId})${yielded ? " mid-stream" : ", falling back"}:`,
        error.message
      );
      if (yielded) return;
      // Fall through to admin custom voice or OpenAI
    }
  }

  // Admin-level custom voice from voices table
  if (voice.customVoice && voice.customVoice.active) {
    try {
      for await (const chunk of elevenlabsTtsService.synthesizeStream(text, {
        voiceId: voice.customVoice.externalId,
        language: voice.language,
      })) {
        yielded = true;
        yield chunk;
      }
      onUsage?.({ provider: "elevenlabs", characters: chars });
      return;
    } catch (error: any) {
      console.error(
        `[TTSFacade] ElevenLabs streaming failed for voice "${voice.customVoice.name}"${yielded ? " mid-stream" : ", falling back to OpenAI"}:`,
        error.message
      );
      if (yielded) return;
      // Fall through to OpenAI
    }
  }

  // Persistent Gemini Live session — preferred for student voice (no
  // per-call connection overhead, native Gemini voice quality)
  if (voice.geminiLiveSession) {
    try {
      for await (const chunk of voice.geminiLiveSession.synthesizeStream(text, signal)) {
        yielded = true;
        yield chunk;
      }
      if (!signal?.aborted) onUsage?.({ provider: "gemini-live", characters: chars });
      return;
    } catch (error: any) {
      if (signal?.aborted) return;
      console.error(`[TTSFacade] Gemini Live TTS streaming failed${yielded ? " mid-stream" : ", falling back"}:`, error.message);
      if (yielded) return;
    }
  }

  // Gemini TTS streaming (`gemini-2.5-flash-preview-tts`) is available
  // here but currently disabled — Chirp 3 HD wins on latency and quota.
  // Kept importable via `geminiTtsService` for future experimentation.

  // Google TTS — Chirp 3 HD when a Gemini-style voice name is set
  // (same voice library, faster), otherwise language-mapped Neural2/Standard.
  yield* googleTtsService.synthesizeStream(text, voice.language, {
    voiceType: voice.fallbackType,
    voiceName: voice.geminiVoiceName,
  });
  onUsage?.({ provider: "google", characters: chars });
}

export const ttsFacade = {
  synthesize,
  synthesizeStream,
};
