// games/world-lab/src/glyph-resolver.ts
//
// Image resolver for the glyph compositor in the lab — the same
// registry-artwork subset the goal-tree player bundles (each Vite app emits
// its own hashed copy of the aac-icons via import.meta.glob), so a quest
// village's speech bubbles render composed glyphs with the real artwork.

import type { ImageResolver } from "@shared/glyph-compositor";
import { getVocabularyItemByEmoji } from "@shared/glyph-registry";
import { isEmoji } from "@shared/emoji-registry";
import { flagEmojiToIso } from "@shared/flag-emoji";

// Vite glob: repo-root attached_assets/aac-icons/** → hashed asset URLs.
const iconUrlMap = import.meta.glob(
  "../../../attached_assets/aac-icons/**/*.{png,svg}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const ICON_BY_RELATIVE_PATH = new Map<string, string>();
for (const [absPath, url] of Object.entries(iconUrlMap)) {
  const m = absPath.match(/\/aac-icons\/(.+)\.(png|svg)$/);
  if (m) ICON_BY_RELATIVE_PATH.set(m[1]!, url);
}

function resolveIconPath(relativePath: string): string | null {
  return ICON_BY_RELATIVE_PATH.get(relativePath) ?? null;
}

export const labImageResolver: ImageResolver = ({ item, key }) => {
  if (item?.imagePath) {
    const url = resolveIconPath(item.imagePath);
    if (url) return url;
  }
  const iso = flagEmojiToIso(key);
  if (iso) {
    const url = resolveIconPath(`flags/${iso}`);
    if (url) return url;
  }
  if (isEmoji(key)) {
    const emojiItem = getVocabularyItemByEmoji(key);
    if (emojiItem?.imagePath) {
      const url = resolveIconPath(emojiItem.imagePath);
      if (url) return url;
    }
  }
  return null;
};
