// server/services/dual-agent/dual-agent-logger.ts
// Single debug log file for the dual-agent / live-relay system.
//
// When called inside `runInSessionContext(sessionId, debugMode, fn)`, log
// entries are also persisted to the `session_debug_logs` table so admins can
// review a specific session's trace from the UI (Session History → Debug Log).
// High-volume events (audio chunks, frame grids) are dropped at the DB
// boundary — they still go to the file for local debugging.

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "async_hooks";
import { db } from "../../db";
import { sessionDebugLogs } from "../../../shared/schema-private";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "..", "live-session-debug.log");
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

// Sections that fire many times per second; dropped from DB persistence.
// They still go to the file (where they're coalesced).
const NOISY_SECTIONS = new Set<string>([
  "pcm_audio",
  "FRAME_GRID",
  "FRAME_GRID DROPPED",
  "GEMINI → audioChunk",
  "MINIMAL: GEMINI → audioChunk",
  "RAW_MSG",
  "MINIMAL: WS ping",
  "MINIMAL: WS pong",
  "MINIMAL: WS RAW MESSAGE",
]);

type SessionContext = {
  sessionId: string;
  debugMode: boolean;
  /** Optional agent label (Observer / Speaker / BoardManager) used in the
   *  three-agent path so the file log + DB rows can distinguish which
   *  Live session a server message or tool call belongs to. */
  agent?: string;
};
const sessionContextStore = new AsyncLocalStorage<SessionContext>();

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

function persistToDb(section: string, content: string): void {
  const ctx = sessionContextStore.getStore();
  if (!ctx || !ctx.debugMode) return;
  if (NOISY_SECTIONS.has(section)) return;
  // Fire-and-forget; do not await. Logging errors must never break the relay.
  db.insert(sessionDebugLogs)
    .values({ sessionId: ctx.sessionId, section, content })
    .catch(() => { /* swallow — admin will see file but not DB row */ });
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
  persistToDb(displaySection, JSON.stringify(data, null, 2));
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
  persistToDb(displaySection, content);
}
