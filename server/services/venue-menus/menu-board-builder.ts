// server/services/venue-menus/menu-board-builder.ts
//
// Turning a reviewed menu into a board the student can order from (§4.5).
//
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC BY DESIGN
//
// No model runs here. §3.2 says the board is built by server code from
// extracted items, and the Board Manager may lay out, group, and label but may
// never mint a dish. This file is where that promise is kept: every button's
// text comes from a `RefinedMenuItem` that survived extraction, refinement
// (which cannot invent — see menu-refinement.ts), caretaker review, and the
// allergen filter. There is no path here through which a new dish can appear.
//
// Pure and synchronous, so the whole layout is unit-testable without a database
// or a network.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR THINGS THIS FILE GETS RIGHT
//
// 1. JUNK. `boardableItems` drops notice rows, or a student presses
//    "Dear customers!" — a real row from the טומי רול extraction.
// 2. ALLERGENS. Filtered items are ABSENT, never greyed (§3.3): a nonverbal
//    student cannot be asked to interpret a disabled button.
// 3. WHAT GETS SPOKEN. The label is in the student's language; the SPOKEN text
//    is the original dish name. A waiter cannot act on a translated name, and
//    "שניצלונים" reaching a waiter as "Survivors" (a real machine-translation
//    from the teardown) is an order nobody can fill.
// 4. ESSENTIALS SURVIVE. Every page keeps more / finished / bathroom, and those
//    stay live even in reading mode. A menu must never take away the words a
//    student had before it loaded.
//
// See planning-docs/aac-restaurant-menus.md §4.5, §3.3.

import type { ParsedBoardData, BoardButton, BoardPage } from "@shared/schema";
import { getVocabularyItem } from "@shared/glyph-registry";
import { boardableItems, type RefinedMenuItem, type RefinementResult } from "./menu-refinement.js";
import { filterItemsForAllergies, type AllergenFilterResult } from "./allergen-filter.js";

/** Board geometry. Four columns matches the floor board and the default home. */
const DEFAULT_COLS = 4;
/** Rows of menu items above the essentials row. */
const DEFAULT_ITEM_ROWS = 2;

/**
 * The words that stay on every page, in the essentials row.
 *
 * A deliberate subset of the floor board (§3, requirement 4): the three a
 * student needs WHILE ordering. `hungry`/`thirsty` are not here — the menu
 * itself now says those things far better than one generic button could.
 */
const ESSENTIAL_KEYS = ["more", "finished", "bathroom"] as const;

/** Kind → fallback emoji, for before generated art arrives. */
const KIND_EMOJI: Record<string, string> = {
  food: "🍽️",
  drink: "🥤",
  condiment: "🧂",
  unknown: "🍽️",
};

export interface VenueMenuBoardSettings {
  categoryPages: boolean;
  showPrices: boolean;

}

export interface VenueMenuBoardInput {
  /** Shown as the board name. A venue name is a proper noun — never translated. */
  venueName: string;
  /**
   * Where the menu came from. Governs PRICES, and only prices.
   *
   * The טומי רול page carried the restaurant's own notice that delivery and
   * takeaway prices differ from in-restaurant ones — on a page whose 59 rows
   * were all priced. Our student is sitting at a table, so a scraped price is
   * wrong in the way that looks most like being right. Only a photograph of the
   * menu in front of the student prices a dine-in meal.
   */
  provenance?: "camera" | "web" | "manual";
  /** Items as stored on the `venue_menus` row (post-refinement, post-review). */
  items: readonly RefinedMenuItem[];
  settings: VenueMenuBoardSettings;

  grid?: { cols?: number; itemRows?: number };
}

export interface VenueMenuBoardResult {
  /**
   * The board, or NULL when nothing orderable survived.
   *
   * Null is a real outcome, not an error: an empty menu, a menu that was all
   * notices, or a student whose allergies rule out everything on it. The caller
   * falls back to the floor board — eight words beats an empty grid.
   */
  board: ParsedBoardData | null;
  stats: {
    /** Items on the menu row before any filtering. */
    total: number;
    /** Notice/section rows dropped as junk. */
    notices: number;
    /** Always empty since 2026-09-01 — allergen filtering is out of the
     *  serving path (see step 2 in the build). Field kept so stored stats and
     *  the later allergen design have a stable shape to return to. */
    removedByAllergy: AllergenFilterResult["removed"];
    /** Always zero since the same decision — see removedByAllergy. */
    uninspectableCount: number;
    /** Items dropped for having no readable text at all. */
    unreadableCount: number;
    categories: string[];
    pageCount: number;
    /** Prices were asked for but withheld because the source was the web. */
    pricesSuppressed: boolean;
  };
}

/** The label a student reads: translated when we have one, original otherwise. */
function displayName(item: RefinedMenuItem): string {
  return item.translatedName?.trim() || item.name.trim();
}

/**
 * What the device says on press: ALWAYS the original.
 *
 * The student is speaking to a waiter, not to us. A translated dish name is
 * unorderable — sometimes comically so — and the original is exactly the string
 * printed on the menu the waiter is holding.
 */
function spokenName(item: RefinedMenuItem): string {
  return item.name.trim();
}

function priceSuffix(item: RefinedMenuItem, showPrices: boolean): string {
  if (!showPrices) return "";
  const price = item.priceText?.trim() || (item.price !== undefined ? String(item.price) : "");
  return price ? `  ${price}` : "";
}

function essentialButton(key: string, row: number, col: number): BoardButton | null {
  const entry = getVocabularyItem(key);
  if (!entry) return null; // A missing key drops one button, never the board.

  const labelEn = key.charAt(0).toUpperCase() + key.slice(1);
  return {
    id: `venue_essential_${key}`,
    row,
    col,
    label: labelEn,
    glyph: key,
    // Server has no t(); the client localizes from `aac.glyph.<key>`, exactly
    // as the floor board does.
    localizeFromGlyph: true,
    ...(entry.emoji ? { glyphFallback: entry.emoji, iconRef: entry.emoji } : {}),
    spokenText: labelEn,
    sentence: labelEn,
    readingModeSafe: true,
    action: { type: "speak" as const, text: labelEn },
  } as BoardButton;
}

/**
 * A page-navigation button, localized through the glyph registry.
 *
 * `glyphKey` must be a registry key (`return`, `next`) so the client renders
 * `aac.glyph.<key>` in the student's language — the server has no t(), and a
 * hardcoded "Back" reached Hebrew boards in English (2026-09-01). The emoji is
 * passed EXPLICITLY rather than taken from the registry: the registry's
 * `return` fallback is 🔙, whose baked-in "BACK" lettering mirrors into
 * gibberish under RTL. ↩️/➡️ are pure arrows — mirroring them is exactly
 * what a direction should do when the reading order flips.
 */
function navButton(
  id: string,
  glyphKey: string,
  labelEn: string,
  toPageId: string,
  row: number,
  col: number,
  emoji: string,
): BoardButton {
  return {
    id,
    row,
    col,
    label: labelEn,
    glyph: glyphKey,
    localizeFromGlyph: true,
    iconRef: emoji,
    glyphFallback: emoji,
    // Navigation is always live (the reading-mode gate is gone from menus,
    // but the flag is harmless and correct if it ever returns).
    readingModeSafe: true,
    action: { type: "link" as const, toPageId },
  } as BoardButton;
}

function itemButton(
  item: RefinedMenuItem,
  index: number,
  showPrices: boolean,
): PlacedButton {
  const spoken = spokenName(item);
  const emoji = KIND_EMOJI[item.kind] ?? KIND_EMOJI.unknown;

  return {
    id: `venue_item_${index}`,
    row: 0,
    col: 0,
    label: `${displayName(item)}${priceSuffix(item, showPrices)}`,
    // Art from the auto-icon pipeline. `imageKey` is English, generic, and
    // never a proper noun (enforced in menu-refinement.ts), so a branded dish
    // maps to its generic food art rather than to the brand.
    ...(item.imageKey ? { imageKey: item.imageKey } : {}),
    iconRef: emoji,
    glyphFallback: emoji,
    // NOT localizeFromGlyph: a dish name is data, not a registry word. Routing
    // it through the glyph table would replace the dish with whatever word the
    // key happened to name.
    spokenText: spoken,
    sentence: spoken,
    // Speaks in place. A student ordering a meal presses several of these in a
    // row, so unloading the board on the first press would be hostile.
    action: { type: "speak" as const, text: spoken },
  } as PlacedButton;
}

/** Group items by category, preserving menu order both within and between. */
function groupByCategory(items: readonly RefinedMenuItem[]): Map<string, RefinedMenuItem[]> {
  const groups = new Map<string, RefinedMenuItem[]>();
  for (const item of items) {
    const key = item.category?.trim() || "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** A button whose row/col are assigned by the paginator, not by its maker. */
type PlacedButton = BoardButton;

interface LayoutOptions {
  pageIdPrefix: string;
  pageName: string;
  cols: number;
  itemRows: number;
  /** Adds a Back link to this page in the essentials row. */
  indexPageId?: string;
}

/**
 * Lay content buttons across as many pages as they need, giving every page the
 * essentials row.
 *
 * Used for BOTH the item pages and the category index, because a menu with ten
 * categories overflows a page exactly as a category with ten dishes does. When
 * content overruns, the LAST content slot becomes a "More" link rather than the
 * essentials row losing a slot — a student must never trade "bathroom" for more
 * of the menu.
 */
function layoutPages(content: readonly PlacedButton[], opts: LayoutOptions): BoardPage[] {
  const { pageIdPrefix, pageName, cols, itemRows, indexPageId } = opts;
  const perPage = cols * itemRows;
  const pages: BoardPage[] = [];

  let cursor = 0;
  let pageNo = 0;

  do {
    const remaining = content.length - cursor;
    const needsNext = remaining > perPage;
    const capacity = needsNext ? perPage - 1 : perPage;
    const slice = content.slice(cursor, cursor + capacity);

    const pageId = pageNo === 0 ? pageIdPrefix : `${pageIdPrefix}_${pageNo + 1}`;
    const buttons: BoardButton[] = slice.map((button, i) => ({
      ...button,
      row: Math.floor(i / cols),
      col: i % cols,
    }));

    if (needsNext) {
      buttons.push(
        navButton(
          `${pageId}_next`,
          "next",
          "Next",
          `${pageIdPrefix}_${pageNo + 2}`,
          Math.floor(capacity / cols),
          capacity % cols,
          "➡️",
        ),
      );
    }

    let col = 0;
    if (indexPageId) {
      buttons.push(navButton(`${pageId}_back`, "return", "Back", indexPageId, itemRows, col++, "↩️"));
    }
    for (const key of ESSENTIAL_KEYS) {
      const button = essentialButton(key, itemRows, col);
      if (button) {
        // Ids must be unique across the BOARD, not merely the page.
        buttons.push({ ...button, id: `${pageId}_${button.id}` });
        col++;
      }
    }

    pages.push({
      id: pageId,
      name: pageNo === 0 ? pageName : `${pageName} ${pageNo + 1}`,
      buttons,
      layout: { rows: itemRows + 1, cols },
    });

    cursor += capacity;
    pageNo++;
    if (!needsNext) break;
  } while (cursor < content.length);

  return pages;
}

/**
 * Build the menu board.
 *
 * Order of operations is load-bearing: junk out, then allergens, then layout.
 * Filtering after layout would leave holes in the grid, and a hole is a slot a
 * student has already learned the position of.
 */
export function buildVenueMenuBoard(input: VenueMenuBoardInput): VenueMenuBoardResult {
  const cols = Math.max(2, input.grid?.cols ?? DEFAULT_COLS);
  const itemRows = Math.max(1, input.grid?.itemRows ?? DEFAULT_ITEM_ROWS);
  const { categoryPages } = input.settings;

  // Web prices are suppressed regardless of the setting — see `provenance`.
  // A manual menu is a caretaker typing what they read at the table, so it
  // prices like the camera does.
  const showPrices = input.settings.showPrices && input.provenance !== "web";

  const total = input.items.length;

  // 1. Junk. `boardableItems` takes a RefinementResult, and these items are
  //    already refined — wrap them rather than duplicating the notice rule.
  const asResult: RefinementResult = { items: [...input.items], dropped: [], rejected: [] };
  const boardable = boardableItems(asResult);
  const notices = total - boardable.length;

  // 2. NO allergen filtering (Daniel's decision, 2026-09-01). The
  //    string-matching filter proved unreliable in both directions the day the
  //    pipeline suite first ran it end to end — פסטו (pesto) erased the whole
  //    pasta category, and a filter that cannot inspect a bare dish name gives
  //    false confidence on exactly the menus that need it most. Allergen
  //    handling belongs to the companion at the table, and later to the AI
  //    refinement pass or ask-the-waiter buttons — never to a term list. The
  //    pass still runs with NO terms because it also drops unreadable rows,
  //    and an empty term list is structurally incapable of removing a dish.
  const filtered = filterItemsForAllergies(boardable, []);

  const stats: VenueMenuBoardResult["stats"] = {
    total,
    notices,
    removedByAllergy: filtered.removed,
    uninspectableCount: filtered.uninspectableCount,
    unreadableCount: filtered.unreadableCount,
    categories: [],
    pageCount: 0,
    pricesSuppressed: input.settings.showPrices && !showPrices,
  };

  if (!filtered.items.length) return { board: null, stats };

  // 3. Layout.
  const groups = groupByCategory(filtered.items);
  const useCategories = categoryPages && [...groups.keys()].filter((c) => c.length > 0).length > 1;

  const pages: BoardPage[] = [];

  if (useCategories) {
    const indexPageId = "venue_menu_index";
    const categoryButtons: PlacedButton[] = [];
    let itemIndex = 0;
    let slot = 0;

    for (const [category, items] of groups.entries()) {
      const categoryPageId = `venue_cat_${slot}`;
      const label = category || "Other";

      // Counts included: an empty category is a dead end, and a student who
      // opens one learns the board lies.
      categoryButtons.push({
        // Distinct prefix: an id merely derived from the page id is hard to
        // tell apart from the essentials the paginator adds to the same page.
        id: `venue_cat_link_${slot}`,
        row: 0,
        col: 0,
        label: `${label} (${items.length})`,
        iconRef: "📋",
        glyphFallback: "📋",
        readingModeSafe: true,
        action: { type: "link" as const, toPageId: categoryPageId },
      } as PlacedButton);

      pages.push(
        ...layoutPages(
          items.map((item, i) => itemButton(item, itemIndex + i, showPrices)),
          { pageIdPrefix: categoryPageId, pageName: label, cols, itemRows, indexPageId },
        ),
      );

      itemIndex += items.length;
      slot++;
      stats.categories.push(label);
    }

    // The index is paginated by the same function, so a menu with more
    // categories than fit cannot push a category button into the essentials row.
    pages.unshift(
      ...layoutPages(categoryButtons, {
        pageIdPrefix: indexPageId,
        pageName: "Menu",
        cols,
        itemRows,
      }),
    );
  } else {
    pages.push(
      ...layoutPages(
        filtered.items.map((item, i) => itemButton(item, i, showPrices)),
        { pageIdPrefix: "venue_menu", pageName: "Menu", cols, itemRows },
      ),
    );
  }

  stats.pageCount = pages.length;

  return {
    board: {
      name: input.venueName,
      grid: { rows: itemRows + 1, cols },
      pages,
      currentPageId: pages[0]?.id,
      // Reading mode by default (§4.5). Opening a dense menu with dwell live
      // means the first dish the student's eyes settle on gets ordered.
      // No reading mode (Daniel, 2026-09-01): the "Start ordering" unlock was
      // small enough to miss, and until it was pressed every dish button was
      // simply silent — a board that looks pressable and is not. The menu
      // opens live; every press speaks.
    },
    stats,
  };
}
