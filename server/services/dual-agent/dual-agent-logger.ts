// server/services/dual-agent/dual-agent-logger.ts
// Verbose file-only debug log for the dual-agent / live-relay system.
//
// File: live-session-debug.log. Local-only — for low-level traces (provider
// raw messages, frame counts, audio chunks). The admin-visible
// session_debug_logs DB rows are populated by agent-flow-logger.ts instead;
// the flow log is one line per high-signal event and is far more useful for
// session review.
//
// runInSessionContext / sessionContextStore are still exported so the flow
// logger and any caller wanting DB persistence can ride on the same
// session-scoped context. The store keeps `sessionId` + `debugMode` (and
// an optional agent tag) bound to whatever async chain is started inside
// `run()`.

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "async_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "..", "live-session-debug.log");
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

// This file log captures full system prompts and verbatim input/output
// transcriptions — i.e. PHI (student speech) and biometric identifiers. It must
// NEVER be written to disk in production. Lambda's filesystem is ephemeral, but
// the planned ECS/HIPAA path is long-lived, so gate on more than just isLambda.
// Opt back in explicitly with DEBUG_LIVE_SESSIONS=true for local debugging only.
// Mirrors the isLambda guard in server/services/chat/memory-debug-log.ts.
const isLambda = !!process.env.AWS_LAMBDA_EXEC_WRAPPER;
const fileLoggingEnabled =
  process.env.DEBUG_LIVE_SESSIONS === "true" ||
  (!isLambda && process.env.NODE_ENV !== "production");

// NOTE: live-session-debug.log is file-only as of 2026-06. The admin
// session-debug view reads from agent-flow-logger persistence instead.
// The flow log is one line per high-signal event and is far more useful
// for session review than the live-session log's verbose RAW_MSG /
// per-chunk audio entries.

export type SessionContext = {
  sessionId: string;
  debugMode: boolean;
  /** Optional agent label (Observer / Speaker / BoardManager) used in the
   *  three-agent path so the file log + DB rows can distinguish which
   *  Live session a server message or tool call belongs to. */
  agent?: string;
};
export const sessionContextStore = new AsyncLocalStorage<SessionContext>();

/**
 * Run `fn` with logger context bound to the given session. Any
 * logLiveSession / logDualAgent calls inside (or in async work spawned from)
 * `fn` will also write to `session_debug_logs` when `debugMode` is true.
 *
 * `agent` is the optional three-agent-path tag — passing it includes the
 * agent name in each log entry's section header (e.g.
 * `OBSERVER · TOOL CALL transcript`) so concurrent Observer / Speaker
 * traces don't intermix indistinguishably.
 */
export function runInSessionContext<T>(
  sessionId: string,
  debugMode: boolean,
  fn: () => T,
  agent?: string,
): T {
  return sessionContextStore.run({ sessionId, debugMode, agent }, fn);
}

/** Current agent tag (if any) from the surrounding context. Used by the
 *  log formatters to prefix the section name. */
function currentAgentTag(): string | undefined {
  return sessionContextStore.getStore()?.agent;
}

function ensureSize(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      fs.writeFileSync(LOG_FILE, ""); // truncate
    }
  } catch { /* ignore */ }
}

/** Log a structured event (JSON data). */
export function logDualAgent(section: string, data: Record<string, any>): void {
  if (!fileLoggingEnabled) return;
  const tag = currentAgentTag();
  const displaySection = tag ? `[${tag}] ${section}` : section;
  try {
    ensureSize();
    const timestamp = new Date().toISOString();
    const entry = `\n${"=".repeat(60)}\n[${timestamp}] ${displaySection}\n${"-".repeat(40)}\n${JSON.stringify(data, null, 2)}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch {
    /* ignore logging errors */
  }
  // File-only — admin debug view reads from agent-flow-logger DB rows.
}

// Coalesce identical consecutive entries — useful for noisy events like pcm_audio
let lastEntry: { section: string; content: string; count: number; firstTimestamp: string; lastTimestamp: string } | null = null;

function flushCoalesced(): void {
  if (!lastEntry || lastEntry.count <= 1) {
    lastEntry = null;
    return;
  }
  try {
    const entry = `\n${"=".repeat(80)}\n[${lastEntry.firstTimestamp} → ${lastEntry.lastTimestamp}] ${lastEntry.section} (×${lastEntry.count})\n${"─".repeat(80)}\n${lastEntry.content}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch { /* ignore */ }
  lastEntry = null;
}

/**
 * Log a free-form event (prompt text, tool declarations, etc.).
 * Pass truncate=true at session start to get a clean log.
 * Identical consecutive entries are coalesced into a single line with a count.
 */
export function logLiveSession(section: string, content: string, truncate = false): void {
  if (!fileLoggingEnabled) return;
  const tag = currentAgentTag();
  const displaySection = tag ? `[${tag}] ${section}` : section;
  try {
    if (truncate) {
      flushCoalesced();
      fs.writeFileSync(LOG_FILE, ""); // fresh file for new session
    }
    ensureSize();
    const timestamp = new Date().toISOString();

    // Coalesce identical consecutive entries (same agent + section + content).
    if (lastEntry && lastEntry.section === displaySection && lastEntry.content === content) {
      lastEntry.count++;
      lastEntry.lastTimestamp = timestamp;
      return;
    }
    // Flush previous coalesced run if it had repeats
    flushCoalesced();

    const entry = `\n${"=".repeat(80)}\n[${timestamp}] ${displaySection}\n${"─".repeat(80)}\n${content}\n`;
    fs.appendFileSync(LOG_FILE, entry);
    lastEntry = { section: displaySection, content, count: 1, firstTimestamp: timestamp, lastTimestamp: timestamp };
  } catch {
    /* ignore logging errors */
  }
  // File-only — admin debug view reads from agent-flow-logger DB rows.
}
