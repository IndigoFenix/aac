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
import type { ImageResolver } from "@shared/glyph-compositor";
import { canResolveGlyph } from "@shared/glyph-compositor";

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

/** Register an AI-generated key's resolved image URL. Safe to call repeatedly. */
export function registerSymbolPath(key: string, symbolPath: string): void {
  const prev = SYMBOL_PATH_BY_KEY.get(key);
  if (prev === symbolPath) return; // no-op: same path
  SYMBOL_PATH_BY_KEY.set(key, symbolPath);
  notifySymbolListeners();
}

/** Has a generated symbol been registered for this key? Server-safe shape. */
export function hasResolvedSymbol(key: string): boolean {
  return SYMBOL_PATH_BY_KEY.has(key);
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
 *   2. Server-resolved symbolPath (AI-generated keys with custom symbols)
 *   3. null → compositor falls back to emoji/text
 */
export const defaultImageResolver: ImageResolver = ({ item, key }) => {
  if (item?.imagePath) {
    const url = resolveIconPath(item.imagePath);
    if (url) return url;
  }
  return SYMBOL_PATH_BY_KEY.get(key) ?? null;
};
