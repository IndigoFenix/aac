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
// All functions are pure (ParsedGlyph in → ParsedGlyph out); rendering stays in
// each client. The per-pos option lists live in glyph-registry (modifiersFor,
// colorModifiersFor, emotionModifiersFor, gaugeModifiersFor, qualityPairsFor,
// listConnectors) — import those directly.

import { getVocabularyItem, type ModifierTransform } from "./glyph-registry.js";
import {
  addModifier,
  removeModifier,
  pushSlot,
  withSlotJoin,
  type ParsedGlyph,
  type Join,
} from "./glyph-compositor.js";

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
