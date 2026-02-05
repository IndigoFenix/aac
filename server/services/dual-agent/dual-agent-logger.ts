// server/services/dual-agent/dual-agent-logger.ts
// Simple file-based debug logger for the dual-agent system

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_FILE = join(__dirname, "..", "..", "dual-agent-debug.log");
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export function logDualAgent(section: string, data: Record<string, any>): void {
  try {
    // Rotate if too large
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      fs.writeFileSync(LOG_FILE, ""); // truncate
    }
    const timestamp = new Date().toISOString();
    const entry = `\n${"=".repeat(60)}\n[${timestamp}] ${section}\n${"-".repeat(40)}\n${JSON.stringify(data, null, 2)}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch {
    /* ignore logging errors */
  }
}
