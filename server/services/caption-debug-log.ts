/**
 * Caption Studio debug logger — logs the full LLM prompts + raw responses for
 * the video-caption pipeline (idea pass + glyph pass) to a file in development
 * only. TEMPORARY diagnostic for the glyph-generation work; safe to remove once
 * the `gen:` flow is confirmed.
 *
 * The prompts embed the video transcript. Gated by the shared predicate in
 * ./file-debug-log.ts (formerly gated on isLambda alone, which is false on ECS).
 *
 * Writes to `<repo>/server/caption-debug.log`, fresh per server start, capped.
 */

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fileDebugLoggingEnabled, safeAppend, safeTruncate } from "./file-debug-log";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "caption-debug.log");
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

let sessionStarted = false;

function ensureSize(): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      safeTruncate(LOG_FILE); // truncate
    }
  } catch { /* ignore */ }
}

export function captionDebug(label: string, data?: unknown): void {
  if (!fileDebugLoggingEnabled) return;
  try {
    if (!sessionStarted) {
      sessionStarted = true;
      safeTruncate(LOG_FILE); // fresh file per process
    }
    ensureSize();
    const timestamp = new Date().toISOString().slice(11, 23);
    const payload =
      data !== undefined
        ? typeof data === "string"
          ? data
          : JSON.stringify(data, null, 2)
        : "";
    const entry = `[${timestamp}] ${label}${payload ? "\n" + payload : ""}\n`;
    safeAppend(LOG_FILE, entry);
  } catch { /* ignore */ }
}

export function captionDebugSeparator(title?: string): void {
  if (!fileDebugLoggingEnabled) return;
  try {
    const line = title
      ? `\n${"=".repeat(70)}\n  ${title}\n${"=".repeat(70)}\n`
      : `\n${"─".repeat(70)}\n`;
    safeAppend(LOG_FILE, line);
  } catch { /* ignore */ }
}
