// server/services/dual-agent/interactive-agent.ts
// Fast, lightweight Interactive Agent for quick AAC responses

import type {
  DualAgentConfig,
} from "./types";
import type {
  ChatProvider,
} from "../providers/streaming-provider";
import { resolveEmoji } from "@shared/emoji-registry";
import { stripBrackets } from "@shared/glyph-compositor.js";

/**
 * Parse board button format. NEW field order:
 *   sentence|glyph|fallback|label[|rowSpan|colSpan]
 *
 * Fields:
 *   - sentence: natural first-person phrase voiced when pressed.
 *   - glyph:    composed glyph string (slots joined by `+`, modifiers with
 *               `.`, composable hosts with `(payload)`, tone tags with `#`).
 *               Slot keys may be emojis, snake_case imageKeys (server may
 *               auto-generate images), `symbol:ID`, or `face:ID`.
 *   - fallback: same glyph syntax, but slots may ONLY be emojis,
 *               `symbol:ID`, or `face:ID` — no imageKeys. Used when
 *               `glyph` rendering can't complete (e.g. all slots are
 *               waiting on generation).
 *   - label:    short on-button text. May begin with "[GUESS]" for
 *               guessing-mode buttons.
 *
 * For backward compat with the renderer's existing visual priority chain,
 * the parser ALSO derives `iconRef`, `symbolPath`, and `imageKey` from
 * the glyph/fallback fields when they're single-slot:
 *   - fallback is a bare emoji → iconRef = emoji
 *   - fallback is `symbol:ID`  → symbolPath = `__SYMBOL__:ID`
 *   - fallback is `face:ID`    → symbolPath = `__FACE__:ID`
 *   - glyph is a bare snake_case key → imageKey = key (single-concept
 *     button — same as legacy imageKey, may trigger symbol generation)
 *
 * Examples:
 *   "I want water|i_me+want+water|👤+🤲+💧|Water"
 *   "I want a hug|i_me+want+hug|🤗|Hug"
 *   "It's my turn|turn.my|👉|My turn"
 *   "Hello!|hello|👋|Hi"           (single-concept)
 *   "Big button|big|🎯|Press!|2|2" (rowSpan/colSpan trailing)
 */
export function parseBoardButtons(content: string): Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; glyph?: string; glyphFallback?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }> {
  const buttons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; glyph?: string; glyphFallback?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }> = [];
  const items = content.split(',');

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('|');

    // Degenerate input: a bare label with no pipes at all.
    if (parts.length === 1) {
      buttons.push({ label: trimmed, iconRef: "fas fa-comment" });
      continue;
    }

    let sentence = parts[0]?.trim() || undefined;
    const glyph = parts[1]?.trim() || undefined;
    const glyphFallback = parts[2]?.trim() || undefined;
    let label = parts[3]?.trim() || "";

    // Tolerate AI undershoot — if there are fewer than 4 fields, treat the
    // FIRST field as the label (this matches the most common "label only"
    // and "label|icon" shapes seen in older prompts).
    if (parts.length < 4 && !label) {
      label = sentence || "";
      sentence = undefined;
    }
    if (!label) continue;

    // Detect [GUESS] prefix for guessing-mode final guesses.
    let buttonType: "guess" | "category" | undefined;
    if (label.startsWith("[GUESS]")) {
      label = label.substring(7).trim();
      buttonType = "guess";
    }

    // Optional trailing rowSpan/colSpan in fields 4 / 5.
    const rawRowSpan = parseInt(parts[4]?.trim(), 10);
    const rawColSpan = parseInt(parts[5]?.trim(), 10);
    const rowSpan = rawRowSpan >= 2 ? rawRowSpan : undefined;
    const colSpan = rawColSpan >= 2 ? rawColSpan : undefined;

    // ── Derive iconRef / symbolPath / imageKey for renderer fallback ────
    let iconRef = "fas fa-comment";
    let symbolPath: string | undefined;
    let imageKey: string | undefined;

    if (glyphFallback) {
      // Single-slot fallback → pull an iconRef or symbolPath from it.
      const fbSlots = glyphFallback.split('+').map(s => s.trim()).filter(Boolean);
      if (fbSlots.length === 1) {
        const slotMain = stripBrackets(fbSlots[0].split('.')[0].split('(')[0]);
        if (slotMain.startsWith("face:")) {
          symbolPath = `__FACE__:${slotMain.substring(5).trim()}`;
        } else if (slotMain.startsWith("symbol:")) {
          symbolPath = `__SYMBOL__:${slotMain.substring(7).trim()}`;
        } else if (slotMain) {
          iconRef = slotMain;
        }
      }
      // Multi-slot fallback: leave iconRef as default. The renderer prefers
      // glyphFallback over iconRef when it's set, so this is fine.
    }

    if (glyph) {
      const glyphSlots = glyph.split('+').map(s => s.trim()).filter(Boolean);
      if (glyphSlots.length === 1) {
        // Brackets around an imageKey are a prompt hint, not data — strip
        // them so the downstream emoji/registry/generator lookups see the
        // bare key the AI intended.
        const slotMain = stripBrackets(glyphSlots[0].split('.')[0].split('(')[0]);
        // An imageKey is a bare snake_case identifier — not an emoji, not a
        // symbol/face ref. The existing auto-symbol pipeline picks this up
        // and queues generation if no matching custom symbol exists yet.
        const isEmoji = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(slotMain);
        if (slotMain && !isEmoji && !slotMain.startsWith("face:") && !slotMain.startsWith("symbol:")) {
          imageKey = slotMain;
          // Emoji-registry swap: if the imageKey has a known emoji and the
          // fallback didn't already set an iconRef, use the emoji and skip
          // generation entirely.
          if (iconRef === "fas fa-comment") {
            const emojiSwap = resolveEmoji(imageKey);
            if (emojiSwap) {
              iconRef = emojiSwap;
              imageKey = undefined;
            }
          }
        }
      }
    }

    buttons.push({
      label,
      iconRef,
      symbolPath,
      imageKey,
      glyph,
      glyphFallback,
      sentence,
      buttonType,
      rowSpan,
      colSpan,
    });
  }

  return buttons;
}

/**
 * Interactive Agent
 *
 * Handles fast, real-time interactions with the user.
 * Uses 4o-mini for quick responses.
 * Can trigger special commands (starting with #) to hand off to Monitor.
 */
export class InteractiveAgent {
  private config: DualAgentConfig;
  private systemPrompt: string;
  private chatProvider: ChatProvider;

  constructor(systemPrompt: string, config: DualAgentConfig, chatProvider: ChatProvider) {
    this.systemPrompt = systemPrompt;
    this.config = config;
    this.chatProvider = chatProvider;
  }

  /**
   * Update the system prompt (called by Monitor)
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Get the current system prompt
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }
}

/**
 * Create a new Interactive Agent with the given prompt
 */
export function createInteractiveAgent(
  systemPrompt: string,
  config: DualAgentConfig,
  chatProvider: ChatProvider
): InteractiveAgent {
  return new InteractiveAgent(systemPrompt, config, chatProvider);
}
