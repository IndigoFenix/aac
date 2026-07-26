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

/** The bubble a completed rest-shaped step shows (what just happened, glanceable). */
export function restDoneBubble(tplKey: string): { text: string; glyph?: string } {
  // "fun" shows the project's registered "play" glyph artwork (glyph-registry
  // "play", imagePath actions/body/play), NOT a dice/emoji; toilet is 🚽.
  if (tplKey === "fun") return activityBubbleContent("play", "🎮");
  if (tplKey === "hygiene") return activityBubbleContent(undefined, "🫧");
  if (tplKey === "waste") return activityBubbleContent(undefined, "🚽");
  return activityBubbleContent(undefined, "💤");
}
