/**
 * Tests for the deterministic menu board builder (§4.5).
 *
 * The builder is where several separate promises land on one grid, so the suite
 * is organised by promise rather than by function:
 *
 *   - junk never becomes a button ("Dear customers!" is a real extracted row)
 *   - a filtered item is ABSENT, not disabled
 *   - the label is for the student, the SPOKEN text is for the waiter
 *   - the essentials survive every page and every mode
 *   - nothing invented can appear, because nothing here invents
 *
 * DB-free, no LLM: belongs in `test:unit`.
 */

import { describe, it, expect } from "@jest/globals";
import { buildVenueMenuBoard } from "../services/venue-menus/menu-board-builder.js";
import type { RefinedMenuItem } from "../services/venue-menus/menu-refinement.js";
import type { BoardButton, BoardPage } from "@shared/schema";

const SETTINGS = { categoryPages: true, showPrices: true, readingModeDefault: true };

function item(partial: Partial<RefinedMenuItem> & { name: string }): RefinedMenuItem {
  return { kind: "food", ...partial };
}

/** Shape of the real טומי רול extraction, trimmed to the interesting rows. */
const MENU: RefinedMenuItem[] = [
  item({ name: "רול אנטריקוט", price: 48, priceText: "₪48", category: "טורטיות", imageKey: "beef_wrap", translatedName: "Beef roll" }),
  item({ name: "‫לקוחות יקרים!", category: "💙", kind: "notice" }),
  item({ name: "קוקה קולה פחית", price: 13, priceText: "₪13", category: "שתייה קלה", kind: "drink", imageKey: "cola" }),
  item({ name: "רוטב שום", price: 1, priceText: "₪1", category: "רטבים", kind: "condiment" }),
];

const allButtons = (pages: BoardPage[]): BoardButton[] => pages.flatMap((p) => p.buttons);
const itemButtons = (pages: BoardPage[]) => allButtons(pages).filter((b) => b.id.startsWith("venue_item_"));

describe("buildVenueMenuBoard — what does and does not become a button", () => {
  it("drops notice rows", () => {
    const { board, stats } = buildVenueMenuBoard({ venueName: "טומי רול", items: MENU, settings: SETTINGS });

    const labels = itemButtons(board!.pages).map((b) => b.label);
    expect(labels.some((l) => l.includes("לקוחות יקרים"))).toBe(false);
    expect(stats.notices).toBe(1);
    expect(itemButtons(board!.pages)).toHaveLength(3);
  });

  it("keeps condiments — asking for garlic sauce is a real thing to say", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    expect(itemButtons(board!.pages).some((b) => b.label.includes("רוטב שום"))).toBe(true);
  });

  it("makes a filtered item ABSENT rather than disabled", () => {
    // §3.3: a nonverbal student cannot be asked to interpret a greyed button,
    // and a visible-but-dead item invites the very press we are preventing.
    const { board, stats } = buildVenueMenuBoard({
      venueName: "T",
      items: [item({ name: "Almond Croissant" }), item({ name: "Orange Juice", kind: "drink" })],
      settings: SETTINGS,
      allergies: ["nut allergy"],
    });

    const buttons = itemButtons(board!.pages);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].label).toBe("Orange Juice");
    expect(stats.removedByAllergy).toHaveLength(1);
    // No disabled/hidden survivor anywhere on the board.
    expect(allButtons(board!.pages).some((b) => b.label.includes("Almond"))).toBe(false);
  });

  it("returns null when nothing orderable survives", () => {
    // A real outcome, not an error — the caller falls back to the floor board,
    // and eight words beats an empty grid.
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: [item({ name: "Peanut Soup" })],
      settings: SETTINGS,
      allergies: ["peanuts"],
    });
    expect(board).toBeNull();
  });

  it("returns null for a menu that was nothing but notices", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: [item({ name: "Dear customers!", kind: "notice" })],
      settings: SETTINGS,
    });
    expect(board).toBeNull();
  });
});

describe("buildVenueMenuBoard — the student reads one thing, the waiter hears another", () => {
  it("labels with the translation and speaks the original", () => {
    // "שניצלונים" reached MenuSpark's UI as "Survivors". A waiter cannot fill
    // that order; the original string is what is printed on their menu.
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const button = itemButtons(board!.pages).find((b) => b.label.startsWith("Beef roll"))!;

    expect(button.label).toContain("Beef roll");
    expect(button.spokenText).toBe("רול אנטריקוט");
    expect(button.action?.text).toBe("רול אנטריקוט");
  });

  it("falls back to the original name when there is no translation", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const button = itemButtons(board!.pages).find((b) => b.spokenText === "רוטב שום")!;
    expect(button.label).toContain("רוטב שום");
  });

  it("never sets localizeFromGlyph on an item — a dish name is data", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    expect(itemButtons(board!.pages).every((b) => !b.localizeFromGlyph)).toBe(true);
  });

  it("shows prices only when the setting says so, and never speaks them", () => {
    const withPrices = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const priced = itemButtons(withPrices.board!.pages).find((b) => b.spokenText === "רול אנטריקוט")!;
    expect(priced.label).toContain("₪48");
    expect(priced.spokenText).not.toContain("₪48"); // you do not say the price when ordering

    const without = buildVenueMenuBoard({
      venueName: "T",
      items: MENU,
      settings: { ...SETTINGS, showPrices: false },
    });
    expect(itemButtons(without.board!.pages).every((b) => !b.label.includes("₪"))).toBe(true);
  });
});

describe("buildVenueMenuBoard — art", () => {
  it("passes imageKey through to the auto-icon pipeline", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const button = itemButtons(board!.pages).find((b) => b.spokenText === "רול אנטריקוט")!;
    expect(button.imageKey).toBe("beef_wrap");
  });

  it("gives every item a self-contained emoji fallback by kind", () => {
    // glyphFallback exists precisely for when generation has not completed, so
    // it must never itself be an imageKey.
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const drink = itemButtons(board!.pages).find((b) => b.spokenText === "קוקה קולה פחית")!;
    const condiment = itemButtons(board!.pages).find((b) => b.spokenText === "רוטב שום")!;

    expect(drink.glyphFallback).toBe("🥤");
    expect(condiment.glyphFallback).toBe("🧂");
    expect(itemButtons(board!.pages).every((b) => !!b.glyphFallback)).toBe(true);
  });

  it("still builds a button for an item with no imageKey", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: [item({ name: "Mystery dish" })],
      settings: SETTINGS,
    });
    const button = itemButtons(board!.pages)[0];
    expect(button.imageKey).toBeUndefined();
    expect(button.glyphFallback).toBe("🍽️");
  });
});

describe("buildVenueMenuBoard — the essentials survive", () => {
  const essentialsOn = (page: BoardPage) =>
    page.buttons.filter((b) => b.id.includes("venue_essential_")).map((b) => b.glyph);

  it("puts more / finished / bathroom on every page", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    for (const page of board!.pages) {
      expect(essentialsOn(page)).toEqual(["more", "finished", "bathroom"]);
    }
  });

  it("marks them readingModeSafe, and item buttons not", () => {
    // Needing the toilet does not wait for a mode to be switched off.
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const essentials = allButtons(board!.pages).filter((b) => b.id.includes("venue_essential_"));

    expect(essentials.length).toBeGreaterThan(0);
    expect(essentials.every((b) => b.readingModeSafe)).toBe(true);
    expect(itemButtons(board!.pages).every((b) => !b.readingModeSafe)).toBe(true);
  });

  it("localizes them from the glyph, since they ARE registry words", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const essentials = allButtons(board!.pages).filter((b) => b.id.includes("venue_essential_"));
    expect(essentials.every((b) => b.localizeFromGlyph && b.glyph)).toBe(true);
  });

  it("keeps them clear of the item area on every page", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: Array.from({ length: 30 }, (_, i) => item({ name: `Dish ${i}`, category: "All" })),
      settings: { ...SETTINGS, categoryPages: false },
    });

    for (const page of board!.pages) {
      // Essentials only — the "More" link is readingModeSafe too, and it
      // legitimately sits in the item area.
      const essentialRows = page.buttons
        .filter((b) => b.id.includes("venue_essential_"))
        .map((b) => b.row);
      const itemRows = page.buttons.filter((b) => b.id.startsWith("venue_item_")).map((b) => b.row);
      // No item shares a row with the essentials.
      expect(itemRows.some((r) => essentialRows.includes(r))).toBe(false);
    }
  });
});

describe("buildVenueMenuBoard — paging", () => {
  const many = (n: number, category = "All") =>
    Array.from({ length: n }, (_, i) => item({ name: `Dish ${i}`, category }));

  it("fits a short menu on one page with no next link", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: many(8),
      settings: { ...SETTINGS, categoryPages: false },
    });
    expect(board!.pages).toHaveLength(1);
    expect(allButtons(board!.pages).some((b) => b.id.endsWith("_next"))).toBe(false);
  });

  it("spills to a second page rather than dropping items", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: many(20),
      settings: { ...SETTINGS, categoryPages: false },
    });

    expect(itemButtons(board!.pages)).toHaveLength(20);
    expect(board!.pages.length).toBeGreaterThan(1);

    // Every next link points at a page that exists.
    const ids = new Set(board!.pages.map((p) => p.id));
    for (const button of allButtons(board!.pages)) {
      if (button.action?.type === "link") expect(ids.has(button.action.toPageId!)).toBe(true);
    }
  });

  it("gives every button a board-unique id", () => {
    // Page-unique is not enough: the renderer keys on id across the board.
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: many(20),
      settings: { ...SETTINGS, categoryPages: false },
    });
    const ids = allButtons(board!.pages).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildVenueMenuBoard — categories", () => {
  it("opens on an index of categories, with counts", () => {
    const { board, stats } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });

    const index = board!.pages[0];
    expect(board!.currentPageId).toBe(index.id);
    const links = index.buttons.filter((b) => b.action?.type === "link");
    // Counts included: an empty category is a dead end.
    expect(links.map((b) => b.label)).toEqual(["טורטיות (1)", "שתייה קלה (1)", "רטבים (1)"]);
    expect(stats.categories).toHaveLength(3);
  });

  it("gives each category page a way back to the index", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    const categoryPages = board!.pages.slice(1);

    expect(categoryPages.length).toBeGreaterThan(0);
    for (const page of categoryPages) {
      const back = page.buttons.find((b) => b.id.endsWith("_back"));
      expect(back?.action?.toPageId).toBe(board!.pages[0].id);
      expect(back?.readingModeSafe).toBe(true);
    }
  });

  it("pages the INDEX too when a menu has more categories than fit", () => {
    // A ten-category menu must not push a category button into the essentials
    // row — the index is laid out by the same paginator the item pages use.
    const items = Array.from({ length: 10 }, (_, i) => item({ name: `Dish ${i}`, category: `Cat ${i}` }));
    const { board } = buildVenueMenuBoard({ venueName: "T", items, settings: SETTINGS });

    const indexPages = board!.pages.filter((p) => p.id.startsWith("venue_menu_index"));
    expect(indexPages.length).toBeGreaterThan(1);

    for (const page of indexPages) {
      const essentialRow = page.layout!.rows - 1;
      const categoryLinks = page.buttons.filter((b) => b.id.startsWith("venue_cat_link_"));
      expect(categoryLinks.every((b) => b.row < essentialRow)).toBe(true);
    }
  });

  it("skips the index entirely when the menu has one category or none", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: [item({ name: "A", category: "All" }), item({ name: "B", category: "All" })],
      settings: SETTINGS,
    });
    expect(board!.pages).toHaveLength(1);
    expect(board!.pages[0].id).toBe("venue_menu");
  });

  it("honours categoryPages: false with a flat board", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: MENU,
      settings: { ...SETTINGS, categoryPages: false },
    });
    expect(board!.pages).toHaveLength(1);
    expect(itemButtons(board!.pages)).toHaveLength(3);
  });
});

describe("buildVenueMenuBoard — reading mode", () => {
  it("opens in reading mode by default", () => {
    const { board } = buildVenueMenuBoard({ venueName: "T", items: MENU, settings: SETTINGS });
    expect(board!.openInReadingMode).toBe(true);
  });

  it("omits the flag when the setting is off", () => {
    const { board } = buildVenueMenuBoard({
      venueName: "T",
      items: MENU,
      settings: { ...SETTINGS, readingModeDefault: false },
    });
    expect(board!.openInReadingMode).toBeUndefined();
  });
});

describe("buildVenueMenuBoard — the board is named for the place", () => {
  it("uses the venue name verbatim — a proper noun is never translated", () => {
    const { board } = buildVenueMenuBoard({ venueName: "טומי רול בר", items: MENU, settings: SETTINGS });
    expect(board!.name).toBe("טומי רול בר");
  });
});
