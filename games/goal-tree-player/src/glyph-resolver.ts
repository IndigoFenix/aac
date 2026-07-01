// games/goal-tree-player/src/glyph-resolver.ts
//
// Image resolver for the glyph compositor in this game — mirrors the AAC client's
// `defaultImageResolver` core so an in-world speech bubble renders a composed
// glyph IDENTICALLY to the response-board buttons (same bundled artwork, not just
// emoji). The player is its own Vite app, so it bundles its own copy of the
// aac-icons via import.meta.glob (each app emits its own hashed assets).
//
// The AAC-only resolution paths (custom `symbol:<id>` endpoints, `face:<id>`
// caches, AI-generated symbolPaths) don't apply in the game, so this is the
// registry-artwork subset: imagePath → bundled icon, flag emoji → flag svg, and
// the reverse-emoji lookup for raw-emoji keys that ship bundled art.

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

export const playerImageResolver: ImageResolver = ({ item, key }) => {
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
