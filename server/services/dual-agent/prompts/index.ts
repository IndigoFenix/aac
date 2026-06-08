// server/services/dual-agent/prompts/index.ts
//
// Barrel re-exports for the per-agent prompt + tool files. Importers can
// reach for the canonical public names through `from "./prompts"` instead
// of remembering which sibling owns each helper.

export * from "./shared";
export * from "./observer";
export * from "./speaker";
export * from "./board-manager";
export * from "./monitor";
export * from "./legacy";
