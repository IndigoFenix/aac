// server/services/venue-menus/allergen-filter.ts
//
// Removing items a student must not be offered (§3.3).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHAT IT IS NOT
//
// This filter reduces exposure. It is NOT a guarantee that everything left on
// the board is safe to eat, and no code operating on a scraped or photographed
// menu could be. Live evidence: the טומי רול extraction was 59 rows of NAME AND
// PRICE — no ingredients, no descriptions. A dish cooked in peanut oil looks
// exactly like one that is not. Anyone reading this file must carry that
// forward: the caretaker at the table is the safety control, and this filter is
// there so the board does not actively hand a child the thing they react to.
//
// What it therefore does NOT do is pretend. `AllergenFilterResult` reports how
// much of the menu it could actually inspect, so a caller can tell a caretaker
// "this menu carries no ingredient text" instead of quietly implying a check
// happened.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULES
//
// 1. NEVER consult an extracted `dietary` tag. Defect (b) is live proof they are
//    unsafe in both directions ("Almond Croissant" → `dietary: []`). Note that
//    `RefinedMenuItem` does not even carry the field: the tags are dropped at
//    extraction, so this rule is structural rather than remembered.
// 2. Nothing CLEARS an item. There is no "nut free" claim, tag, or phrase that
//    marks a dish safe — an item is kept only because no term matched it.
// 3. An unknown allergen is still an allergen. Beyond the curated groups below,
//    the clinician's own words are matched literally, so "mango" filters mango
//    without anyone having taught this file about mangoes.
// 4. An item with no readable text at all is DROPPED. We cannot check nothing.
//
// A note on over-filtering: it is the safe direction and is accepted freely
// here. Dropping every wrap from a celiac student's board is a poorer menu;
// leaving one in is a hospital visit.
//
// See planning-docs/aac-restaurant-menus.md §3.3, §7.

import type { RefinedMenuItem } from "./menu-refinement.js";
import { stripBidi } from "./page-merge.js";

/**
 * A curated allergen group: any of `terms` appearing in the CLINICIAN's text
 * activates the group, and then any of `terms` appearing in an ITEM's text
 * removes that item.
 *
 * The lists are deliberately over-broad. `hummus` sits under sesame because it
 * is made with tahini; `pesto` under nuts because of the pine nuts; `roll` and
 * `pita` under gluten. Each is a dish a strict reading would let through.
 *
 * Hebrew and English both, because an Israeli menu is Hebrew and the clinician
 * may have typed either.
 */
interface AllergenGroup {
  id: string;
  terms: string[];
}

const ALLERGEN_GROUPS: readonly AllergenGroup[] = [
  {
    id: "nuts",
    terms: [
      "nut", "nuts", "peanut", "peanuts", "almond", "almonds", "walnut", "walnuts",
      "pecan", "pecans", "cashew", "cashews", "pistachio", "pistachios", "hazelnut",
      "hazelnuts", "macadamia", "praline", "marzipan", "nutella", "pesto",
      "אגוז", "אגוזי", "אגוזים", "בוטן", "בוטנים", "שקד", "שקדים", "פקאן",
      "קשיו", "פיסטוק", "לוז", "מרציפן", "נוטלה", "פסטו",
    ],
  },
  {
    id: "sesame",
    terms: [
      "sesame", "tahini", "tahina", "halva", "hummus", "houmous",
      "שומשום", "טחינה", "חלבה", "חומוס",
    ],
  },
  {
    id: "dairy",
    terms: [
      "milk", "dairy", "cheese", "butter", "cream", "yogurt", "yoghurt", "lactose",
      "mozzarella", "parmesan", "ricotta", "feta", "labneh", "gelato",
      "חלב", "חלבי", "גבינה", "גבינת", "חמאה", "שמנת", "יוגורט", "לקטוז",
      "מוצרלה", "פרמזן", "ריקוטה", "פטה", "לבנה", "גלידה",
    ],
  },
  {
    id: "egg",
    terms: [
      "egg", "eggs", "mayonnaise", "mayo", "omelette", "omelet", "meringue", "aioli",
      "ביצה", "ביצים", "מיונז", "חביתה", "מרנג", "אייולי",
    ],
  },
  {
    id: "gluten",
    terms: [
      "gluten", "wheat", "bread", "flour", "pasta", "couscous", "barley", "rye",
      "breadcrumb", "breadcrumbs", "pita", "bun", "roll", "wrap", "cracker",
      "pastry", "cake", "semolina", "seitan",
      "גלוטן", "חיטה", "לחם", "קמח", "פסטה", "קוסקוס", "שעורה", "שיפון",
      "פיתה", "לחמניה", "לחמנייה", "בורקס", "בצק", "עוגה", "סולת", "רול", "טורטיה",
    ],
  },
  {
    id: "soy",
    terms: ["soy", "soya", "tofu", "edamame", "miso", "soybean", "סויה", "טופו", "אדממה", "מיסו"],
  },
  {
    id: "fish",
    terms: [
      "fish", "salmon", "tuna", "anchovy", "anchovies", "cod", "sardine", "sardines",
      "דג", "דגים", "סלמון", "טונה", "אנשובי", "סרדין",
    ],
  },
  {
    id: "shellfish",
    terms: [
      "shellfish", "shrimp", "shrimps", "prawn", "prawns", "crab", "lobster",
      "calamari", "squid", "mussel", "mussels", "oyster", "oysters",
      "שרימפס", "סרטן", "לובסטר", "קלמארי", "פירות ים", "מולים",
    ],
  },
];

/**
 * Words that describe the ALLERGY rather than the allergen. Stripped before the
 * clinician's remaining words are used as literal search terms, so
 * "severe allergy to peanuts" searches for "peanuts" and not for "severe".
 */
const ALLERGY_STOPWORDS = new Set([
  "allergy", "allergies", "allergic", "intolerance", "intolerant", "sensitivity",
  "sensitive", "severe", "mild", "moderate", "reaction", "anaphylaxis", "anaphylactic",
  "epipen", "avoid", "avoids", "contains", "free", "and", "or", "the", "a", "an", "to",
  "no", "not", "all", "any", "food", "foods", "products", "product", "based",
  "אלרגיה", "אלרגי", "אלרגית", "אלרגיות", "רגישות", "רגיש", "רגישה", "חמורה", "חמור",
  "קלה", "קל", "תגובה", "להימנע", "ללא", "וגם", "או", "אי", "סבילות", "מוצרי", "מוצר",
]);

/** Hebrew one-letter prefixes that attach to a noun (ב ה ו כ ל מ ש). */
const HEBREW_PREFIXES = "בהוכלמש";
const HEBREW_LETTER = "\\u0590-\\u05FF";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHebrew(text: string): boolean {
  return /[֐-׿]/.test(text);
}

/**
 * Hebrew final letters, folded to their medial forms.
 *
 * This is not cosmetic. Hebrew rewrites a word's last letter when a suffix
 * attaches: בוטן (peanut) pluralises to בוטנים, ן becoming נ. A term stored in
 * its singular form therefore does NOT occur inside its own plural, and a
 * matcher that does not fold silently misses every real menu occurrence — the
 * dangerous direction, and invisible in English-only testing.
 *
 * Also what makes לחם match לחמניה (bread → roll) and שומשום match שומשומים.
 */
const HEBREW_FINAL_FORMS: Record<string, string> = {
  "ך": "כ",
  "ם": "מ",
  "ן": "נ",
  "ף": "פ",
  "ץ": "צ",
};

/** Bidi marks out, punctuation to spaces, final forms folded, lowercased. */
function normalize(text: string): string {
  return stripBidi(text)
    .toLowerCase()
    .replace(/[.,;:!?()[\]{}"'`״׳\/\\|+*—–-]/g, " ")
    .replace(/[ךםןףץ]/g, (char) => HEBREW_FINAL_FORMS[char] ?? char)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does `text` contain `term` as a WORD rather than as a fragment?
 *
 * Latin terms use word boundaries, so an "egg" allergy does not strike
 * "eggplant" — a genuinely unrelated vegetable, and filtering it would train a
 * caretaker to distrust the filter, which is its own hazard.
 *
 * Hebrew has no word boundary that `\b` understands, and it glues prefixes
 * (ב/ה/ו/כ/ל/מ/ש) and suffixes (plurals, possessives) directly onto the noun.
 * So a Hebrew term matches with an optional single prefix letter in front and
 * any letters behind: "אגוז" catches "אגוזים" and "באגוזים". Trailing letters
 * are allowed freely — that over-matches slightly, in the safe direction.
 */
export function textContainsTerm(text: string, term: string): boolean {
  const haystack = normalize(text);
  const needle = normalize(term);
  if (!haystack || !needle) return false;

  const pattern = isHebrew(needle)
    ? new RegExp(
        `(?:^|[^${HEBREW_LETTER}])[${HEBREW_PREFIXES}]?${escapeRegExp(needle)}[${HEBREW_LETTER}]*`,
      )
    : new RegExp(`\\b${escapeRegExp(needle)}\\b`);

  return pattern.test(haystack);
}

/**
 * Turn one clinician-written allergy line into the terms to search menus for.
 *
 * Two sources, both kept: every term of any curated group the line activates,
 * AND the line's own content words. The second is what makes an allergen this
 * file has never heard of still work — "mango" filters mango on its own.
 */
export function allergyTerms(allergyText: string): string[] {
  const normalized = normalize(allergyText);
  if (!normalized) return [];

  const terms = new Set<string>();

  for (const group of ALLERGEN_GROUPS) {
    if (group.terms.some((term) => textContainsTerm(normalized, term))) {
      for (const term of group.terms) terms.add(term);
    }
  }

  for (const rawToken of normalized.split(" ")) {
    // A Hebrew word may arrive with its prefix attached ("לבוטנים"); drop it so
    // the stem is what gets searched for.
    const token =
      isHebrew(rawToken) && rawToken.length > 3 && HEBREW_PREFIXES.includes(rawToken[0])
        ? rawToken.slice(1)
        : rawToken;

    if (ALLERGY_STOPWORDS.has(token) || ALLERGY_STOPWORDS.has(rawToken)) continue;
    // Latin needs 3 chars to be a plausible ingredient; Hebrew words are
    // shorter ("דג" is fish), so 2 is the floor there.
    const minLength = isHebrew(token) ? 2 : 3;
    if (token.length < minLength) continue;
    terms.add(token);
  }

  return [...terms];
}

export interface RemovedItem {
  name: string;
  /** The clinician's line that caused the removal — what a caretaker recognises. */
  allergyText: string;
  /** The specific word that matched, so a false positive is diagnosable. */
  term: string;
}

export interface AllergenFilterResult {
  items: RefinedMenuItem[];
  removed: RemovedItem[];
  /**
   * Kept items whose only checkable text was a bare name.
   *
   * This is the honesty field. A high count means the filter had almost nothing
   * to read and its silence means very little — surface it to the caretaker
   * rather than presenting a filtered board as a checked one.
   */
  uninspectableCount: number;
  /** Items dropped for having no readable text at all (rule 4). */
  unreadableCount: number;
  /** The allergy lines that produced at least one search term. */
  activeAllergies: string[];
}

/** Everything about an item a filter may read. Never `dietary` — see rule 1. */
function itemText(item: RefinedMenuItem): string {
  return [item.name, item.description, item.translatedName, item.category]
    .filter(Boolean)
    .join(" ");
}

/**
 * Remove every item that matches any of the student's recorded allergies.
 *
 * `allergies` is `medical_records.alerts_allergies` — free text a clinician
 * typed, in Hebrew or English, one line per allergy. A student with an empty
 * list has nothing filtered, which is why §4.7 declines to offer an "off"
 * switch: there would be no configuration it enables that an empty list does
 * not already give.
 */
export function filterItemsForAllergies(
  items: readonly RefinedMenuItem[],
  allergies: readonly string[] | null | undefined,
): AllergenFilterResult {
  const lines = (allergies ?? []).filter((line): line is string => typeof line === "string");

  const searches = lines
    .map((line) => ({ allergyText: line.trim(), terms: allergyTerms(line) }))
    .filter((entry) => entry.terms.length > 0);

  const kept: RefinedMenuItem[] = [];
  const removed: RemovedItem[] = [];
  let uninspectableCount = 0;
  let unreadableCount = 0;

  for (const item of items) {
    const text = itemText(item);

    // Rule 4: we cannot check nothing. With no allergies recorded there is
    // nothing to check FOR either, so a nameless row is simply junk and the
    // board builder's own filtering deals with it.
    if (!normalize(text)) {
      if (searches.length) {
        unreadableCount++;
        continue;
      }
      kept.push(item);
      continue;
    }

    const hit = (() => {
      for (const search of searches) {
        for (const term of search.terms) {
          if (textContainsTerm(text, term)) {
            return { allergyText: search.allergyText, term };
          }
        }
      }
      return null;
    })();

    if (hit) {
      // Absent, not greyed (§3.3). A nonverbal student cannot be asked to
      // interpret a disabled button, and a visible-but-dead item invites the
      // press we are trying to prevent.
      removed.push({ name: item.name, allergyText: hit.allergyText, term: hit.term });
      continue;
    }

    if (searches.length && !item.description?.trim()) uninspectableCount++;
    kept.push(item);
  }

  return {
    items: kept,
    removed,
    uninspectableCount,
    unreadableCount,
    activeAllergies: searches.map((s) => s.allergyText),
  };
}
