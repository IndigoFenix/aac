// shared/glyph-compositor.ts
//
// Pure parsing + layout logic for glyph strings. No React, no asset
// resolution — server-safe so the AI prompt builder can enumerate parsed
// structure. The React SVG renderer lives in glyph-compositor.tsx and uses
// these primitives.
//
// Glyph string format (from planning-docs/glyph-system.md):
//   slot1[.mod[.mod]] [+ slot2[.mod[.mod]] [+ slot3[.mod[.mod]]]] [#tag[.tag]]
//
// A single bare key (e.g. "apple") is a 1-slot glyph and renders as a simple
// image — this is what gives backward compatibility with old single-image
// buttons.

import {
  getVocabularyItem,
  type ToneFamily,
  type VocabularyItem,
} from "./glyph-registry.js";

export type ToneTag = "question" | "exclamation";

/**
 * Image resolver passed to the React renderer. Receives the registry item
 * (or undefined for AI-generated keys) and returns a URL or null. Returning
 * null lets the renderer fall back to emoji/text.
 */
export type ImageResolver = (input: {
  item: VocabularyItem | undefined;
  key: string;
}) => string | null;

export interface ParsedSlot {
  /** Main vocabulary key for this slot. May not exist in the registry — AI-generated keys are allowed. */
  key: string;
  /** Modifier keys applied to this slot, in left-to-right composition order. */
  modifiers: string[];
  /** True when `key` is not in the registry (AI-generated / on-demand image). */
  unknown: boolean;
}

export interface ParsedGlyph {
  slots: ParsedSlot[];     // 0–3 slots; 0 is an empty/invalid glyph
  toneTags: ToneTag[];     // 0–2 distinct tone tags
  raw: string;             // original input
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse / serialize
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SLOTS = 3;
const KNOWN_TONE_TAGS = new Set<ToneTag>(["question", "exclamation"]);

/** Parse a glyph string. Tolerant — malformed segments are dropped silently. */
export function parseGlyph(input: string): ParsedGlyph {
  const raw = input ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return { slots: [], toneTags: [], raw };

  // Split tone tags from glyph body
  const hashIdx = trimmed.indexOf("#");
  const body = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const tagPart = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : "";

  // Parse tone tags
  const toneTags: ToneTag[] = [];
  if (tagPart) {
    for (const t of tagPart.split(".").map((s) => s.trim()).filter(Boolean)) {
      if (KNOWN_TONE_TAGS.has(t as ToneTag) && !toneTags.includes(t as ToneTag)) {
        toneTags.push(t as ToneTag);
      }
    }
  }

  // Parse slots
  const slotStrs = body.split("+").map((s) => s.trim()).filter(Boolean);
  const slots: ParsedSlot[] = slotStrs.slice(0, MAX_SLOTS).map((slotStr) => {
    const parts = slotStr.split(".").map((s) => s.trim()).filter(Boolean);
    const key = parts[0] ?? "";
    const modifiers = parts.slice(1);
    return {
      key,
      modifiers,
      unknown: !getVocabularyItem(key),
    };
  });

  return { slots, toneTags, raw };
}

/** Round-trip back to a glyph string. */
export function serializeGlyph(parsed: ParsedGlyph): string {
  const slotStrs = parsed.slots
    .map((s) => {
      if (!s.key) return "";
      return s.modifiers.length ? [s.key, ...s.modifiers].join(".") : s.key;
    })
    .filter(Boolean);

  let result = slotStrs.join("+");
  if (parsed.toneTags.length) {
    result += "#" + parsed.toneTags.join(".");
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout math
// ─────────────────────────────────────────────────────────────────────────────
//
// Layout is computed in a unit viewBox (each slot = 100×100). The renderer
// scales the SVG to whatever physical size the button needs via viewBox +
// preserveAspectRatio.

export const SLOT_UNIT = 100;
/** Tone corner-badge extends slightly outside the slot grid. */
export const CORNER_BADGE_SIZE = 24;

export interface SlotLayout {
  /** Slot index (0..n-1) in the parsed glyph's `slots` array. */
  index: number;
  /** Top-left of slot box in viewBox units. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GlyphLayout {
  viewBoxWidth: number;
  viewBoxHeight: number;
  slots: SlotLayout[];
  /** Where the tone corner-badge anchors (top-right of overall glyph). */
  cornerBadge: { x: number; y: number; size: number };
}

/**
 * Compute slot positions. Slots are arranged horizontally; in RTL the slot
 * ORDER is reversed (slot 0 still in `slots[0]` but renders rightmost).
 * Single-slot glyphs occupy the full viewBox.
 */
export function computeLayout(parsed: ParsedGlyph, rtl = false): GlyphLayout {
  const count = Math.max(1, parsed.slots.length);
  const viewBoxWidth = count * SLOT_UNIT;
  const viewBoxHeight = SLOT_UNIT;

  const slots: SlotLayout[] = [];
  for (let i = 0; i < count; i++) {
    const visualOrder = rtl ? count - 1 - i : i;
    slots.push({
      index: i,
      x: visualOrder * SLOT_UNIT,
      y: 0,
      width: SLOT_UNIT,
      height: SLOT_UNIT,
    });
  }

  const cornerBadge = {
    x: rtl ? 0 : viewBoxWidth - CORNER_BADGE_SIZE,
    y: 0,
    size: CORNER_BADGE_SIZE,
  };

  return { viewBoxWidth, viewBoxHeight, slots, cornerBadge };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tone family resolution
// ─────────────────────────────────────────────────────────────────────────────
//
// Rules for picking the background color:
//   1. If `#question` tone tag → "question" family
//   2. Else if any slot is a verb → that verb's tone family
//   3. Else if any slot is a feeling → "feeling" family
//   4. Else first registered slot's tone family
//   5. Else "comment"

export function dominantToneFamily(parsed: ParsedGlyph): ToneFamily {
  if (parsed.toneTags.includes("question")) return "question";

  const resolved: VocabularyItem[] = parsed.slots
    .map((s) => getVocabularyItem(s.key))
    .filter((v): v is VocabularyItem => !!v);

  const verb = resolved.find((v) => v.pos === "verb");
  if (verb) return verb.tone;

  const feeling = resolved.find((v) => v.pos === "feeling");
  if (feeling) return feeling.tone;

  return resolved[0]?.tone ?? "comment";
}

/** Hex color for a tone family — tints rather than dominates. */
export const TONE_COLORS: Record<ToneFamily, string> = {
  request: "#FCEBC1",  // warm amber, low saturation
  comment: "#F2F2F2",  // neutral gray-white
  feeling: "#FBD9E3",  // soft pink
  social:  "#C9E8E3",  // warm teal
  question: "#DCD3F1", // cool purple
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure glyph mutations
// ─────────────────────────────────────────────────────────────────────────────
//
// These return new ParsedGlyph values without mutating the input. The
// construction-board reducer uses them; future server-side glyph editing
// can use them too.

export const EMPTY_GLYPH: ParsedGlyph = Object.freeze({
  slots: [],
  toneTags: [],
  raw: "",
});

function makeSlot(key: string): ParsedSlot {
  return { key, modifiers: [], unknown: !getVocabularyItem(key) };
}

/**
 * Push a new slot into the next empty position. If all 3 slots are filled,
 * returns the input unchanged (caller must explicitly replace).
 */
export function pushSlot(glyph: ParsedGlyph, key: string): ParsedGlyph {
  if (glyph.slots.length >= MAX_SLOTS) return glyph;
  return { ...glyph, slots: [...glyph.slots, makeSlot(key)] };
}

/** Replace the slot at `idx`, preserving the rest. No-op for out-of-range. */
export function replaceSlot(
  glyph: ParsedGlyph,
  idx: number,
  key: string
): ParsedGlyph {
  if (idx < 0 || idx >= glyph.slots.length) return glyph;
  const slots = glyph.slots.slice();
  slots[idx] = makeSlot(key);
  return { ...glyph, slots };
}

/** Remove the slot at `idx`. Slots after shift down by 1. */
export function clearSlot(glyph: ParsedGlyph, idx: number): ParsedGlyph {
  if (idx < 0 || idx >= glyph.slots.length) return glyph;
  return { ...glyph, slots: glyph.slots.filter((_, i) => i !== idx) };
}

/** Append a modifier key onto a slot. Duplicates are ignored. */
export function addModifier(
  glyph: ParsedGlyph,
  slotIdx: number,
  modKey: string
): ParsedGlyph {
  if (slotIdx < 0 || slotIdx >= glyph.slots.length) return glyph;
  const slot = glyph.slots[slotIdx];
  if (slot.modifiers.includes(modKey)) return glyph;
  const slots = glyph.slots.slice();
  slots[slotIdx] = { ...slot, modifiers: [...slot.modifiers, modKey] };
  return { ...glyph, slots };
}

/** Remove a modifier from a slot. */
export function removeModifier(
  glyph: ParsedGlyph,
  slotIdx: number,
  modKey: string
): ParsedGlyph {
  if (slotIdx < 0 || slotIdx >= glyph.slots.length) return glyph;
  const slot = glyph.slots[slotIdx];
  if (!slot.modifiers.includes(modKey)) return glyph;
  const slots = glyph.slots.slice();
  slots[slotIdx] = {
    ...slot,
    modifiers: slot.modifiers.filter((m) => m !== modKey),
  };
  return { ...glyph, slots };
}

/** Replace the tone tags wholesale (deduplicating). */
export function setToneTags(glyph: ParsedGlyph, tags: ToneTag[]): ParsedGlyph {
  const seen = new Set<ToneTag>();
  const out: ToneTag[] = [];
  for (const t of tags) {
    if (KNOWN_TONE_TAGS.has(t) && !seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return { ...glyph, toneTags: out };
}

/** Index of the most-recently-filled slot, or null if all are empty. */
export function mostRecentSlot(glyph: ParsedGlyph): number | null {
  return glyph.slots.length > 0 ? glyph.slots.length - 1 : null;
}

/**
 * Resolve the "active" slot per the construction-board rule: explicit
 * selection wins; otherwise fall back to the most-recently-filled slot.
 */
export function resolveActiveSlot(
  glyph: ParsedGlyph,
  explicit: number | null
): number | null {
  if (explicit != null && explicit >= 0 && explicit < glyph.slots.length) {
    return explicit;
  }
  return mostRecentSlot(glyph);
}
