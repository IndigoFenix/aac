// client-shared/src/builder/sidebar-layout.test.ts
//
// THE SENTENCE BUILDER'S SIDEBAR COLUMNS — the arithmetic that decides how many
// buttons a column shows and how tightly they draw.
//
// The bug this pins (user, 2026-08-27): the columns held at most SIX
// content-sized buttons, a constant picked for the shortest screen we ship. On
// a tall screen that left the bottom third of the column empty while the pager
// hid categories there was room for; on a short one it still squeezed six in
// and clipped their labels. Capacity is now measured and the buttons fill the
// height — and the pager counts as one of them, which is the part easiest to
// get wrong (a column that pages must show one fewer item, not one more).

import { describe, it, expect } from "@jest/globals";
import {
  SIDEBAR_BUTTON_FILL,
  SIDEBAR_FALLBACK_BUTTONS,
  SIDEBAR_MAX_BUTTONS,
  SIDEBAR_MIN_BUTTONS,
  SIDEBAR_MIN_BUTTON_PX,
  sidebarCapacity,
  sidebarDensity,
  sidebarPage,
} from "./sidebar-layout";

describe("sidebarCapacity — the measured column", () => {
  it("grows with the column: a taller sidebar shows more categories", () => {
    expect(sidebarCapacity(400)).toBeGreaterThan(sidebarCapacity(250));
    expect(sidebarCapacity(700)).toBeGreaterThan(sidebarCapacity(400));
  });

  it("never draws a button smaller than one can read", () => {
    for (const h of [200, 320, 480, 640, 900, 1200]) {
      const n = sidebarCapacity(h);
      const per = (h - 16 - 8 * (n - 1)) / n;
      // The clamp floor is allowed to overrun a very short screen — three
      // buttons is the minimum a column can be useful at — but nothing else may.
      if (n > SIDEBAR_MIN_BUTTONS) expect(per).toBeGreaterThanOrEqual(SIDEBAR_MIN_BUTTON_PX);
    }
  });

  it("clamps at both ends, and holds the old cap until the first measurement", () => {
    expect(sidebarCapacity(0)).toBe(SIDEBAR_FALLBACK_BUTTONS);
    expect(sidebarCapacity(40)).toBe(SIDEBAR_MIN_BUTTONS);
    expect(sidebarCapacity(5000)).toBe(SIDEBAR_MAX_BUTTONS);
  });
});

describe("sidebarPage — minding the More button", () => {
  const ITEMS = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("shows everything and no pager when the column has room", () => {
    const p = sidebarPage(ITEMS.slice(0, 5), 1, 0, 6);
    expect(p.items).toEqual(["a", "b", "c", "d", "e"]);
    expect(p.needsMore).toBe(false);
  });

  it("THE PAGER COSTS A SLOT: overflowing shows one fewer item, not one more", () => {
    // 6 slots, one pinned ("all") ⇒ 5 for items; 8 items overflow, so the
    // pager claims a slot and only 4 items are drawn. Pinned + items + pager
    // must come to exactly the capacity — the column may not overrun.
    const p = sidebarPage(ITEMS, 1, 0, 6);
    expect(p.needsMore).toBe(true);
    expect(p.items).toEqual(["a", "b", "c", "d"]);
    expect(1 + p.items.length + 1).toBe(6);
  });

  it("a bigger column pages less — the whole point of measuring", () => {
    expect(sidebarPage(ITEMS, 1, 0, 6).needsMore).toBe(true);
    expect(sidebarPage(ITEMS, 1, 0, 9).items).toEqual(ITEMS);
    expect(sidebarPage(ITEMS, 1, 0, 9).needsMore).toBe(false);
  });

  it("pages by a full screenful and WRAPS — never a dead pager", () => {
    const first = sidebarPage(ITEMS, 1, 0, 6).items;
    const second = sidebarPage(ITEMS, 1, 1, 6).items;
    expect(second).toEqual(["e", "f", "g", "h"]);
    expect(second).not.toEqual(first);
    // Round the cycle: 8 items, 4 per page ⇒ page 2 is page 0 again.
    expect(sidebarPage(ITEMS, 1, 2, 6).items).toEqual(first);
    // …and a negative page (a backwards press) stays in range.
    expect(sidebarPage(ITEMS, 1, -1, 6).items).toEqual(second);
  });

  it("survives a column with no room left over for items", () => {
    const p = sidebarPage(ITEMS, 6, 0, 6);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.needsMore).toBe(true);
  });
});

describe("sidebarDensity — compress before you clip", () => {
  it("keys off the height each button GETS, not off how many there are", () => {
    // Five buttons in a tall column are roomy; the same five in a short one
    // are not. The count alone could never tell those apart.
    expect(sidebarDensity(5, 700).icon).not.toBe(sidebarDensity(5, 300).icon);
    expect(sidebarDensity(5, 300).label).toContain("text-[10px]");
  });

  it("steps down monotonically as the column fills", () => {
    const sizes = [2, 4, 6, 8, 10].map((n) => sidebarDensity(n, 520).face);
    // Never grows as buttons are added.
    const order = ["w-12 h-12", "w-10 h-10", "w-8 h-8"];
    let seen = 0;
    for (const f of sizes) {
      const i = order.indexOf(f);
      expect(i).toBeGreaterThanOrEqual(seen);
      seen = i;
    }
  });

  it("falls back to the count thresholds while unmeasured", () => {
    expect(sidebarDensity(6, 0)).toEqual(sidebarDensity(6, 0));
    expect(sidebarDensity(2, 0).icon).toBe("text-2xl");
    expect(sidebarDensity(4, 0).icon).toBe("text-xl");
    expect(sidebarDensity(6, 0).icon).toBe("text-lg");
  });
});

describe("the fill class", () => {
  it("splits the column evenly and cannot push it taller", () => {
    // `basis-0` is what makes the split even (without it a long label buys its
    // button extra height); `min-h-0` is what stops the column overflowing.
    expect(SIDEBAR_BUTTON_FILL).toContain("flex-1");
    expect(SIDEBAR_BUTTON_FILL).toContain("basis-0");
    expect(SIDEBAR_BUTTON_FILL).toContain("min-h-0");
  });
});
