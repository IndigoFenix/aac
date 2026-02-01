// server/services/voice/index.ts
// Voice services exports

export { whisperService, transcribe, transcribeToText } from "./whisper-service";
export type { TranscriptionResult, TranscriptionOptions } from "./whisper-service";

export { openaiTtsService, synthesize, synthesizeStream } from "./openai-tts-service";
export type { VoiceType, TTSOptions } from "./openai-tts-service";
