// server/services/dual-agent/prompts/monitor.ts
//
// Monitor Agent prompt + tool surface + enhancer/summarizer prompt builders.
// The Monitor is the supervisory agent: it manages memory, produces the
// thorough-startup enhancer sections, and emits the rolling session summary.
//
// Pulled from shared.ts: getBundledIconsBlock, ex (transitively via prompt-examples).
//
// NOTE: This file currently RE-EXPORTS the live-system Monitor prompt builder
// from its existing home in memory-schema/aac-memory-schema.ts. The Monitor
// prompt is tightly intertwined with the read-only memory-field schema in
// that file (composeAacPersona, the Context_* memory paths, the persona
// glue) and physically moving it would require pulling those companion
// pieces out of a 1900-line memory-schema file. Per the task constraint
// "preserve behavior exactly", we expose the existing buildMonitorSystemPrompt
// from this barrel so consumers can import a single canonical location.
//
// The enhancer prompt + session-summary prompt builders ALSO remain inside
// monitor-agent.ts as `thoroughStartup` / `produceSessionSummary` methods
// — they're tightly coupled to the per-student data fetch + per-call
// nonce / GPT invocation logic. Extracting just the prompt strings here
// would split a single computation into two files for no readability gain.
// Their CONTENT is documented in planning-docs/aac-prompt-strings-audit.md
// §5.4 / §5.5. (TODO: When the enhancer is next revisited for prompt
// pruning, the prompt template can be lifted into a `buildEnhancerPrompt`
// helper here and the agent file reduced to data-gathering + LLM dispatch.)

export {
  buildMonitorSystemPrompt,
} from "../../memory-schema/aac-memory-schema";

// `getBundledIconsBlock` is also re-exported from `./shared` — call sites
// reach it through there (the canonical AAC home for the symbol inventory).

// ===========================================================================
// MONITOR TOOL DECLARATIONS
// ===========================================================================
//
// Monitor does NOT use the dual-agent tool-shared.ts primitives. Its tools
// flow through the generic chat-tool path via `sessionService.onMessage`
// (persona = "aac-assistant"), which exposes `manageMemory` and similar
// generic memory tools defined in the memory-schema layer. There is no
// dedicated `tool-declarations-monitor.ts` file to move.
//
// See planning-docs/aac-prompt-strings-audit.md §5.2.
