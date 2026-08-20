// server/services/venue-menus/web-menu-fetcher.ts
//
// The `web` menu source (§4.2b): fetch a menu page and read it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ORDER IS THE SAFETY PROPERTY
//
//   candidate URL (from the BOUND place record only)
//     -> binding check (§3.1a)        <- REFUSAL HAPPENS HERE
//       -> Web Unlocker fetch
//         -> HTML to text
//           -> LLM extraction
//
// Binding runs BEFORE the fetch, not after. Two reasons, and the second is the
// one that matters: fetching first spends money on pages we then refuse, and it
// leaves an unbound URL exactly one code change away from a student's board.
// With the check first, an unbound page is never even retrieved.
//
// This path is what MenuSpark demonstrates works in Israel — with the bug
// fixed. Its failure was not the scraping; it was scraping a URL nothing tied
// to the place the user had chosen.
//
// ─────────────────────────────────────────────────────────────────────────────
// WEB PRICES ARE NOT DINE-IN PRICES
//
// The טומי רול teardown found the restaurant's OWN notice that delivery and
// takeaway prices differ from in-restaurant ones — on an aggregator page whose
// 59 rows were all priced. Our use case is a student sitting at a table, so a
// scraped price is wrong in a way that looks exactly like being right. Prices
// from this path are suppressed at board build regardless of `showPrices`; see
// menu-board-builder.ts.

import type { Venue } from "@shared/schema";
import { checkMenuBinding, type BindingResult } from "@shared/venue-binding";
import { fetchPageHtml, isBrightDataConfigured } from "./brightdata-client.js";
import { extractMenuFromText } from "./web-menu-extraction.js";
import type { RawMenuItem } from "./menu-refinement.js";

/** Paths a restaurant site keeps its menu on, in the order we would try them. */
const MENU_PATHS = ["/menu", "/menus", "/תפריט", "/our-menu", "/food"];

export type WebFetchFailure =
  | "not_configured"
  | "no_source_url"
  | "binding_refused"
  | "fetch_failed"
  | "nothing_extracted";

export interface WebMenuResult {
  ok: true;
  sourceUrl: string;
  items: RawMenuItem[];
  language?: string;
  currency?: string;
  binding: Extract<BindingResult, { ok: true }>;
  /** Rows the extractor was unsure of — feeds the review escalation. */
  requiresReview: boolean;
}

export interface WebMenuFailure {
  ok: false;
  reason: WebFetchFailure;
  detail?: string;
}

/**
 * Candidate menu URLs for a venue, best first.
 *
 * ONLY derived from the place's own `websiteUri` (§4.2b: "resolve the menu URL
 * from the bound place record only"). There is deliberately no search step: a
 * brand-name search with no spatial anchor is precisely how a Canadian
 * franchise won an Israeli query.
 *
 * Exported for tests — this decides what we are willing to fetch at all.
 */
export function menuUrlCandidates(venue: Pick<Venue, "websiteUri">): string[] {
  const site = venue.websiteUri?.trim();
  if (!site) return [];

  let base: URL;
  try {
    base = new URL(site.startsWith("http") ? site : `https://${site}`);
  } catch {
    return [];
  }

  // If the stored URL already points at a menu, trust it and stop.
  //
  // Decoded first: `new URL()` percent-encodes a non-ASCII path, so a Hebrew
  // menu path arrives as `/%D7%AA%D7%A4...` and a literal Hebrew test never
  // matches. An Israeli restaurant’s own menu link would then be treated as a
  // homepage, and we would fetch five guessed paths before trying the real one.
  let pathname = base.pathname;
  try {
    pathname = decodeURIComponent(base.pathname);
  } catch {
    // Malformed escape sequence — keep the raw path rather than losing the
    // candidate entirely.
  }
  if (/menu|תפריט/i.test(pathname)) return [base.toString()];

  const origin = base.origin;
  return [...MENU_PATHS.map((path) => `${origin}${path}`), base.toString()];
}

/**
 * Strip a page down to the text a menu reader needs.
 *
 * Cheap and deliberately crude: script/style/nav removal, tags to spaces,
 * entities decoded, whitespace collapsed. A full DOM parse would be more
 * accurate and is not worth a dependency here — the extraction model is
 * reading prose either way, and it is the one being asked to find the rows.
 *
 * Exported for tests: the entity handling in particular is easy to get wrong on
 * Hebrew pages, where a stray `&nbsp;` glues two dish names together.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t ]+/g, " ")
    // Spaces hugging a newline are block-tag residue, not layout. Left in,
    // every extracted line arrives with a leading space.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Model input cap. A menu page beyond this is navigation, not more dishes. */
const MAX_TEXT_CHARS = 24_000;

export interface FetchWebMenuOptions {
  /** Language to hint the extractor with — normally the student's. */
  expectedLanguage?: string;
}

/**
 * Fetch and read this venue's menu from the web.
 *
 * Returns a discriminated failure rather than throwing: every one of these
 * outcomes is ordinary, and all of them mean the same thing to a caretaker —
 * we could not find this restaurant's menu, please photograph it.
 */
export async function fetchWebMenu(
  venue: Venue,
  options: FetchWebMenuOptions = {},
): Promise<WebMenuResult | WebMenuFailure> {
  if (!isBrightDataConfigured()) return { ok: false, reason: "not_configured" };

  const candidates = menuUrlCandidates(venue);
  if (!candidates.length) return { ok: false, reason: "no_source_url" };

  let lastBindingDetail = "";

  for (const sourceUrl of candidates) {
    // ── Bind first. An unbound URL is never fetched. ──
    const binding = checkMenuBinding(
      {
        name: venue.name,
        countryCode: venue.countryCode,
        websiteUri: venue.websiteUri,
        address: venue.address,
        brandKey: venue.brandKey,
      },
      { sourceUrl },
    );

    if (!binding.ok) {
      lastBindingDetail = binding.detail;
      continue;
    }

    const html = await fetchPageHtml(sourceUrl);
    if (!html) continue;

    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    if (text.length < 80) continue; // a shell page, not a menu

    const extracted = await extractMenuFromText(text, {
      venueName: venue.name,
      ...(options.expectedLanguage ? { expectedLanguage: options.expectedLanguage } : {}),
    });

    if (!extracted || !extracted.items.length) continue;

    // The currency the page states is checked against the place a SECOND time.
    // The first check only had the URL; now we have what the page claims, and
    // `currency: "CAD"` on an Israeli place is the Aroma defect arriving late.
    if (extracted.currency) {
      const recheck = checkMenuBinding(
        { name: venue.name, countryCode: venue.countryCode, websiteUri: venue.websiteUri, address: venue.address },
        { sourceUrl, currency: extracted.currency },
      );
      if (!recheck.ok) {
        lastBindingDetail = recheck.detail;
        continue;
      }
    }

    return {
      ok: true,
      sourceUrl,
      items: extracted.items,
      ...(extracted.language ? { language: extracted.language } : {}),
      ...(extracted.currency ? { currency: extracted.currency } : {}),
      binding,
      requiresReview: extracted.requiresReview,
    };
  }

  return lastBindingDetail
    ? { ok: false, reason: "binding_refused", detail: lastBindingDetail }
    : { ok: false, reason: "nothing_extracted" };
}
