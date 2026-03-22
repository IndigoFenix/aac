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

import { customSymbolRepository } from "../../repositories/customSymbolRepository";
import { customSymbolService } from "./custom-symbol-service";
import { generateSymbolImage } from "./symbol-generator";
import type { CustomSymbol } from "@shared/schema";

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
export const IMAGE_KEY_BOARD_PROMPT = `**Image Key:** The imageKey field is used to look up or auto-generate symbol images. Required for every content button.${IMAGE_KEY_RULES}`;

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
        } else {
          // Symbol exists but can't be used (e.g., unapproved) — still mark
          // as unresolved so it can be re-queued for generation notification
          unresolved.push(button.imageKey);
        }
      } else {
        unresolved.push(button.imageKey);
      }
    } catch {
      unresolved.push(button.imageKey);
    }
  }

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
        job.onReady?.(job.imageKey, existing);
        continue;
      }

      const imageBuffer = await generateSymbolImage(job.imageKey.replace(/_/g, " "));
      const symbol = await customSymbolService.createSymbol(imageBuffer, {
        key: job.imageKey,
        description: job.imageKey.replace(/_/g, " "),
        isPublic: true,
        isApproved: false,
      });
      generated++;
      console.log(`[AutoSymbolService] Generated "${job.imageKey}" → ${symbol.id} (${generated} total)`);
      job.onReady?.(job.imageKey, symbol);
    } catch (err: any) {
      const isQuota = err?.status === 429
        || err?.message?.includes("quota")
        || err?.message?.includes("RESOURCE_EXHAUSTED");
      if (isQuota) {
        console.warn(`[AutoSymbolService] Quota exhausted after ${generated} — clearing queue (${queue.length} remaining)`);
        queue = [];
        break;
      }
      console.error(`[AutoSymbolService] Failed to generate "${job.imageKey}":`, err?.message || err);
    }
  }

  busy = false;
}
