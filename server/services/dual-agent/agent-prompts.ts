// server/services/dual-agent/agent-prompts.ts
//
// Re-export shim. The per-agent prompt builders + shared helpers moved to
// `./prompts/`. This file remains as a thin barrel so external importers
// keep working. New code should import directly from `./prompts` or the
// per-agent file (`./prompts/observer`, `./prompts/speaker`, etc.).

export {
  // Shared sub-types
  type KnownContact,
  type ClassroomContext,
  type BaseStudentContext,
  // Shared helpers (re-exported in case external code reaches for them)
  transcriptionRulesText,
  observationRulesText,
} from "./prompts/shared";

export {
  type ObserverPromptConfig,
  buildObserverPrompt,
} from "./prompts/observer";

export {
  type SpeakerPromptConfig,
  buildSpeakerPrompt,
} from "./prompts/speaker";

export {
  type BoardManagerPromptConfig,
  type BoardManagerPromptParts,
  buildBoardManagerPrompt,
} from "./prompts/board-manager";
