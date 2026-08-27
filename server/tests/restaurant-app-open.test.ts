/**
 * `open_app("restaurant", …)` — mode resolution (§4.1a, §4.6).
 *
 * The restaurant system is an APP, so its entry point is an app open with
 * startup parameters, and the MODE is resolved here rather than by the model.
 * That is the property these tests exist to hold: the AI knows the student said
 * "pizza", and knows nothing about whether a venue is bound, whether its menu
 * passed review, or whether a clinician allowed browsing. If it could name the
 * mode it could open a menu that does not exist — which for a nonverbal student
 * is a promise nobody can keep.
 *
 * DB-free: the two services this composes are mocked, so these are the routing
 * rules rather than the menu builder or the browse search.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const resolveStudentVenueBoard = jest.fn(async (_s: any, _n?: Date) => null as any);
const resolveBoundVenue = jest.fn(async (_s: any, _n?: Date) => null as any);
const browse = jest.fn(async (_i: any, _n?: Date) => ({
  categories: [] as any[],
  places: [] as any[],
  searched: false,
}));

jest.unstable_mockModule("../db", () => ({ db: {} }));
jest.unstable_mockModule("../services/venue-menus/venue-board-service.js", () => ({
  resolveStudentVenueBoard,
  resolveBoundVenue,
  describeVenueBoardStats: () => "stats",
}));
jest.unstable_mockModule("../services/venue-menus/venue-browse-service.js", () => ({
  venueBrowseService: { browse },
}));

let resolveRestaurantOpen: typeof import("../services/venue-menus/restaurant-app-open").resolveRestaurantOpen;
let restaurantOpenNote: typeof import("../services/venue-menus/restaurant-app-open").restaurantOpenNote;

beforeAll(async () => {
  ({ resolveRestaurantOpen, restaurantOpenNote } = await import(
    "../services/venue-menus/restaurant-app-open"
  ));
});

const NOW = new Date("2026-08-23T12:00:00Z");
const GPS = { latitude: 32.0853, longitude: 34.7818 };

function student(venueMenus: Record<string, unknown> = { enabled: true, studentBrowse: true }) {
  return {
    id: "s1",
    birthDate: "2014-01-01",
    aacSettings: { venueMenus, languageLevel: 3 },
  } as any;
}

const MENU = {
  venueId: "v1",
  venueName: "Cafe Aroma",
  menuId: "m1",
  board: { name: "Cafe Aroma", pages: [] },
  stats: {} as any,
};

beforeEach(() => {
  resolveStudentVenueBoard.mockReset().mockResolvedValue(null);
  resolveBoundVenue.mockReset().mockResolvedValue(null);
  browse.mockReset().mockResolvedValue({ categories: [], places: [], searched: false });
});

describe("mode resolution", () => {
  test("a bound venue with an approved menu opens MENU mode", async () => {
    resolveStudentVenueBoard.mockResolvedValue(MENU);
    const payload = await resolveRestaurantOpen({ student: student(), gps: GPS }, NOW);
    expect(payload.mode).toBe("menu");
    expect(payload.venueName).toBe("Cafe Aroma");
    expect(payload.menuBoard).toBeTruthy();
  });

  test("menu mode carries the floor board too", async () => {
    // A menu can say "chicken soup" and cannot say "this is too hot", "yuck" or
    // "I am still hungry" — the menu board keeps only more/finished/bathroom,
    // because the rest of the grid belongs to food. Those words have to be one
    // press away, not in another app.
    resolveStudentVenueBoard.mockResolvedValue(MENU);
    const payload = await resolveRestaurantOpen({ student: student(), gps: GPS }, NOW);
    const floor = payload.floorBoard as { pages?: Array<{ buttons?: Array<{ glyph?: string }> }> };
    const glyphs = (floor?.pages?.[0]?.buttons ?? []).map((b) => b.glyph);
    expect(glyphs).toEqual(expect.arrayContaining(["hungry", "thirsty", "hot", "yuck"]));
  });

  test("the menu WINS over a food the AI named", async () => {
    // A student sitting in a restaurant who says "pizza" wants the pizza on
    // THIS menu, not a list of other restaurants they are not in.
    resolveStudentVenueBoard.mockResolvedValue(MENU);
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "pizza" },
      NOW,
    );
    expect(payload.mode).toBe("menu");
    expect(browse).not.toHaveBeenCalled();
  });

  test("a bound venue with NO usable menu opens FLOOR mode", async () => {
    // Nobody has photographed it, it is in review, it aged out, or the allergen
    // filter emptied it — and the student is still sitting at the table.
    resolveBoundVenue.mockResolvedValue({ venueId: "v1", venueName: "Cafe Aroma", menuId: "m1" });
    const payload = await resolveRestaurantOpen({ student: student(), gps: GPS }, NOW);
    expect(payload.mode).toBe("floor");
    expect(payload.floorBoard).toBeTruthy();
    expect(payload.venueName).toBe("Cafe Aroma");
    // Being AT a restaurant must not send them searching for another one.
    expect(browse).not.toHaveBeenCalled();
  });

  test("floor mode beats search even when the AI named a food", async () => {
    resolveBoundVenue.mockResolvedValue({ venueId: "v1", venueName: "Cafe Aroma", menuId: "m1" });
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "pizza" },
      NOW,
    );
    expect(payload.mode).toBe("floor");
  });

  test("no venue at all, browsing allowed → SEARCH mode", async () => {
    const payload = await resolveRestaurantOpen({ student: student(), gps: GPS }, NOW);
    expect(payload.mode).toBe("search");
  });

  test("browsing NOT allowed → the food grid, whoever asked", async () => {
    // 🚨 The bug this pins, and it bit twice. `studentBrowse` ships FALSE, so
    // with no venue bound this was the DEFAULT path.
    //
    // First it sent everyone to the caretaker lane: a paragraph of text a child
    // cannot read, a button that opens a camera, nothing sayable. Then it was
    // narrowed to student presses only — and on 2026-08-27 a student composed
    // "I want to go to a restaurant", picked a hamburger off the board the AI
    // offered, and still got nothing three times running, because an utterance
    // reaches the app through the Speaker's open_app and counts as "ai".
    //
    // The setting is labelled "Student can look for somewhere to eat". It
    // governs the outbound venue lookup, not whether a child may name a food,
    // and not who is allowed to ask.
    for (const trigger of ["ai", "student"] as const) {
      browse.mockClear();
      const payload = await resolveRestaurantOpen(
        { student: student({ enabled: true, studentBrowse: false }), gps: GPS, data: "pizza", trigger },
        NOW,
      );
      expect(payload.mode).toBe("search");
      expect(payload.canSearch).toBe(false);
      expect(payload.food).toBe("pizza");
      // The vocabulary is free; the SEARCH is what was withheld.
      expect(browse).not.toHaveBeenCalled();
    }
  });

  test("browsing ON marks the payload searchable", async () => {
    const payload = await resolveRestaurantOpen({ student: student(), gps: GPS }, NOW);
    expect(payload.mode).toBe("search");
    expect(payload.canSearch).toBe(true);
  });

  test("the whole feature off → CARETAKER mode, even for a student press", async () => {
    // `enabled: false` is a different statement from `studentBrowse: false`:
    // the clinician turned the FEATURE off, not just the venue search, so there
    // is no student lane to fall back to.
    for (const trigger of ["ai", "student"] as const) {
      const payload = await resolveRestaurantOpen(
        { student: student({ enabled: false, studentBrowse: true }), gps: GPS, trigger },
        NOW,
      );
      expect(payload.mode).toBe("caretaker");
    }
  });

  test("no student at all is still a real screen", async () => {
    // A press must always change the screen. The caretaker lane is the one
    // that works with no data behind it.
    const payload = await resolveRestaurantOpen({ student: null }, NOW);
    expect(payload.mode).toBe("caretaker");
  });

  test("a thrown error degrades to the caretaker lane, never propagates", async () => {
    resolveStudentVenueBoard.mockRejectedValue(new Error("connection terminated"));
    await expect(
      resolveRestaurantOpen({ student: student(), gps: GPS }, NOW),
    ).resolves.toMatchObject({ mode: "caretaker" });
  });
});

describe("the food parameter", () => {
  test("a named food seeds the search and is passed to the browse", async () => {
    await resolveRestaurantOpen({ student: student(), gps: GPS, data: "pizza" }, NOW);
    expect(browse).toHaveBeenCalledWith(
      expect.objectContaining({ category: "pizza" }),
      NOW,
    );
  });

  test("a word the AI phrased loosely still lands on a category", async () => {
    // The Speaker passes what the student said, not a key.
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "I want ice cream" },
      NOW,
    );
    expect(payload.food).toBe("ice_cream");
  });

  test("an unrecognised food opens the whole grid rather than a guess", async () => {
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "something nice" },
      NOW,
    );
    expect(payload.food).toBeNull();
    expect(browse).toHaveBeenCalledWith(expect.objectContaining({ category: null }), NOW);
  });

  test("no position still opens the grid, and never searches", async () => {
    // iPad sessions send no gps_update. The grid is a vocabulary board first:
    // "I want pizza" at home is a sentence a child is entitled to say.
    const payload = await resolveRestaurantOpen({ student: student(), gps: null }, NOW);
    expect(payload.mode).toBe("search");
    expect(payload.categories).toEqual([]);
    expect(browse).not.toHaveBeenCalled();
  });
});

describe("the caretaker lane is where an AI open must NOT land", () => {
  // The coordinator refuses an AI-initiated open whose payload comes back
  // `caretaker`, because that mode means the app has nothing for the student.
  // These pin the payload the gate keys on; the gate itself lives in
  // routeAppOpen alongside the Word Finder gate it is modelled on.
  //
  // Live evidence for why a prompt was not enough (2026-08-23): the registry
  // entry already said in as many words that naming a food is not asking for a
  // restaurant, and the Speaker watched a student press "פיצה" on a food board
  // in his own bedroom and called open_app("restaurant", "pizza") anyway.
  test("no venue and no browsing is NOT caretaker — the gate must not fire here", async () => {
    // This used to be the gate's headline trigger. It is now the case the gate
    // must stay out of: there IS something for the student (the vocabulary
    // grid), so refusing the open leaves a child who asked to go to a
    // restaurant with nothing. Whether the AI should have asked is
    // aiOpenPolicy's question, not this one's.
    const payload = await resolveRestaurantOpen(
      { student: student({ enabled: true, studentBrowse: false }), gps: GPS, data: "pizza", trigger: "ai" },
      NOW,
    );
    expect(payload.mode).not.toBe("caretaker");
  });

  test("browsing ON is NOT caretaker, so the same press is allowed through", async () => {
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "pizza" },
      NOW,
    );
    expect(payload.mode).toBe("search");
  });

  test("being AT a venue is never caretaker, however the open was triggered", async () => {
    resolveBoundVenue.mockResolvedValue({ venueId: "v1", venueName: "Cafe Aroma", menuId: "m1" });
    const payload = await resolveRestaurantOpen(
      { student: student({ enabled: true, studentBrowse: false }), gps: GPS },
      NOW,
    );
    expect(payload.mode).toBe("floor");
  });
});

describe("what the Speaker is told", () => {
  test("menu mode names the venue and forbids naming dishes", async () => {
    const note = restaurantOpenNote({ mode: "menu", venueName: "Cafe Aroma" });
    expect(note).toContain("Cafe Aroma");
    expect(note).toContain("NOT name specific dishes");
  });

  test("floor mode says there is no menu and forbids describing dishes", () => {
    const note = restaurantOpenNote({ mode: "floor", venueName: "Cafe Aroma" });
    expect(note).toContain("Cafe Aroma");
    expect(note).toContain("no menu");
    expect(note).toContain("not describe dishes");
  });

  test("menu mode never lists the dishes themselves", async () => {
    // Sixty rows of menu on every subsequent turn, to say nothing of the ones
    // the allergen filter removed — the Speaker cannot see the board and must
    // not pretend to.
    resolveStudentVenueBoard.mockResolvedValue(MENU);
    const payload = await resolveRestaurantOpen({ student: student(), gps: GPS }, NOW);
    const note = restaurantOpenNote(payload);
    expect(note).not.toContain("Croissant");
    expect(note.length).toBeLessThan(400);
  });

  test("search mode says plainly that nothing is booked", async () => {
    const note = restaurantOpenNote({
      mode: "search",
      food: "pizza",
      places: [{ venueId: "v1", name: "Pizza Roma", distanceM: 100, visitedBefore: false, hasMenu: false }],
      categories: [],
    });
    expect(note).toContain("nothing is booked");
  });

  test("an empty search tells the Speaker not to invent a place", async () => {
    const note = restaurantOpenNote({ mode: "search", food: "pizza", places: [], categories: [] });
    expect(note).toContain("not invent");
  });

  test("a vocabulary-only grid tells the Speaker NOT to offer to find a place", async () => {
    // Otherwise it offers to look one up, the screen never shows any, and a
    // child who cannot ask what happened is left waiting on it.
    const note = restaurantOpenNote({ mode: "search", canSearch: false, food: "pizza", categories: [], places: [] });
    expect(note).toContain("turned OFF");
    expect(note).toMatch(/do NOT offer to find/i);
  });

  test("a searchable grid does NOT carry the turned-off wording", async () => {
    const note = restaurantOpenNote({ mode: "search", canSearch: true, food: "pizza", places: [], categories: [] });
    expect(note).not.toContain("turned OFF");
  });

  test("caretaker mode tells the Speaker there is no menu to read", async () => {
    const note = restaurantOpenNote({ mode: "caretaker", reason: "browse_off" });
    expect(note).toContain("caretaker");
    expect(note).toContain("no menu");
  });
});
