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
const resolveVenueBoardById = jest.fn(async (_s: any, _v: string, _n?: Date) => null as any);
const browse = jest.fn(async (_i: any, _n?: Date) => ({
  categories: [] as any[],
  places: [] as any[],
  searched: false,
}));
const resolveNamedVenue = jest.fn(
  async (_sid: string, _t: any, _g: any, _r: number) => null as any,
);

jest.unstable_mockModule("../db", () => ({ db: {} }));
jest.unstable_mockModule("../services/venue-menus/venue-board-service.js", () => ({
  resolveStudentVenueBoard,
  resolveBoundVenue,
  resolveVenueBoardById,
  describeVenueBoardStats: () => "stats",
}));
jest.unstable_mockModule("../services/venue-menus/venue-browse-service.js", () => ({
  venueBrowseService: { browse, resolveNamedVenue },
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
  resolveVenueBoardById.mockReset().mockResolvedValue(null);
  browse.mockReset().mockResolvedValue({ categories: [], places: [], searched: false });
  resolveNamedVenue.mockReset().mockResolvedValue(null);
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
    // 🚨 And it SAYS so. Without this flag "we never looked" and "we looked and
    // the street is empty" are the same payload, and both told a child there
    // was nothing near him (2026-09-01).
    expect(payload.positionKnown).toBe(false);
  });

  test("a search that ran marks the payload as positioned", async () => {
    const payload = await resolveRestaurantOpen({ student: student(), gps: GPS }, NOW);
    expect(payload.positionKnown).toBe(true);
  });

  test("a NAMED venue with an approved menu opens ITS menu — as a preview", async () => {
    // 🚨 The reset this replaces (live, 2026-09-01). The student pressed
    // "לה פיצליה" on the places grid; the Speaker heard the sentence and called
    // open_app("restaurant", "לה פיצליה"); the name matched no cuisine, so the
    // app RE-OPENED ON THE FOOD GRID. The AI said "we'll open it for you" and
    // the screen went back to "what do you want to eat?".
    resolveNamedVenue.mockResolvedValue({ id: "v9", name: "La Pizzalia", cuisine: "pizza" });
    resolveVenueBoardById.mockResolvedValue({
      venueId: "v9",
      venueName: "La Pizzalia",
      menuId: "m9",
      board: { name: "La Pizzalia", pages: [] },
      stats: {},
    });
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "לה פיצליה" },
      NOW,
    );
    expect(payload.mode).toBe("menu");
    expect(payload.preview).toBe(true);
    expect(payload.venueName).toBe("La Pizzalia");
    expect(payload.menuBoard).toBeTruthy();
    // A preview is a WANT — no binding path is involved, and no floor board:
    // "this is too hot" is a sentence for a table they are not at.
    expect(payload.floorBoard).toBeUndefined();
    expect(resolveVenueBoardById).toHaveBeenCalledWith(expect.anything(), "v9", NOW);
  });

  test("the client's venue:<id> token reaches the same path", async () => {
    // The places grid sends `venue:<id>` on the reopen so the student's own
    // press does not depend on the AI hearing the sentence and re-opening.
    resolveNamedVenue.mockResolvedValue({ id: "v9", name: "La Pizzalia", cuisine: null });
    resolveVenueBoardById.mockResolvedValue({
      venueId: "v9",
      venueName: "La Pizzalia",
      menuId: "m9",
      board: { name: "La Pizzalia", pages: [] },
      stats: {},
    });
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "venue:v9" },
      NOW,
    );
    expect(payload.mode).toBe("menu");
    expect(resolveNamedVenue).toHaveBeenCalledWith("s1", "venue:v9", GPS, expect.any(Number));
  });

  test("a named venue with NO usable menu keeps the ask on screen, not the bare grid", async () => {
    // We know the place; there is just nothing a student may see (never
    // captured, in review, stale, or emptied by the allergen filter). The open
    // lands on that venue's KIND of food — so the place they named is in the
    // list — and carries the name so the Speaker says what happened.
    resolveNamedVenue.mockResolvedValue({ id: "v9", name: "La Pizzalia", cuisine: "pizza" });
    browse.mockResolvedValue({
      categories: [{ key: "pizza", emoji: "🍕", count: 2 }],
      places: [
        { venueId: "v9", name: "La Pizzalia", distanceM: 120, visitedBefore: false, hasMenu: false },
      ],
      searched: false,
    });
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "לה פיצליה" },
      NOW,
    );
    expect(payload.mode).toBe("search");
    expect(payload.requestedVenueName).toBe("La Pizzalia");
    // The id rides along so the coordinator can try a background web fetch —
    // the cache-once trigger (webMenuService.warmForVenue).
    expect(payload.requestedVenueId).toBe("v9");
    // The venue's own cuisine chose the page, even though the NAME matched no
    // cuisine word.
    expect(payload.food).toBe("pizza");
    expect(browse).toHaveBeenCalledWith(expect.objectContaining({ category: "pizza" }), NOW);
  });

  test("a plain food word is NOT hijacked by a venue whose name contains it", async () => {
    // resolveNamedVenue is exact-match only, so "pizza" returns null here —
    // pinned from this side so a looser matcher cannot regress the grid.
    resolveNamedVenue.mockResolvedValue(null);
    const payload = await resolveRestaurantOpen(
      { student: student(), gps: GPS, data: "pizza" },
      NOW,
    );
    expect(payload.mode).toBe("search");
    expect(payload.food).toBe("pizza");
    expect(payload.requestedVenueName).toBeUndefined();
    expect(resolveVenueBoardById).not.toHaveBeenCalled();
  });

  test("browsing off is not positioned either — nothing was looked up", async () => {
    const payload = await resolveRestaurantOpen(
      { student: student({ enabled: true, studentBrowse: false }), gps: GPS },
      NOW,
    );
    expect(payload.positionKnown).toBe(false);
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

  test("an empty search we never RAN must not be reported as an empty street", async () => {
    // 2026-09-01, live: the student's deviceLocationEnabled was off, so no
    // position ever reached the server and no lookup ran. The note said
    // "Nothing nearby serves pizza" — indistinguishable from a real search that
    // came back empty — and the Speaker duly told a child there was no pizza
    // place near him. A screen may say it does not know; it may not assert a
    // fact about the world that nobody checked.
    const note = restaurantOpenNote({
      mode: "search",
      canSearch: true,
      positionKnown: false,
      food: "pizza",
      places: [],
      categories: [],
    });
    expect(note).toMatch(/do not know where the student is/i);
    expect(note).toMatch(/no search .* has run/i);
    // The exact claim that was wrong.
    expect(note).not.toMatch(/nothing nearby serves/i);
    expect(note).toMatch(/do NOT say there is nothing nearby/i);
  });

  test("a search that DID run still reports an empty street plainly", async () => {
    // The other half of the pair — `positionKnown: true` must not blunt a real
    // "we looked and there is nothing" into a vague "we don't know".
    const note = restaurantOpenNote({
      mode: "search",
      canSearch: true,
      positionKnown: true,
      food: "pizza",
      places: [],
      categories: [],
    });
    expect(note).toContain("Nothing nearby serves pizza");
    expect(note).toContain("not invent");
  });

  test("a menu PREVIEW note says they are NOT there", async () => {
    // A preview is a want. The Speaker must not narrate a table.
    const note = restaurantOpenNote({
      mode: "menu",
      preview: true,
      venueName: "La Pizzalia",
      menuBoard: {},
    });
    expect(note).toContain("NOT there");
    expect(note).toContain("nothing is booked");
    expect(note).toMatch(/do not name\s+specific dishes/i);
  });

  test("a fetching screen gets a fetching narration — no promises", async () => {
    const note = restaurantOpenNote({
      mode: "search",
      canSearch: true,
      requestedVenueName: "La Pizzalia",
      fetchingMenu: { venueId: "v9", venueName: "La Pizzalia" },
      categories: [],
      places: [],
    });
    expect(note).toContain("FETCHED right now");
    expect(note).toMatch(/may fail/i);
    expect(note).not.toMatch(/no menu loaded/);
  });

  test("a finished failed fetch is said plainly", async () => {
    const note = restaurantOpenNote({
      mode: "search",
      canSearch: true,
      menuFetchFailed: "La Pizzalia",
      categories: [],
      places: [],
      food: null,
    });
    expect(note).toContain("could not be shown");
    expect(note).toMatch(/offer to try again/i);
  });

  test("a named venue with no menu is answered, not narrated over", async () => {
    const note = restaurantOpenNote({
      mode: "search",
      canSearch: true,
      positionKnown: true,
      requestedVenueName: "La Pizzalia",
      food: "pizza",
      categories: [],
      places: [],
    });
    expect(note).toContain("La Pizzalia");
    expect(note).toContain("no menu");
    // It must not fall through to the generic grid narration — that reads to
    // the child as being ignored.
    expect(note).not.toContain("Nothing nearby serves");
  });

  test("browsing off wins over the position — the grid is vocabulary either way", async () => {
    // Both flags are false here. `canSearch` is the more specific statement
    // (a clinician turned searching off), so it must be the one reported.
    const note = restaurantOpenNote({
      mode: "search",
      canSearch: false,
      positionKnown: false,
      food: "pizza",
      places: [],
      categories: [],
    });
    expect(note).toContain("turned OFF");
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
    // The MODE token stays `caretaker` — it is a payload discriminant shared
    // with the client and the server type. The user-facing vocabulary is
    // "companion" (2026-08-30), so the prose must not say "caretaker" while the
    // screens say something else: the Speaker reads this note aloud in its own
    // words, and it is the one place the two vocabularies could drift apart.
    const note = restaurantOpenNote({ mode: "caretaker", reason: "browse_off" });
    expect(note).toContain("companion");
    expect(note).not.toMatch(/caretaker|grown-?up/i);
    expect(note).toContain("no menu");
  });
});
