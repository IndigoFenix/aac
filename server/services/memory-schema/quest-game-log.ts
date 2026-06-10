// server/services/memory-schema/quest-game-log.ts
//
// File logger for quest-game authoring. The clinician chat AI builds games
// over many manageMemory ops + validateQuestGame calls; the console scrolls /
// overwrites during long turns, so we persist the full trace to a file you can
// tail after the fact. Debug aid — safe to delete once authoring is solid.
//
// Output: server/quest-game-debug.log  (gitignored via *.log)
//   [ISO]  EVENT  ::  <compact JSON detail>
//
// Logs: session open (with the open game's certify status), createQuestGame,
// every manageMemory op that touches /Context_QuestGame (action, path, value
// summary, result, and the game's LIVE certify status after the op), and every
// validateQuestGame result.

import fs from "fs";
import path from "path";
import { certifyGoalTreeGame } from "@shared/goal-tree/index";
import type { MemoryProcessor } from "../chat/tool-router";

const LOG_FILE = path.resolve(process.cwd(), "server", "quest-game-debug.log");
const QUEST_FIELD = "Context_QuestGame";

function truncate(value: unknown, max = 800): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s == null) return String(s);
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;
}

export function questGameLog(event: string, detail?: unknown): void {
  try {
    const line =
      `[${new Date().toISOString()}] ${event}` +
      (detail === undefined ? "" : ` :: ${truncate(detail)}`) +
      "\n";
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* logging must never break a chat turn */
  }
}

/** One-line "does this game certify right now" summary for the log. */
export function certifySummary(contentPack: unknown): string {
  if (contentPack === undefined || contentPack === null) return "no game";
  try {
    const r = certifyGoalTreeGame(contentPack);
    if (r.ok) return `OK (plan ${r.solution.plan.length})`;
    return `INVALID [${r.stage}]: ${r.errors.slice(0, 3).join("; ")}`;
  } catch (e) {
    return `certify threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function touchesQuestGame(input: any): boolean {
  const paths: string[] = [];
  if (typeof input?.path === "string") paths.push(input.path);
  if (Array.isArray(input?.paths)) paths.push(...input.paths);
  return paths.some((p) => typeof p === "string" && p.includes(QUEST_FIELD));
}

/**
 * Wraps the memory processor to LOG (never alter) every manageMemory op that
 * touches the quest game, plus the game's certify status after the op. Purely
 * observational — distinct from the (removed) certify-on-write revert.
 */
export function wrapQuestGameLogging(processor: MemoryProcessor): MemoryProcessor {
  return async (input) => {
    const relevant = touchesQuestGame(input);
    const result = await processor(input);
    if (relevant) {
      try {
        const after = result.updatedMemoryValues?.[QUEST_FIELD]?.contentPack;
        questGameLog("memory_op", {
          action: (input as any)?.action,
          path: (input as any)?.path,
          paths: (input as any)?.paths,
          key: (input as any)?.key,
          newKey: (input as any)?.newKey,
          index: (input as any)?.index,
          value: (input as any)?.value,
          results: result.results?.map((r) => ({ target: r.target, action: r.action, ok: r.ok, message: r.message })),
          certify: certifySummary(after),
        });
      } catch {
        /* never break the turn */
      }
    }
    return result;
  };
}
