// server/services/dual-agent/agent-flow-logger.ts
//
// High-signal flow log for the three-agent AAC architecture. One line per
// significant event, timestamped, agent-tagged. Strips out the noise
// (pcm_audio, raw server messages, per-chunk audio) that makes
// live-session-debug.log hard to read. Image frames appear as the literal
// token "image_frame" — no base64 payload.
//
// Categories logged:
//   - SESSION START + the three full system prompts
//   - IN  — inputs delivered to an agent (context injection, user turn,
//           image_frame, gemini's inputTranscription, board manager trigger)
//   - TOOL — function calls each agent makes (parsed from its tool calls)
//   - OUT  — voice / text outputs (Speaker SpeechEnd, monitor broadcast)
//
// The file is rotated at 50 MB (same policy as live-session-debug.log).
// Errors are swallowed — logging must never break the relay.

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { db } from "../../db";
import { sessionDebugLogs } from "../../../shared/schema-private";
import { sessionContextStore } from "./dual-agent-logger";
import { fileDebugLoggingEnabled, sessionDebugPersistenceEnabled } from "../file-debug-log";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FLOW_LOG_FILE = join(__dirname, "..", "..", "agent-flow-debug.log");
const MAX_SIZE = 50 * 1024 * 1024;

/** Stable agent labels used as the second field of every flow-log line.
 *  CLIENT is for raw client WS messages reaching the Coordinator — gives
 *  operators a "did the press reach the server?" trail without having to
 *  cross-reference the live-session-debug log. */
export type FlowAgent = "OBSERVER" | "SPEAKER" | "BOARD_MGR" | "MONITOR" | "COORDINATOR" | "CLIENT";

/**
 * Sections to keep out of the DB. Skipped only at the DB-persistence
 * boundary — file logging is unaffected. `image_frame` fires once per
 * frame (every few seconds during active sessions); persisting each one
 * would drown the admin session-debug view in repetition without adding
 * signal. Frame counts surface through other channels.
 */
const DB_NOISY_SECTIONS = new Set<string>([
  "OBSERVER:IN:image_frame",
]);

function ensureSize(): void {
  try {
    if (fs.existsSync(FLOW_LOG_FILE) && fs.statSync(FLOW_LOG_FILE).size > MAX_SIZE) {
      fs.writeFileSync(FLOW_LOG_FILE, "");
    }
  } catch { /* ignore */ }
}

/**
 * Persist a flow event to `session_debug_logs` when running inside a
 * session context with debugMode on. Section is the stable
 * `<agent>:<kind>` key the admin UI can filter on; content is the
 * one-line message. Fire-and-forget — DB errors must never break the
 * relay or the flow log.
 */
function persistFlowToDb(section: string, content: string): void {
  // `ctx.debugMode` comes from the client's `initialize` message — any
  // WebSocket client can set it. On its own that would let a client switch
  // on permanent persistence of untruncated prompts and transcripts (no
  // retention policy on this table), so production additionally requires
  // the server-side SESSION_DEBUG_LOGS=true opt-in.
  if (!sessionDebugPersistenceEnabled) return;
  const ctx = sessionContextStore.getStore();
  if (!ctx || !ctx.debugMode) return;
  if (DB_NOISY_SECTIONS.has(section)) return;
  db.insert(sessionDebugLogs)
    .values({ sessionId: ctx.sessionId, section, content })
    .catch(() => { /* swallow — file log still captures it */ });
}

function ts(): string {
  return new Date().toISOString();
}

function appendLine(line: string): void {
  // Full system prompts, student name, every utterance and press. This file
  // had NO production gate at all (its sibling dual-agent-logger.ts did).
  if (!fileDebugLoggingEnabled) return;
  try {
    ensureSize();
    fs.appendFileSync(FLOW_LOG_FILE, line + "\n");
  } catch { /* ignore */ }
}

/** One-line truncate of long content so the log stays line-scannable.
 *  Multi-line content is joined with " | " and the whole string is
 *  trimmed to a generous max so prompts/transcripts stay readable. */
function compact(s: string | undefined, max = 400): string {
  if (s === undefined || s === null) return "";
  const flat = String(s).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

function tag(agent: FlowAgent, profile?: "awake" | "resting"): string {
  // Suffix the agent label with `(resting)` when the session is in the
  // resting profile so a glance reveals which configuration produced
  // the line.
  const base = profile === "resting" ? `${agent}/RESTING` : agent;
  return `[${base.padEnd(15)}]`;
}

// ---------------------------------------------------------------------------
// Public log functions
// ---------------------------------------------------------------------------

/**
 * Mark the start of a new session. Adds a visible separator and a header
 * line; the three full system prompts follow via flowSystemPrompt. The
 * separator makes it trivial to scroll between sessions.
 */
export function flowSessionStart(
  sessionId: string,
  meta: {
    studentName?: string;
    observerModel?: string;
    speakerModel?: string;
    boardMgrModel?: string;
    monitorModel?: string;
    useDirectAudio?: boolean;
    // Per-student master switch. true → full-attention (raw frames + audio
    // streamed continuously, energy/attention throttling disabled — higher cost
    // by design). false/undefined → economize (text-first, cost-saving on).
    fullAttention?: boolean;
  },
): void {
  appendLine("");
  appendLine("=".repeat(100));
  appendLine(`[${ts()}] ── SESSION START ${sessionId}${meta.studentName ? ` (${meta.studentName})` : ""}`);
  const attentionLine =
    meta.fullAttention === undefined
      ? ""
      : `attention=${meta.fullAttention ? "full" : "adaptive/economize"}`;
  const modelsLine =
    `models: observer=${meta.observerModel || "?"} | speaker=${meta.speakerModel || "?"}` +
    `${meta.useDirectAudio !== undefined ? ` (directAudio=${meta.useDirectAudio})` : ""}` +
    ` | board=${meta.boardMgrModel || "?"}${meta.monitorModel ? ` | monitor=${meta.monitorModel}` : ""}` +
    `${attentionLine ? `\n${attentionLine}` : ""}`;
  appendLine(`              ${modelsLine}`);
  appendLine("=".repeat(100));
  persistFlowToDb(
    "SESSION_START",
    `${sessionId}${meta.studentName ? ` (${meta.studentName})` : ""}\n${modelsLine}`,
  );
}

/** Dump an agent's full system prompt verbatim under a header. Called
 *  once per session per agent (Observer/Speaker/Board Manager). Useful
 *  to verify what each agent actually sees as its standing context. */
export function flowSystemPrompt(agent: FlowAgent, prompt: string): void {
  appendLine("");
  appendLine(`[${ts()}] ── ${agent} SYSTEM PROMPT (${prompt.length} chars) ${"─".repeat(40)}`);
  appendLine(prompt);
  appendLine(`── /${agent} SYSTEM PROMPT ${"─".repeat(60)}`);
  persistFlowToDb(`${agent}:SYSTEM_PROMPT`, prompt);
}

/** An input delivered to `agent`. `kind` is a stable short label (e.g.
 *  "context", "user_turn", "image_frame", "gemini_input_transcript",
 *  "trigger"). Content is truncated for readability. */
export function flowInput(
  agent: FlowAgent,
  kind: string,
  content: string,
  profile?: "awake" | "resting",
): void {
  appendLine(`[${ts()}] ${tag(agent, profile)} IN   ${kind.padEnd(20)} ${compact(content)}`);
  persistFlowToDb(`${agent}:IN:${kind}`, content);
}

/** A function call made by `agent`. `args` is the argument summary
 *  (already formatted by the caller — usually one-line). */
export function flowTool(
  agent: FlowAgent,
  name: string,
  args: string,
  profile?: "awake" | "resting",
): void {
  appendLine(`[${ts()}] ${tag(agent, profile)} TOOL ${name.padEnd(20)} ${compact(args, 500)}`);
  persistFlowToDb(`${agent}:TOOL:${name}`, args);
}

/** A voice / text output produced by `agent`. `kind` is e.g. "speech"
 *  (Speaker's audio transcript), "monitor_context" (Monitor's
 *  broadcast), or "tts:student" (interpret() going through student TTS). */
export function flowOutput(
  agent: FlowAgent,
  kind: string,
  content: string,
  profile?: "awake" | "resting",
): void {
  appendLine(`[${ts()}] ${tag(agent, profile)} OUT  ${kind.padEnd(20)} ${compact(content, 500)}`);
  persistFlowToDb(`${agent}:OUT:${kind}`, content);
}

/** Free-form note in the flow log (rare; for unusual events the four
 *  primary categories don't cover, e.g. "PROFILE_TRANSITION resting"). */
export function flowNote(agent: FlowAgent, message: string, profile?: "awake" | "resting"): void {
  appendLine(`[${ts()}] ${tag(agent, profile)} NOTE                      ${compact(message)}`);
  persistFlowToDb(`${agent}:NOTE`, message);
}

/** One credit charge (Live turn / HTTP completion / TTS / STT). `category`
 *  is the cost_breakdown key (e.g. "stt", "board-manager:gemini-2.5-flash");
 *  `detail` is the token/duration summary (prompt=, cacheRead=, seconds=).
 *  Previously this detail only reached console.log via the credit ledger and
 *  was unrecoverable from deployed sessions — persisting it here makes
 *  per-call cost (and cache-hit rates) auditable per session. No PHI. */
export function flowCost(category: string, credits: number, detail: string): void {
  const line = `${category} credits=${credits.toFixed(6)} ${detail}`;
  appendLine(`[${ts()}] ${tag("COORDINATOR")} COST ${compact(line, 500)}`);
  persistFlowToDb(`COST:${category}`, line);
}
