// server/services/dual-agent/tool-declarations-observer.ts
//
// Re-export shim. Observer's tool declarations moved to
// `./prompts/observer`. This file remains as a thin barrel so existing
// importers keep working.

export {
  type ObserverToolConfig,
  buildObserverToolDeclarations,
} from "./prompts/observer";
