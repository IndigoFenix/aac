// games/nature-hike/src/glyph-resolver.ts
//
// Image resolver for the glyph compositor — the same registry-artwork subset
// world-lab bundles (each Vite app emits its own hashed copy of the aac-icons
// via import.meta.glob), so speech bubbles and board buttons render composed
// glyphs with the real artwork. Note: glyph-registry/emoji-registry resolve to
// the game's VENDORED engine snapshot (vite.config alias), so the lexicon the
// resolver keys on is the one the game shipped with.

import type { ImageResolver } from "@shared/glyph-compositor";
import { getVocabularyItemByEmoji } from "@shared/glyph-registry";
import { isEmoji } from "@shared/emoji-registry";
import { flagEmojiToIso } from "@shared/flag-emoji";
import { portraitFor } from "./portraits";

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

export const gameImageResolver: ImageResolver = ({ item, key }) => {
  if (item?.imagePath) {
    const url = resolveIconPath(item.imagePath);
    if (url) return url;
  }
  // A CREATURE'S OWN FACE (portraits.ts): below designed artwork, above every
  // generic lookup — a name is nobody's registry key, so a baked portrait is the
  // only picture "mara" will ever have.
  const portrait = portraitFor(key);
  if (portrait) return portrait;
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
