import { describe, it, expect } from "@jest/globals";
import { BUILDER_GRID_CELLS, BUILDER_ITEMS_WITH_MORE, pageBuilderGrid } from "@shared/aac-builder-paging";

/** n items, labelled by index, so a page reads as the indices it contains. */
const items = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("pageBuilderGrid", () => {
  it("shows everything and no More button when the list fits", () => {
    const p = pageBuilderGrid(items(BUILDER_GRID_CELLS), 0);
    expect(p.needsMore).toBe(false);
    expect(p.items).toHaveLength(BUILDER_GRID_CELLS);
    expect(p.perPage).toBe(BUILDER_GRID_CELLS);
  });

  it("gives one cell to More the moment the list overflows", () => {
    const p = pageBuilderGrid(items(BUILDER_GRID_CELLS + 1), 0);
    expect(p.needsMore).toBe(true);
    expect(p.perPage).toBe(BUILDER_ITEMS_WITH_MORE);
    expect(p.items).toHaveLength(BUILDER_ITEMS_WITH_MORE);
  });

  it("advances by a full page of words", () => {
    const p = pageBuilderGrid(items(100), 1);
    expect(p.items[0]).toBe(BUILDER_ITEMS_WITH_MORE);
  });

  it("WRAPS past the end rather than stopping — More never goes dead", () => {
    // 20 items, 17 per page: page 1 starts at 17 and wraps 17,18,19,0,1,…
    const p = pageBuilderGrid(items(20), 1);
    expect(p.items.slice(0, 4)).toEqual([17, 18, 19, 0]);
    expect(p.items).toHaveLength(BUILDER_ITEMS_WITH_MORE);
  });

  it("keeps every page full, so there is no ragged final page", () => {
    for (let page = 0; page < 6; page++) {
      expect(pageBuilderGrid(items(20), page).items).toHaveLength(BUILDER_ITEMS_WITH_MORE);
    }
  });

  it("cycles back around to the first page", () => {
    // 34 items at 17/page ⇒ two distinct pages, then it repeats.
    const first = pageBuilderGrid(items(34), 0).items;
    expect(pageBuilderGrid(items(34), 2).items).toEqual(first);
  });

  it("survives an empty list", () => {
    const p = pageBuilderGrid([], 3);
    expect(p.items).toEqual([]);
    expect(p.needsMore).toBe(false);
  });

  it("honours a caller-supplied cell count", () => {
    const p = pageBuilderGrid(items(10), 0, 4);
    expect(p.perPage).toBe(3);
    expect(p.items).toEqual([0, 1, 2]);
  });
});
