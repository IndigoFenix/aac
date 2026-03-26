// server/services/voice/google-tts-service.ts
// Google Cloud Text-to-Speech service with streaming support

import { TextToSpeechClient, protos } from "@google-cloud/text-to-speech";

// Voice mapping based on language and voice type preferences
// Using Neural2 voices for better quality where available
const VOICE_MAP: Record<string, { languageCode: string; name: string }> = {
  // English voices
  "en-man": { languageCode: "en-US", name: "en-US-Neural2-D" },
  "en-woman": { languageCode: "en-US", name: "en-US-Neural2-F" },
  "en-boy": { languageCode: "en-US", name: "en-US-Neural2-A" },
  "en-girl": { languageCode: "en-US", name: "en-US-Neural2-E" },

  // Hebrew voices (Standard — Neural2 not available for he-IL)
  "he-man": { languageCode: "he-IL", name: "he-IL-Standard-D" },
  "he-woman": { languageCode: "he-IL", name: "he-IL-Standard-A" },
  "he-boy": { languageCode: "he-IL", name: "he-IL-Standard-D" },
  "he-girl": { languageCode: "he-IL", name: "he-IL-Standard-A" },

  // Arabic voices (Neural2)
  "ar-man": { languageCode: "ar-XA", name: "ar-XA-Neural2-B" },
  "ar-woman": { languageCode: "ar-XA", name: "ar-XA-Neural2-A" },
  "ar-boy": { languageCode: "ar-XA", name: "ar-XA-Neural2-B" },
  "ar-girl": { languageCode: "ar-XA", name: "ar-XA-Neural2-A" },

  // Spanish voices
  "es-man": { languageCode: "es-ES", name: "es-ES-Neural2-B" },
  "es-woman": { languageCode: "es-ES", name: "es-ES-Neural2-A" },
  "es-boy": { languageCode: "es-ES", name: "es-ES-Neural2-B" },
  "es-girl": { languageCode: "es-ES", name: "es-ES-Neural2-A" },

  // Russian voices
  "ru-man": { languageCode: "ru-RU", name: "ru-RU-Standard-B" },
  "ru-woman": { languageCode: "ru-RU", name: "ru-RU-Standard-A" },
  "ru-boy": { languageCode: "ru-RU", name: "ru-RU-Standard-B" },
  "ru-girl": { languageCode: "ru-RU", name: "ru-RU-Standard-A" },

  // French voices
  "fr-man": { languageCode: "fr-FR", name: "fr-FR-Neural2-B" },
  "fr-woman": { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
  "fr-boy": { languageCode: "fr-FR", name: "fr-FR-Neural2-B" },
  "fr-girl": { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
};

export type VoiceType = "man" | "woman" | "boy" | "girl";

export interface TTSOptions {
  voiceType?: VoiceType;
  speakingRate?: number; // 0.25 to 4.0, default 1.0
  pitch?: number; // -20.0 to 20.0, default 0.0
}

// Lazy initialization of client
let client: TextToSpeechClient | null = null;

function getClient(): TextToSpeechClient {
  if (!client) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (credentialsJson) {
      try {
        const credentials = JSON.parse(credentialsJson);
        client = new TextToSpeechClient({ credentials });
        console.log("[GoogleTTSService] Client initialized with JSON credentials");
      } catch (error) {
        console.error("[GoogleTTSService] Failed to parse credentials JSON:", error);
        throw new Error("Failed to initialize Google TTS client: invalid credentials JSON");
      }
    } else {
      // Fall back to default credentials (ADC)
      client = new TextToSpeechClient();
      console.log("[GoogleTTSService] Client initialized with default credentials");
    }
  }
  return client;
}

/**
 * Get the voice configuration for a given language and voice type
 */
function getVoiceConfig(language: string, voiceType: VoiceType): { languageCode: string; name: string } {
  // Normalize language code (e.g., "en-US" -> "en", "hebrew" -> "he")
  let langCode = language.toLowerCase();
  if (langCode.includes("-")) {
    langCode = langCode.split("-")[0];
  }
  // Map common language names
  const langMap: Record<string, string> = {
    english: "en",
    hebrew: "he",
    arabic: "ar",
    spanish: "es",
    russian: "ru",
    french: "fr",
  };
  langCode = langMap[langCode] || langCode;

  const voiceKey = `${langCode}-${voiceType}`;
  return VOICE_MAP[voiceKey] || VOICE_MAP["en-woman"]; // Default to English woman
}

/**
 * Synthesize text to speech and return audio as a Buffer
 *
 * @param text - The text to synthesize
 * @param language - The language code (e.g., 'en', 'he', 'en-US')
 * @param options - TTS options including voice type
 * @returns Audio buffer in MP3 format
 */
export async function synthesize(
  text: string,
  language: string,
  options: TTSOptions = {}
): Promise<Buffer> {
  const voiceType = options.voiceType || "woman";
  const voice = getVoiceConfig(language, voiceType);

  console.log(`[GoogleTTSService] Synthesizing: "${text.substring(0, 50)}..." (lang: ${language}, voice: ${voice.name})`);

  const ttsClient = getClient();

  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: {
      languageCode: voice.languageCode,
      name: voice.name,
    },
    audioConfig: {
      audioEncoding: "MP3" as const,
      speakingRate: options.speakingRate || 1.0,
      pitch: options.pitch || 0.0,
    },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);

  if (!response.audioContent) {
    throw new Error("No audio content in TTS response");
  }

  const audioBuffer = Buffer.from(response.audioContent as Uint8Array);
  console.log(`[GoogleTTSService] Synthesized ${audioBuffer.length} bytes of audio`);

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

  console.log(`[GoogleTTSService] Streaming ${sentences.length} sentence(s)`);

  for (const sentence of sentences) {
    if (sentence.trim()) {
      const audioBuffer = await synthesize(sentence, language, options);
      yield audioBuffer;
    }
  }
}

/**
 * Get available voices for a language
 */
export async function listVoices(languageCode?: string): Promise<protos.google.cloud.texttospeech.v1.IVoice[]> {
  const ttsClient = getClient();
  const [response] = await ttsClient.listVoices({ languageCode });
  return response.voices || [];
}

export const googleTtsService = {
  synthesize,
  synthesizeStream,
  listVoices,
  getVoiceConfig,
};
