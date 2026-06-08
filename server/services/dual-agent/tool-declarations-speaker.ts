// server/services/dual-agent/tool-declarations-speaker.ts
//
// Re-export shim. Speaker's tool declarations moved to
// `./prompts/speaker`. This file remains as a thin barrel so existing
// importers keep working.

export {
  type SpeakerToolConfig,
  buildSpeakerToolDeclarations,
} from "./prompts/speaker";
