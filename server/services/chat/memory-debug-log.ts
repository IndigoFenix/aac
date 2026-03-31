/**
 * Memory debug logger — logs to a file in development, no-ops on Lambda.
 * Captures all memory system interactions for debugging.
 */

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isLambda = !!process.env.AWS_LAMBDA_EXEC_WRAPPER;
const LOG_FILE = join(__dirname, "..", "..", "memory-debug.log");
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

let sessionStarted = false;

function ensureSize(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      fs.writeFileSync(LOG_FILE, ""); // truncate
    }
  } catch { /* ignore */ }
}

export function memDebug(label: string, data?: any) {
  if (isLambda) return;
  try {
    if (!sessionStarted) {
      sessionStarted = true;
      fs.writeFileSync(LOG_FILE, ""); // fresh file
    }
    ensureSize();
    const timestamp = new Date().toISOString().slice(11, 23);
    const payload = data !== undefined
      ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2))
      : '';
    const entry = `[${timestamp}] ${label}${payload ? '\n' + payload : ''}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch { /* ignore */ }
}

export function memDebugSeparator(title?: string) {
  if (isLambda) return;
  try {
    const line = title
      ? `\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}\n`
      : `\n${"─".repeat(60)}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* ignore */ }
}
