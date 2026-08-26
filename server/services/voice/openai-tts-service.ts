// server/services/voice/openai-tts-service.ts
// OpenAI Text-to-Speech service

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// OpenAI TTS voices
type OpenAIVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

// Map our voice types to OpenAI voices
const VOICE_MAP: Record<string, OpenAIVoice> = {
  // Default mappings by voice type
  man: "onyx",      // Deep male voice
  woman: "nova",    // Female voice
  boy: "echo",      // Younger male voice
  girl: "shimmer",  // Younger female voice

  // Language-specific can use same voices (OpenAI voices work across languages)
  "en-man": "onyx",
  "en-woman": "nova",
  "en-boy": "echo",
  "en-girl": "shimmer",
  "he-man": "onyx",
  "he-woman": "nova",
  "he-boy": "echo",
  "he-girl": "shimmer",
};

export type VoiceType = "man" | "woman" | "boy" | "girl";

export interface TTSOptions {
  voiceType?: VoiceType;
  speed?: number; // 0.25 to 4.0, default 1.0
  model?: "tts-1" | "tts-1-hd"; // tts-1 is faster, tts-1-hd is higher quality
}

/**
 * Get the OpenAI voice for a given language and voice type
 */
function getVoice(language: string, voiceType: VoiceType): OpenAIVoice {
  // Normalize language code
  let langCode = language.toLowerCase();
  if (langCode.includes("-")) {
    langCode = langCode.split("-")[0];
  }

  const voiceKey = `${langCode}-${voiceType}`;
  return VOICE_MAP[voiceKey] || VOICE_MAP[voiceType] || "nova";
}

/**
 * Synthesize text to speech using OpenAI TTS
 *
 * @param text - The text to synthesize
 * @param language - The language code (used for voice selection)
 * @param options - TTS options
 * @returns Audio buffer in MP3 format
 */
export async function synthesize(
  text: string,
  language: string,
  options: TTSOptions = {}
): Promise<Buffer> {
  const voiceType = options.voiceType || "woman";
  const voice = getVoice(language, voiceType);
  const model = options.model || "tts-1"; // Use faster model by default
  const speed = options.speed || 1.0;

  // Text is the utterance (PHI) — log its size, never its content.
  console.log(`[OpenAITTSService] Synthesizing: ${text.length} chars (voice: ${voice}, model: ${model})`);

  const response = await openai.audio.speech.create({
    model,
    voice,
    input: text,
    response_format: "mp3",
    speed,
  });

  // Get the audio data as a buffer
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuffer);

  console.log(`[OpenAITTSService] Synthesized ${audioBuffer.length} bytes of audio`);

  return audioBuffer;
}

/**
 * Split text into sentences for streaming synthesis
 */
function splitIntoSentences(text: string): string[] {
  // Split by sentence-ending punctuation, keeping the punctuation
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Synthesize text to speech as a stream of audio chunks
 * Splits text by sentences and yields each as a separate audio chunk
 *
 * @param text - The text to synthesize
 * @param language - The language code
 * @param options - TTS options
 * @yields Audio buffers in MP3 format, one per sentence
 */
export async function* synthesizeStream(
  text: string,
  language: string,
  options: TTSOptions = {}
): AsyncGenerator<Buffer> {
  const sentences = splitIntoSentences(text);

  console.log(`[OpenAITTSService] Streaming ${sentences.length} sentence(s)`);

  for (const sentence of sentences) {
    if (sentence.trim()) {
      const audioBuffer = await synthesize(sentence, language, options);
      yield audioBuffer;
    }
  }
}

export const openaiTtsService = {
  synthesize,
  synthesizeStream,
  getVoice,
};
