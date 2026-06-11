// server/services/dual-agent/defined-gestures.ts
//
// Defined student gestures — clinician-configured in AAC Settings
// (aac_settings.defined_gestures). The Observer agent watches for them and
// reports a match via its `report_gesture` tool; the Coordinator resolves
// the report against this registry (server config wins over model-supplied
// text) and replays the standard button-press flow with the gesture's
// `meaning` as the voiced sentence.

import type { DefinedGesture } from "@shared/schema";

export type { DefinedGesture };

/** Minimum gap between two presses triggered by the SAME gesture. The
 *  Observer sees the gesture across many consecutive frames; without a
 *  cooldown one physical gesture can fire several synthetic presses. */
export const GESTURE_PRESS_COOLDOWN_MS = 10_000;

/** Validate the raw jsonb value from aac_settings into a clean list.
 *  Rows missing a name or meaning are dropped (half-filled editor rows). */
export function parseDefinedGestures(raw: unknown): DefinedGesture[] {
  if (!Array.isArray(raw)) return [];
  const out: DefinedGesture[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = typeof (item as any).name === "string" ? (item as any).name.trim() : "";
    const meaning = typeof (item as any).meaning === "string" ? (item as any).meaning.trim() : "";
    if (!name || !meaning) continue;
    const description = typeof (item as any).description === "string"
      ? (item as any).description.trim() || undefined
      : undefined;
    out.push({ name, meaning, description });
  }
  return out;
}

/** Loose name normalization for matching the model's `gesture` argument
 *  against the registry — case/punctuation/whitespace insensitive. */
function normalizeGestureName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Resolve a model-reported gesture name to its registry entry. Exact
 * normalized match first; falls back to one-way containment ("thumbs up
 * gesture" → "thumbs up") only when exactly one entry qualifies, so an
 * ambiguous report never fires the wrong meaning.
 */
export function resolveDefinedGesture(
  gestures: DefinedGesture[],
  reportedName: string,
): DefinedGesture | undefined {
  const reported = normalizeGestureName(reportedName);
  if (!reported) return undefined;

  const exact = gestures.find(g => normalizeGestureName(g.name) === reported);
  if (exact) return exact;

  const partial = gestures.filter(g => {
    const name = normalizeGestureName(g.name);
    return name.includes(reported) || reported.includes(name);
  });
  return partial.length === 1 ? partial[0] : undefined;
}
