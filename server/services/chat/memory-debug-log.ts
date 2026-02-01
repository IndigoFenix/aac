/**
 * Temporary debug logger for memory operations.
 * Writes to server/memory-debug.log so it can be inspected.
 * Remove this file once debugging is complete.
 */

import { appendFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, '..', '..', 'memory-debug.log');

let initialized = false;

function ensureInit() {
  if (!initialized) {
    writeFileSync(LOG_FILE, `=== Memory Debug Log - ${new Date().toISOString()} ===\n\n`);
    initialized = true;
  }
}

export function memDebug(label: string, data?: any) {
  ensureInit();
  const timestamp = new Date().toISOString().slice(11, 23);
  let line = `[${timestamp}] ${label}`;
  if (data !== undefined) {
    try {
      line += ': ' + JSON.stringify(data, null, 2);
    } catch {
      line += ': [unserializable]';
    }
  }
  line += '\n';
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Ignore write errors
  }
}

export function memDebugSeparator(title?: string) {
  ensureInit();
  const sep = title
    ? `\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}\n`
    : `\n${'─'.repeat(60)}\n`;
  try {
    appendFileSync(LOG_FILE, sep);
  } catch {}
}
