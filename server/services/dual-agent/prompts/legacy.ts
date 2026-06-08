// server/services/dual-agent/prompts/legacy.ts
//
// LEGACY — InteractiveAgent only. Off the live path; kept for possible
// revival of the single-agent architecture.
//
// The three-agent live path (Observer + Speaker + BoardManager + Monitor)
// is the active code. This file re-exports the legacy single-agent tool
// surface (`buildToolDeclarations` + `ToolDeclarationConfig`) and the
// legacy `buildInteractiveAgentPrompt` so importers have a single canonical
// location to reach for them — but the underlying definitions still live
// in their original files because nothing on the live path depends on
// them being relocated.
//
// If we ever revive the single-agent path, the next step is to physically
// move tool-declarations.ts and the `buildInteractiveAgentPrompt` /
// `buildRestingAgentPrompt` exports into this file. Right now they remain
// in their existing homes (`server/services/dual-agent/tool-declarations.ts`
// and `server/services/memory-schema/aac-memory-schema.ts`) because:
//   1. `buildInteractiveAgentPrompt` is intertwined with composeAacPersona,
//      AAC_DEFAULT_PERSONA_PROMPT, getBundledIconsBlock, and 1900+ lines
//      of memory-field schema in aac-memory-schema.ts.
//   2. `tool-declarations.ts` (832 lines) declares schema in a Vertex Live
//      API-specific `parameters` shape (NOT `parametersJsonSchema`) per the
//      file-top comment — moving it without verifying the legacy live-relay
//      path still works would risk a regression on the single-agent fallback.
//
// See planning-docs/aac-prompt-strings-audit.md §10 for the full inventory.

// Re-exports — point all legacy importers at this single location.
export {
  buildToolDeclarations,
  type ToolDeclarationConfig,
} from "../tool-declarations";

export {
  buildInteractiveAgentPrompt,
  buildRestingAgentPrompt,
  composeAacPersona,
  AAC_DEFAULT_PERSONA_PROMPT,
} from "../../memory-schema/aac-memory-schema";
