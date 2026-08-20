// shared/picture-search.ts
//
// ONE definition of what the AAC's picture search may look for and what a found
// picture looks like on the wire. Shared because the SERVER enforces the policy
// (it runs the search before anything opens) and the AAC CLIENT renders exactly
// what it is handed — two copies would drift, and the failure mode of drift is
// a picture on screen that nobody vetted.
//
// Why this feature exists: the assistant kept telling students it would "find a
// picture of a giraffe" and then had no way to do it. A model that promises a
// capability it lacks is worse than one that declines — a student who cannot
// re-ask has no way to recover from the broken promise. So either the capability
// is real (this module) or the prompt says plainly that it is not.
//
// Pure and dependency-free so it runs under the server jest config.

/** Registry id. Hard-coded in one place so client, server and settings agree. */
export const PICTURE_SEARCH_APP_ID = "picture_search";

/** Per-student settings, stored in `aac_settings.app_config.picture_search`. */
export interface PictureSearchConfig {
  /** Clinician opt-in. OFF unless someone deliberately turned it on. */
  enabled: boolean;
  /** Extra words this student must never see pictures of, on top of the
   *  baseline. Free text from the clinician, matched case-insensitively. */
  blockedTerms: string[];
  /** How many pictures one search may put on screen. */
  maxResults: number;
}

export const DEFAULT_MAX_RESULTS = 9;
export const MAX_RESULTS_CEILING = 18;
export const MIN_RESULTS = 1;

/** Longest query we will send upstream. Long enough for "a big red fire truck",
 *  short enough that a runaway model cannot paste a paragraph into a search. */
export const MAX_QUERY_CHARS = 64;

/** Shortest query worth running. One character matches everything. */
export const MIN_QUERY_CHARS = 2;

/**
 * Baseline blocks that apply to EVERY student regardless of settings.
 *
 * This is defence in depth, not the primary filter — provider SafeSearch is what
 * actually keeps explicit imagery out. What a word list adds is the categories
 * SafeSearch is not aimed at (gore, self-harm, weapons) and a hard stop on the
 * assistant relaying a distressed student's own phrasing straight into an image
 * search. It is deliberately short: a long list of near-misses blocks "chicken
 * breast" and teaches nobody anything.
 */
export const BASELINE_BLOCKED_TERMS: readonly string[] = [
  "porn", "nude", "naked", "sex", "sexy", "nsfw", "erotic", "fetish",
  "gore", "gory", "corpse", "dead body", "mutilated", "beheading",
  "suicide", "self harm", "selfharm", "cutting myself", "hang myself", "kill myself",
  "gun", "guns", "rifle", "pistol", "shotgun", "bomb", "explosive",
  "drug", "drugs", "cocaine", "heroin", "meth",
  "swastika", "nazi",
];

// ---------------------------------------------------------------------------
// RESULT-side screening
// ---------------------------------------------------------------------------
//
// A clean query can return dirty results, and that is the gap the lists above
// cannot close. Pixabay's `safesearch` is defined as "only images suitable for
// all ages" — an ADULT-content filter. A photograph of a cocktail bar is
// genuinely suitable for all ages by that standard, so "drink" comes back full
// of them (reported 2026-08-20): stock libraries are shot for advertising, and
// `order=popular` ranks what sells.
//
// Pixabay has no child-appropriateness parameter — confirmed against the API
// docs; `safesearch` is the only content flag it offers. So we screen the hits
// ourselves, using the `tags` string every hit carries.
//
// The lists are split by AMBIGUITY, which is the whole difficulty:
//   - TOKENS are words that mean one thing. Blocked wherever they appear inside
//     a tag phrase, so "alcoholic drink" and "beer bottle" both go.
//   - PHRASES are words that mean several things. Blocked ONLY as a complete
//     tag, so the tag "bar" (a drinking establishment) goes while "chocolate
//     bar" and "monkey bars" stay.
//
// Kept deliberately short and biased toward false NEGATIVES. Over-blocking here
// is invisible and permanent: the student asks for a picture, gets an empty
// grid, and cannot ask why. Words left out on purpose, because they earn their
// place on a child's screen far more often than not: sword and knight (fantasy
// art), knife and fork (cutlery), party and cake, weed (the garden kind),
// needle (sewing), smoke (campfires), war and soldier (history lessons).

/** Unambiguous words. Any tag CONTAINING one of these is rejected. */
export const UNSAFE_TAG_TOKENS: readonly string[] = [
  // Alcohol — the reported case.
  "alcohol", "alcoholic", "beer", "beers", "wine", "wines", "cocktail", "cocktails",
  "whisky", "whiskey", "vodka", "rum", "gin", "tequila", "brandy", "bourbon", "absinthe",
  "liquor", "liqueur", "champagne", "prosecco", "martini", "booze", "brewery", "distillery",
  "drunk", "drunken", "hangover", "bartender", "keg", "tavern", "saloon", "pint",
  // Smoking and vaping.
  "cigarette", "cigarettes", "cigar", "smoking", "smoker", "tobacco", "nicotine",
  "vape", "vaping", "hookah", "shisha", "ashtray",
  // Gambling.
  "casino", "gambling", "roulette", "poker", "betting",
  // Weapons and injury.
  "weapon", "weapons", "gun", "guns", "rifle", "pistol", "shotgun", "revolver",
  "firearm", "ammunition", "grenade", "blood", "bloody", "corpse", "autopsy", "wound",
  // Drugs.
  "cocaine", "heroin", "cannabis", "marijuana", "syringe",
  // Adult framing that SafeSearch lets through.
  "lingerie", "bikini", "topless", "cleavage", "seductive", "sensual", "erotic",
  // Death.
  "coffin", "funeral",
];

/** Ambiguous words. Rejected ONLY when they are the ENTIRE tag. */
export const UNSAFE_TAG_PHRASES: readonly string[] = [
  "bar", "bars", "pub", "pubs", "nightlife", "nightclub",
  "cemetery", "graveyard", "grave",
];

/**
 * The tag that disqualifies a search hit, or null when it is clean.
 *
 * `tags` is Pixabay's comma-separated string ("cocktail, bar, alcohol, glass").
 * Clinician-authored `extraTerms` screen results too, not just queries — a
 * clinician who blocked a word meant they did not want to see it, and a search
 * for something else that happens to return it is the same outcome.
 *
 * Returns the offending TAG rather than a boolean so the drop can be logged;
 * an over-eager entry here is otherwise invisible.
 */
export function blockedTagFor(
  tags: string,
  extraTerms: readonly string[] = [],
): string | null {
  const phrases = tags
    .toLowerCase()
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (phrases.length === 0) return null;

  const extras = extraTerms.map((t) => t.trim().toLowerCase()).filter(Boolean);

  for (const phrase of phrases) {
    if (UNSAFE_TAG_PHRASES.includes(phrase)) return phrase;
    const words = phrase.split(/[\s/-]+/);
    for (const word of words) {
      if (UNSAFE_TAG_TOKENS.includes(word)) return phrase;
    }
    // A clinician's term matches as a whole word inside the tag, or as a
    // substring for phrases and for scripts that do not space their words —
    // the same rule `blockedTermFor` applies to queries.
    for (const t of extras) {
      if (/^[a-z0-9]+$/.test(t) ? words.includes(t) : phrase.includes(t)) return phrase;
    }
  }
  return null;
}

/** Read the per-student config out of the raw `appConfig` jsonb blob.
 *  Defensive: the blob is client-writable, so nothing in it can be trusted to
 *  have the shape it claims. A malformed value degrades to "off". */
export function normalizePictureSearchConfig(raw: unknown): PictureSearchConfig {
  const cfg = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  const terms = Array.isArray(cfg.blockedTerms) ? cfg.blockedTerms : [];
  const rawMax = typeof cfg.maxResults === "number" && Number.isFinite(cfg.maxResults)
    ? Math.floor(cfg.maxResults)
    : DEFAULT_MAX_RESULTS;

  return {
    enabled: cfg.enabled === true,
    blockedTerms: terms
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)
      .slice(0, 200),
    maxResults: Math.min(MAX_RESULTS_CEILING, Math.max(MIN_RESULTS, rawMax)),
  };
}

/** Pull the picture-search entry out of a whole appConfig blob. */
export function pictureSearchConfigFrom(appConfig: unknown): PictureSearchConfig {
  const blob = appConfig && typeof appConfig === "object" ? (appConfig as Record<string, unknown>) : {};
  return normalizePictureSearchConfig(blob[PICTURE_SEARCH_APP_ID]);
}

/**
 * Reduce a model-supplied query to something safe to put on a search URL, or
 * null when nothing usable is left.
 *
 * Everything that is not a letter, a digit, whitespace or an apostrophe/hyphen
 * becomes a space. That is a WHITELIST on purpose: it kills search operators
 * (`site:`, `filetype:`, quoting, `|`) in one rule rather than chasing each one,
 * and — because it is written against Unicode letter classes — it leaves Hebrew,
 * Arabic and Chinese queries completely intact. A blacklist of ASCII punctuation
 * would have quietly mangled every non-Latin language we ship.
 */
export function normalizeSearchQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_CHARS)
    .trim();
  if (cleaned.length < MIN_QUERY_CHARS) return null;
  return cleaned;
}

/**
 * The blocked term a query trips, or null when it is clear.
 *
 * Word-boundary matching for single Latin words, plain containment for phrases
 * and for scripts with no spaces between words. Returning the TERM rather than a
 * boolean is deliberate: the caller logs which rule fired, so a clinician who
 * blocked "shot" can find out why "rocket shot" stopped working.
 */
export function blockedTermFor(
  query: string,
  extraTerms: readonly string[] = [],
): string | null {
  const q = query.toLowerCase();
  for (const term of [...BASELINE_BLOCKED_TERMS, ...extraTerms]) {
    const t = term.trim().toLowerCase();
    if (!t) continue;
    if (/^[a-z0-9]+$/.test(t)) {
      // Single ASCII word — respect word boundaries so "gun" does not block
      // "penguin". Phrases and non-Latin terms fall through to containment.
      if (new RegExp(`\\b${t}\\b`).test(q)) return t;
    } else if (q.includes(t)) {
      return t;
    }
  }
  return null;
}

/** One picture, as the AAC client receives it.
 *
 *  `thumbPath` / `displayPath` are SERVER-RELATIVE paths into our own image
 *  proxy, never the third-party URL. The student's device must not make requests
 *  to arbitrary hosts a search happened to return: that would leak their IP and
 *  a referrer to strangers, and would break the moment we turn CSP on. */
export interface PictureSearchResult {
  /** Stable within one result set — used as a React key and a nav index. */
  id: string;
  /** The page title the picture came from, already trimmed. May be empty. */
  title: string;
  /** Hostname the picture came from, shown to the student as provenance. */
  sourceDomain: string;
  width: number | null;
  height: number | null;
  thumbPath: string;
  displayPath: string;
}

/** The `appData` payload the server hands the client when the app opens. */
export interface PictureSearchPayload {
  /** The normalized query these results answer, or null when the app was opened
   *  with nothing searched yet (a student tapping it from the Apps page). */
  query: string | null;
  results: PictureSearchResult[];
}
