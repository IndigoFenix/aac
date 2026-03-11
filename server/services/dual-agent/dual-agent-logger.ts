// server/services/dual-agent/dual-agent-logger.ts
// Single debug log file for the dual-agent / live-relay system.

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "..", "live-session-debug.log");
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

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

/**
 * Log a free-form event (prompt text, tool declarations, etc.).
 * Pass truncate=true at session start to get a clean log.
 */
export function logLiveSession(section: string, content: string, truncate = false): void {
  try {
    if (truncate) {
      fs.writeFileSync(LOG_FILE, ""); // fresh file for new session
    }
    ensureSize();
    const timestamp = new Date().toISOString();
    const entry = `\n${"=".repeat(80)}\n[${timestamp}] ${section}\n${"─".repeat(80)}\n${content}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch {
    /* ignore logging errors */
  }
}
