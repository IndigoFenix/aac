// shared/venue-binding.ts
//
// THE BINDING CHECK (§3.1a) — may this menu be shown as THIS restaurant's?
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUG THIS FILE EXISTS FOR
//
// MenuSpark, live: a Hebrew search for "ארומה" resolved an ISRAELI Aroma, then
// served a menu scraped from `aromaespressobar.ca` with `currency: "CAD"`.
// Nothing tied the scraped URL to the selected place, so a franchise on another
// continent won on string similarity. A student would have been handed a board
// of dishes their café does not sell.
//
// Second case, same day: venue "טומי רול בר סניף רמת גן", menu URL
// `wolt.com/.../tommy-roll-givatayim`. Country, currency, and brand ALL agree
// and it is still the wrong restaurant — a different branch in a different city.
//
// Both are checkable facts, which is why this is code and not a caveat.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS AND IS NOT DECIDED HERE
//
// This file decides `bindingBasis` and `bindingBranchMatch` — the two NOT NULL
// columns that make a menu row carry its own justification. It does NOT decide
// whether a menu goes live: that is `resolveCacheStatus` in menu-cache.ts,
// which sends anything weaker than an exact branch match to a caretaker.
//
// Failing the check is a NORMAL outcome, not an error. When binding fails we
// tell the caretaker we could not find this restaurant's menu and fall through
// to the camera. Refusing is always correct; guessing never is.
//
// Pure and dependency-free.

/** Why we believe a menu belongs to a venue. Mirrors `venue_menus.binding_basis`. */
export type MenuBindingBasis =
  | "gps_place_match"
  | "place_website"
  | "caretaker_confirmed"
  | "camera"
  | "chain_fallback";

export type MenuBranchMatch = "exact" | "chain" | "unknown";

export type BindingRejection =
  | "country_mismatch"
  | "currency_mismatch"
  | "branch_mismatch"
  | "unusable_url";

/** The place record GPS resolved — the thing a menu must be bound TO. */
export interface PlaceRecord {
  name: string;
  /** ISO-3166 alpha-2. The anchor for the country and currency checks. */
  countryCode?: string | null;
  /** The place's OWN website, per-place rather than a global brand guess. */
  websiteUri?: string | null;
  address?: string | null;
  brandKey?: string | null;
}

/** A candidate menu source, before we have agreed to trust it. */
export interface MenuSourceCandidate {
  sourceUrl: string;
  /** Currency the source states, when it states one. */
  currency?: string | null;
  /** A branch name the source itself claims (page title, breadcrumb). */
  branchHint?: string | null;
}

export type BindingResult =
  | {
      ok: true;
      bindingBasis: MenuBindingBasis;
      bindingBranchMatch: MenuBranchMatch;
      bindingCountry?: string;
    }
  | { ok: false; rejections: BindingRejection[]; detail: string };

// ---------------------------------------------------------------------------
// Country and currency
// ---------------------------------------------------------------------------

/**
 * ccTLD → country. Longest suffix wins, so `co.il` beats `il` and `com.au`
 * beats `au`. Generic TLDs (.com/.net/.org/.food) are absent ON PURPOSE: they
 * say nothing about country, and a check that guessed from them would reject
 * legitimate menus.
 */
const TLD_COUNTRY: Record<string, string> = {
  "co.il": "IL", "org.il": "IL", il: "IL",
  "co.uk": "GB", "org.uk": "GB", uk: "GB",
  "com.au": "AU", au: "AU",
  "co.nz": "NZ", nz: "NZ",
  "com.br": "BR", br: "BR",
  ca: "CA", us: "US", de: "DE", fr: "FR", es: "ES", pt: "PT", it: "IT",
  nl: "NL", be: "BE", ch: "CH", at: "AT", ie: "IE", gr: "GR", tr: "TR",
  ru: "RU", cn: "CN", kr: "KR", jp: "JP", in: "IN", mx: "MX", za: "ZA",
};

/** Country → its currency. Only what a country/currency contradiction needs. */
const COUNTRY_CURRENCY: Record<string, string> = {
  IL: "ILS", CA: "CAD", US: "USD", GB: "GBP", AU: "AUD", NZ: "NZD",
  BR: "BRL", CH: "CHF", RU: "RUB", CN: "CNY", KR: "KRW", JP: "JPY",
  IN: "INR", MX: "MXN", ZA: "ZAR", TR: "TRY",
  DE: "EUR", FR: "EUR", ES: "EUR", PT: "EUR", IT: "EUR", NL: "EUR",
  BE: "EUR", AT: "EUR", IE: "EUR", GR: "EUR",
};

/** Hostname of a URL, lowercased and `www.`-stripped. Null if unparseable. */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/** The country a hostname's TLD implies, or null when it implies nothing. */
export function countryFromHost(host: string): string | null {
  const parts = host.split(".");
  for (let i = Math.max(0, parts.length - 3); i < parts.length; i++) {
    const suffix = parts.slice(i).join(".");
    if (TLD_COUNTRY[suffix]) return TLD_COUNTRY[suffix];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

/**
 * Israeli place names, Latin slug → Hebrew.
 *
 * Needed because the two halves of the comparison are written in different
 * scripts: the venue record says "סניף רמת גן" and the aggregator URL says
 * `tommy-roll-givatayim`. Without a bridge the branch check can never see a
 * contradiction, and the טומי רול defect passes silently.
 *
 * Deliberately small and Israel-only — this is the market we serve, and a table
 * that guessed at transliterations it does not know would manufacture
 * contradictions rather than find them. An unknown slug yields `unknown`, which
 * is already enough to force review.
 */
const PLACE_TRANSLITERATIONS: Record<string, string[]> = {
  givatayim: ["גבעתיים"],
  "ramat-gan": ["רמת גן", "רמתגן"],
  ramatgan: ["רמת גן", "רמתגן"],
  "tel-aviv": ["תל אביב", "תלאביב"],
  telaviv: ["תל אביב", "תלאביב"],
  jerusalem: ["ירושלים"],
  haifa: ["חיפה"],
  netanya: ["נתניה"],
  herzliya: ["הרצליה"],
  rishon: ["ראשון לציון", "ראשל״צ"],
  "petah-tikva": ["פתח תקווה"],
  petahtikva: ["פתח תקווה"],
  ashdod: ["אשדוד"],
  beersheva: ["באר שבע"],
  eilat: ["אילת"],
  raanana: ["רעננה"],
  modiin: ["מודיעין"],
  holon: ["חולון"],
  "bat-yam": ["בת ים"],
  kfarsaba: ["כפר סבא"],
  "kfar-saba": ["כפר סבא"],
};

/** Every place name we can recognise, in either script. */
function knownPlaceTokens(): Array<{ slug: string; hebrew: string[] }> {
  return Object.entries(PLACE_TRANSLITERATIONS).map(([slug, hebrew]) => ({ slug, hebrew }));
}

function normalizeLatin(text: string): string {
  return text.toLowerCase().replace(/[_\s]+/g, "-");
}

/**
 * Every known place this text names, as canonical slugs.
 *
 * Returns slugs so a Hebrew venue name and a Latin URL slug can be compared as
 * the same value. Plural because one string routinely names two places: a Wolt
 * URL carries a REGION segment as well as a branch slug
 * (`/he/isr/tel-aviv/restaurant/tommy-roll-givatayim`), and picking whichever
 * one happened to be checked first would decide a branch match by dictionary
 * order.
 */
export function placesIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const latin = normalizeLatin(text);

  const found = new Set<string>();
  for (const { slug, hebrew } of knownPlaceTokens()) {
    if (latin.includes(slug) || hebrew.some((form) => text.includes(form))) found.add(slug);
  }
  return [...found];
}

/** The first place a text names. Convenience over `placesIn`. */
export function placeIn(text: string | null | undefined): string | null {
  return placesIn(text)[0] ?? null;
}

/**
 * The part of a URL that names the BRANCH: the host plus the LAST path
 * segment.
 *
 * Deliberately not the whole path. An aggregator URL puts the region early
 * (`/he/isr/tel-aviv/...`) and the branch last, so reading the whole path would
 * let a Tel Aviv venue "match" a Givatayim branch on the region segment — a
 * false exact, which is worse than no match at all because it goes live
 * unattended.
 */
function branchTextOf(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : "";

  // Wolt is the ONE aggregator whose city segment is safe to read, because
  // its position is fixed by the URL scheme itself:
  // `/{lang}/{country}/{CITY}/restaurant/{branch-slug}`. Without this, a Wolt
  // page carried NO branch evidence at all — the city sat in the excluded
  // early segments and the final slug rarely names one — so a Ramat Gan
  // venue could bind the Petah Tikva branch's menu as an unrefusable "chain"
  // guess (found live, 2026-09-01, טריולה). Reading a FIXED position is not
  // the whole-path mistake the note above warns about: the region segment of
  // an arbitrary aggregator is a guess, Wolt's city segment is a contract.
  const host = url.hostname.toLowerCase();
  if (
    (host === "wolt.com" || host.endsWith(".wolt.com")) &&
    segments.length >= 4 &&
    (segments[3] === "restaurant" || segments[3] === "venue")
  ) {
    return `${url.hostname} ${segments[2]} ${last}`;
  }

  return `${url.hostname} ${last}`;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Bind a menu source to a place, or refuse.
 *
 * The country and currency checks are INDEPENDENT on purpose: the Aroma record
 * failed both, and either alone must be enough. A source that agrees on country
 * but states the wrong currency is telling us something the URL did not.
 */
export function checkMenuBinding(
  place: PlaceRecord,
  candidate: MenuSourceCandidate,
): BindingResult {
  const rejections: BindingRejection[] = [];
  const detail: string[] = [];

  const host = hostOf(candidate.sourceUrl);
  if (!host) {
    return { ok: false, rejections: ["unusable_url"], detail: candidate.sourceUrl };
  }

  const placeCountry = place.countryCode?.trim().toUpperCase() || null;

  // 1. Country. `aromaespressobar.ca` against an Israeli place — the exact bug.
  const urlCountry = countryFromHost(host);
  if (placeCountry && urlCountry && urlCountry !== placeCountry) {
    rejections.push("country_mismatch");
    detail.push(`url country ${urlCountry} != place country ${placeCountry}`);
  }

  // 2. Currency, checked independently of the URL.
  const currency = candidate.currency?.trim().toUpperCase() || null;
  const expected = placeCountry ? COUNTRY_CURRENCY[placeCountry] : null;
  if (currency && expected && currency !== expected) {
    rejections.push("currency_mismatch");
    detail.push(`currency ${currency} != ${expected} for ${placeCountry}`);
  }

  // 3. Branch. A PROVEN different branch is refused rather than downgraded:
  //    "chain" means we do not know which branch, and here we do know — it is
  //    the wrong one. There is nothing to show a student from the kitchen in
  //    the next city.
  const placeBranches = placesIn(`${place.name} ${place.address ?? ""}`);
  const sourceBranches = placesIn(
    `${branchTextOf(new URL(candidate.sourceUrl))} ${candidate.branchHint ?? ""}`,
  );
  const sharesBranch = sourceBranches.some((branch) => placeBranches.includes(branch));

  // Both name a place and they have none in common: we do not merely lack
  // evidence, we have evidence of the WRONG kitchen. Refuse.
  if (placeBranches.length && sourceBranches.length && !sharesBranch) {
    rejections.push("branch_mismatch");
    detail.push(`source branch ${sourceBranches.join("/")} != place branch ${placeBranches.join("/")}`);
  }

  if (rejections.length) return { ok: false, rejections, detail: detail.join("; ") };

  // ── Accepted. Now: how strongly? ──

  const placeHost = place.websiteUri ? hostOf(place.websiteUri) : null;
  const ownSite = !!placeHost && (host === placeHost || host.endsWith(`.${placeHost}`));

  const branchMatch: MenuBranchMatch =
    sharesBranch
      ? "exact"
      : ownSite && !placeBranches.length
        ? "unknown"
        : "chain";

  const basis: MenuBindingBasis = ownSite
    ? "place_website"
    : branchMatch === "exact"
      ? "gps_place_match"
      : "chain_fallback";

  return {
    ok: true,
    bindingBasis: basis,
    bindingBranchMatch: branchMatch,
    ...(placeCountry ? { bindingCountry: placeCountry } : {}),
  };
}
