// client-aac/src/lib/builder-rules.ts
//
// The PURE half of the sentence builder's press behavior — the rules that
// decide what a press MEANS and what the board remembers, with no React, no
// DOM geometry and no rendering. They live here rather than inside
// SentenceConstructorBoard.tsx for one reason: they change what a student's
// sentence means, so they have to be testable on their own (the AAC's client
// test path is a node environment — a component cannot run there, a rule can).
//
// What is left here is the CLIENT-BOUND half — the two rules that need this
// client's world-engine build or its localStorage:
//   - `engineNounKind`  — the wire's noun kind as the PARSER names it.
//   - the recency store — where this student's learned layer is kept.
//
// The press-ROUTING rules (`slotKeyForSelection`, `computeTargetSlot`,
// `autoComposeSlot`) moved to `@shared/glyph-builder-ops`: they decide what a
// press MEANS, the clinician's "Edit visual" builder must decide it the same
// way, and while they lived here the two builders drifted (a descriptor pushed
// beside its head instead of onto it, a room word stored as a bare emoji).

import type { BuilderRecency } from "@shared/games-bridge";
import { emptyRecency } from "@shared/world-engine/interaction/intent/surface-next";

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
