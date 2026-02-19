// server/services/voice/elevenlabs-tts-service.ts
// ElevenLabs Text-to-Speech service

export interface ElevenLabsTTSOptions {
  voiceId: string;
  modelId?: string; // explicit override; otherwise auto-selected by language
  language?: string; // ISO 639-1 code: 'en', 'he', etc. — used to pick the right model
  stability?: number; // 0-1, default 0.5
  similarityBoost?: number; // 0-1, default 0.75
  apiKeyOverride?: string; // Use this API key instead of the env var
}

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = "eleven_multilingual_v2";

// Languages that require eleven_v3 (multilingual_v2 doesn't support them well)
const V3_LANGUAGES = new Set(["he", "ar"]);

/** Pick the best ElevenLabs model for the given language */
function resolveModel(options: ElevenLabsTTSOptions): string {
  if (options.modelId) return options.modelId;
  if (options.language && V3_LANGUAGES.has(options.language)) return "eleven_v3";
  return DEFAULT_MODEL;
}

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY environment variable is not set");
  }
  return key;
}

/**
 * Synthesize text to speech using ElevenLabs TTS API
 * Returns the full audio buffer in MP3 format
 */
export async function synthesize(
  text: string,
  options: ElevenLabsTTSOptions
): Promise<Buffer> {
  const apiKey = options.apiKeyOverride || getApiKey();
  const modelId = resolveModel(options);

  console.log(
    `[ElevenLabsTTS] Synthesizing: "${text.substring(0, 50)}..." (voice: ${options.voiceId}, model: ${modelId})`
  );

  const response = await fetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${options.voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: options.stability ?? 0.5,
          similarity_boost: options.similarityBoost ?? 0.75,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuffer);

  console.log(`[ElevenLabsTTS] Synthesized ${audioBuffer.length} bytes of audio`);

  return audioBuffer;
}

/**
 * Synthesize text to speech as a stream using ElevenLabs API.
 *
 * Buffers the full response before yielding to avoid stuttering caused by
 * the client playing many tiny network chunks as separate audio sources.
 * For typical AAC utterances (1-3 sentences) the buffering delay is ~1-2s.
 */
export async function* synthesizeStream(
  text: string,
  options: ElevenLabsTTSOptions
): AsyncGenerator<Buffer> {
  const buffer = await synthesize(text, options);
  yield buffer;
}

export const elevenlabsTtsService = {
  synthesize,
  synthesizeStream,
};
