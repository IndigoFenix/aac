/**
 * Permitted-website helpers — shared by server (tool gating) and clients
 * (button handlers / nav guard).
 *
 * Matching is origin + path-prefix based: if a permitted entry's URL is
 * `https://en.wikipedia.org/wiki/`, any URL starting with that prefix
 * (after normalization) is permitted. Nested `subpages` are purely
 * AI-facing hints and do not further restrict.
 */

import type { PermittedWebsite, ParsedBoardData } from "./schema";

/** Normalize a URL for prefix comparison: lowercase host, keep scheme + path. */
export function normalizeUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    const host = u.host.toLowerCase();
    // Preserve path as-is (URLs are path-sensitive).
    return `${u.protocol}//${host}${u.pathname}`;
  } catch {
    return null;
  }
}

/** Flatten permitted list + subpages into a single list of allow-prefixes. */
export function flattenPermittedWebsites(list: PermittedWebsite[]): PermittedWebsite[] {
  const out: PermittedWebsite[] = [];
  const walk = (items: PermittedWebsite[]) => {
    for (const item of items) {
      out.push(item);
      if (item.subpages?.length) walk(item.subpages);
    }
  };
  walk(list);
  return out;
}

/**
 * Returns true if `url` is covered by any permitted entry (parent or subpage).
 * Because subpages are AI hints only, we still succeed on any ancestor match.
 */
export function isUrlPermitted(url: string, permitted: PermittedWebsite[] | undefined | null): boolean {
  if (!permitted || permitted.length === 0) return false;
  const target = normalizeUrl(url);
  if (!target) return false;
  for (const entry of flattenPermittedWebsites(permitted)) {
    const base = normalizeUrl(entry.url);
    if (!base) continue;
    if (target === base || target.startsWith(base)) return true;
  }
  return false;
}

/**
 * Extract all website URLs referenced by `open_website` button actions
 * anywhere in a board (all pages, all buttons).
 */
export function extractBoardWebsiteUrls(board: ParsedBoardData | null | undefined): string[] {
  if (!board?.pages) return [];
  const urls: string[] = [];
  for (const page of board.pages) {
    for (const btn of page.buttons || []) {
      if (btn.action?.type === "open_website" && btn.action.url) {
        urls.push(btn.action.url);
      }
    }
  }
  return urls;
}

/**
 * Merge any URLs present in board buttons into the permitted list as
 * auto-permitted entries (deduped by normalized URL). Used at runtime when
 * a custom board is loaded — board-authored URLs are implicitly permitted.
 */
export function mergeBoardWebsitesIntoPermitted(
  permitted: PermittedWebsite[] | undefined | null,
  board: ParsedBoardData | null | undefined,
): PermittedWebsite[] {
  const base = permitted ? [...permitted] : [];
  const seen = new Set<string>();
  for (const entry of flattenPermittedWebsites(base)) {
    const n = normalizeUrl(entry.url);
    if (n) seen.add(n);
  }
  for (const url of extractBoardWebsiteUrls(board)) {
    const n = normalizeUrl(url);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    base.push({ url, label: url });
  }
  return base;
}
