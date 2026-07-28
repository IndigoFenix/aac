// Over-head activity-bubble content selection. Kept in its own tiny module (it
// imports only the data-only glyph-registry, no renderer/compositor) so the
// pure mapping is unit-testable without dragging in the whole quest-host.
import { getVocabularyItem } from "@shared/glyph-registry.js";

/** Over-head activity-bubble content: prefer the project's REGISTERED glyph
 *  ARTWORK (its imagePath image, drawn through the same composed-glyph channel
 *  the put/wear bubbles use) over a raw emoji. General, not play-only — any
 *  activity that names a glyph key with bundled art routes through the glyph;
 *  everything else keeps its emoji. `emoji` is the fallback shown when the glyph
 *  key is absent or art-less (so the compositor's own emoji fallback is never
 *  needed here — an unmapped activity never touches the glyph path at all). */
export function activityBubbleContent(
  glyphKey: string | undefined,
  emoji: string,
): { text: string; glyph?: string } {
  if (glyphKey && getVocabularyItem(glyphKey)?.imagePath) return { text: "", glyph: glyphKey };
  return { text: emoji };
}

/** Resolve any glanceable STATE / wellbeing ICON to the SINGLE string handed to
 *  the GlyphCompositor (the family chip, the city wellbeing face — any icon that
 *  used to be a bare `<span>{emoji}</span>`). Prefers the mapped REGISTERED glyph
 *  (its bundled ART when it has any, else the vocabulary item's own emoji raster/
 *  text) and otherwise the raw `emoji` — which the compositor STILL renders
 *  through its own path, never as a bare DOM text node. Registered keys are
 *  preferred even when art-less so a later-added icon auto-upgrades the surface
 *  (emergent over scripted). General, used by every converted icon surface. */
export function iconGlyph(glyphKey: string | undefined, emoji: string): string {
  return glyphKey && getVocabularyItem(glyphKey) ? glyphKey : emoji;
}

/**
 * The bubble for a body settling into a DWELL — what it is doing, glanceable.
 *
 * THE STATION NAMES THE ACT when we know which piece was reached: at a toilet
 * the answer is "toilet", at a tub "wash". Only with no station to speak for it
 * does the POSE answer, and then through the project's own registered verb
 * art — the sit pose used to show a raw 🛋️ couch, so using the toilet (a seat,
 * pelvis contact ⇒ `sit`) announced itself with a sofa, and the custom `sit`
 * icon that already exists was never asked for.
 *
 * `stationKind` is the fixture kind reached (absent ⇒ none), `pose` the body's
 * activity. Pure — the glyph keys are looked up by the caller's compositor.
 */
export function dwellBubble(
  stationKind: string | undefined,
  pose: "sleep" | "eat" | "sit" | "play",
): { text: string; glyph?: string } {
  if (stationKind === "toilet") return activityBubbleContent("toilet", "🚽");
  if (stationKind === "bath") return activityBubbleContent("wash", "🫧");
  if (pose === "play") return activityBubbleContent("play", "🎮");
  if (pose === "sleep") return activityBubbleContent("sleep", "😴");
  if (pose === "eat") return activityBubbleContent("eat", "🍽️");
  return activityBubbleContent("sit", "🪑");
}

/**
 * Every glyph the dwell/rest bubbles can ever show, for prewarming the glyph
 * raster cache at session start — composing them ahead is what stops the first
 * bubble being text-only while its icon decodes.
 *
 * DERIVED by asking the functions themselves rather than listing keys, so it
 * cannot drift: a motive that today falls back to an emoji (no bundled art)
 * contributes nothing here, and the day art lands for it, it joins the prewarm
 * automatically with no edit.
 */
export function dwellBubbleGlyphs(): string[] {
  const poses = ["sleep", "eat", "sit", "play"] as const;
  const stations = ["toilet", "bath", undefined];
  const restKeys = ["fun", "hygiene", "waste", "rest"];
  const out = [
    ...poses.flatMap((p) => stations.map((s) => dwellBubble(s, p).glyph)),
    ...restKeys.map((k) => restDoneBubble(k).glyph),
  ];
  return Array.from(new Set(out.filter((g): g is string => !!g)));
}

/** The bubble a completed rest-shaped step shows (what just happened, glanceable). */
export function restDoneBubble(tplKey: string): { text: string; glyph?: string } {
  // Each motive shows the project's own REGISTERED glyph — "play" has bundled
  // artwork, and `wash`/`toilet`/`sleep` raster their own emoji through the
  // glyph path until art lands for them (which then upgrades these with no
  // change here). The emoji arg is the last-resort fallback only.
  if (tplKey === "fun") return activityBubbleContent("play", "🎮");
  if (tplKey === "hygiene") return activityBubbleContent("wash", "🫧");
  if (tplKey === "waste") return activityBubbleContent("toilet", "🚽");
  return activityBubbleContent("sleep", "💤");
}
