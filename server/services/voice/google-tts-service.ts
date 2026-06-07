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

  // German voices (Neural2)
  "de-man": { languageCode: "de-DE", name: "de-DE-Neural2-B" },
  "de-woman": { languageCode: "de-DE", name: "de-DE-Neural2-A" },
  "de-boy": { languageCode: "de-DE", name: "de-DE-Neural2-B" },
  "de-girl": { languageCode: "de-DE", name: "de-DE-Neural2-A" },

  // Portuguese voices (Neural2)
  "pt-man": { languageCode: "pt-BR", name: "pt-BR-Neural2-B" },
  "pt-woman": { languageCode: "pt-BR", name: "pt-BR-Neural2-A" },
  "pt-boy": { languageCode: "pt-BR", name: "pt-BR-Neural2-B" },
  "pt-girl": { languageCode: "pt-BR", name: "pt-BR-Neural2-C" },

  // Mandarin Chinese voices (Neural2)
  "zh-man": { languageCode: "cmn-CN", name: "cmn-CN-Neural2-B" },
  "zh-woman": { languageCode: "cmn-CN", name: "cmn-CN-Neural2-A" },
  "zh-boy": { languageCode: "cmn-CN", name: "cmn-CN-Neural2-B" },
  "zh-girl": { languageCode: "cmn-CN", name: "cmn-CN-Neural2-A" },

  // Cantonese voices (Standard)
  "yue-man": { languageCode: "yue-HK", name: "yue-HK-Standard-B" },
  "yue-woman": { languageCode: "yue-HK", name: "yue-HK-Standard-A" },
  "yue-boy": { languageCode: "yue-HK", name: "yue-HK-Standard-B" },
  "yue-girl": { languageCode: "yue-HK", name: "yue-HK-Standard-A" },

  // Korean voices (Neural2)
  "ko-man": { languageCode: "ko-KR", name: "ko-KR-Neural2-C" },
  "ko-woman": { languageCode: "ko-KR", name: "ko-KR-Neural2-A" },
  "ko-boy": { languageCode: "ko-KR", name: "ko-KR-Neural2-C" },
  "ko-girl": { languageCode: "ko-KR", name: "ko-KR-Neural2-B" },
};

export type VoiceType = "man" | "woman" | "boy" | "girl";

export interface TTSOptions {
  voiceType?: VoiceType;
  /** Chirp 3 HD voice name (e.g. "Puck", "Kore", "Zephyr") — same
   *  names as Gemini Live voices. When set, the resolved Google voice
   *  is `<lang>-Chirp3-HD-<voiceName>`. Falls back to voiceType-mapped
   *  Neural2/Standard if Chirp 3 HD synthesis errors (unsupported
   *  language, voice withdrawn, etc.). */
  voiceName?: string;
  /** Natural-language style hint passed to Chirp 3 HD voices for
   *  prosody control (e.g. "Speak warmly, as a friendly companion").
   *  Ignored when the request falls back to non-Chirp voices. */
  prompt?: string;
  speakingRate?: number; // 0.25 to 4.0, default 1.0
  pitch?: number; // -20.0 to 20.0, default 0.0
}

/** Languages that have Chirp 3 HD voices available. Anything outside
 *  this list falls back to the Neural2/Standard VOICE_MAP path.
 *  Covers all 11 platform-supported languages (en/he/ar/es/ru/fr/de/pt/zh/yue/ko). */
const CHIRP3_HD_LANGUAGES = new Set([
  "en-US", "en-GB", "en-AU", "en-IN",
  "he-IL",
  "ar-XA",
  "es-ES", "es-US",
  "ru-RU",
  "fr-FR", "fr-CA",
  "de-DE",
  "pt-BR",
  "cmn-CN",
  "yue-HK",
  "ko-KR",
  "it-IT", "ja-JP",
]);

function chirpLanguageFor(languageCode: string): string | null {
  if (CHIRP3_HD_LANGUAGES.has(languageCode)) return languageCode;
  // Map the base language to a Chirp-supported regional variant if
  // possible (e.g. "en" → "en-US", "es" → "es-ES", "fr" → "fr-FR").
  const base = languageCode.split("-")[0];
  for (const candidate of CHIRP3_HD_LANGUAGES) {
    if (candidate.startsWith(`${base}-`)) return candidate;
  }
  return null;
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
    german: "de",
    portuguese: "pt",
    mandarin: "zh",
    chinese: "zh",
    cantonese: "yue",
    korean: "ko",
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
  const fallbackVoice = getVoiceConfig(language, voiceType);
  const ttsClient = getClient();

  // Chirp 3 HD path — shares voice names with Gemini Live (Puck, Kore,
  // Leda, Zephyr, etc.) so the configured Gemini voice flows through
  // seamlessly. Faster + cheaper than the Gemini TTS API path.
  if (options.voiceName) {
    const baseLang = fallbackVoice.languageCode; // already resolved from language map
    const chirpLang = chirpLanguageFor(baseLang);
    if (chirpLang) {
      const chirpName = `${chirpLang}-Chirp3-HD-${options.voiceName}`;
      try {
        console.log(`[GoogleTTSService] Synthesizing (Chirp3-HD): "${text.substring(0, 50)}..." (voice: ${chirpName}${options.prompt ? `, prompt="${options.prompt}"` : ""})`);
        const input: protos.google.cloud.texttospeech.v1.ISynthesisInput = options.prompt
          ? { text, prompt: options.prompt }
          : { text };
        const [response] = await ttsClient.synthesizeSpeech({
          input,
          voice: { languageCode: chirpLang, name: chirpName },
          audioConfig: {
            audioEncoding: "MP3" as const,
            speakingRate: options.speakingRate || 1.0,
            pitch: options.pitch || 0.0,
          },
        });
        if (response.audioContent) {
          return Buffer.from(response.audioContent as Uint8Array);
        }
      } catch (err: any) {
        // Voice not available in this locale, or Chirp 3 HD temporarily
        // unavailable. Fall through to the language-mapped voice below.
        console.warn(`[GoogleTTSService] Chirp3-HD ${chirpName} failed (${err?.message ?? err}); falling back to ${fallbackVoice.name}`);
      }
    }
  }

  console.log(`[GoogleTTSService] Synthesizing: "${text.substring(0, 50)}..." (lang: ${language}, voice: ${fallbackVoice.name})`);

  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: {
      languageCode: fallbackVoice.languageCode,
      name: fallbackVoice.name,
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
