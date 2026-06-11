// server/services/dual-agent/tool-shared.ts
//
// Re-export shim. The shared tool primitives (`call_monitor`, `private_thought`,
// `remain_silent`, `debug_message`) moved to `./prompts/shared`. This file
// remains as a thin barrel so external importers keep working.

export {
  CALL_MONITOR,
  PRIVATE_THOUGHT,
  REMAIN_SILENT,
  DEBUG_MESSAGE,
  debugIntrospectionEnabled,
} from "./prompts/shared";
