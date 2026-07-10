// Pure (React-free) helpers for building Apps-board website tiles.
// Extracted from AppsBoard so the defensive coercion/labelling logic can be
// unit-tested without a component harness. Kept free of `@/` and React imports
// so it resolves under the server jest config (only `@shared/*` is aliased).

import type { PermittedWebsite } from "@shared/schema";

/** A website entry turned into an Apps-board tile. Structurally a subset of
 *  AppsBoard's internal AppTile, so it spreads straight into the tile list. */
export interface WebsiteTile {
  id: string;
  name: string;
  icon: null;
  imageUrl: string | null;
  fallbackIcon: string;
  appId: "browser";
  appData: { url: string; label: string };
}

/** Site hostname without a leading www., for a friendly default tile label. */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The site's own favicon URL, or null if the url can't be parsed. */
export function faviconUrl(url: string): string | null {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** Build the Apps-board website tiles from a student's permitted-websites list.
 *  Coerces defensively: a malformed settings value (non-array, or entries with
 *  no usable url) must never blank the whole board or crash the render. */
export function buildWebsiteTiles(permittedWebsites: unknown): WebsiteTile[] {
  const list = Array.isArray(permittedWebsites) ? (permittedWebsites as PermittedWebsite[]) : [];
  return list
    .filter(w => w && typeof w.url === "string" && w.url.trim() !== "")
    .map(w => {
      const name = w.label || hostFromUrl(w.url);
      return {
        id: `web:${w.url}`,
        name,
        icon: null,
        imageUrl: faviconUrl(w.url),
        fallbackIcon: "🌐",
        appId: "browser",
        appData: { url: w.url, label: name },
      } satisfies WebsiteTile;
    });
}
