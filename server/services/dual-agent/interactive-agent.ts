// server/services/dual-agent/interactive-agent.ts
// Fast, lightweight Interactive Agent for quick AAC responses

import type {
  DualAgentConfig,
} from "./types";
import type {
  ChatProvider,
} from "../providers/streaming-provider";
import { resolveEmoji, isEmoji } from "@shared/emoji-registry";
import { stripBrackets } from "@shared/glyph-compositor.js";
import {
  parseSuggestionKey,
  isValidSuggestionKey,
  getSuggestionEntry,
} from "@shared/guessing-mode/suggestion-registry.js";

/**
 * Parse the SENTENCE BUTTON wire format. Field order:
 *   speech|sentence|fallback|label[|rowSpan|colSpan]
 *
 * Fields:
 *   - speech:   natural first-person SENTENCE the TTS voices when pressed.
 *               (The variable below is still called `sentence` for backwards
 *               compatibility; it carries the speech.)
 *   - sentence: visual encoding — GLYPHs joined by `+`, MODIFIER SYMBOLs
 *               attached with `.`, sentence-level OPERATORs appended with
 *               `#`. SYMBOLs may be canonical registry keys, raw emojis,
 *               `generate:snake_case` (async-generated), `symbol:ID`, or
 *               `face:ID`. (The variable below is still called `glyph`.)
 *   - fallback: same `sentence` encoding but with NO `generate:` SYMBOLs.
 *               Used while generated SYMBOLs are loading or if generation
 *               fails.
 *   - label:    short on-button text. May begin with "[GUESS]" for
 *               guessing-mode SENTENCE BUTTONs.
 *
 * For backward compat with the renderer's existing visual priority chain,
 * the parser ALSO derives `iconRef`, `symbolPath`, and `imageKey` from the
 * sentence/fallback fields when they're a single-SYMBOL SENTENCE:
 *   - fallback is a bare emoji → iconRef = emoji
 *   - fallback is `symbol:ID`  → symbolPath = `__SYMBOL__:ID`
 *   - fallback is `face:ID`    → symbolPath = `__FACE__:ID`
 *   - sentence is a bare snake_case key → imageKey = key (single-concept
 *     SENTENCE — same as legacy imageKey, may trigger symbol generation)
 *
 * Examples:
 *   "I want water|i_me+want+💧||Water"
 *   "I want a hug|i_me+want+🤗||Hug"
 *   "It's my turn|turn.my||My turn"
 *   "Hello!|hello||Hi"           (single-SYMBOL)
 *   "Big button|big||Press!|2|2" (rowSpan/colSpan trailing)
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
    let glyphFallback: string | undefined;
    let label: string;

    if (parts.length === 3) {
      // AI sometimes emits `sentence|glyph|label` instead of
      // `sentence|glyph||label` — it reads "omit fallback" as dropping the
      // delimiter rather than leaving the field empty. Treat the 3-section
      // shape as fallback-absent; the downstream validator still raises a
      // "fallback required" error when the glyph actually needs one.
      glyphFallback = undefined;
      label = parts[2]?.trim() || "";
    } else {
      glyphFallback = parts[2]?.trim() || undefined;
      label = parts[3]?.trim() || "";
    }

    // Tolerate AI undershoot — for 2-section forms (`label|icon`), the
    // first field is the label, not the sentence.
    if (parts.length < 3 && !label) {
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

// ─── Guessing-mode SUGGESTION button expansion ─────────────────────────────

export interface SuggestionButton {
  label: string;
  iconRef: string;
  symbolPath?: string;
  imageKey?: string;
  glyph?: string;
  glyphFallback?: string;
  sentence?: string;
  buttonType?: "guess" | "category" | "suggestion";
  suggestionKey?: string;
  rowSpan?: number;
  colSpan?: number;
}

/**
 * Expand one `suggestion:<dim>:<value>` key into a full board button using the
 * shared suggestion registry. Returns null for unknown/invalid keys. The icon
 * is an emoji when one exists (rendered directly); otherwise the snake_case
 * imageKey is routed through the normal symbol-generation pipeline, with a
 * neutral placeholder shown until the generated image lands.
 */
export function expandSuggestionKey(key: string): SuggestionButton | null {
  if (!isValidSuggestionKey(key)) return null;
  const parsed = parseSuggestionKey(key);
  if (!parsed) return null;
  const entry = getSuggestionEntry(parsed.dimension, parsed.value);
  if (!entry) return null;

  const emoji = isEmoji(entry.icon) ? entry.icon : resolveEmoji(entry.icon);
  const base: SuggestionButton = {
    label: entry.labelEn,
    sentence: entry.labelEn,
    buttonType: "suggestion",
    suggestionKey: `suggestion:${parsed.dimension}:${parsed.value}`,
    iconRef: "fas fa-comment",
  };
  if (emoji) {
    base.iconRef = emoji;
    base.glyph = emoji;
    base.glyphFallback = emoji;
  } else {
    base.imageKey = entry.icon;
    base.glyph = `[${entry.icon}]`;
    base.glyphFallback = "🧩"; // neutral placeholder while the icon generates
  }
  return base;
}

/**
 * Split a parsed button list into trusted, already-expanded guessing-mode
 * SUGGESTION buttons and everything else. Suggestion buttons arrive as bare
 * `suggestion:<dim>:<value>` keys (no pipes), which parseBoardButtons leaves as
 * label-only buttons that the structural validator would reject. We detect
 * them here (by label, glyph, or sentence) and expand them via the shared
 * registry so they bypass validation as known-good system content.
 */
export function splitOutSuggestionButtons<
  T extends { label: string; glyph?: string; sentence?: string }
>(buttons: T[]): { others: T[]; suggestions: SuggestionButton[] } {
  const others: T[] = [];
  const suggestions: SuggestionButton[] = [];
  for (const btn of buttons) {
    const candidate = [btn.label, btn.glyph, btn.sentence].find(
      (s): s is string => !!s && isValidSuggestionKey(s.trim()),
    );
    const expanded = candidate ? expandSuggestionKey(candidate.trim()) : null;
    if (expanded) suggestions.push(expanded);
    else others.push(btn);
  }
  return { others, suggestions };
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
