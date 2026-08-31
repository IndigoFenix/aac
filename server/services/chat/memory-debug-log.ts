/**
 * Memory debug logger — logs to a file in development only.
 * Captures all memory system interactions for debugging: the whole Student_*
 * memory object, the rendered memory prompt, manageMemory payloads. PHI.
 * Gated by the shared predicate in ../file-debug-log.ts (formerly gated on
 * isLambda alone, which is false on ECS — so it wrote in production).
 */

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fileDebugLoggingEnabled, safeAppend, safeTruncate } from "../file-debug-log";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "..", "memory-debug.log");
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

let sessionStarted = false;

function ensureSize(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      safeTruncate(LOG_FILE); // truncate
    }
  } catch { /* ignore */ }
}

export function memDebug(label: string, data?: any) {
  if (!fileDebugLoggingEnabled) return;
  try {
    if (!sessionStarted) {
      sessionStarted = true;
      safeTruncate(LOG_FILE); // fresh file
    }
    ensureSize();
    const timestamp = new Date().toISOString().slice(11, 23);
    const payload = data !== undefined
      ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2))
      : '';
    const entry = `[${timestamp}] ${label}${payload ? '\n' + payload : ''}\n`;
    safeAppend(LOG_FILE, entry);
  } catch { /* ignore */ }
}

export function memDebugSeparator(title?: string) {
  if (!fileDebugLoggingEnabled) return;
  try {
    const line = title
      ? `\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}\n`
      : `\n${"─".repeat(60)}\n`;
    safeAppend(LOG_FILE, line);
  } catch { /* ignore */ }
}
