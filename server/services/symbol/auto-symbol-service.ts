/**
 * Auto Symbol Service
 *
 * Centralizes all image-key-based symbol resolution and generation.
 * Used by both SyntAACx (session service) and the AAC live relay.
 *
 * Responsibilities:
 * - Prompt rules for image key generation (shared by all prompt builders)
 * - DB lookup: resolve an image key to an existing symbol
 * - Background generation: queue image keys for sequential Gemini generation
 * - Notification callback: callers provide a function to be notified when a symbol is ready
 */

import { EventEmitter } from "events";
import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { customSymbolRepository } from "../../repositories/customSymbolRepository";
import { customSymbolService } from "./custom-symbol-service";
import { generateSymbolImage, type SymbolGenerationCost } from "./symbol-generator";
import type { CustomSymbol } from "@shared/schema";

// ---------------------------------------------------------------------------
// Symbol event bus — notifies SSE connections when symbols are generated
// ---------------------------------------------------------------------------

export const symbolEvents = new EventEmitter();
symbolEvents.setMaxListeners(50);

// ---------------------------------------------------------------------------
// Debug file logger — writes to server/symbol-generation-debug.log
// ---------------------------------------------------------------------------

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const LOG_FILE = join(__dirname_local, "..", "..", "symbol-generation-debug.log");
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB

function debugLog(section: string, message: string): void {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      fs.writeFileSync(LOG_FILE, "");
    }
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] [${section}] ${message}\n`);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Cost logging — logs generation costs to the debug file
// ---------------------------------------------------------------------------

function logCost(imageKey: string, cost: SymbolGenerationCost): void {
  const { promptRefinement: pr, imageGeneration: ig } = cost;
  const prCached = pr.cachedTokens > 0 ? ` (${pr.cachedTokens} cached)` : "";
  debugLog("COST", [
    `imageKey="${imageKey}"`,
    `refinement: ${pr.provider}/${pr.model} in=${pr.inputTokens}${prCached} out=${pr.outputTokens}`,
    `image: ${ig.provider}/${ig.model} in=${ig.inputTokens} out=${ig.outputTokens}`,
  ].join(" | "));
}

// ---------------------------------------------------------------------------
// Prompt constants — single source of truth for image key rules
// ---------------------------------------------------------------------------

const IMAGE_KEY_RULES= `
Image keys must follow these rules:
- Always in English, unambiguous single concept
- Use lowercase with underscores for spaces
- Symbols should describe clear physical objects representing the button's meaning. For example, "person_running", "man_petting_dog".
- When describing feelings or abstract concepts, use a concrete metaphor: "feeling_tired" → "person_yawning", "play_activity" → "child_playing_with_toy".
- Clarify ambiguous words with underscores: "bat_animal" not "bat", "musical_note" not "note"
- No proper nouns except globally known concepts (countries, etc.)
- Omit imageKey for navigation/utility buttons (Back, Home)
Image keys are used to auto-generate AAC symbol images. Emojis are used as a fallback option when image generation is unavailable, but the imageKey is the primary source for symbol generation.`;

/** Image key rules for inclusion in LLM system prompts */
export const IMAGE_KEY_PROMPT_RULES = `The imageKey is an unambiguous English key used to generate symbol images.${IMAGE_KEY_RULES}`;

/** Image key rules formatted for the SyntAACx board creator prompt */
export const IMAGE_KEY_BOARD_PROMPT = `**Image Key:** The imageKey field is used to look up or auto-generate symbol images. REQUIRED for every content button — NEVER omit imageKey. Every content button MUST have both iconRef (emoji fallback) AND imageKey (symbol generation).${IMAGE_KEY_RULES}`;

/** Image key rules formatted for the AAC live button format instruction */
export const IMAGE_KEY_LIVE_PROMPT = `IMPORTANT — Button format: label|icon|imageKey|sentence (e.g., "Water|💧|water_drop|I would like some water", "Play|🎮|I want to play").
${IMAGE_KEY_PROMPT_RULES}`;

// ---------------------------------------------------------------------------
// Symbol resolution — look up existing symbol by key
// ---------------------------------------------------------------------------

/**
 * Look up an existing symbol by image key.
 * Returns the symbol if found, undefined otherwise.
 */
export async function resolveSymbolByKey(imageKey: string): Promise<CustomSymbol | undefined> {
  return customSymbolRepository.getSymbolByKey(imageKey);
}

/**
 * Resolve image keys on a list of buttons in-place.
 * Sets symbolPath for buttons whose imageKey matches an existing symbol.
 * Returns the list of unresolved keys (for generation).
 */
export async function resolveImageKeys(
  buttons: Array<{ imageKey?: string; symbolPath?: string; [k: string]: any }>,
  opts?: {
    /** How to format the symbolPath (default: api-path) */
    symbolPathFormat?: "api-path" | "internal";
    /** Only use approved symbols */
    approvedOnly?: boolean;
    /** Also use unapproved symbols */
    useUnapproved?: boolean;
  },
): Promise<string[]> {
  const unresolved: string[] = [];
  const format = opts?.symbolPathFormat ?? "api-path";
  const keysToResolve = buttons.filter(b => b.imageKey && !b.symbolPath).map(b => b.imageKey);
  debugLog("resolveImageKeys", `Resolving ${keysToResolve.length} keys: ${keysToResolve.join(", ")} (format=${format}, useUnapproved=${opts?.useUnapproved})`);

  for (const button of buttons) {
    if (!button.imageKey || button.symbolPath) continue;

    try {
      const existing = await customSymbolRepository.getSymbolByKey(button.imageKey);
      if (existing) {
        const canUse = existing.isApproved || opts?.useUnapproved;
        if (canUse) {
          button.symbolPath = format === "internal"
            ? `__SYMBOL__:${existing.id}`
            : `/api/custom-symbols/${existing.id}/image`;
          debugLog("resolveImageKeys", `Resolved "${button.imageKey}" → ${button.symbolPath}`);
        } else {
          unresolved.push(button.imageKey);
          debugLog("resolveImageKeys", `Found "${button.imageKey}" but cannot use (approved=${existing.isApproved})`);
        }
      } else {
        unresolved.push(button.imageKey);
        debugLog("resolveImageKeys", `No symbol found for "${button.imageKey}"`);
      }
    } catch (err: any) {
      unresolved.push(button.imageKey);
      debugLog("resolveImageKeys", `Error looking up "${button.imageKey}": ${err?.message}`);
    }
  }

  debugLog("resolveImageKeys", `Done. Resolved ${keysToResolve.length - unresolved.length}, unresolved ${unresolved.length}: ${unresolved.join(", ")}`);
  return unresolved;
}

// ---------------------------------------------------------------------------
// Background generation queue
// ---------------------------------------------------------------------------

interface GenerationJob {
  imageKey: string;
  /** Called when a symbol is generated or found */
  onReady?: (imageKey: string, symbol: CustomSymbol) => void;
}

let queue: GenerationJob[] = [];
let busy = false;

/**
 * Queue image keys for sequential background generation.
 * Does not block — symbols are generated one at a time with rate limiting.
 */
export function queueSymbolGeneration(
  imageKeys: string[],
  onReady?: (imageKey: string, symbol: CustomSymbol) => void,
): void {
  debugLog("queueGeneration", `Queuing ${imageKeys.length} keys: ${imageKeys.join(", ")} (hasCallback=${!!onReady})`);
  for (const imageKey of imageKeys) {
    queue.push({ imageKey, onReady });
  }
  if (!busy) {
    processQueue().catch(err =>
      console.error("[AutoSymbolService] Queue processing error:", err)
    );
  }
}

async function processQueue(): Promise<void> {
  busy = true;
  let generated = 0;

  while (queue.length > 0) {
    const job = queue.shift()!;

    // Rate limit: 4s between generations
    if (generated > 0) {
      await new Promise(r => setTimeout(r, 4000));
    }

    try {
      // Double-check not already generated
      const existing = await customSymbolRepository.getSymbolByKey(job.imageKey);
      if (existing) {
        debugLog("processQueue", `"${job.imageKey}" already exists → ${existing.id}`);
        job.onReady?.(job.imageKey, existing);
        symbolEvents.emit("symbol:ready", {
          imageKey: job.imageKey,
          symbolId: existing.id,
          symbolPath: `/api/custom-symbols/${existing.id}/image`,
        });
        continue;
      }

      debugLog("processQueue", `Generating "${job.imageKey}"...`);
      const result = await generateSymbolImage(job.imageKey);
      const symbol = await customSymbolService.createSymbol(result.imageBuffer, {
        key: job.imageKey,
        description: job.imageKey.replace(/_/g, " "),
        isPublic: true,
        isApproved: false,
      });
      generated++;
      logCost(job.imageKey, result.cost);
      debugLog("processQueue", `Generated "${job.imageKey}" → ${symbol.id} (${generated} total)`);
      debugLog("processQueue", `FULL REFINED PROMPT for "${job.imageKey}": ${result.refinedPrompt}`);
      console.log(`[AutoSymbolService] Generated "${job.imageKey}" → ${symbol.id} (${generated} total)`);
      console.log(`[AutoSymbolService] Refined prompt for "${job.imageKey}": ${result.refinedPrompt}`);
      job.onReady?.(job.imageKey, symbol);
      symbolEvents.emit("symbol:ready", {
        imageKey: job.imageKey,
        symbolId: symbol.id,
        symbolPath: `/api/custom-symbols/${symbol.id}/image`,
      });
    } catch (err: any) {
      const isQuota = err?.status === 429
        || err?.message?.includes("quota")
        || err?.message?.includes("RESOURCE_EXHAUSTED");
      if (isQuota) {
        debugLog("processQueue", `Quota exhausted after ${generated} — clearing queue (${queue.length} remaining)`);
        console.warn(`[AutoSymbolService] Quota exhausted after ${generated} — clearing queue (${queue.length} remaining)`);
        symbolEvents.emit("symbol:failed", { imageKey: job.imageKey, error: "Quota exhausted", isQuota: true });
        for (const remaining of queue) {
          symbolEvents.emit("symbol:failed", { imageKey: remaining.imageKey, error: "Quota exhausted", isQuota: true });
        }
        queue = [];
        break;
      }
      debugLog("processQueue", `Failed "${job.imageKey}": ${err?.message || err}`);
      console.error(`[AutoSymbolService] Failed to generate "${job.imageKey}":`, err?.message || err);
      symbolEvents.emit("symbol:failed", { imageKey: job.imageKey, error: err?.message || "Generation failed", isQuota: false });
    }
  }

  busy = false;
}
