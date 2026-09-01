/**
 * The student's browse path (§4.1 student-browse extension).
 *
 * Two properties matter more than the feature itself, and both are the sort
 * that only a test keeps true:
 *
 *   1. BROWSING NEVER BINDS. Nothing here may write `student_venues`, because
 *      `resolveBoundVenue` reads `lastVisitedAt` to decide "we are here" — so
 *      a binding write would put a pizzeria's menu on the board of a child
 *      sitting in their own kitchen.
 *   2. ONE OUTBOUND SEARCH PER PLACE PER WINDOW. A caretaker pressed once per
 *      meal; a student can dwell as often as they can look. The rate limit is
 *      what keeps repeated presses from becoming repeated position reports and
 *      from hammering a shared community endpoint.
 *
 * DB-free: the repository and the OSM provider are mocked.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from "@jest/globals";

const findNearby = jest.fn(async (_gps: any, _r: number) => [] as any[]);
const listForStudent = jest.fn(async (_id: string) => [] as any[]);
const getActiveMenu = jest.fn(async (_id: string) => undefined as any);
const upsert = jest.fn(async (v: any) => ({ id: `v-${v.sourceId}`, ...v }));
const linkStudent = jest.fn(async (_d: any) => ({}) as any);
const getById = jest.fn(async (_id: string) => undefined as any);
const searchNearbyVenues = jest.fn(async (_gps: any, _r: number) => [] as any[]);

jest.unstable_mockModule("../db", () => ({ db: {} }));
// Mock paths resolve relative to THIS file, not to the module under test.
jest.unstable_mockModule("../repositories/venueRepository.js", () => ({
  venueRepository: { findNearby, listForStudent, getActiveMenu, upsert, linkStudent, getById },
}));
jest.unstable_mockModule("../services/venue-menus/osm-venue-provider.js", () => ({
  searchNearbyVenues,
}));

let venueBrowseService: typeof import("../services/venue-menus/venue-browse-service").venueBrowseService;
let resetBrowseSearchCache: typeof import("../services/venue-menus/venue-browse-service").resetBrowseSearchCache;
let BROWSE_SEARCH_TTL_MS: number;

beforeAll(async () => {
  ({ venueBrowseService, resetBrowseSearchCache, BROWSE_SEARCH_TTL_MS } = await import(
    "../services/venue-menus/venue-browse-service"
  ));
});

const NOW = new Date("2026-08-22T18:00:00Z");
const GPS = { latitude: 32.0853, longitude: 34.7818 };

/** Resolved settings with browsing on. */
function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    studentBrowse: true,
    locationSearch: "precise",
    browseRadiusM: 1500,
    searchRadiusM: 150,
    providers: { osm: true, brightData: false },
    sources: { camera: true, web: false, manual: true },
    requireVenueConfirmation: true,
    requireReview: "always",
    maxMenuAgeDays: 30,
    showBranchDisclaimer: true,
    requireReviewWithAllergies: true,
    readingModeDefault: true,
    showPrices: false,
    categoryPages: true,
    showDietaryTags: false,
    ...overrides,
  } as any;
}

function venueRow(id: string, name: string, cuisine: string | null, venueType = "restaurant") {
  return {
    venue: { id, name, cuisine, venueType, latitude: GPS.latitude, longitude: GPS.longitude },
    distanceM: 10,
  };
}

beforeEach(() => {
  resetBrowseSearchCache();
  findNearby.mockReset().mockResolvedValue([]);
  listForStudent.mockReset().mockResolvedValue([]);
  getActiveMenu.mockReset().mockResolvedValue(undefined);
  upsert.mockReset().mockImplementation(async (v: any) => ({ id: `v-${v.sourceId}`, ...v }));
  linkStudent.mockReset();
  getById.mockReset().mockResolvedValue(undefined);
  searchNearbyVenues.mockReset().mockResolvedValue([]);
});

describe("gates", () => {
  test("the feature being off yields nothing and reads nothing", async () => {
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings({ enabled: false }) },
      NOW,
    );
    expect(result.categories).toEqual([]);
    expect(findNearby).not.toHaveBeenCalled();
    expect(searchNearbyVenues).not.toHaveBeenCalled();
  });

  test("student browsing is a SEPARATE switch from the feature", async () => {
    // A clinician may want menus without giving the student a search button.
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings({ studentBrowse: false }) },
      NOW,
    );
    expect(result.categories).toEqual([]);
    expect(findNearby).not.toHaveBeenCalled();
  });

  test("location off means no browse at all", async () => {
    await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings({ locationSearch: "off" }) },
      NOW,
    );
    expect(searchNearbyVenues).not.toHaveBeenCalled();
  });
});

describe("browsing never binds", () => {
  test("no student_venues row is written, with or without a category", async () => {
    findNearby.mockResolvedValue([venueRow("v1", "Pizza Roma", "pizza")]);

    await venueBrowseService.browse({ studentId: "s1", gps: GPS, settings: settings() }, NOW);
    await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings(), category: "pizza" },
      NOW,
    );

    // `resolveBoundVenue` decides "we are here" from lastVisitedAt. If browsing
    // touched it, wanting pizza would open a pizzeria's menu at home.
    expect(linkStudent).not.toHaveBeenCalled();
  });
});

describe("outbound search is rate-limited by PLACE", () => {
  test("the first press searches", async () => {
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings() },
      NOW,
    );
    expect(result.searched).toBe(true);
    expect(searchNearbyVenues).toHaveBeenCalledTimes(1);
  });

  test("a burst of presses searches ONCE", async () => {
    // The student-dwell case: twelve food types explored in a minute.
    for (let i = 0; i < 12; i++) {
      await venueBrowseService.browse(
        { studentId: "s1", gps: GPS, settings: settings(), category: "pizza" },
        new Date(NOW.getTime() + i * 1000),
      );
    }
    expect(searchNearbyVenues).toHaveBeenCalledTimes(1);
  });

  test("an empty cell does not re-query on every press", async () => {
    // The rate limit keys on the PLACE, not on whether the search found
    // anything — otherwise somewhere with no restaurants would hit Overpass on
    // every single press, which is the worst case, not the cheapest.
    searchNearbyVenues.mockResolvedValue([]);
    await venueBrowseService.browse({ studentId: "s1", gps: GPS, settings: settings() }, NOW);
    await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings() },
      new Date(NOW.getTime() + 5000),
    );
    expect(searchNearbyVenues).toHaveBeenCalledTimes(1);
  });

  test("a different student at the same place reuses the search", async () => {
    // The cell is the key, not the student — the same reason the venue cache
    // is global. It also means no identifier is stored to rate-limit on.
    await venueBrowseService.browse({ studentId: "s1", gps: GPS, settings: settings() }, NOW);
    const second = await venueBrowseService.browse(
      { studentId: "s2", gps: GPS, settings: settings() },
      new Date(NOW.getTime() + 1000),
    );
    expect(second.searched).toBe(false);
    expect(searchNearbyVenues).toHaveBeenCalledTimes(1);
  });

  test("searches again once the window has passed", async () => {
    await venueBrowseService.browse({ studentId: "s1", gps: GPS, settings: settings() }, NOW);
    await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings() },
      new Date(NOW.getTime() + BROWSE_SEARCH_TTL_MS + 1000),
    );
    expect(searchNearbyVenues).toHaveBeenCalledTimes(2);
  });

  test("never calls the paid provider", async () => {
    // Bright Data earns its keep by supplying the `website` the binding check
    // needs. Browse binds nothing, so there is nothing here for it to do.
    await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings({ providers: { osm: true, brightData: true } }) },
      NOW,
    );
    expect(searchNearbyVenues).toHaveBeenCalledTimes(1);
  });
});

describe("results", () => {
  beforeEach(() => {
    findNearby.mockResolvedValue([
      venueRow("v1", "Pizza Roma", "pizza"),
      venueRow("v2", "Cafe Aroma", null, "cafe"),
    ]);
  });

  test("reports only the food types actually nearby", async () => {
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings() },
      NOW,
    );
    const keys = result.categories.map((c) => c.key);
    expect(keys).toContain("pizza");
    expect(keys).toContain("coffee");
    expect(keys).not.toContain("falafel");
  });

  test("no category asked for means no places listed", async () => {
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings() },
      NOW,
    );
    expect(result.places).toEqual([]);
  });

  test("a category lists the places serving it, nearest first", async () => {
    findNearby.mockResolvedValue([
      { ...venueRow("v3", "Far Pizza", "pizza"), venue: { id: "v3", name: "Far Pizza", cuisine: "pizza", venueType: "restaurant", latitude: 32.095, longitude: 34.7818 } },
      venueRow("v1", "Near Pizza", "pizza"),
    ]);
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings(), category: "pizza" },
      NOW,
    );
    expect(result.places.map((p) => p.name)).toEqual(["Near Pizza", "Far Pizza"]);
  });

  test("marks places this student has eaten at before", async () => {
    listForStudent.mockResolvedValue([{ venueId: "v1" }]);
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings(), category: "pizza" },
      NOW,
    );
    expect(result.places[0].visitedBefore).toBe(true);
  });

  test("an unknown category is empty, not everything", async () => {
    const result = await venueBrowseService.browse(
      { studentId: "s1", gps: GPS, settings: settings(), category: "shawarma_palace" },
      NOW,
    );
    expect(result.places).toEqual([]);
  });

  test("a discovery outage is an empty grid, never a throw", async () => {
    // The student pressed a button and said something true. An exception here
    // becomes an error screen for a child who did nothing wrong.
    findNearby.mockRejectedValue(new Error("connection terminated"));
    await expect(
      venueBrowseService.browse({ studentId: "s1", gps: GPS, settings: settings() }, NOW),
    ).resolves.toEqual({ categories: [], places: [], searched: false });
  });
});

describe("resolveNamedVenue — how open_app data finds a venue", () => {
  // The matcher exists so `open_app("restaurant", "לה פיצליה")` opens La
  // Pizzalia's menu instead of resetting the app to the food grid (observed
  // live 2026-09-01). Its one dangerous failure mode is looseness: a venue
  // named "פיצה רומא" must NOT swallow the word "פיצה", or a student asking
  // for pizza gets teleported into one specific pizzeria. Exact normalized
  // equality only.

  test("a venue:<id> token is a direct lookup, no matching", async () => {
    // Ids are our own UUIDs; the token pattern requires a plausible one
    // (six-plus id chars) so junk after the prefix cannot trigger a lookup.
    const id = "3f2e1d0c-venue-uuid";
    getById.mockResolvedValue({ id, name: "La Pizzalia" });
    const venue = await venueBrowseService.resolveNamedVenue("s1", `venue:${id}`, GPS, 1500);
    expect(venue?.id).toBe(id);
    expect(findNearby).not.toHaveBeenCalled();
  });

  test("an exact name match against the nearby pool resolves", async () => {
    findNearby.mockResolvedValue([venueRow("v1", "לה פיצליה", "pizza")]);
    const venue = await venueBrowseService.resolveNamedVenue("s1", "לה פיצליה", GPS, 1500);
    expect(venue?.id).toBe("v1");
  });

  test("normalization bridges punctuation and case, nothing more", async () => {
    findNearby.mockResolvedValue([venueRow("v1", "Cafe Aroma", "coffee_shop")]);
    const venue = await venueBrowseService.resolveNamedVenue("s1", "cafe aroma!", GPS, 1500);
    expect(venue?.id).toBe("v1");
  });

  test("a CONTAINED name does not match — words belong to the cuisine matcher", async () => {
    findNearby.mockResolvedValue([venueRow("v1", "פיצה רומא", "pizza")]);
    const venue = await venueBrowseService.resolveNamedVenue("s1", "פיצה", GPS, 1500);
    expect(venue).toBeNull();
  });

  test("the family's own label for a linked venue matches first", async () => {
    // "המסעדה שלנו" is a name the cached pool has never heard of.
    listForStudent.mockResolvedValue([{ venueId: "v7", label: "המסעדה שלנו" }]);
    getById.mockResolvedValue({ id: "v7", name: "Trattoria Roma" });
    const venue = await venueBrowseService.resolveNamedVenue("s1", "המסעדה שלנו", GPS, 1500);
    expect(venue?.id).toBe("v7");
    expect(findNearby).not.toHaveBeenCalled();
  });

  test("no gps limits matching to the student's own venues", async () => {
    findNearby.mockResolvedValue([venueRow("v1", "לה פיצליה", "pizza")]);
    const venue = await venueBrowseService.resolveNamedVenue("s1", "לה פיצליה", null, 1500);
    expect(venue).toBeNull();
    expect(findNearby).not.toHaveBeenCalled();
  });

  test("empty or foodish free text resolves to nothing, quietly", async () => {
    expect(await venueBrowseService.resolveNamedVenue("s1", "", GPS, 1500)).toBeNull();
    expect(await venueBrowseService.resolveNamedVenue("s1", "  ", GPS, 1500)).toBeNull();
    expect(await venueBrowseService.resolveNamedVenue("s1", null, GPS, 1500)).toBeNull();
  });
});
