// server/services/voice/index.ts
// Voice services exports

export { whisperService, transcribe, transcribeToText } from "./whisper-service";
export type { TranscriptionResult, TranscriptionOptions } from "./whisper-service";

export { googleTtsService, synthesize, synthesizeStream } from "./google-tts-service";
export type { VoiceType, TTSOptions } from "./google-tts-service";

export { geminiTtsService, GEMINI_VOICES } from "./gemini-tts-service";

export { elevenlabsTtsService } from "./elevenlabs-tts-service";
export type { ElevenLabsTTSOptions } from "./elevenlabs-tts-service";

export { ttsFacade } from "./tts-facade";
export type { ResolvedVoice } from "./tts-facade";
