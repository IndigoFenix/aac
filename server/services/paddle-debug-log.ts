/**
 * Paddle webhook / fulfillment logger.
 *
 * Billing needs a trail: when a customer says "I paid and got nothing", the
 * question is which event arrived, what price id it carried, and what we
 * resolved it to. Those lines go to a FILE rather than the console, per
 * CLAUDE.md, and through the shared gate in ./file-debug-log.ts so nothing is
 * written in production (where the root filesystem may be read-only, and where
 * the durable record is the `paddle_events` table anyway — that row carries the
 * status, the reason and the raw payload with no gate on it).
 *
 * Writes to `<repo>/server/paddle-debug.log`, appended across restarts (unlike
 * the caption log): a webhook problem is usually noticed after the fact, so
 * truncating on boot would throw away the evidence.
 */

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fileDebugLoggingEnabled, safeAppend, safeTruncate } from "./file-debug-log";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "paddle-debug.log");
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function ensureSize(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      safeTruncate(LOG_FILE);
    }
  } catch {
    /* ignore */
  }
}

/** Append one line (plus optional structured payload) to the Paddle log. */
export function paddleLog(label: string, data?: unknown): void {
  if (!fileDebugLoggingEnabled) return;
  try {
    ensureSize();
    const timestamp = new Date().toISOString();
    const payload =
      data === undefined
        ? ""
        : typeof data === "string"
          ? data
          : JSON.stringify(data, null, 2);
    safeAppend(LOG_FILE, `[${timestamp}] ${label}${payload ? "\n" + payload : ""}\n`);
  } catch {
    /* ignore */
  }
}
