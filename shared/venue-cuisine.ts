// shared/venue-cuisine.ts
//
// FOOD TYPES A STUDENT CAN BROWSE BY (§4.1, student-browse extension).
//
// The student half of Location Menus asks "what do you want to eat?" before it
// asks "where are we?". This file is the vocabulary that question is asked in,
// and the mapping from that vocabulary to what OpenStreetMap actually records.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CATEGORIES ARE FOOD, NOT CUISINES
//
// OSM thinks in nationalities — `italian`, `american`, `asian`, `regional`. A
// nonverbal student cannot read "Italian", and there is no picture of it. So
// the browsable set is FOOD: pizza, burger, chicken, ice cream. Each one maps
// to whatever OSM tags mean it, including the nationality tags, so a restaurant
// tagged `cuisine=italian` still turns up under 🍕 where a child can find it.
//
// Overlap is deliberate and harmless: a kebab place answers both 🧆 and 🥩,
// and a sushi bar tagged `sushi;japanese` answers both 🐟 and 🍜. A student
// looking under either should find it, and nothing here binds a menu — see
// venue-browse-service.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE KEYS ARE GLYPH KEYS
//
// Every category key is a `shared/glyph-registry.ts` entry, so the browse grid
// draws the same artwork, in the same style, with the same 11-locale label the
// student already meets everywhere else. It costs nothing and it means the word
// for "pizza" is defined in exactly one place.
//
// See planning-docs/aac-restaurant-menus.md §4.1.

/** One browsable food type. */
export interface CuisineCategory {
  /** A `glyph-registry` key — supplies the label, the art and the translation. */
  key: string;
  /** Fallback when the registry entry has no art yet. */
  emoji: string;
  /**
   * OSM `cuisine` tokens that mean this food. Matched against the venue's
   * `cuisine` column, which OSM writes lowercase and may semicolon-separate
   * (`cuisine=pizza;italian`).
   */
  cuisines: readonly string[];
  /**
   * OSM `amenity` values that mean this food on their own. A café is coffee
   * whether or not anyone tagged `cuisine=coffee_shop`, and in practice most
   * of them did not.
   */
  amenities?: readonly string[];
}

/**
 * The browse grid, in display order — 12 items, so a 4-column grid fills three
 * clean rows at the default board geometry.
 *
 * Ordered by how often a child asks for the thing, not alphabetically: the
 * first row should answer most presses without the student paging.
 */
export const CUISINE_CATEGORIES: readonly CuisineCategory[] = [
  { key: "pizza",     emoji: "🍕", cuisines: ["pizza", "italian", "pasta"] },
  { key: "burger",    emoji: "🍔", cuisines: ["burger", "hamburger", "american", "diner"] },
  { key: "ice_cream", emoji: "🍦", cuisines: ["ice_cream", "gelato", "frozen_yogurt"],
    amenities: ["ice_cream"] },
  { key: "chicken",   emoji: "🍗", cuisines: ["chicken", "fried_chicken", "wings", "poultry"] },

  { key: "falafel",   emoji: "🧆", cuisines: ["falafel", "hummus", "shawarma", "kebab", "middle_eastern", "lebanese", "turkish"] },
  { key: "sandwich",  emoji: "🥪", cuisines: ["sandwich", "bagel", "deli", "sub", "wrap", "toast"] },
  { key: "noodles",   emoji: "🍜", cuisines: ["noodle", "noodles", "ramen", "asian", "chinese", "thai", "japanese", "vietnamese", "korean"] },
  { key: "fish",      emoji: "🐟", cuisines: ["fish", "seafood", "sushi", "fish_and_chips"] },

  // `kebab`/`shawarma` appear here AND under falafel on purpose: a shawarma
  // place is a meat place and a "grilled things on a skewer" place, and a child
  // may be looking for either. Nothing binds on a match, so the cost of listing
  // it twice is zero and the cost of listing it once is a child not finding it.
  { key: "meat",      emoji: "🥩", cuisines: ["steak_house", "steak", "grill", "barbecue", "bbq", "meat", "kebab", "shawarma", "argentinian", "brazilian"] },
  { key: "cake",      emoji: "🍰", cuisines: ["cake", "bakery", "pastry", "dessert", "donut", "crepe", "waffle"],
    amenities: ["bakery"] },
  { key: "coffee",    emoji: "☕", cuisines: ["coffee_shop", "coffee", "tea"],
    amenities: ["cafe"] },
  { key: "soup",      emoji: "🍲", cuisines: ["soup", "stew"] },
];

/** Every category key, for validators and tests. */
export const CUISINE_CATEGORY_KEYS: readonly string[] = CUISINE_CATEGORIES.map((c) => c.key);

/** Look one up. Returns undefined for an unknown key rather than throwing —
 *  a stale key from a client is a miss, not a crash. */
export function cuisineCategory(key: string): CuisineCategory | undefined {
  return CUISINE_CATEGORIES.find((c) => c.key === key);
}

/**
 * Turn whatever the AI passed as `open_app("restaurant", data)` into a category.
 *
 * The Speaker is told to pass the food the student named, and it will pass a
 * WORD rather than a key — "pizza", "ice cream", "Italian", "a burger". So
 * match three ways, cheapest first: the key itself, the OSM tokens the category
 * already claims (which is how `italian` finds pizza), and finally a
 * word-boundary mention anywhere in the string.
 *
 * Returns null for anything unrecognised, which is a real answer: the app then
 * opens on the full grid and lets the student choose, rather than opening on a
 * guess about what they meant.
 */
export function matchCuisineCategory(text: string | null | undefined): CuisineCategory | null {
  const raw = (text ?? "").toLowerCase().trim();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, "_");

  const exact = CUISINE_CATEGORIES.find(
    (c) => c.key === normalized || c.cuisines.includes(normalized),
  );
  if (exact) return exact;

  // Word-boundary only. A substring test would let "chickpea" match "chicken"
  // and open the wrong grid on a word the student never said.
  //
  // Adjacent PAIRS are checked as well as single words, because several foods
  // are two words and the Speaker passes what the student said rather than a
  // key: "I want ice cream" has to reach `ice_cream`, and no single word in it
  // does. Pairs are joined the same way tags are folded, so one table serves
  // both jobs.
  const words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const terms = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) terms.add(`${words[i]}_${words[i + 1]}`);

  return (
    CUISINE_CATEGORIES.find(
      (c) => terms.has(c.key) || c.cuisines.some((token) => terms.has(token)),
    ) ?? null
  );
}

/**
 * Split an OSM tag value into comparable tokens.
 *
 * OSM writes `cuisine=pizza;italian` and, in the wild, `Pizza ; Italian` and
 * `ice cream`. Lowercase, split on the separator, trim, and fold spaces and
 * hyphens to underscores so `ice cream`, `ice-cream` and `ice_cream` are one
 * thing. A tag nobody normalised is still a tag a child's search should match.
 */
export function cuisineTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .toLowerCase()
    .split(";")
    .map((token) => token.trim().replace(/[\s-]+/g, "_"))
    .filter(Boolean);
}

/** The venue fields this module reads. Deliberately narrow so it stays pure. */
export interface CuisineVenueFields {
  cuisine?: string | null;
  venueType?: string | null;
}

/**
 * Does this venue serve this food type?
 *
 * Amenity is checked as well as cuisine because the amenity IS the answer for
 * whole classes of place: `amenity=cafe` is coffee, `amenity=ice_cream` is ice
 * cream, and most such places carry no `cuisine` tag at all. Ignoring amenity
 * would empty the two categories a child is most likely to press.
 */
export function venueServes(venue: CuisineVenueFields, category: CuisineCategory): boolean {
  const tokens = cuisineTokens(venue.cuisine);
  if (tokens.some((token) => category.cuisines.includes(token))) return true;

  if (category.amenities?.length) {
    const type = cuisineTokens(venue.venueType);
    if (type.some((token) => category.amenities!.includes(token))) return true;
  }
  return false;
}

/**
 * How many of these venues serve each food type.
 *
 * Counts drive the grid: a category with nothing behind it is a dead end, and
 * a dead end costs a student a dwell, a page change and the trust that the
 * button meant anything. The caller hides zeroes rather than greying them —
 * §3.3's rule for allergen-filtered items applies just as well here.
 */
export function countByCategory(
  venues: readonly CuisineVenueFields[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const category of CUISINE_CATEGORIES) {
    const n = venues.filter((venue) => venueServes(venue, category)).length;
    if (n > 0) counts.set(category.key, n);
  }
  return counts;
}

// —————————————————————————————————————-
// The app's startup payload
// —————————————————————————————————————-

/**
 * What `open_app("restaurant", ...)` hands the client.
 *
 * The MODE is decided on the server, not the client, and not by the AI. The AI
 * says what the student wants; the server knows whether a venue is bound, what
 * its menu says, whether a clinician allowed browsing, and what the student is
 * allergic to. Letting the model pick the mode would mean letting it open a
 * menu that does not exist.
 *
 * This is the whole reason the restaurant system is an APP rather than a board:
 * a board key resolves to one fixed surface, whereas an app open resolves
 * server-side to whichever of these the situation actually calls for.
 */
export type RestaurantMode = "menu" | "floor" | "search" | "caretaker";

export interface RestaurantPlace {
  venueId: string;
  name: string;
  distanceM: number;
  visitedBefore: boolean;
  hasMenu: boolean;
}

export interface RestaurantCategoryView {
  key: string;
  emoji: string;
  count: number;
}

export interface RestaurantAppPayload {
  mode: RestaurantMode;
  /** menu and floor modes: the venue we are at, when it is known. */
  venueName?: string;
  /**
   * menu mode: the built menu, as `ParsedBoardData`. Typed loosely here so
   * `shared/schema` stays out of a file the AAC client imports for a table of
   * emoji. The builder is the single source of truth for what is on it —
   * junk filter, allergens, categories, paging, prices, spoken-vs-shown names.
   */
  menuBoard?: unknown;
  /**
   * The generic eating-out words — hungry, thirsty, more, finished, yuck, hot,
   * bathroom, help.
   *
   * Sent in floor mode (where it IS the screen) and alongside the menu in menu
   * mode (where it is one press away). A menu can say "chicken soup" and cannot
   * say "this is too hot", so a student at a table with a menu open still needs
   * these; the menu board only keeps more/finished/bathroom.
   *
   * This board used to be registered in `availableBoards` as a virtual
   * pre-built board, which put it in the Board Manager's <prebuilt_boards> list
   * competing with the student's own boards. It belongs to the app.
   */
  floorBoard?: unknown;
  /** search mode: the food types actually available nearby. */
  categories?: RestaurantCategoryView[];
  /** search mode: places serving `food`, when the AI named one. */
  places?: RestaurantPlace[];
  /** search mode: the category key the open was seeded with, if any. */
  food?: string | null;
  /**
   * search mode: may this student look for PLACES, or is the grid vocabulary
   * only?
   *
   * False when a clinician left "Student can look for somewhere to eat" off.
   * The food grid still renders in full and every button still speaks — that is
   * a vocabulary board and never depended on the setting. What is withheld is
   * the outbound venue lookup, which is what the setting actually governs.
   */
  canSearch?: boolean;
  /** caretaker mode: why the student lanes were not available. */
  reason?: "no_menu" | "browse_off";
}
