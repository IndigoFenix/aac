// client-aac/src/lib/glyphRaster.ts
//
// Thin AAC-client wrapper over the world-engine's baked-in glyph→image mechanism
// (shared/world-engine/glyph-images.ts). The raster logic now lives there so the
// goal-tree player and social-world share ONE implementation; this file just
// binds it to the AAC client's image resolver + UI direction. Existing callers
// (SocialWorldCanvas, the BubbleTest debug harnesses) import `glyphBubbleImageUrl`
// from here unchanged.

import { rasterizeGlyphToUrl } from "@shared/world-engine/glyph-images";
import { defaultImageResolver } from "@/lib/glyph-images";

/**
 * Resolve a composed glyph string to a single self-contained image (SVG data
 * URL) of the WHOLE glyph. RTL follows the document direction so it matches the
 * student's UI language. Returns null for an empty/unrenderable glyph.
 */
export async function glyphBubbleImageUrl(glyph: string): Promise<string | null> {
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  return rasterizeGlyphToUrl(glyph, { resolveImage: defaultImageResolver, rtl });
}
