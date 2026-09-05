// shared/glyph-builder-ops.ts
//
// Shared, pure glyph-mutation operations for the SENTENCE BUILDERs. The AAC
// student builder (client-aac/SentenceConstructorBoard) and the clinician
// builder (client/syntAACx/glyph-builder) have very different UIs (full-screen
// eyegaze vs. a compact dialog) but identical *logic* for applying modifiers,
// toggling opposite-pair poles, and consuming a pending forward-binding join.
// Centralizing that logic here keeps the two builders in lockstep — adding a
// family to the registry surfaces it in both.
//
// Two halves live here: the MUTATION ops (what a press does to the glyph) and,
// below them, the PRESS ROUTING rules (what a press means — which slot it lands
// on, and what key that slot stores). The routing half used to be client-aac's
// alone, which is exactly how the two builders drifted.
//
// All functions are pure (ParsedGlyph in → ParsedGlyph out); rendering stays in
// each client. The per-pos option lists live in glyph-registry (modifiersFor,
// colorModifiersFor, emotionModifiersFor, gaugeModifiersFor, qualityPairsFor,
// listConnectors) — import those directly.

import {
  getVocabularyItem,
  getVocabularyItemByEmoji,
  listAllVocabulary,
  type ModifierTransform,
  type VocabularyItem,
} from "./glyph-registry.js";
import {
  addModifier,
  removeModifier,
  pushSlot,
  withSlotJoin,
  serializeGlyph,
  MAX_SLOTS,
  type ParsedGlyph,
  type Join,
} from "./glyph-compositor.js";
import { placeArt } from "./glyph-place-art.js";

/**
 * Toggle a modifier on a slot, keeping modifiers of the SAME transform family
 * mutually exclusive — used by the color, emotion, and amount (gauge) pickers.
 * Tapping the already-applied member removes it; otherwise the existing member
 * of that family is stripped and the new one added.
 */
export function applyExclusiveModifier(
  glyph: ParsedGlyph,
  slotIdx: number,
  key: string,
  transform: ModifierTransform,
): ParsedGlyph {
  const slot = glyph.slots[slotIdx];
  if (!slot) return glyph;
  let next = glyph;
  for (const m of slot.modifiers) {
    if (m === key) continue;
    if (getVocabularyItem(m)?.modifier?.transform === transform) {
      next = removeModifier(next, slotIdx, m);
    }
  }
  const refreshed = next.slots[slotIdx];
  return refreshed.modifiers.includes(key)
    ? removeModifier(next, slotIdx, key)
    : addModifier(next, slotIdx, key);
}

/**
 * Modifier families where the members are mutually exclusive BY NATURE, so a
 * press replaces rather than stacks.
 *
 *   color / emotion / gauge — one frame colour, one face, one fill level; these
 *     already had dedicated exclusive pickers, and this generalizes them.
 *   dots — a COUNT. A thing is one, or two, or many; never two of those.
 *
 * Deliberately NOT here:
 *   badge — the generic transform. Most descriptors are badges and most of them
 *     combine fine ("a big red ball"); the ones that don't declare it with
 *     `pairKey` instead.
 *   dimension — big + long is a legitimate description of one stick. Only the
 *     declared opposites within it (via `pairKey`) conflict.
 *   relational — stacks on purpose (`applyRelationalModifier` owns that).
 */
const EXCLUSIVE_TRANSFORMS: ReadonlySet<ModifierTransform> = new Set<ModifierTransform>([
  "color",
  "emotion",
  "gauge",
  "dots",
]);

/**
 * APPLY ONE MODIFIER PRESS, keeping a slot coherent.
 *
 * The plain toggle this replaces let two members of one axis land on the same
 * head: `.hot` then `.cold` composed `apple.hot.cold`, which reads out as "a hot
 * cold apple" — a sentence the student never meant, reachable in two presses and
 * not undoable in one. The same held for counts (`one` + `three`).
 *
 * Two registry-declared sources of conflict, no new tables:
 *   1. `pairKey` — a modifier naming its own opposite (hot↔cold, clean↔dirty).
 *      The pair member is dropped before the press lands.
 *   2. EXCLUSIVE_TRANSFORMS — families where any two members conflict (counts,
 *      colours, emotions, fill levels).
 *
 * Everything else keeps the old behaviour exactly: a toggle that adds on first
 * press and removes on second. Callers handle `relational` themselves before
 * reaching here — those stack by design.
 */
export function applyModifierPress(
  glyph: ParsedGlyph,
  slotIdx: number,
  key: string,
): ParsedGlyph {
  const slot = glyph.slots[slotIdx];
  if (!slot) return glyph;
  const mod = getVocabularyItem(key)?.modifier;

  // A declared opposite cannot sit alongside its pair. Dropped first so the
  // toggle below still reads the press as "turn this one on".
  let next = mod?.pairKey ? removeModifier(glyph, slotIdx, mod.pairKey) : glyph;

  if (mod && EXCLUSIVE_TRANSFORMS.has(mod.transform)) {
    return applyExclusiveModifier(next, slotIdx, key, mod.transform);
  }

  const refreshed = next.slots[slotIdx];
  return refreshed.modifiers.includes(key)
    ? removeModifier(next, slotIdx, key)
    : addModifier(next, slotIdx, key);
}

/**
 * Cycle a quality opposite-pair on a slot: none → positive → negative → none,
 * keeping the two poles mutually exclusive. Used by the pole-toggle picker.
 */
export function cycleQualityPole(
  glyph: ParsedGlyph,
  slotIdx: number,
  posKey: string,
  negKey: string,
): ParsedGlyph {
  const slot = glyph.slots[slotIdx];
  if (!slot) return glyph;
  let next = glyph;
  if (slot.modifiers.includes(posKey)) {
    next = removeModifier(next, slotIdx, posKey);
    next = addModifier(next, slotIdx, negKey);
  } else if (slot.modifiers.includes(negKey)) {
    next = removeModifier(next, slotIdx, negKey);
  } else {
    next = addModifier(next, slotIdx, posKey);
  }
  return next;
}

/**
 * Push a new slot, attaching a pending forward-binding join (connector or
 * spatial relation) to it when one is armed. The join binds the new slot to the
 * previous one; `withSlotJoin` ignores a join on slot 0.
 */
export function pushSlotWithJoin(
  glyph: ParsedGlyph,
  key: string,
  pendingJoin: string | null,
): ParsedGlyph {
  const g2 = pushSlot(glyph, key);
  return pendingJoin ? withSlotJoin(g2, g2.slots.length - 1, pendingJoin as Join) : g2;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRESS ROUTING — what a press MEANS, before any glyph is mutated.
//
// These three lived in client-aac/src/lib/builder-rules.ts, which made them the
// STUDENT builder's rules; the clinician's dialog then grew its own answers to
// the same three questions and gave a different sentence for the same presses
// (a room word stored as a bare emoji, a descriptor pushed beside its head
// instead of onto it). They are pure ParsedGlyph/registry arithmetic, so they
// belong beside the mutation ops both builders already share.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What goes into a glyph slot when the user selects a vocabulary item from a
 * builder grid or AI strip. For items the AI is explicitly taught about
 * (`exposeToAi: true`) the slot keeps the snake_case key — the AI's vocabulary
 * list says `i_me`, `want`, `play`, so the [GLYPH PRESS] should match. For
 * everything else the slot stores the item's CANONICAL EMOJI; the AI's
 * vocabulary is just "emoji" for those concepts, so it sees 🐈 (not "cat"), 🚶
 * (not "walk"), 🍌 (not "banana"), and interprets intent visually. The renderer
 * reverse-maps emojis back to bundled artwork when one is available (see
 * getVocabularyItemByEmoji), so the visual fidelity is the same whether the slot
 * stores `key` or `emoji`.
 */
export function slotKeyForSelection(item: VocabularyItem): string {
  if (item.exposeToAi) return item.key;
  // A PLACE WORD keeps its key even when the AI's vocabulary for it is an
  // emoji: its picture is a shell plus a fixture (glyph-place-art.ts) and only
  // the WORD resolves to that. Storing 🛌 for `bedroom` put a bare bed in the
  // sentence — the very "furniture with no room around it" this exists to fix —
  // and the word reads more clearly to the interpreter than the emoji anyway.
  if (placeArt(item.key)) return item.key;
  if (item.emoji) return item.emoji;
  return item.key;
}

/**
 * The INVERSE of `slotKeyForSelection`'s emoji rule: every stored emoji back to
 * the item that stored it.
 *
 * The registry ships its own reverse map (`getVocabularyItemByEmoji`), but that
 * one exists to serve the RENDERER, so it is filtered to items with bundled
 * artwork (`imagePath`) — `water` has none, so 💧 is not in it. The builders,
 * however, store the emoji for EVERY un-exposed item (see slotKeyForSelection),
 * artwork or not. This map covers the rest of them; the registry's map is still
 * consulted first so a lookup agrees with the picture actually on screen when
 * the two disagree about a shared emoji.
 *
 * Built once, lazily — the registry's VOCAB is large and most callers of this
 * module never touch an emoji-keyed slot.
 */
let byStoredEmoji: Map<string, VocabularyItem> | null = null;
function storedEmojiMap(): Map<string, VocabularyItem> {
  if (byStoredEmoji) return byStoredEmoji;
  const out = new Map<string, VocabularyItem>();
  for (const item of listAllVocabulary()) {
    const stored = slotKeyForSelection(item);
    if (stored === item.key) continue;   // key-stored: nothing to reverse
    if (!out.has(stored)) out.set(stored, item);  // first wins, registry order
  }
  byStoredEmoji = out;
  return out;
}

/**
 * THE ITEM A SLOT ACTUALLY MEANS — use this, never `getVocabularyItem(slot.key)`,
 * wherever a builder asks "what is in this slot?".
 *
 * A slot key is not always a registry key. `slotKeyForSelection` deliberately
 * stores the CANONICAL EMOJI for items the AI isn't taught by name
 * (`exposeToAi: false`), and AI-authored board glyphs are mostly emoji too
 * (`i_me+want+💧`). A raw `getVocabularyItem("💧")` is `undefined`, so the
 * builder decided a selected water slot had no part of speech and offered NO
 * modifiers — no hot, no cold, no colours — while the same word spelled `water`
 * offered all of them.
 *
 * Returns undefined for keys that genuinely have no registry item (AI-generated
 * words, `face:ID`, `symbol:ID`); callers keep their existing fallbacks.
 */
export function resolveSlotItem(key: string): VocabularyItem | undefined {
  return getVocabularyItem(key) ?? getVocabularyItemByEmoji(key) ?? storedEmojiMap().get(key);
}

/**
 * Serialize a glyph for the ENGINE (builder surfacer) and the INTENT PARSER,
 * with emoji-stored slot heads spelled back as their registry keys.
 *
 * Those two consumers reason over WORDS: `builderSurfaceFor("i_me+want+💧")`
 * returns no modifiers and only the generic connectives, while
 * `builderSurfaceFor("i_me+want+water")` returns hot/cold/warm/counts and a
 * descriptor rail. The emoji is a storage detail of the board (and of what the
 * AI is shown); it must not reach the lexicon.
 *
 * Pure, and deliberately narrow: only a slot's HEAD is rewritten, and only when
 * it is not itself a registry key AND does reverse-map. Modifiers, joins,
 * payloads and tone tags pass through untouched, as do keys with no registry
 * item at all (a raw emoji nothing claims, `face:ID`, `symbol:ID`).
 *
 * NOT for the AI, the call mirror or `onPlay` — those keep the raw glyph, since
 * the AI's vocabulary for these concepts IS the emoji.
 */
export function canonicalizeForEngine(glyph: ParsedGlyph): string {
  let changed = false;
  const slots = glyph.slots.map((slot) => {
    if (!slot.key || getVocabularyItem(slot.key)) return slot;
    const item = resolveSlotItem(slot.key);
    if (!item) return slot;
    changed = true;
    // The head is a registry key now, so the slot is no longer "unknown".
    return { ...slot, key: item.key, unknown: false };
  });
  return serializeGlyph(changed ? { ...glyph, slots } : glyph);
}

/** Compute the slot we want the AI to suggest for. */
export function computeTargetSlot(glyph: ParsedGlyph, activeSlot: number | null): number {
  if (activeSlot != null) return activeSlot;
  // No upper clamp — slots can grow up to MAX_SLOTS. We always target
  // the next empty position; if it's at the cap, the last slot is the
  // target for re-suggestion.
  return Math.min(glyph.slots.length, MAX_SLOTS - 1);
}

/**
 * THE DESCRIPTOR AUTO-COMPOSE RULE (the in-game SpeakMenu's `tapWord`, ported
 * verbatim — games/dollhouse/src/board-island.tsx:388, whose own comment calls
 * this "the AAC-board rule").
 *
 * A tapped descriptor lands ON the head it modifies rather than beside it:
 * "banana" then "hot" is `banana.hot` (a hot banana — a request), never
 * `banana + hot` (banana IS hot — a statement). The two boards were building
 * different sentences out of the same two presses, and the parser reads the
 * difference, so the student's meaning depended on which board they used.
 *
 * Registry-gated exactly as the SpeakMenu gates it: the tapped word must be a
 * modifier whose `appliesTo` includes the LAST slot's part of speech, and must
 * not already sit on that slot.
 *
 * @returns the slot index to compose onto, or null to push a new slot.
 */
export function autoComposeSlot(glyph: ParsedGlyph, tappedKey: string): number | null {
  const idx = glyph.slots.length - 1;
  if (idx < 0) return null;
  const slot = glyph.slots[idx];
  const head = getVocabularyItem(slot.key);
  const tapped = getVocabularyItem(tappedKey);
  if (!head || !tapped?.modifier?.appliesTo.includes(head.pos)) return null;
  if (slot.modifiers.includes(tappedKey)) return null;
  return idx;
}
