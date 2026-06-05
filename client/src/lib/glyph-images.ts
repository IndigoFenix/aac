// client/src/lib/glyph-images.ts
//
// Clinician-side mirror of the AAC client's glyph-image resolver. The two
// clients build separately, so each needs its own Vite glob of the
// shared aac-icons folder. Behavior matches client-aac/src/lib/glyph-images.ts:
// bundled-icon URLs are looked up by relative path, AI-generated symbol
// paths can be registered into a module-level cache, and a React hook
// lets components observe new registrations so the rendered glyph swaps
// from fallback → primary as symbols arrive.

import { useSyncExternalStore } from "react";
import type { VocabularyItem } from "@shared/glyph-registry";
import type { ImageResolver } from "@shared/glyph-compositor";
import { canResolveGlyph } from "@shared/glyph-compositor";
import { apiUrl } from "@/lib/queryClient";

// Vite root for the clinician client is `client/`, so we walk up two
// levels to reach `attached_assets/aac-icons/` at the repo root.
const iconUrlMap: Record<string, string> = import.meta.glob(
  "../../../attached_assets/aac-icons/**/*.{png,svg}",
  { eager: true, query: "?url", import: "default" }
) as Record<string, string>;

// Build a clean lookup by relative path (without extension).
// Key: "people/me" → value: hashed URL
const ICON_BY_RELATIVE_PATH: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const [absPath, url] of Object.entries(iconUrlMap)) {
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
 * symbol resolution flow (custom-symbol SSE) so the compositor can
 * render generated parts of a multi-slot glyph.
 */
const SYMBOL_PATH_BY_KEY = new Map<string, string>();

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
  if (prev === symbolPath) return;
  SYMBOL_PATH_BY_KEY.set(key, symbolPath);
  notifySymbolListeners();
}

/** Has a generated symbol been registered for this key? Server-safe shape. */
export function hasResolvedSymbol(key: string): boolean {
  return SYMBOL_PATH_BY_KEY.has(key);
}

/**
 * Clinician-side face cache: `face:<contactId>` → photo URL. The clinician has
 * no live camera/face cache like the AAC shell, so the board editor populates
 * this from the student's contacts (see registerStudentFace) and the resolver
 * reads it. Contacts with no stored photo are simply not registered → the
 * compositor falls back to the 👤 emoji.
 */
const FACE_URL_BY_ID = new Map<string, string>();

/** Register a contact's face photo URL. Safe to call repeatedly. */
export function registerStudentFace(contactId: string, photoUrl: string): void {
  if (FACE_URL_BY_ID.get(contactId) === photoUrl) return;
  FACE_URL_BY_ID.set(contactId, photoUrl);
  notifySymbolListeners();
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
  // Custom-symbol slot (`symbol:<id>`) → the stored image. Used by the clinician
  // board editor's glyph builder + previews.
  if (key.startsWith("symbol:")) {
    const id = key.slice("symbol:".length).trim();
    if (id) return apiUrl(`/api/custom-symbols/${id}/image`);
  }
  // Face slot (`face:<contactId>`) → the registered contact photo (board editor).
  if (key.startsWith("face:")) {
    const id = key.slice("face:".length).trim();
    return (id && FACE_URL_BY_ID.get(id)) || null;
  }
  return SYMBOL_PATH_BY_KEY.get(key) ?? null;
};

/**
 * React hook — subscribes to the symbol-path cache and returns the current
 * version counter. Use as a dependency for any memo that needs to react to
 * symbol generations (e.g. canResolveGlyph).
 */
export function useResolvedSymbolsVersion(): number {
  return useSyncExternalStore(
    subscribeSymbols,
    () => symbolStoreVersion,
    () => 0,
  );
}

/**
 * Given a glyph and a fallback string, return whichever can be rendered
 * right now. The hook re-subscribes to symbol-path updates so the result
 * automatically swaps from fallback → glyph as parts arrive.
 */
export function useDisplayGlyph(glyph?: string, fallback?: string): string | undefined {
  const version = useResolvedSymbolsVersion();
  void version;
  if (!glyph) return fallback;
  if (!fallback) return glyph;
  return canResolveGlyph(glyph, hasResolvedSymbol) ? glyph : fallback;
}
