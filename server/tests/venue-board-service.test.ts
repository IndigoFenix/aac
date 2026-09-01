/**
 * The venue-menu board's resolution rules (§4.6, build-order step 9).
 *
 * This is the last inch of the Location Menus pipeline — the thing that turns
 * a reviewed menu row into a board a student can press. Everything it decides
 * is a GATE, and every gate here is one that keeps something off a child's
 * board: an unreviewed menu, a stale menu, last week's restaurant, a feature
 * the clinician never switched on.
 *
 * DB-free: the venue repository and the allergy reader are mocked, so this
 * tests the gates rather than the tables.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const listForStudent = jest.fn(async (_studentId: string) => [] as any[]);
const getActiveMenu = jest.fn(async (_venueId: string) => undefined as any);
const getMenuById = jest.fn(async (_id: string) => undefined as any);
const getById = jest.fn(async (_id: string) => undefined as any);
const getStudentAllergies = jest.fn(async (_studentId: string) => [] as string[]);

jest.unstable_mockModule("../db", () => ({ db: {} }));
jest.unstable_mockModule("../repositories/venueRepository.js", () => ({
  venueRepository: { listForStudent, getActiveMenu, getMenuById, getById },
}));
jest.unstable_mockModule("../services/venue-menus/student-allergies.js", () => ({
  getStudentAllergies,
}));

let resolveBoundVenue: typeof import("../services/venue-menus/venue-board-service").resolveBoundVenue;
let resolveStudentVenueBoard: typeof import("../services/venue-menus/venue-board-service").resolveStudentVenueBoard;
let describeVenueBoardStats: typeof import("../services/venue-menus/venue-board-service").describeVenueBoardStats;
let VISIT_WINDOW_MS: number;

beforeAll(async () => {
  ({ resolveBoundVenue, resolveStudentVenueBoard, describeVenueBoardStats, VISIT_WINDOW_MS } =
    await import("../services/venue-menus/venue-board-service"));
});

const NOW = new Date("2026-08-22T13:00:00Z");

/** A student with the feature on and nothing exotic about them. */
function student(overrides: Record<string, unknown> = {}) {
  return {
    id: "student-1",
    birthDate: "2014-01-01",
    aacSettings: { venueMenus: { enabled: true }, languageLevel: 3 },
    ...overrides,
  } as any;
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    venueId: "venue-1",
    label: null,
    lastVisitedAt: new Date(NOW.getTime() - 20 * 60_000), // 20 minutes ago
    ...overrides,
  };
}

function menu(overrides: Record<string, unknown> = {}) {
  return {
    id: "menu-1",
    venueId: "venue-1",
    provenance: "camera",
    extractedAt: new Date(NOW.getTime() - 60 * 60_000),
    items: [
      { name: "Croissant", kind: "food", category: "Pastries" },
      { name: "Iced coffee", kind: "drink", category: "Drinks" },
    ],
    ...overrides,
  };
}

const VENUE = { id: "venue-1", name: "Cafe Aroma" };

beforeEach(() => {
  listForStudent.mockReset().mockResolvedValue([link()]);
  getActiveMenu.mockReset().mockResolvedValue(menu());
  getMenuById.mockReset().mockResolvedValue(menu());
  getById.mockReset().mockResolvedValue(VENUE);
  getStudentAllergies.mockReset().mockResolvedValue([]);
});

describe("resolveBoundVenue", () => {
  test("resolves the venue a student was just at", async () => {
    const bound = await resolveBoundVenue(student(), NOW);
    expect(bound).toEqual({ venueId: "venue-1", venueName: "Cafe Aroma", menuId: "menu-1" });
  });

  test("the feature being off is a hard stop, before any lookup", async () => {
    const bound = await resolveBoundVenue(
      student({ aacSettings: { venueMenus: { enabled: false } } }),
      NOW,
    );
    expect(bound).toBeNull();
    // Not merely null — a disabled feature must not read the student's
    // movements at all.
    expect(listForStudent).not.toHaveBeenCalled();
  });

  test("the family's own label wins over the venue's name", async () => {
    listForStudent.mockResolvedValue([link({ label: "  our pizza place  " })]);
    expect((await resolveBoundVenue(student(), NOW))?.venueName).toBe("our pizza place");
  });

  test("a visit outside the window is not where we are now", async () => {
    listForStudent.mockResolvedValue([
      link({ lastVisitedAt: new Date(NOW.getTime() - VISIT_WINDOW_MS - 60_000) }),
    ]);
    expect(await resolveBoundVenue(student(), NOW)).toBeNull();
  });

  test("a saved venue never visited is not where we are either", async () => {
    listForStudent.mockResolvedValue([link({ lastVisitedAt: null })]);
    expect(await resolveBoundVenue(student(), NOW)).toBeNull();
  });

  test("picks the most recent visit inside the window, not the first row", async () => {
    // listForStudent orders by lastVisitedAt DESC; the stale row must not win
    // just by being reachable.
    listForStudent.mockResolvedValue([
      link({ venueId: "venue-2", lastVisitedAt: new Date(NOW.getTime() - 5 * 60_000) }),
      link({ venueId: "venue-1" }),
    ]);
    getById.mockResolvedValue({ id: "venue-2", name: "Tommy Roll" });
    expect((await resolveBoundVenue(student(), NOW))?.venueId).toBe("venue-2");
  });

  test("no approved menu means no menu — a pending one is invisible here", async () => {
    // getActiveMenu is approved-only by contract; this pins that the caller
    // treats its empty result as "nothing to show", not as an error.
    getActiveMenu.mockResolvedValue(undefined);
    expect(await resolveBoundVenue(student(), NOW)).toBeNull();
  });

  test("a menu older than maxMenuAgeDays is not offered", async () => {
    getActiveMenu.mockResolvedValue(
      menu({ extractedAt: new Date(NOW.getTime() - 31 * 86_400_000) }),
    );
    const s = student({
      aacSettings: { venueMenus: { enabled: true, maxMenuAgeDays: 30 }, languageLevel: 3 },
    });
    expect(await resolveBoundVenue(s, NOW)).toBeNull();
  });

  test("maxMenuAgeDays: 0 means never expire, not expire instantly", async () => {
    getActiveMenu.mockResolvedValue(
      menu({ extractedAt: new Date(NOW.getTime() - 400 * 86_400_000) }),
    );
    const s = student({
      aacSettings: { venueMenus: { enabled: true, maxMenuAgeDays: 0 }, languageLevel: 3 },
    });
    expect(await resolveBoundVenue(s, NOW)).not.toBeNull();
  });

  test("a database outage is null, never a throw", async () => {
    // Someone is standing at a table. An exception here becomes an error
    // screen; null becomes the floor board.
    listForStudent.mockRejectedValue(new Error("connection terminated"));
    await expect(resolveBoundVenue(student(), NOW)).resolves.toBeNull();
  });
});

describe("resolveStudentVenueBoard", () => {
  test("builds a board from the bound venue's menu", async () => {
    const resolved = await resolveStudentVenueBoard(student(), NOW);
    expect(resolved?.venueName).toBe("Cafe Aroma");
    expect(resolved?.board).toBeTruthy();
    expect(resolved?.stats.total).toBe(2);
  });

  test("allergies are read NOWHERE on the board path", async () => {
    // Since 2026-09-01 the serving path does no allergen filtering (Daniel's
    // decision — the string filter erased whole categories on term
    // collisions), so the board build reads no PHI at all. The strongest
    // version of the old "never for the binding" rule: never for anything.
    await resolveBoundVenue(student(), NOW);
    await resolveStudentVenueBoard(student(), NOW);
    expect(getStudentAllergies).not.toHaveBeenCalled();
  });

  test("every dish reaches the board, whatever the student's record says", async () => {
    getStudentAllergies.mockResolvedValue(["dairy", "gluten", "coffee"]);
    getMenuById.mockResolvedValue(
      menu({ items: [{ name: "Iced coffee", kind: "drink" }] }),
    );
    const resolved = await resolveStudentVenueBoard(student(), NOW);
    expect(JSON.stringify(resolved?.board)).toContain("Iced coffee");
  });

  test("web prices stay suppressed through this path", async () => {
    // The board builder owns the rule; this pins that provenance survives the
    // hand-off, because a scraped delivery price on a dine-in board is the
    // defect that looks most like working correctly.
    getActiveMenu.mockResolvedValue(menu({ provenance: "web" }));
    getMenuById.mockResolvedValue(menu({ provenance: "web" }));
    const s = student({
      aacSettings: { venueMenus: { enabled: true, showPrices: true }, languageLevel: 3 },
    });
    const resolved = await resolveStudentVenueBoard(s, NOW);
    expect(resolved?.stats.pricesSuppressed).toBe(true);
  });

  test("a corrupt items column is an empty menu, not a crash", async () => {
    getMenuById.mockResolvedValue(menu({ items: null }));
    expect(await resolveStudentVenueBoard(student(), NOW)).toBeNull();
  });
});

describe("describeVenueBoardStats", () => {
  test("reports counts only — and no allergen segments since the filter left", async () => {
    getMenuById.mockResolvedValue(
      menu({
        items: [
          { name: "Croissant", kind: "food" },
          { name: "Peanut butter toast", kind: "food" },
        ],
      }),
    );
    const resolved = await resolveStudentVenueBoard(student(), NOW);
    const line = describeVenueBoardStats(resolved!.stats);

    expect(line).toContain("2 item(s)");
    // No allergen filtering runs (2026-09-01 decision), so the line no longer
    // claims any — a stat that always reads zero implies a check that happens.
    expect(line).not.toContain("allergen");
    expect(resolved!.stats.removedByAllergy).toHaveLength(0);
  });
});
