// server/services/voice/gemini-tts-service.ts
// Gemini API Text-to-Speech service — uses generateContent with AUDIO modality

import { GoogleGenAI, Modality } from "@google/genai";

export type VoiceType = "man" | "woman" | "boy" | "girl";

export interface TTSOptions {
  voiceType?: VoiceType;
  voiceName?: string; // Direct Gemini voice name override (e.g. "Puck", "Kore")
}

// Gemini prebuilt voice names
const VOICE_MAP: Record<string, string> = {
  man:   "Orus",
  woman: "Kore",
  boy:   "Puck",
  girl:  "Leda",
};

// Available Gemini voices for UI selection
export const GEMINI_VOICES = [
  { id: "Puck", name: "Puck", description: "Young, energetic" },
  { id: "Charon", name: "Charon", description: "Calm, mature male" },
  { id: "Kore", name: "Kore", description: "Clear, friendly female" },
  { id: "Fenrir", name: "Fenrir", description: "Deep, confident male" },
  { id: "Aoede", name: "Aoede", description: "Warm, expressive female" },
  { id: "Leda", name: "Leda", description: "Gentle, youthful female" },
  { id: "Orus", name: "Orus", description: "Steady, reassuring male" },
  { id: "Zephyr", name: "Zephyr", description: "Light, neutral" },
] as const;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    // Use Vertex AI if configured, otherwise use API key
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
    if (projectId) {
      client = new GoogleGenAI({ vertexai: true, project: projectId, location });
    } else {
      client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    }
  }
  return client;
}

function getVoiceName(options: TTSOptions): string {
  if (options.voiceName) return options.voiceName;
  return VOICE_MAP[options.voiceType || "woman"] || "Kore";
}

/**
 * Synthesize text to speech using Gemini's generateContent with AUDIO modality.
 * Returns audio as an MP3 buffer.
 */
export async function synthesize(
  text: string,
  language: string,
  options: TTSOptions = {}
): Promise<Buffer> {
  const voiceName = getVoiceName(options);

  console.log(
    `[GeminiTTS] Synthesizing: "${text.substring(0, 50)}..." (voice: ${voiceName}, lang: ${language})`
  );

  const ai = getClient();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Say the following in ${language}, exactly as written, with natural intonation. Do not add anything else:\n\n${text}`,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  // Extract audio data from the response
  const part = response.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error("Gemini returned no audio data");
  }

  // Gemini returns raw PCM audio — convert to WAV for playback
  const pcm = Buffer.from(part.inlineData.data, "base64");
  const wav = pcmToWav(pcm);

  console.log(`[GeminiTTS] Synthesized ${wav.length} bytes WAV audio`);

  return wav;
}

/**
 * Synthesize as a stream (yields single buffer).
 */
export async function* synthesizeStream(
  text: string,
  language: string,
  options: TTSOptions = {}
): AsyncGenerator<Buffer> {
  const buffer = await synthesize(text, language, options);
  yield buffer;
}

/** Convert raw PCM (24kHz 16-bit LE mono) to WAV */
function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export const geminiTtsService = {
  synthesize,
  synthesizeStream,
  getVoiceName,
  GEMINI_VOICES,
};
