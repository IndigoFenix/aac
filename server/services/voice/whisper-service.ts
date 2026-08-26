// server/services/voice/whisper-service.ts
// Whisper Speech-to-Text service using OpenAI's Whisper API

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface TranscriptionResult {
  text: string;
  language: string;
  duration?: number;
}

export interface TranscriptionOptions {
  languageHint?: string; // ISO 639-1 code: 'en', 'he', etc.
  prompt?: string; // Optional prompt for context
}

/**
 * Map MIME types to file extensions that Whisper accepts
 */
function getFileExtension(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    "audio/webm": "webm",
    "audio/webm;codecs=opus": "webm",
    "audio/mp3": "mp3",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/ogg;codecs=opus": "ogg",
    "audio/flac": "flac",
  };

  // Handle codecs in mime type
  const baseMime = mimeType.split(";")[0].trim();
  return mimeMap[baseMime] || mimeMap[mimeType] || "webm";
}

/**
 * Transcribe audio using OpenAI's Whisper API
 *
 * @param audioBuffer - The audio data as a Buffer
 * @param mimeType - The MIME type of the audio (e.g., 'audio/webm', 'audio/mp3')
 * @param options - Optional transcription options
 * @returns Transcription result with text and detected language
 */
export async function transcribe(
  audioBuffer: Buffer,
  mimeType: string,
  options: TranscriptionOptions = {}
): Promise<TranscriptionResult> {
  const extension = getFileExtension(mimeType);
  const filename = `audio.${extension}`;

  // Create a File object from the buffer
  const file = new File([audioBuffer], filename, { type: mimeType });

  console.log(`[WhisperService] Transcribing audio: ${audioBuffer.length} bytes, type: ${mimeType}`);

  const response = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: options.languageHint, // Optional: 'en', 'he', etc.
    response_format: "verbose_json",
    prompt: options.prompt,
  });

  // The transcript is what a student or bystander said — log its size only.
  console.log(`[WhisperService] Transcription complete: ${response.text.length} chars (lang: ${response.language})`);

  return {
    text: response.text,
    language: response.language || "en",
    duration: response.duration,
  };
}

/**
 * Transcribe audio and return only the text
 * Convenience wrapper for simple use cases
 */
export async function transcribeToText(
  audioBuffer: Buffer,
  mimeType: string,
  languageHint?: string
): Promise<string> {
  const result = await transcribe(audioBuffer, mimeType, { languageHint });
  return result.text;
}

export const whisperService = {
  transcribe,
  transcribeToText,
};
