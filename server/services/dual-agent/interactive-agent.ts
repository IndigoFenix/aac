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
type ParsedBoardButton = {
  label: string;
  iconRef: string;
  symbolPath?: string;
  imageKey?: string;
  glyph?: string;
  glyphFallback?: string;
  sentence?: string;
  buttonType?: "guess" | "category" | "narrow";
  narrowDimension?: string;
  narrowValue?: string;
  rowSpan?: number;
  colSpan?: number;
};

// ---------------------------------------------------------------------------
// Shared helpers — derive render fields + detect label prefixes. Both the
// structured path (parseStructuredBoardButton) and the pipe path
// (parseSinglePipeButton) reuse these so the two paths can't drift.
// ---------------------------------------------------------------------------

/**
 * Derive renderer hints from `glyph` (visual encoding) and `glyphFallback`.
 * Pulled out so the structured and pipe parsers share one implementation:
 *
 *   - bare emoji glyph                  → iconRef = the emoji
 *   - `symbol:ID` / `face:ID`           → symbolPath = `__SYMBOL__:ID` / `__FACE__:ID`
 *   - bare snake_case (single slot)     → imageKey (triggers symbol generation)
 *   - registered emoji key              → iconRef = the registry emoji, no imageKey
 *
 * Multi-slot glyphs leave iconRef at the default — the renderer prefers the
 * full glyph string to the iconRef when it's set.
 */
function deriveRenderFields(
  glyph: string | undefined,
  glyphFallback: string | undefined,
): { iconRef: string; symbolPath?: string; imageKey?: string } {
  let iconRef = "fas fa-comment";
  let symbolPath: string | undefined;
  let imageKey: string | undefined;

  if (glyphFallback) {
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
  }

  if (glyph) {
    const glyphSlots = glyph.split('+').map(s => s.trim()).filter(Boolean);
    if (glyphSlots.length === 1) {
      const slotMain = stripBrackets(glyphSlots[0].split('.')[0].split('(')[0]);
      const isEmoji = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(slotMain);
      if (slotMain && !isEmoji && !slotMain.startsWith("face:") && !slotMain.startsWith("symbol:")) {
        imageKey = slotMain;
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

  return { iconRef, symbolPath, imageKey };
}

/**
 * Detect [GUESS] / [NARROW:dim] label prefixes and strip them. Returns the
 * cleaned label plus the structural fields the renderer needs.
 *
 * A malformed `[NARROW:]` or `[NARROW:foo]` (no value) falls through to the
 * normal-button path — downstream validation surfaces the bad shape.
 */
function applyLabelPrefix(rawLabel: string): {
  label: string;
  buttonType?: "guess" | "narrow";
  narrowDimension?: string;
  narrowValue?: string;
} {
  if (rawLabel.startsWith("[GUESS]")) {
    return { label: rawLabel.substring(7).trim(), buttonType: "guess" };
  }
  const m = rawLabel.match(/^\[NARROW:([^\]]+)\]\s*(.*)$/);
  if (m) {
    const dim = m[1].trim();
    const value = m[2].trim();
    if (dim && value) {
      return { label: value, buttonType: "narrow", narrowDimension: dim, narrowValue: value };
    }
  }
  return { label: rawLabel };
}

// ---------------------------------------------------------------------------
// Structured input — the canonical path. The AI tool schema declares each
// button as `{speech, sentence, fallback, label, ...}`; this parser reads
// those fields directly. NO pipe round-trip → no comma-fragmentation when
// a field value contains a comma (e.g. Hebrew "כן, אני רוצה לדבר").
// ---------------------------------------------------------------------------

export interface StructuredBoardButton {
  /** Natural-language SENTENCE the TTS voices on press (stored as `.sentence`
   *  on the parsed button — naming is unfortunate but matches the renderer). */
  speech?: unknown;
  /** Visual GLYPH encoding (stored as `.glyph` on the parsed button). */
  sentence?: unknown;
  /** Visual fallback encoding (stored as `.glyphFallback`). */
  fallback?: unknown;
  /** Short on-button text. May carry [GUESS] / [NARROW:] prefixes. */
  label?: unknown;
  rowSpan?: unknown;
  colSpan?: unknown;
  /** Special-kind marker (wordfinder / more) — handled by the caller before
   *  reaching this parser. Accepted in either casing for tolerance. */
  buttonType?: unknown;
  button_type?: unknown;
}

export function parseStructuredBoardButton(input: unknown): ParsedBoardButton | null {
  if (!input || typeof input !== "object") return null;
  const o = input as StructuredBoardButton;

  const speech = typeof o.speech === "string" ? o.speech.trim() : "";
  const glyph = typeof o.sentence === "string" ? o.sentence.trim() : "";
  const glyphFallback = typeof o.fallback === "string" ? o.fallback.trim() : "";
  const rawLabel = typeof o.label === "string" ? o.label.trim() : "";
  if (!rawLabel) return null;

  const prefix = applyLabelPrefix(rawLabel);
  const { iconRef, symbolPath, imageKey } = deriveRenderFields(
    glyph || undefined,
    glyphFallback || undefined,
  );

  const rowSpan = typeof o.rowSpan === "number" && o.rowSpan >= 2 ? o.rowSpan : undefined;
  const colSpan = typeof o.colSpan === "number" && o.colSpan >= 2 ? o.colSpan : undefined;

  return {
    label: prefix.label,
    iconRef,
    symbolPath,
    imageKey,
    glyph: glyph || undefined,
    glyphFallback: glyphFallback || undefined,
    sentence: speech || undefined,
    buttonType: prefix.buttonType,
    narrowDimension: prefix.narrowDimension,
    narrowValue: prefix.narrowValue,
    rowSpan,
    colSpan,
  };
}

/**
 * Dispatcher — branch by input shape. Object inputs use the structured
 * parser; string inputs use the legacy pipe parser. Lets callers accept
 * either format without caring which it is.
 *
 * The string path is RETAINED only for legacy compatibility (tests, older
 * AI prompts). New tool schemas declare structured arrays; route those
 * directly via `parseStructuredBoardButton` for clarity.
 */
export function parseBoardButton(input: unknown): ParsedBoardButton | null {
  if (typeof input === "string") return parseSinglePipeButton(input);
  if (input && typeof input === "object") return parseStructuredBoardButton(input);
  return null;
}

/**
 * LEGACY pipe parser — parse ONE pipe-encoded button string. Retained for
 * older code paths (tests, the legacy comma-separated multi-button list).
 * New code should pass structured objects through
 * `parseStructuredBoardButton` instead.
 *
 * Comma-split was deliberately moved up into `parseBoardButtons` so a
 * comma inside a field (e.g. Hebrew "כן, אני רוצה לדבר") doesn't
 * fragment a single button when callers pass it here directly.
 */
export function parseSinglePipeButton(input: string): ParsedBoardButton | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('|');

  // Degenerate input: a bare label with no pipes at all.
  if (parts.length === 1) {
    return { label: trimmed, iconRef: "fas fa-comment" };
  }

  let speech = parts[0]?.trim() || "";
  let glyph = parts[1]?.trim() || "";
  let glyphFallback = "";
  let label: string;

  if (parts.length === 3) {
    // AI sometimes emits `sentence|glyph|label` instead of
    // `sentence|glyph||label` — it reads "omit fallback" as dropping the
    // delimiter rather than leaving the field empty. Treat the 3-section
    // shape as fallback-absent.
    label = parts[2]?.trim() || "";
  } else {
    glyphFallback = parts[2]?.trim() || "";
    label = parts[3]?.trim() || "";
  }

  // Tolerate AI undershoot — for 2-section forms (`label|icon`), the
  // first field is the label, not the speech.
  if (parts.length < 3 && !label) {
    label = speech;
    speech = "";
  }
  if (!label) return null;

  const rawRowSpan = parseInt(parts[4]?.trim(), 10);
  const rawColSpan = parseInt(parts[5]?.trim(), 10);

  // Delegate to the structured parser so the derivation + label-prefix
  // logic stays in one place and the two paths can't drift.
  return parseStructuredBoardButton({
    speech: speech || undefined,
    sentence: glyph || undefined,
    fallback: glyphFallback || undefined,
    label,
    rowSpan: rawRowSpan >= 2 ? rawRowSpan : undefined,
    colSpan: rawColSpan >= 2 ? rawColSpan : undefined,
  });
}

export function parseBoardButtons(content: string): ParsedBoardButton[] {
  const items = content.split(',');
  const buttons: ParsedBoardButton[] = [];
  for (const item of items) {
    const parsed = parseSinglePipeButton(item);
    if (parsed) buttons.push(parsed);
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
  buttonType?: "guess" | "category" | "suggestion" | "narrow";
  suggestionKey?: string;
  /** For `buttonType: "narrow"` — AI-proposed narrowing dimension label. */
  narrowDimension?: string;
  /** For `buttonType: "narrow"` — the value the user is selecting. */
  narrowValue?: string;
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

/** Matches a `suggestion:<dim>:<value>` key anywhere in a string (dim may be dotted). */
export const SUGGESTION_KEY_RE = /suggestion:[a-z_]+(?:\.[a-z_]+)*:[a-z0-9_]+/g;

/**
 * Regex-extract guessing-mode SUGGESTION buttons from a RAW buttons string,
 * recovering EVERY key even when the model crams them into one pipe-joined item
 * with labels — `suggestion:x:a|label||suggestion:x:b|label||…` — instead of
 * comma-separating bare keys. (Gemini does this often; parseBoardButtons would
 * otherwise see one button and drop the rest.) Returns the expanded suggestion
 * buttons plus the raw string with suggestion-bearing comma-segments removed,
 * so the caller can parse any genuine non-suggestion buttons (e.g. a [GUESS]).
 */
export function extractSuggestionButtonsFromRaw(str: string): { suggestions: SuggestionButton[]; othersRaw: string } {
  const keys = Array.from(new Set(str.match(SUGGESTION_KEY_RE) ?? [])).filter(isValidSuggestionKey);
  const suggestions = keys
    .map((k) => expandSuggestionKey(k))
    .filter((b): b is SuggestionButton => b !== null);
  const othersRaw = str.split(",").filter((seg) => !seg.includes("suggestion:")).join(",");
  return { suggestions, othersRaw };
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
