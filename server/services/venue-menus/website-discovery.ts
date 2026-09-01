// server/services/venue-menus/website-discovery.ts
//
// FINDING A MENU PAGE FOR A VENUE THAT HAS NO WEBSITE ON RECORD.
//
// The fetcher's original stance was "no search step at all", and the reason
// was real: a brand-name search with no spatial anchor is precisely how a
// Canadian franchise once won an Israeli query. What made that stance
// affordable was the assumption that place records would carry `websiteUri` —
// OSM rows mostly do not, and the paid Maps dataset that reliably supplies it
// is not configured. The result in practice was `no_source_url` on every
// venue a student asked about, i.e. the web source never fired at all
// (observed 2026-09-01).
//
// So the search step now exists, with the original lesson built in rather
// than ignored:
//
//   1. THE QUERY IS SPATIALLY ANCHORED. The venue's locality (from its
//      address) rides in the query, and for Israeli places the query word is
//      "תפריט" — which anchors the result set to Hebrew pages far harder than
//      any operator would.
//   2. NOTHING FOUND HERE IS TRUSTED. Every URL goes back through
//      `checkMenuBinding` in the fetcher — country by TLD, branch by name,
//      currency again after extraction. Discovery widens what we are willing
//      to TEST, never what we are willing to BELIEVE.
//   3. The venue row is NOT updated. A discovered URL may be an aggregator's
//      page (Wolt, ten-bis), which is a fine place to read a menu and a wrong
//      thing to record as the restaurant's own website. The menu keeps the
//      URL in its own `sourceUrl`, as always.
//
// The search itself goes to DuckDuckGo's plain-HTML endpoint first — no key,
// no JavaScript, trivially parseable — and falls back to fetching the same
// page through the Bright Data Unlocker when the direct request is blocked.

import type { Venue } from "@shared/schema";
import { fetchPageHtml, isBrightDataConfigured } from "./brightdata-client.js";

/** A search page is small; do not let a slow origin stall an app-open warm. */
const SEARCH_TIMEOUT_MS = 10_000;

/** More than this is deeper into the results than a menu plausibly lives. */
const MAX_CANDIDATES = 5;

/**
 * Hosts that can never be a menu page worth fetching: the search engines
 * themselves, and the walled gardens whose pages are JavaScript shells the
 * HTML-to-text pass reads as empty. Aggregators (wolt, tenbis, mishloha) are
 * deliberately NOT here — an aggregator page is a fine place to READ a menu,
 * and the branch check is what keeps it the right branch's.
 */
const EXCLUDED_HOSTS = [
  "duckduckgo.com",
  "google.com",
  "bing.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
  "waze.com",
  "maps.google.com",
  // Document-hosting mirrors: pages of chrome around an embedded file the
  // text pass cannot read (the live probe surfaced a scribd mirror of a menu).
  "scribd.com",
];

function isExcluded(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return EXCLUDED_HOSTS.some((bad) => h === bad || h.endsWith(`.${bad}`));
}

/**
 * The last comma-separated segment of an address that still has letters in it
 * — which is where street-first address formats keep the locality. Best
 * effort: a null is a weaker query, not a failure.
 */
export function localityOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /\p{L}/u.test(p));
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  // A trailing country name adds nothing a TLD check does not already do
  // better; prefer the segment before it when there is one.
  if (parts.length >= 2 && /^(israel|ישראל)$/i.test(last)) return parts[parts.length - 2];
  return last;
}

/**
 * The query, spatially anchored. The quoted name keeps multi-word venue names
 * whole; the locality and the language of the menu word do the anchoring that
 * the original no-search stance existed to protect.
 */
export function discoveryQuery(
  venue: Pick<Venue, "name" | "address" | "countryCode">,
): string {
  const menuWord = (venue.countryCode ?? "").toUpperCase() === "IL" ? "תפריט" : "menu";
  const locality = localityOf(venue.address);
  return [`"${venue.name}"`, locality, menuWord].filter(Boolean).join(" ");
}

/**
 * Result URLs out of DuckDuckGo's HTML endpoint, in page order.
 *
 * Two link shapes appear there: a redirect (`/l/?uddg=<encoded target>`) and,
 * on some variants, the target directly. Both are taken; everything else on
 * the page (ads carry `ad_domain`, internal nav stays on the engine's host)
 * is dropped by the exclusion list. One URL per host — the second hit on the
 * same site is the same site.
 */
export function parseSearchResults(html: string): string[] {
  const urls: string[] = [];
  const seenHosts = new Set<string>();

  const consider = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    if (isExcluded(url.hostname)) return;
    // Binary documents the HTML-to-text pass cannot read. A PDF is often the
    // REAL menu (the live probe found טריולה's own as result #3), but fetching
    // one buys a pile of bytes the extractor sees as noise — skip it rather
    // than spend an Unlocker fetch learning that again.
    if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(url.pathname)) return;
    const hostKey = url.hostname.toLowerCase().replace(/^www\./, "");
    if (seenHosts.has(hostKey)) return;
    seenHosts.add(hostKey);
    urls.push(url.toString());
  };

  // The redirect form. `uddg` is the percent-encoded target.
  for (const match of html.matchAll(/[?&]uddg=([^&"'<>\s]+)/g)) {
    if (urls.length >= MAX_CANDIDATES) break;
    try {
      consider(decodeURIComponent(match[1]));
    } catch {
      /* malformed escape — skip this one */
    }
  }

  // The direct form, if the page used it instead.
  if (!urls.length) {
    for (const match of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
      if (urls.length >= MAX_CANDIDATES) break;
      consider(match[1]);
    }
  }

  return urls.slice(0, MAX_CANDIDATES);
}

/** Direct fetch of the search page; null on any failure, never a throw. */
async function fetchSearchHtml(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          // The plain-HTML endpoint serves anything, but an empty UA gets an
          // empty page from some frontends.
          "User-Agent": "Mozilla/5.0 (compatible; AivotaMenuBot/1.0)",
          "Accept-Language": "he,en;q=0.8",
        },
      });
      if (!response.ok) return null;
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * The Wolt-targeted query. Separate from the general one because a Wolt page
 * is not just another result: it is the ONE source the live probes showed
 * server-rendering the full menu as HTML — dishes, descriptions, prices —
 * where restaurants' own sites were JS shells, PDFs, or reservation SPAs the
 * text pass reads as ~20 characters. Its URL also carries the branch city
 * (`/he/isr/petah-tikva/restaurant/…`), which is exactly what the branch
 * check needs to refuse the wrong-city twin.
 */
export function woltQuery(venue: Pick<Venue, "name">): string {
  return `site:wolt.com "${venue.name}"`;
}

/** One search, both transports. The fallback decision is "did we get
 *  RESULTS", never "did we get a page": a blocked direct request is not a
 *  4xx — the engine answers 202 with a full-size challenge page (measured
 *  2026-09-01, 14KB of it), so a response-status check would happily parse
 *  the challenge, find nothing, and report `no_source_url` without the
 *  Unlocker ever being asked — the one page it exists to get past. */
async function runSearch(query: string): Promise<string[]> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const direct = await fetchSearchHtml(searchUrl);
  let found = direct ? parseSearchResults(direct) : [];
  if (!found.length && isBrightDataConfigured()) {
    const unlocked = await fetchPageHtml(searchUrl);
    if (unlocked) found = parseSearchResults(unlocked);
  }
  return found;
}

/**
 * Candidate menu URLs for a venue with no website on record — Wolt hits
 * first, then the general results.
 *
 * Never throws; an empty array means the web has no answer we are willing to
 * test, and the caller reports `no_source_url` exactly as before.
 */
export async function discoverMenuUrls(venue: Venue): Promise<string[]> {
  const [wolt, general] = await Promise.all([
    runSearch(woltQuery(venue)),
    runSearch(discoveryQuery(venue)),
  ]);

  const found: string[] = [];
  const seenHosts = new Set<string>();
  for (const url of [...wolt, ...general]) {
    let hostKey: string;
    try {
      hostKey = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (seenHosts.has(hostKey)) continue;
    seenHosts.add(hostKey);
    found.push(url);
    if (found.length >= MAX_CANDIDATES) break;
  }

  if (found.length) {
    console.info(`[website-discovery] ${found.length} candidate(s) for venue=${venue.id}`);
  }
  return found;
}
