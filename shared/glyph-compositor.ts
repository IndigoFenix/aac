// shared/glyph-compositor.ts
//
// Pure parsing + layout logic for glyph strings. No React, no asset
// resolution — server-safe so the AI prompt builder can enumerate parsed
// structure. The React SVG renderer lives in glyph-compositor.tsx and uses
// these primitives.
//
// Glyph string format (from planning-docs/glyph-system.md):
//   slot1[(payload)][.mod[.mod]] [+ slot2... [+ slot3...]] [#tag[.tag]]
//
// A single bare key (e.g. "apple") is a 1-slot glyph and renders as a simple
// image — this is what gives backward compatibility with old single-image
// buttons.
//
// `(payload)` is only valid when the slot's key is a composable host
// (see ComposableFacet in glyph-registry.ts). The payload renders as an
// overlay on the host's symbol — e.g. `want(apple)` shows the want-hands
// image with an apple centered inside it.

import { resolveEmoji } from "./emoji-registry.js";
import {
  getVocabularyItem,
  type ToneFamily,
  type VocabularyItem,
} from "./glyph-registry.js";

/**
 * Glyph-level tags attached after `#`. They split into two visual groups
 * the compositor renders as separate corner badges so a sentence can stack
 * tense + prosody (e.g. `i_me+want+water#past#question` = "Did I want
 * water?"):
 *   - PROSODY: `question` / `exclamation` — purple/red ?/! badge, top-right.
 *   - TENSE:   `past` / `future`           — amber/blue ←/→ badge, top-left.
 * Each axis allows at most one tag; if both members of an axis appear,
 * the renderer collapses them (question+exclamation → "?!"). Cross-axis
 * tags coexist on opposite corners.
 */
export type ToneTag = "question" | "exclamation" | "past" | "future";

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
  /**
   * Embedded payload key — only meaningful when the slot's `key` is a
   * composable host. Rendered as an overlay on the host's symbol.
   */
  payload?: string;
  /** True when the payload key is not in the registry. */
  payloadUnknown?: boolean;
}

export interface ParsedGlyph {
  slots: ParsedSlot[];     // 0–MAX_SLOTS slots; 0 is an empty/invalid glyph
  toneTags: ToneTag[];     // 0–2 distinct tone tags
  raw: string;             // original input
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse / serialize
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upper bound on slot count. Set high enough that students composing a full
 * compound sentence don't bump into a cap, but bounded so a malformed glyph
 * string (e.g. a 10 KB blob of `a+a+a+...`) doesn't allocate without limit.
 * The visual scaling in `computeLayout` makes more slots progressively
 * smaller, which is the practical limit students will hit first.
 */
export const MAX_SLOTS = 16;
const KNOWN_TONE_TAGS = new Set<ToneTag>(["question", "exclamation", "past", "future"]);

/** Tags that occupy the prosody (top-right) badge. */
const PROSODY_TAGS = new Set<ToneTag>(["question", "exclamation"]);
/** Tags that occupy the tense (top-left) badge. */
const TENSE_TAGS = new Set<ToneTag>(["past", "future"]);

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
  const slots: ParsedSlot[] = slotStrs.slice(0, MAX_SLOTS).map((slotStr) => parseSlot(slotStr));

  return { slots, toneTags, raw };
}

/**
 * Strip the imageKey marker from a slot key. The AI is now instructed to
 * prefix generated keys with `generate:` (e.g. `generate:planet_mars`)
 * — that's the syntax in the current prompt. Bracket-wrapping
 * (`[planet_mars]`) is the previous syntax and stays tolerated here so
 * older transcripts and any model that hasn't fully picked up the new
 * convention still parse cleanly. Either form gets reduced to the bare
 * inner key (`planet_mars`) — the downstream resolver decides whether
 * that's a canonical registry hit, an emoji match, or a generation
 * target. Canonical keys wrapped in the marker (`generate:water`,
 * `[water]`) still resolve to the canonical item — the marker is a
 * hint, not a force.
 */
export function stripBrackets(s: string): string {
  let t = s.trim();
  if (t.toLowerCase().startsWith("generate:")) {
    t = t.slice("generate:".length).trim();
  } else if (t.length >= 2 && t.startsWith("[") && t.endsWith("]")) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Expand an alias key (a registry item with `expandsTo`) into its head key +
 * modifier list. Returns null when the key isn't an alias. One level only —
 * the `expandsTo` fragment is authored as a literal `head[.mod[.mod]]` and is
 * NOT itself re-expanded, which also guards against alias cycles.
 */
export function expandAlias(key: string): { key: string; modifiers: string[] } | null {
  const frag = getVocabularyItem(key)?.expandsTo;
  if (!frag) return null;
  const parts = frag.split(".").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  return { key: parts[0], modifiers: parts.slice(1) };
}

/**
 * Parse a single slot string like `want(apple).please` into a ParsedSlot.
 * Tolerant of malformed input — missing payload close-paren is treated as
 * no payload; empty `()` is treated as no payload.
 */
function parseSlot(slotStr: string): ParsedSlot {
  // Split out payload `(...)` first so dots inside it don't confuse modifiers.
  const open = slotStr.indexOf("(");
  let head = slotStr;
  let payload: string | undefined;
  if (open >= 0) {
    const close = slotStr.indexOf(")", open + 1);
    if (close > open) {
      const inner = slotStr.slice(open + 1, close).trim();
      if (inner) payload = stripBrackets(inner);
      head = slotStr.slice(0, open) + slotStr.slice(close + 1);
    }
  }
  const parts = head.split(".").map((s) => stripBrackets(s)).filter(Boolean);
  const rawKey = parts[0] ?? "";
  const rawModifiers = parts.slice(1);
  // Alias keys (tomorrow → day.next) normalize to their head + modifiers, with
  // the alias's own modifiers coming first so any explicitly-typed modifiers
  // stack after them.
  const expanded = expandAlias(rawKey);
  const key = expanded ? expanded.key : rawKey;
  const modifiers = expanded ? [...expanded.modifiers, ...rawModifiers] : rawModifiers;
  const slot: ParsedSlot = {
    key,
    modifiers,
    unknown: !getVocabularyItem(key),
  };
  if (payload) {
    slot.payload = payload;
    slot.payloadUnknown = !getVocabularyItem(payload);
  }
  return slot;
}

/** Round-trip back to a glyph string. */
export function serializeGlyph(parsed: ParsedGlyph): string {
  const slotStrs = parsed.slots
    .map((s) => {
      if (!s.key) return "";
      const headWithPayload = s.payload ? `${s.key}(${s.payload})` : s.key;
      return s.modifiers.length ? [headWithPayload, ...s.modifiers].join(".") : headWithPayload;
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
  /** Prosody (?/!) badge — top-right in LTR, top-left in RTL. */
  cornerBadge: { x: number; y: number; size: number };
  /** Tense (←/→) badge — top-left in LTR, top-right in RTL. Opposite the prosody badge. */
  tenseBadge: { x: number; y: number; size: number };
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
  // Tense badge sits on the opposite top corner so prosody (?/!) and
  // tense (past/future) don't collide when both are set on a sentence.
  const tenseBadge = {
    x: rtl ? viewBoxWidth - CORNER_BADGE_SIZE : 0,
    y: 0,
    size: CORNER_BADGE_SIZE,
  };

  return { viewBoxWidth, viewBoxHeight, slots, cornerBadge, tenseBadge };
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
  // Aliases (e.g. pressing "tomorrow" in the sentence builder) materialize as
  // their composed head + modifiers, so the slot is born as `day.next`.
  const expanded = expandAlias(key);
  const head = expanded ? expanded.key : key;
  return {
    key: head,
    modifiers: expanded ? expanded.modifiers.slice() : [],
    unknown: !getVocabularyItem(head),
  };
}

/**
 * Push a new slot into the next empty position. If MAX_SLOTS slots are
 * filled, returns the input unchanged (caller must explicitly replace
 * an existing slot to make room).
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

/**
 * Apply a relational modifier (next / prev / this) to a slot, honoring the
 * axis rules on the modifier's `relation` facet:
 *   - a present opposite cancels one occurrence (next vs prev) — the click
 *     consumes the opposite arrow rather than adding a new one,
 *   - same direction stacks up to `maxStack` (default 4),
 *   - a neutral member (step 0, e.g. `this`) is mutually exclusive with the
 *     directional members on its axis and toggles on/off.
 * Non-relational keys fall through to `addModifier`, so a caller can route
 * every modifier press through here and get toggle-stack behavior only where
 * it's declared.
 */
export function applyRelationalModifier(
  glyph: ParsedGlyph,
  slotIdx: number,
  modKey: string
): ParsedGlyph {
  if (slotIdx < 0 || slotIdx >= glyph.slots.length) return glyph;
  const rel = getVocabularyItem(modKey)?.modifier?.relation;
  if (!rel) return addModifier(glyph, slotIdx, modKey);

  const relOf = (k: string) => getVocabularyItem(k)?.modifier?.relation;
  const slot = glyph.slots[slotIdx];
  const mods = slot.modifiers;
  const write = (next: string[]): ParsedGlyph => {
    const slots = glyph.slots.slice();
    slots[slotIdx] = { ...slot, modifiers: next };
    return { ...glyph, slots };
  };

  // Neutral ("this"): clear the whole axis, then toggle this key on/off.
  if (rel.step === 0) {
    const had = mods.includes(modKey);
    const cleared = mods.filter((k) => relOf(k)?.axis !== rel.axis);
    return write(had ? cleared : [...cleared, modKey]);
  }

  // Directional: a present opposite cancels one occurrence (no new arrow).
  const oppositeIdx = mods.findIndex((k) => {
    const r = relOf(k);
    return !!r && r.axis === rel.axis && r.step === -rel.step;
  });
  if (oppositeIdx >= 0) {
    const next = mods.slice();
    next.splice(oppositeIdx, 1);
    return write(next);
  }

  // Drop any neutral on this axis ("this" then "next" is contradictory),
  // then stack up to the cap in this direction.
  const withoutNeutral = mods.filter((k) => {
    const r = relOf(k);
    return !(r && r.axis === rel.axis && r.step === 0);
  });
  const sameDir = withoutNeutral.filter((k) => {
    const r = relOf(k);
    return !!r && r.axis === rel.axis && r.step === rel.step;
  }).length;
  if (sameDir >= (rel.maxStack ?? 4)) return write(withoutNeutral);
  return write([...withoutNeutral, modKey]);
}

/**
 * Set (or replace) the payload on a composable host slot. No-op when the
 * slot's host item isn't composable or accepts don't match — the registry
 * is the gate, this helper just stores the key.
 */
export function setPayload(
  glyph: ParsedGlyph,
  slotIdx: number,
  payloadKey: string
): ParsedGlyph {
  if (slotIdx < 0 || slotIdx >= glyph.slots.length) return glyph;
  const slot = glyph.slots[slotIdx];
  const host = getVocabularyItem(slot.key);
  if (!host?.composable) return glyph;
  const slots = glyph.slots.slice();
  slots[slotIdx] = {
    ...slot,
    payload: payloadKey,
    payloadUnknown: !getVocabularyItem(payloadKey),
  };
  return { ...glyph, slots };
}

/** Clear the payload on a slot. No-op when there's no payload. */
export function clearPayload(glyph: ParsedGlyph, slotIdx: number): ParsedGlyph {
  if (slotIdx < 0 || slotIdx >= glyph.slots.length) return glyph;
  const slot = glyph.slots[slotIdx];
  if (!slot.payload) return glyph;
  const slots = glyph.slots.slice();
  const { payload: _p, payloadUnknown: _u, ...rest } = slot;
  slots[slotIdx] = rest;
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

/** Caller-supplied predicate: "is this snake_case key cached as a
 *  generated symbol whose URL we can render now?" */
export type HasResolvedSymbol = (key: string) => boolean;

/** True iff `key` would render to something other than "❓" right now. */
function canResolveKey(key: string, hasSymbol: HasResolvedSymbol): boolean {
  if (!key) return false;
  // Explicit custom-symbol reference (e.g. `symbol:abc`). The compositor's
  // resolver translates the prefix into a `/api/custom-symbols/<id>/image`
  // URL; that URL is assumed to load successfully here so canResolveGlyph
  // doesn't force the whole glyph onto its fallback string. If the image
  // actually 404s, the per-slot onError handler marks the URL as failed
  // and the slot renders its emoji fallback on the next pass — the
  // fallback STRING only kicks in when there's no symbol path at all.
  if (key.startsWith("symbol:")) return true;
  // Face reference (e.g. `face:abc`). Treated as always resolvable for
  // the same reason as symbol: — if the host doesn't have the face
  // cached, resolveEmoji translates the prefix to the 👤 silhouette so
  // the slot still renders an emoji rather than ❓.
  if (key.startsWith("face:")) return true;
  const item = getVocabularyItem(key);
  // Registry entry with a bundled image → always renders.
  if (item?.imagePath) return true;
  // resolveEmoji covers: raw emoji codepoints, registry item.emoji, and the
  // supplementary EXTRA_EMOJIS map. If any of those produces an emoji, the
  // slot renders an emoji glyph immediately.
  if (resolveEmoji(key)) return true;
  // Generated symbol already cached on the client.
  if (hasSymbol(key)) return true;
  return false;
}

/**
 * Walk every slot's key and payload. Returns true only when ALL of them
 * can render visually right now (bundled image, known emoji, raw emoji,
 * or cached generated symbol). Returns false when any slot would fall
 * through to the "❓" placeholder — the renderer should then use the
 * fallback glyph string instead.
 *
 * Server-safe: pure logic, no React or DOM.
 */
export function canResolveGlyph(
  input: string | ParsedGlyph,
  hasSymbol: HasResolvedSymbol = () => false,
): boolean {
  const parsed = typeof input === "string" ? parseGlyph(input) : input;
  if (parsed.slots.length === 0) return false;
  for (const slot of parsed.slots) {
    if (!canResolveKey(slot.key, hasSymbol)) return false;
    if (slot.payload && !canResolveKey(slot.payload, hasSymbol)) return false;
    // Modifier badges that aren't registry-known need their image either as
    // a raw emoji or as a cached generated symbol — if neither is ready, the
    // badge would draw "❓", so we treat the whole glyph as unresolved.
    for (const modKey of slot.modifiers) {
      if (getVocabularyItem(modKey)) continue;       // canonical modifier — always renders
      if (!canResolveKey(modKey, hasSymbol)) return false;
    }
  }
  return true;
}
