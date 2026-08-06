/**
 * The grid a board button is allowed to sit in.
 *
 * Two things are pinned here, and both used to be wrong:
 *   1. The grid is PER PAGE. `board.grid` is only the default for a page with
 *      no `layout`, so a 2x3 yes/no page and a 5x6 vocabulary page can live in
 *      one board. The AAC renderer already worked this way; the editor and the
 *      AI's guard did not, so they disagreed about which cells exist.
 *   2. A button outside its page's grid is a REPORTED violation, not something
 *      to quietly drop. The AI's board edits are rolled back on one of these
 *      (see tool-router's manageMemory), and the editor refuses the resize.
 */

import { describe, it, expect } from "@jest/globals";
import {
  pageGrid,
  fitGrid,
  findOutOfBoundsButtons,
  outOfBoundsKey,
  DEFAULT_PAGE_GRID,
} from "@shared/board-grid.js";
import { describeOutOfBoundsButtons } from "../services/board-utils";

const btn = (id: string, row: number, col: number, extra: Record<string, unknown> = {}) => ({
  id,
  row,
  col,
  label: id,
  ...extra,
});

describe("pageGrid", () => {
  const board = { grid: { rows: 4, cols: 4 } };

  it("uses the page's own layout when it has one", () => {
    expect(pageGrid(board, { layout: { rows: 2, cols: 3 } })).toEqual({ rows: 2, cols: 3 });
  });

  it("falls back to the board grid for a page with no layout", () => {
    expect(pageGrid(board, { buttons: [] } as any)).toEqual({ rows: 4, cols: 4 });
  });

  it("lets a page be LARGER than the board default, not just smaller", () => {
    // The board grid is a default, not a ceiling — a vocabulary page may need
    // more cells than the home page does.
    expect(pageGrid(board, { layout: { rows: 6, cols: 8 } })).toEqual({ rows: 6, cols: 8 });
  });

  it("ignores unusable numbers rather than bounding to zero", () => {
    expect(pageGrid(board, { layout: { rows: 0, cols: 3 } })).toEqual({ rows: 4, cols: 4 });
    expect(pageGrid(board, { layout: { rows: "two", cols: 3 } } as any)).toEqual({ rows: 4, cols: 4 });
    expect(pageGrid({ grid: null }, null)).toEqual(DEFAULT_PAGE_GRID);
  });
});

describe("fitGrid", () => {
  it("is the smallest grid holding the buttons — no empty trailing row", () => {
    // 7 buttons packed from 0,0 across 4 columns → 2x4, never 4x4.
    const buttons = [
      btn("a", 0, 0), btn("b", 0, 1), btn("c", 0, 2), btn("d", 0, 3),
      btn("e", 1, 0), btn("f", 1, 1), btn("g", 1, 2),
    ];
    expect(fitGrid(buttons)).toEqual({ rows: 2, cols: 4 });
  });

  it("counts spans, so a wide button is not half off the edge", () => {
    expect(fitGrid([btn("wide", 0, 3, { colSpan: 2 })])).toEqual({ rows: 1, cols: 5 });
  });

  it("keeps the fallback for an empty page rather than collapsing to 0x0", () => {
    expect(fitGrid([])).toEqual(DEFAULT_PAGE_GRID);
    // Callers asking "what is the FLOOR for this page" pass their own — an
    // empty page needs no cells, so the editor must still let it shrink.
    expect(fitGrid([], { rows: 1, cols: 1 })).toEqual({ rows: 1, cols: 1 });
  });
});

describe("findOutOfBoundsButtons", () => {
  it("finds nothing when every button has a cell", () => {
    const board = {
      grid: { rows: 2, cols: 2 },
      pages: [{ id: "p1", name: "Main", layout: { rows: 2, cols: 2 }, buttons: [btn("a", 1, 1)] }],
    };
    expect(findOutOfBoundsButtons(board)).toEqual([]);
  });

  it("catches a button left outside a page whose layout shrank", () => {
    const board = {
      grid: { rows: 4, cols: 4 },
      pages: [
        {
          id: "p1",
          name: "Food",
          layout: { rows: 2, cols: 2 },
          buttons: [btn("keep", 0, 0), btn("cut", 3, 0)],
        },
      ],
    };
    const found = findOutOfBoundsButtons(board);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ buttonId: "cut", pageName: "Food", rows: 2, cols: 2 });
  });

  it("judges each page against its OWN grid", () => {
    // Same row=4 button: legal on the tall page, off the edge on the short one.
    const board = {
      grid: { rows: 2, cols: 2 },
      pages: [
        { id: "tall", name: "Tall", layout: { rows: 6, cols: 2 }, buttons: [btn("ok", 4, 0)] },
        { id: "short", name: "Short", layout: { rows: 2, cols: 2 }, buttons: [btn("bad", 4, 0)] },
      ],
    };
    expect(findOutOfBoundsButtons(board).map((v) => v.buttonId)).toEqual(["bad"]);
  });

  it("bounds a layout-less page by the board grid", () => {
    const board = {
      grid: { rows: 2, cols: 2 },
      pages: [{ id: "p1", name: "Main", buttons: [btn("bad", 0, 5)] }],
    };
    expect(findOutOfBoundsButtons(board).map((v) => v.buttonId)).toEqual(["bad"]);
  });

  it("counts a span that runs off the edge", () => {
    const board = {
      grid: { rows: 2, cols: 3 },
      pages: [{ id: "p1", name: "Main", buttons: [btn("wide", 0, 2, { colSpan: 2 })] }],
    };
    expect(findOutOfBoundsButtons(board).map((v) => v.buttonId)).toEqual(["wide"]);
  });

  it("keys violations per page+button, so the same id on two pages is two", () => {
    const board = {
      grid: { rows: 1, cols: 1 },
      pages: [
        { id: "p1", name: "One", buttons: [btn("dup", 3, 0)] },
        { id: "p2", name: "Two", buttons: [btn("dup", 3, 0)] },
      ],
    };
    const keys = findOutOfBoundsButtons(board).map(outOfBoundsKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("survives a board that is missing or half-built", () => {
    expect(findOutOfBoundsButtons(null)).toEqual([]);
    expect(findOutOfBoundsButtons({ pages: [{ id: "p1", name: "x" }] })).toEqual([]);
    // No readable row/col yet — a partial button is not a violation.
    expect(
      findOutOfBoundsButtons({ grid: { rows: 1, cols: 1 }, pages: [{ id: "p", name: "p", buttons: [{ id: "b" }] }] }),
    ).toEqual([]);
  });
});

describe("describeOutOfBoundsButtons", () => {
  it("names every casualty and says the edit was rolled back", () => {
    const message = describeOutOfBoundsButtons([
      { pageId: "p1", pageName: "Food", buttonId: "btn-apple", label: "Apple", row: 3, col: 0, rows: 2, cols: 2 },
    ]);
    expect(message).toContain("REJECTED");
    expect(message).toContain("left unchanged");
    expect(message).toContain("btn-apple");
    expect(message).toContain("Apple");
    expect(message).toContain("Food");
    expect(message).toContain("2x2");
  });
});
