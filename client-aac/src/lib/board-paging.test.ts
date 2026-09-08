// Paging arithmetic for the restaurant app's grids — see board-paging.ts.
//
// The invariant these pin: NO PAGE EVER EXCEEDS THE CAP. The bug this replaced
// grew the grid to fit the content, so a busy street produced a wall of tiles
// too small to read. Every assertion below is ultimately about that.

import {
  MAX_PAGE_COLS,
  MAX_PAGE_ROWS,
  cellPosition,
  gridFor,
  pageLayout,
} from "./board-paging";

describe("gridFor", () => {
  it("keeps a small grid square-ish, so few buttons are BIG buttons", () => {
    expect(gridFor(1)).toEqual({ rows: 1, cols: 1 });
    expect(gridFor(3)).toEqual({ rows: 2, cols: 2 });
    expect(gridFor(6)).toEqual({ rows: 2, cols: 3 });
  });

  it("never exceeds three rows by four columns", () => {
    for (let n = 0; n <= 60; n++) {
      const { rows, cols } = gridFor(n);
      expect(rows).toBeLessThanOrEqual(MAX_PAGE_ROWS);
      expect(cols).toBeLessThanOrEqual(MAX_PAGE_COLS);
    }
  });

  it("opens out to the full grid once the content fills it", () => {
    expect(gridFor(12)).toEqual({ rows: 3, cols: 4 });
    expect(gridFor(25)).toEqual({ rows: 3, cols: 4 });
  });

  it("treats an empty list as one cell rather than a zero-sized grid", () => {
    expect(gridFor(0)).toEqual({ rows: 1, cols: 1 });
  });
});

describe("pageLayout", () => {
  it("shows everything on one page when it fits", () => {
    const layout = pageLayout({ itemCount: 12, page: 0 });
    expect(layout.pageCount).toBe(1);
    expect(layout.start).toBe(0);
    expect(layout.end).toBe(12);
    expect(layout.prevCell).toBe(-1);
    expect(layout.nextCell).toBe(-1);
  });

  it("costs a cell for Next when the content overflows", () => {
    // 13 items into 12 cells: eleven items and a Next, not thirteen tiny ones.
    const first = pageLayout({ itemCount: 13, page: 0 });
    expect(first.pageCount).toBe(2);
    expect(first.end - first.start).toBe(11);
    expect(first.nextCell).toBe(11);
    expect(first.usedCells).toBe(12);
  });

  it("pins the leading buttons to cell 0 and puts Previous after them", () => {
    const second = pageLayout({ itemCount: 25, page: 1, leading: 1 });
    expect(second.prevCell).toBe(1);
    expect(second.firstItemCell).toBe(2);
  });

  it("walks the boundaries so no page overflows and nothing is lost", () => {
    for (const leading of [0, 1, 2]) {
      for (const itemCount of [0, 1, 7, 12, 13, 25, 61]) {
        const pages: Array<{ start: number; end: number }> = [];
        let seen = 0;
        const first = pageLayout({ itemCount, page: 0, leading });
        for (let p = 0; p < first.pageCount; p++) {
          const layout = pageLayout({ itemCount, page: p, leading });
          expect(layout.usedCells).toBeLessThanOrEqual(MAX_PAGE_ROWS * MAX_PAGE_COLS);
          expect(layout.start).toBe(seen);
          seen = layout.end;
          pages.push({ start: layout.start, end: layout.end });
        }
        // Every item is on exactly one page, in order.
        expect(seen).toBe(itemCount);
        expect(pages.length).toBe(first.pageCount);
      }
    }
  });

  it("offers Previous on every page but the first, and Next on every page but the last", () => {
    const count = 25;
    const total = pageLayout({ itemCount: count, page: 0, leading: 1 }).pageCount;
    expect(total).toBeGreaterThan(2);
    for (let p = 0; p < total; p++) {
      const layout = pageLayout({ itemCount: count, page: p, leading: 1 });
      expect(layout.prevCell >= 0).toBe(p > 0);
      expect(layout.nextCell >= 0).toBe(p < total - 1);
    }
  });

  it("clamps a page index that no longer exists rather than blanking the board", () => {
    // The student is on page 3 when a fresh search returns four places.
    const layout = pageLayout({ itemCount: 4, page: 3, leading: 1 });
    expect(layout.page).toBe(0);
    expect(layout.end).toBe(4);
    expect(pageLayout({ itemCount: 25, page: -2, leading: 1 }).page).toBe(0);
  });

  it("keeps the paged grid the same shape at every turn", () => {
    // Buttons must not change size when the student pages — including on a
    // final page holding only a couple of items.
    const total = pageLayout({ itemCount: 25, page: 0, leading: 1 }).pageCount;
    for (let p = 0; p < total; p++) {
      const layout = pageLayout({ itemCount: 25, page: p, leading: 1 });
      expect({ rows: layout.rows, cols: layout.cols }).toEqual({ rows: 3, cols: 4 });
    }
  });

  it("gives every button on a page its own cell, inside the grid", () => {
    // The places grid's exact shape: one pinned Back, then the places, then
    // whichever paging controls the page earns. Two buttons on one cell would
    // hide a restaurant behind an arrow.
    const count = 25;
    const total = pageLayout({ itemCount: count, page: 0, leading: 1 }).pageCount;
    for (let p = 0; p < total; p++) {
      const layout = pageLayout({ itemCount: count, page: p, leading: 1 });
      const cells = [
        0, // the pinned Back
        ...(layout.prevCell >= 0 ? [layout.prevCell] : []),
        ...Array.from({ length: layout.end - layout.start }, (_, i) => layout.firstItemCell + i),
        ...(layout.nextCell >= 0 ? [layout.nextCell] : []),
      ];
      expect(new Set(cells).size).toBe(cells.length);
      for (const cell of cells) {
        expect(cell).toBeGreaterThanOrEqual(0);
        expect(cell).toBeLessThan(layout.rows * layout.cols);
        const { row, col } = cellPosition(cell, layout.cols);
        expect(row).toBeLessThan(layout.rows);
        expect(col).toBeLessThan(layout.cols);
      }
    }
  });

  it("survives an empty list", () => {
    const layout = pageLayout({ itemCount: 0, page: 0, leading: 1 });
    expect(layout.pageCount).toBe(1);
    expect(layout.start).toBe(0);
    expect(layout.end).toBe(0);
    expect(layout.usedCells).toBe(1);
  });

  it("does not loop forever when the leading buttons fill the grid", () => {
    const layout = pageLayout({ itemCount: 30, page: 0, leading: 12 });
    expect(layout.pageCount).toBe(1);
    expect(layout.end).toBe(0);
  });
});

describe("cellPosition", () => {
  it("counts across rows", () => {
    expect(cellPosition(0, 4)).toEqual({ row: 0, col: 0 });
    expect(cellPosition(5, 4)).toEqual({ row: 1, col: 1 });
    expect(cellPosition(11, 4)).toEqual({ row: 2, col: 3 });
  });
});
