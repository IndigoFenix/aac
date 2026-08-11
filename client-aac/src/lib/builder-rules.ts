// client-aac/src/lib/builder-rules.ts
//
// The PURE half of the sentence builder's press behavior — the rules that
// decide what a press MEANS and what the board remembers, with no React, no
// DOM geometry and no rendering. They live here rather than inside
// SentenceConstructorBoard.tsx for one reason: they change what a student's
// sentence means, so they have to be testable on their own (the AAC's client
// test path is a node environment — a component cannot run there, a rule can).
//
// Three rules, all of them ports of behavior the IN-GAME board already had:
//   - `autoComposeSlot` — a tapped descriptor lands ON the head it describes.
//   - `engineNounKind`  — the wire's noun kind as the PARSER names it.
//   - the recency store — where this student's learned layer is kept.

import { getVocabularyItem } from "@shared/glyph-registry";
import type { ParsedGlyph } from "@shared/glyph-compositor";
import type { BuilderRecency } from "@shared/games-bridge";
import { emptyRecency } from "@shared/world-engine/interaction/intent/surface-next";

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

/** The wire's noun kind as the PARSER names it. The bridge says "person" for a
 *  named human; the parser's vocabulary has only creature/item/place/unknown,
 *  and a person is a creature there. */
export function engineNounKind(kind: string): "place" | "item" | "creature" | "unknown" {
  if (kind === "person" || kind === "creature") return "creature";
  if (kind === "item" || kind === "place") return kind;
  return "unknown";
}

/**
 * WHERE THE STUDENT'S LEARNED LAYER LIVES: one localStorage entry per student
 * (the same `synapse_student_id` every other per-student value on this client
 * keys off). It is the child's own habit — which words they use, what they
 * mention, which words they say next to each other — so it must survive a
 * session, a game and an app restart, and must never bleed between two
 * students sharing a device.
 */
export const RECENCY_STORAGE_PREFIX = "aac_builder_recency_";

export function recencyStorageKey(): string {
  let studentId: string | null = null;
  try {
    studentId = localStorage.getItem("synapse_student_id");
  } catch {
    // No store at all (SSR, a locked-down webview) — one shared anonymous slot.
  }
  return `${RECENCY_STORAGE_PREFIX}${studentId ?? "anon"}`;
}

/** Read this student's memory back. Anything unreadable or shaped wrong is a
 *  FRESH memory, never a crash — a corrupt entry must cost the board nothing. */
export function loadRecency(): BuilderRecency {
  try {
    const raw = localStorage.getItem(recencyStorageKey());
    if (!raw) return emptyRecency();
    const parsed = JSON.parse(raw) as BuilderRecency;
    if (!parsed || !Array.isArray(parsed.mentioned) || typeof parsed.utterances !== "number") {
      return emptyRecency();
    }
    return parsed;
  } catch {
    return emptyRecency();
  }
}

/** Persist it. `noteUtterance` already caps every list, so this stays small. */
export function saveRecency(mem: BuilderRecency): void {
  try {
    localStorage.setItem(recencyStorageKey(), JSON.stringify(mem));
  } catch {
    // A full or disabled store must never break a press.
  }
}
