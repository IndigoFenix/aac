// server/services/dual-agent/dual-agent-logger.ts
// Single debug log file for the dual-agent / live-relay system.

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "..", "live-session-debug.log");
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

function ensureSize(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      fs.writeFileSync(LOG_FILE, ""); // truncate
    }
  } catch { /* ignore */ }
}

/** Log a structured event (JSON data). */
export function logDualAgent(section: string, data: Record<string, any>): void {
  try {
    ensureSize();
    const timestamp = new Date().toISOString();
    const entry = `\n${"=".repeat(60)}\n[${timestamp}] ${section}\n${"-".repeat(40)}\n${JSON.stringify(data, null, 2)}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch {
    /* ignore logging errors */
  }
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
  try {
    if (truncate) {
      flushCoalesced();
      fs.writeFileSync(LOG_FILE, ""); // fresh file for new session
    }
    ensureSize();
    const timestamp = new Date().toISOString();

    // Coalesce identical consecutive entries
    if (lastEntry && lastEntry.section === section && lastEntry.content === content) {
      lastEntry.count++;
      lastEntry.lastTimestamp = timestamp;
      return;
    }
    // Flush previous coalesced run if it had repeats
    flushCoalesced();

    const entry = `\n${"=".repeat(80)}\n[${timestamp}] ${section}\n${"─".repeat(80)}\n${content}\n`;
    fs.appendFileSync(LOG_FILE, entry);
    lastEntry = { section, content, count: 1, firstTimestamp: timestamp, lastTimestamp: timestamp };
  } catch {
    /* ignore logging errors */
  }
}
