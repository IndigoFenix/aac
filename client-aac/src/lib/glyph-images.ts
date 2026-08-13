// client-aac/src/lib/glyph-images.ts
//
// Image resolver for the shared glyph compositor. Maps a vocabulary item's
// `imagePath` to an actual asset URL via Vite's import.meta.glob — bundled
// icons under attached_assets/aac-icons/ are hashed at build time.
//
// For AI-generated keys (unknown to the registry), falls back to the
// on-demand symbol-generation endpoint.

import { useSyncExternalStore } from "react";
import type { VocabularyItem } from "@shared/glyph-registry";
import { getVocabularyItemByEmoji } from "@shared/glyph-registry";
import type { ImageResolver } from "@shared/glyph-compositor";
import { canResolveGlyph } from "@shared/glyph-compositor";
import { isEmoji } from "@shared/emoji-registry";
import { flagEmojiToIso } from "@shared/flag-emoji";
import { apiUrl } from "@/lib/queryClient";

// Vite glob: { "/abs/path/to/icons/people/me.png": "/built-url/me-hash.png", ... }
// NOTE: the Vite root for client-aac is `client-aac/`, so the icons (which
// live in `attached_assets/aac-icons/` at the repo root) are referenced via
// a relative path that walks up out of the Vite root. A `/`-prefixed glob
// would resolve to `client-aac/attached_assets/...` and silently match
// nothing, which made every glyph fall back to its emoji.
const iconUrlMap: Record<string, string> = import.meta.glob(
  "../../../attached_assets/aac-icons/**/*.{png,svg}",
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

/**
 * Cache of resolved symbolPaths for AI-generated keys. Populated by the
 * sentence-builder when it receives `construction_symbol_ready` events
 * (registered via `registerSymbolPath`). The compositor reads from this
 * cache so that AI-generated payloads — both in the AI strip AND in the
 * glyph display — render their generated images.
 */
const SYMBOL_PATH_BY_KEY = new Map<string, string>();

// External-store machinery so React components can observe newly-registered
// symbol paths. Each registration bumps `symbolStoreVersion` and notifies
// any subscribed listeners; useResolvedSymbolsVersion returns the version
// so a downstream useMemo can re-evaluate `canResolveGlyph` and switch
// from the fallback glyph over to the intended one without a manual
// refresh.
let symbolStoreVersion = 0;
const symbolListeners = new Set<() => void>();
function notifySymbolListeners() {
  symbolStoreVersion++;
  for (const fn of symbolListeners) fn();
}
function subscribeSymbols(listener: () => void): () => void {
  symbolListeners.add(listener);
  return () => { symbolListeners.delete(listener); };
}

/** Register an AI-generated key's resolved image URL. Safe to call repeatedly.
 *
 * The server emits server-root paths like `/api/custom-symbols/<id>/image`.
 * In split-origin deployments (VITE_API_URL set) those need to be qualified
 * against the API origin or the SVG `<image>` element fetches the wrong
 * host. `apiUrl()` is the canonical helper that other render sites
 * (`AppMiniBoard`, `DynamicBoard`'s `__SYMBOL__:` path) already use — apply
 * it once here so every downstream consumer reads a fully-qualified URL.
 */
export function registerSymbolPath(key: string, symbolPath: string): void {
  const qualified = symbolPath.startsWith("/") ? apiUrl(symbolPath) : symbolPath;
  const prev = SYMBOL_PATH_BY_KEY.get(key);
  if (prev === qualified) return; // no-op: same path
  SYMBOL_PATH_BY_KEY.set(key, qualified);
  // A symbol path that previously failed may now have a fresh URL — clear
  // the failure mark so the renderer tries again.
  FAILED_SYMBOL_URLS.delete(qualified);
  notifySymbolListeners();
}

/**
 * PICTURES AN EMBEDDED GAME DREW for words no vocabulary holds — an in-world
 * creature's own face for the button that names it (`word_images` bridge
 * message; the world engine bakes them from the creature's 3D body). Data URLs,
 * so they render without touching the game's origin.
 *
 * Session-scoped to the game that sent them: the words are that world's
 * inhabitants, and "mara" means nothing once the world is gone — the shell
 * clears them when the game closes.
 */
const WORD_IMAGE_BY_KEY = new Map<string, string>();

/** Merge in a batch of game-supplied word pictures (later batches ADD to what is
 *  held; a repeat of the same picture is a no-op). */
export function registerWordImages(images: ReadonlyArray<{ key: string; image: string }>): void {
  let changed = false;
  for (const { key, image } of images) {
    if (!key || !image) continue;
    const k = key.toLowerCase();
    if (WORD_IMAGE_BY_KEY.get(k) === image) continue;
    WORD_IMAGE_BY_KEY.set(k, image);
    FAILED_SYMBOL_URLS.delete(image);
    changed = true;
  }
  if (changed) notifySymbolListeners();
}

/** Drop every game-supplied word picture (the game closed). */
export function clearWordImages(): void {
  if (!WORD_IMAGE_BY_KEY.size) return;
  WORD_IMAGE_BY_KEY.clear();
  notifySymbolListeners();
}

/** Has a generated symbol been registered for this key? Server-safe shape. */
export function hasResolvedSymbol(key: string): boolean {
  // A game-drawn word renders — that is the whole point of the picture arriving.
  const word = WORD_IMAGE_BY_KEY.get(key.toLowerCase());
  if (word && !FAILED_SYMBOL_URLS.has(word)) return true;
  const url = SYMBOL_PATH_BY_KEY.get(key);
  if (!url) return false;
  // A URL we already know is broken (404 from S3, expired upload, etc.)
  // doesn't count as resolved — the renderer should keep showing the
  // emoji/fallback rather than swap to a broken-image visual.
  return !FAILED_SYMBOL_URLS.has(url);
}

/**
 * URLs we've tried to load and gotten a render-error from. Populated by
 * GlyphCompositor's per-slot <image onError>. We treat the failure as
 * permanent for the page session — re-issuing the load would just
 * 404 again. The next server-pushed symbol_ready for the same key
 * clears its URL out of this set in case the backing image was
 * regenerated. Bumps the symbol-store version so subscribed glyphs
 * re-evaluate and swap to the emoji fallback.
 */
const FAILED_SYMBOL_URLS = new Set<string>();

export function markSymbolUrlFailed(url: string): void {
  if (!url) return;
  if (FAILED_SYMBOL_URLS.has(url)) return;
  FAILED_SYMBOL_URLS.add(url);
  notifySymbolListeners();
}

export function isSymbolUrlFailed(url: string | undefined | null): boolean {
  return !!url && FAILED_SYMBOL_URLS.has(url);
}

/**
 * Module-level pointer to the face-image cache's accessor. The AAC
 * shell calls `setFaceImageResolver(cache.getFaceImage)` on mount; the
 * glyph compositor's image resolver reads `face:<id>` slots through it
 * so a glyph carrying a known-contact face renders the actual cached
 * data URL instead of falling back to the 👤 silhouette.
 *
 * The cache itself lives in a React `useRef` (see useFaceImageCache),
 * so storing the accessor as a module-level pointer is safe — the
 * function closes over the ref, and the host clears the pointer on
 * unmount.
 */
let faceImageResolver: ((contactId: string) => string | null) | null = null;

export function setFaceImageResolver(
  resolver: ((contactId: string) => string | null) | null,
): void {
  faceImageResolver = resolver;
  // Bump the version so any glyphs currently rendering as 👤 (because
  // the cache wasn't available yet) re-evaluate now that it is.
  notifySymbolListeners();
}

/**
 * React hook — subscribes to the symbol-path cache and returns the current
 * version counter. Use as a dependency for any memo that needs to react to
 * symbol generations (e.g. canResolveGlyph). The version itself is opaque;
 * what matters is that it changes when new symbols land.
 */
export function useResolvedSymbolsVersion(): number {
  return useSyncExternalStore(
    subscribeSymbols,
    () => symbolStoreVersion,
    () => 0,  // server snapshot
  );
}

/**
 * React hook — given a glyph and a fallback string, returns whichever one
 * can be rendered right now. When the glyph references AI-generated keys
 * whose symbols haven't arrived yet, returns the fallback; once every
 * referenced key has a resolved visual, returns the glyph itself.
 * Re-subscribes via useResolvedSymbolsVersion so the swap happens
 * automatically when generation completes.
 */
export function useDisplayGlyph(glyph?: string, fallback?: string): string | undefined {
  const version = useResolvedSymbolsVersion();
  void version; // dependency tracker — value itself isn't used
  if (!glyph) return fallback;
  if (!fallback) return glyph;
  return canResolveGlyph(glyph, hasResolvedSymbol) ? glyph : fallback;
}

/**
 * The default image resolver passed to <GlyphCompositor>. Resolution order:
 *   1. Registry item with imagePath → bundled icon URL
 *   2. A game-supplied word picture (`word_images` — a creature's baked face)
 *   3. `symbol:<id>` slot → /api/custom-symbols/<id>/image (qualified)
 *   4. `face:<id>` slot → cached face data URL (or null → 👤 fallback)
 *   5. Server-resolved symbolPath (AI-generated imageKeys, cached by key)
 *   6. null → compositor falls back to emoji/text
 *
 * URLs that have hit `<image onError>` are skipped so a broken S3 object
 * (e.g. a long-orphaned generated symbol) doesn't keep showing the
 * browser's broken-image glyph — the slot drops back to the canonical
 * emoji or the fallback string instead.
 */
export const defaultImageResolver: ImageResolver = ({ item, key }) => {
  if (item?.imagePath) {
    const url = resolveIconPath(item.imagePath);
    if (url && !FAILED_SYMBOL_URLS.has(url)) return url;
  }
  // A picture the running game drew for one of its own words. Below designed
  // artwork (a registry symbol is the vocabulary's own answer) and above every
  // generic lookup — nothing else will ever resolve a creature's name.
  const drawn = WORD_IMAGE_BY_KEY.get(key.toLowerCase());
  if (drawn && !FAILED_SYMBOL_URLS.has(drawn)) return drawn;
  // Country-flag emoji → bundled flag SVG (Windows/Chrome have no flag glyphs).
  const iso = flagEmojiToIso(key);
  if (iso) {
    const url = resolveIconPath(`flags/${iso}`);
    if (url && !FAILED_SYMBOL_URLS.has(url)) return url;
  }
  // Reverse-emoji lookup: when the AI emits a slot key that's a raw
  // emoji (the path it uses for non-exposed items like walk/run), see
  // if a registry entry claims that emoji and ships bundled artwork.
  // If so, render the bundled icon instead of the plain emoji glyph —
  // bundled art can flip in RTL, emojis can't. Restricted to the
  // non-exposed subset so emojis shared with exposed items (e.g. 🤲
  // for want) don't accidentally claim the bundled path when the AI
  // intended the emoji literally.
  if (isEmoji(key)) {
    const emojiItem = getVocabularyItemByEmoji(key);
    if (emojiItem?.imagePath) {
      const url = resolveIconPath(emojiItem.imagePath);
      if (url && !FAILED_SYMBOL_URLS.has(url)) return url;
    }
  }
  // Direct symbol:<id> reference — the AI emitted a custom-symbol slot
  // by ID without going through the bracket-imageKey route. Mirrors the
  // resolution `AppMiniBoard` / `DynamicBoard` already do at the
  // single-button level so the glyph compositor and the legacy renderer
  // hit the same `/api/custom-symbols/<id>/image` endpoint.
  if (key.startsWith("symbol:")) {
    const symbolId = key.substring(7).trim();
    if (symbolId) {
      const url = apiUrl(`/api/custom-symbols/${symbolId}/image`);
      if (!FAILED_SYMBOL_URLS.has(url)) return url;
    }
  }
  // face:<id> — pulled from the face-image cache the AAC shell pushes
  // into faceImageResolver. The cache holds data URLs from biometric
  // ID events; missing entries return null and the slot falls through
  // to the 👤 emoji that resolveEmoji emits for `face:` keys.
  if (key.startsWith("face:")) {
    const contactId = key.substring(5).trim();
    if (contactId && faceImageResolver) {
      const dataUrl = faceImageResolver(contactId);
      if (dataUrl && !FAILED_SYMBOL_URLS.has(dataUrl)) return dataUrl;
    }
    return null;
  }
  const symbolUrl = SYMBOL_PATH_BY_KEY.get(key);
  if (symbolUrl && !FAILED_SYMBOL_URLS.has(symbolUrl)) return symbolUrl;
  return null;
};
