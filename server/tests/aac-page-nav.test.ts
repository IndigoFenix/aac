import { describe, it, expect } from "@jest/globals";
import type { ParsedBoardData } from "@shared/schema";
import {
  canGoBackPage,
  emptyPageNav,
  initPageNav,
  pageNavReducer,
  resolvePage,
  type PageNav,
} from "@shared/aac/page-nav";

const board = (...ids: string[]): ParsedBoardData =>
  ({
    name: "b",
    grid: { rows: 2, cols: 2 },
    pages: ids.map((id) => ({ id, name: id.toUpperCase(), buttons: [] })),
  }) as ParsedBoardData;

const at = (currentPageId: string | null, history: string[] = []): PageNav => ({ currentPageId, history });

describe("initPageNav", () => {
  it("opens the first page and forgets any trail", () => {
    expect(initPageNav(board("home", "food"))).toEqual({ currentPageId: "home", history: [] });
  });

  it("survives a board with no pages", () => {
    expect(initPageNav({ name: "b", grid: { rows: 1, cols: 1 }, pages: [] } as ParsedBoardData))
      .toEqual({ currentPageId: null, history: [] });
    expect(initPageNav(null)).toEqual(emptyPageNav());
  });
});

describe("resolvePage", () => {
  it("falls back to the first page when the current id is unknown", () => {
    expect(resolvePage(board("home", "food"), at("gone"))?.id).toBe("home");
  });

  it("returns null only when the board has no pages", () => {
    expect(resolvePage(null, at("home"))).toBeNull();
  });
});

describe("pageNavReducer — to", () => {
  it("pushes the page being left onto the trail", () => {
    const r = pageNavReducer(at("home"), board("home", "food"), { type: "to", pageId: "food" });
    expect(r.nav).toEqual({ currentPageId: "food", history: ["home"] });
    expect(r.landed?.id).toBe("food");
  });

  it("leaves the student where they are when the target does not exist", () => {
    // The AI drives this too, and does occasionally name a page a newer board
    // no longer has.
    const before = at("home");
    const r = pageNavReducer(before, board("home"), { type: "to", pageId: "ghost" });
    expect(r.nav).toBe(before);
    expect(r.landed).toBeNull();
  });

  it("adds nothing to the trail when there was no page to come back to", () => {
    const r = pageNavReducer(at(null), board("home"), { type: "to", pageId: "home" });
    expect(r.nav).toEqual({ currentPageId: "home", history: [] });
  });
});

describe("pageNavReducer — back", () => {
  it("pops the trail", () => {
    const r = pageNavReducer(at("food", ["home"]), board("home", "food"), { type: "back" });
    expect(r.nav).toEqual({ currentPageId: "home", history: [] });
    expect(r.landed?.id).toBe("home");
  });

  it("is a no-op with an empty trail", () => {
    const before = at("home");
    const r = pageNavReducer(before, board("home"), { type: "back" });
    expect(r.nav).toBe(before);
    expect(r.landed).toBeNull();
  });

  it("still moves the cursor when the page has vanished from the board", () => {
    // The trail is the student's own path; `resolvePage` then shows the board's
    // first page rather than stranding them.
    const r = pageNavReducer(at("food", ["retired"]), board("home", "food"), { type: "back" });
    expect(r.nav.currentPageId).toBe("retired");
    expect(r.landed).toBeNull();
    expect(resolvePage(board("home", "food"), r.nav)?.id).toBe("home");
  });
});

describe("pageNavReducer — home", () => {
  it("returns to the first page and clears the trail", () => {
    const r = pageNavReducer(at("deep", ["home", "food"]), board("home", "food", "deep"), { type: "home" });
    expect(r.nav).toEqual({ currentPageId: "home", history: [] });
    expect(r.landed?.id).toBe("home");
    expect(r.fallbackLabelKey).toBe("quickActions.home");
  });

  it("is a no-op on a board with no pages", () => {
    const before = at(null);
    expect(pageNavReducer(before, null, { type: "home" }).nav).toBe(before);
  });
});

describe("canGoBackPage", () => {
  it("is the trail being non-empty", () => {
    expect(canGoBackPage(at("home"))).toBe(false);
    expect(canGoBackPage(at("food", ["home"]))).toBe(true);
  });
});
