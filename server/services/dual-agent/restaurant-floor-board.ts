// server/services/dual-agent/restaurant-floor-board.ts
//
// THE FLOOR BOARD — the data-free restaurant board.
//
// This is the board a student gets the moment we believe they are in a
// restaurant, and it needs NO menu, NO location lookup, and NO network call to
// be useful. It is the floor that everything else in the Location Menus feature
// stands on: a menu board AUGMENTS it, and when menu acquisition fails — no
// binding (planning-docs/aac-restaurant-menus.md §3.1a), no signal, a scrape
// that came back empty — the student is still left with the words that matter
// most rather than with nothing.
//
// Design rules, all of which the button table below obeys:
//
//   1. EVERY button is a SINGLE glyph-registry key. Not a composed
//      `head.mod` fragment — a composed one cannot be localized from one
//      tKey, and "don't like" composed as `like.not` renders in Hebrew as
//      "לא לאהוב", which is not what anyone says. `yuck` is one key, is
//      already translated in all 11 locales, and is what a child actually
//      means about food they are rejecting.
//   2. Labels are baked in ENGLISH here and localized on the client from
//      `aac.glyph.<key>`, exactly as guessing-mode suggestion buttons already
//      are (`localizeSuggestion` in DynamicBoard.tsx). The server has no t().
//   3. Buttons SPEAK the word; they do not navigate and do not exit the board.
//      A student ordering a meal presses several of these in a row, so
//      unloading on the first press would be actively hostile.
//
// Every key here is already present in shared/glyph-registry.ts with a
// translation in all 11 locales — this board added no i18n debt when it landed,
// and `npm run validate-glyphs` is what keeps that true.

import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { getVocabularyItem } from "@shared/glyph-registry";

// ---------------------------------------------------------------------------
// Button definitions
// ---------------------------------------------------------------------------

interface FloorButtonDef {
  /** Glyph-registry key. MUST be a single key — see rule 1 above. */
  glyphKey: string;
  /** English label, baked for the server side and used as the client's
   *  fallback when a translation is missing. */
  labelEn: string;
  /** Why this earns one of only eight slots. */
  rationale: string;
}

/**
 * Eight buttons, in reading order. The count matches the default home board's
 * 4x2 so the grid feels familiar, and eight is about the ceiling for a board
 * scanned under the pressure of a restaurant table.
 *
 * Ordering is deliberate: the two REQUESTS a student is most likely to open
 * with come first, the two CONTINUATION controls next (more / finished are the
 * highest-frequency presses once food arrives), then the two COMPLAINTS, then
 * the two ESCALATIONS. Nothing here needs a menu to make sense.
 */
const FLOOR_BUTTONS: FloorButtonDef[] = [
  { glyphKey: "hungry",   labelEn: "Hungry",    rationale: "opens the meal; the reason they are here" },
  { glyphKey: "thirsty",  labelEn: "Thirsty",   rationale: "drinks arrive before food and are asked for first" },
  { glyphKey: "more",     labelEn: "More",      rationale: "highest-frequency press once food is on the table" },
  { glyphKey: "finished", labelEn: "Finished",  rationale: "ends the meal; without it the student cannot say stop" },
  { glyphKey: "yuck",     labelEn: "Yuck",      rationale: "rejection of a specific food — the repair move a wrong menu makes necessary" },
  { glyphKey: "hot",      labelEn: "Hot",       rationale: "the one food complaint that is time-critical and safety-adjacent" },
  { glyphKey: "bathroom", labelEn: "Bathroom",  rationale: "urgent, and unrelated to any menu" },
  { glyphKey: "help",     labelEn: "Help",      rationale: "catch-all for everything these eight buttons cannot say" },
];

/** The board key used to reference the floor board in availableBoards. */
export const RESTAURANT_FLOOR_BOARD_KEY = "restaurant_floor";

// ---------------------------------------------------------------------------
// Board builder
// ---------------------------------------------------------------------------

/**
 * Build the restaurant floor board.
 *
 * Returns a ParsedBoardData usable as a virtual board in availableBoards, the
 * same way `buildDefaultHomeBoard` is. Labels come out English; the client
 * localizes them from each button's `glyph` key.
 *
 * @param name Board name for display. Callers that know the venue pass its
 *             name so the student sees where they are; otherwise a generic
 *             title is used. NOT localized here for the same reason labels
 *             are not — a venue name is a proper noun and must not be
 *             translated at all, and the generic fallback is localized on the
 *             client alongside the buttons.
 */
export function buildRestaurantFloorBoard(name?: string): ParsedBoardData {
  const cols = 4;
  const rows = 2;

  const buttons: BoardButton[] = FLOOR_BUTTONS.map((def, i) => {
    // Fail loudly at build time rather than shipping a button with no icon.
    // A floor-board button that renders as ❓ is worse than one that is absent,
    // because the student presses it expecting the word they were taught.
    const item = getVocabularyItem(def.glyphKey);
    if (!item) {
      throw new Error(
        `[restaurant-floor-board] glyph key "${def.glyphKey}" is not in the registry. ` +
          `The floor board only accepts registered single keys — see rule 1 in this file.`,
      );
    }

    return {
      id: `restaurant_floor_${def.glyphKey}`,
      row: Math.floor(i / cols),
      col: i % cols,
      label: def.labelEn,
      // The glyph is what the renderer prefers, and what the client localizes
      // the label from. Single key, so `getVocabularyItem` round-trips it.
      glyph: def.glyphKey,
      localizeFromGlyph: true,
      // Self-contained fallback for when generated art is not ready. The
      // registry emoji is always safe here — no imageKeys, per the
      // BoardButton.glyphFallback contract.
      ...(item.emoji ? { glyphFallback: item.emoji, iconRef: item.emoji } : {}),
      spokenText: def.labelEn,
      sentence: def.labelEn,
      // Speaks in place. Deliberately NOT exitBoard — see rule 3.
      action: { type: "speak" as const, text: def.labelEn },
    } as BoardButton;
  });

  return {
    name: name || "Restaurant",
    grid: { rows, cols },
    pages: [
      {
        id: "restaurant_floor_page_main",
        name: "Main",
        buttons,
      },
    ],
  };
}

/**
 * The glyph keys this board is built from, in slot order.
 *
 * Exported so the glyph-registry test suite can assert every one of them is
 * still registered AND still translated in all 11 locales. That assertion is
 * the thing standing between a registry cleanup and a Hebrew student getting a
 * board of raw English keys — the exact silent failure CLAUDE.md warns about,
 * since no `t()` call ever names `aac.glyph.hungry` literally.
 */
export const RESTAURANT_FLOOR_GLYPH_KEYS: readonly string[] =
  FLOOR_BUTTONS.map((b) => b.glyphKey);
