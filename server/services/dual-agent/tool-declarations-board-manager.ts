// server/services/dual-agent/tool-declarations-board-manager.ts
//
// Re-export shim. Board Manager's tool declarations moved to
// `./prompts/board-manager`. This file remains as a thin barrel so
// existing importers keep working.

export {
  type BoardManagerToolConfig,
  buildBoardManagerToolDeclarations,
} from "./prompts/board-manager";
