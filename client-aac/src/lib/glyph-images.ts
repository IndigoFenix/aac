// client-aac/src/lib/glyph-images.ts
//
// Image resolver for the shared glyph compositor. Maps a vocabulary item's
// `imagePath` to an actual asset URL via Vite's import.meta.glob — bundled
// icons under attached_assets/aac-icons/ are hashed at build time.
//
// For AI-generated keys (unknown to the registry), falls back to the
// on-demand symbol-generation endpoint.

import type { VocabularyItem } from "@shared/glyph-registry";
import type { ImageResolver } from "@shared/glyph-compositor";

// Vite glob: { "/abs/path/to/icons/people/me.png": "/built-url/me-hash.png", ... }
const iconUrlMap: Record<string, string> = import.meta.glob(
  "/attached_assets/aac-icons/**/*.{png,svg}",
  { eager: true, query: "?url", import: "default" }
) as Record<string, string>;

// Build a clean lookup by relative path (without extension).
// Key: "people/me" → value: hashed URL
const ICON_BY_RELATIVE_PATH: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const [absPath, url] of Object.entries(iconUrlMap)) {
    // absPath like "/attached_assets/aac-icons/people/me.png"
    const m = absPath.match(/\/aac-icons\/(.+)\.(png|svg)$/);
    if (m) out.set(m[1], url);
  }
  return out;
})();

/** Resolve a built-in icon path (no extension) to a hashed asset URL. */
export function resolveIconPath(relativePath: string): string | null {
  return ICON_BY_RELATIVE_PATH.get(relativePath) ?? null;
}

/** Endpoint hint for on-demand image generation of AI-generated keys. */
function resolveGeneratedImage(key: string): string {
  // The auto-symbol service caches generated images; clients can probe this
  // endpoint and get a 404 / pending state without breaking the SVG render.
  return `/api/symbols/generated/${encodeURIComponent(key)}.png`;
}

/**
 * The default image resolver passed to <GlyphCompositor>. Looks built-in
 * paths first (registry-attested), else falls back to the generated-symbol
 * endpoint for unknown keys.
 */
export const defaultImageResolver: ImageResolver = ({ item, key }) => {
  if (item?.imagePath) {
    const url = resolveIconPath(item.imagePath);
    if (url) return url;
  }
  // Unknown keys (AI-generated): point at the symbol service. If the
  // service returns no image, the compositor falls back to emoji/text.
  if (!item) return resolveGeneratedImage(key);
  return null;
};
