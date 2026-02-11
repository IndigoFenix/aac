// server/services/voice/elevenlabs-tts-service.ts
// ElevenLabs Text-to-Speech service

export interface ElevenLabsTTSOptions {
  voiceId: string;
  modelId?: string; // default: eleven_multilingual_v2
  stability?: number; // 0-1, default 0.5
  similarityBoost?: number; // 0-1, default 0.75
  apiKeyOverride?: string; // Use this API key instead of the env var
}

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = "eleven_multilingual_v2";

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
  const modelId = options.modelId || DEFAULT_MODEL;

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
 * Synthesize text to speech as a stream using ElevenLabs streaming API
 * Returns chunks of MP3 audio as they arrive (true streaming, not per-sentence)
 */
export async function* synthesizeStream(
  text: string,
  options: ElevenLabsTTSOptions
): AsyncGenerator<Buffer> {
  const apiKey = options.apiKeyOverride || getApiKey();
  const modelId = options.modelId || DEFAULT_MODEL;

  console.log(
    `[ElevenLabsTTS] Streaming: "${text.substring(0, 50)}..." (voice: ${options.voiceId}, model: ${modelId})`
  );

  const response = await fetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${options.voiceId}/stream`,
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
    throw new Error(`ElevenLabs streaming API error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error("ElevenLabs streaming response has no body");
  }

  const reader = response.body.getReader();
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      yield chunk;
    }
  } finally {
    reader.releaseLock();
  }

  console.log(`[ElevenLabsTTS] Streamed ${totalBytes} bytes total`);
}

export const elevenlabsTtsService = {
  synthesize,
  synthesizeStream,
};
