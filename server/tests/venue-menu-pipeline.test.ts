/**
 * END-TO-END: can a student actually GET a menu?
 *
 * Three rounds of "review is off now" shipped green unit tests while the live
 * device kept saying "found but needs a caretaker's check". Each round tested
 * one rung with idealized inputs; the failure lived in the seams — above all
 * in the STUDENT'S SAVED ROW, which the settings panel had written with the
 * old defaults baked in, so flipped code defaults never reached it.
 *
 * This suite runs the whole pipe with only two things faked — the network
 * (search + page fetches) and the LLM provider. Everything between them is
 * REAL: discovery parsing, the §3.1a binding check, extraction parsing,
 * refinement application, the cache status table, the resolved settings, the
 * allergen filter, and the board builder. The decisive case uses the LIVE
 * student's venueMenus JSON verbatim (read from staging 2026-09-01) and the
 * LIVE venue's shape (no website, no country, no address) — the exact inputs
 * that failed three times.
 *
 * DB-free: the repository is an in-memory fake. Belongs to `test:unit`.
 */

import { describe, test, expect, jest, beforeAll, beforeEach, afterAll } from "@jest/globals";

// ── The in-memory repository ────────────────────────────────────────────────

interface FakeMenuRow {
  id: string;
  venueId: string;
  language: string;
  currency?: string;
  items: unknown[];
  provenance: string;
  sourceUrl?: string;
  bindingBasis: string;
  bindingCountry?: string;
  bindingBranchMatch: string;
  status: string;
  extractedAt: Date;
}

const venues = new Map<string, Record<string, unknown>>();
let menus: FakeMenuRow[] = [];
let menuSeq = 0;

const venueRepository = {
  getById: async (id: string) => venues.get(id),
  listMenus: async (venueId: string) => menus.filter((m) => m.venueId === venueId),
  getActiveMenu: async (venueId: string) =>
    [...menus].reverse().find((m) => m.venueId === venueId && m.status === "approved"),
  getMenuById: async (id: string) => menus.find((m) => m.id === id),
  createMenu: async (data: Record<string, unknown>) => {
    const row = { id: `m-${++menuSeq}`, extractedAt: new Date(), ...data } as FakeMenuRow;
    menus.push(row);
    return row;
  },
  listForStudent: async (_id: string) => [] as unknown[],
};

// ── The two faked seams: network + LLM ──────────────────────────────────────

/** What the Unlocker "returns" per URL. Reset per test. */
let pagesByUrl = new Map<RegExp, string | null>();
const fetchPageHtml = jest.fn(async (url: string) => {
  for (const [pattern, html] of pagesByUrl) if (pattern.test(url)) return html;
  return null;
});

jest.unstable_mockModule("../db", () => ({ db: {} }));
jest.unstable_mockModule("../repositories/venueRepository.js", () => ({ venueRepository }));
jest.unstable_mockModule("../services/venue-menus/student-allergies.js", () => ({
  // The live student has allergies recorded — part of what gated review.
  getStudentAllergies: jest.fn(async () => ["בוטנים"]),
}));
jest.unstable_mockModule("../services/venue-menus/brightdata-client.js", () => ({
  isBrightDataConfigured: () => true,
  fetchPageHtml,
}));

/**
 * The LLM, answering by schema name. The extraction answer deliberately
 * includes ONE low-confidence row — that single row is what set
 * `requiresReview` on the live 31-item menu (page-merge:
 * `lowConfidenceCount > 0`) and parked it behind review.
 */
const structuredComplete = jest.fn(async (req: { schemaName: string }) => {
  if (req.schemaName === "web_menu_page") {
    return {
      content: {
        language: "he",
        currency: "ILS",
        items: [
          { name: "פיצה מרגריטה", price: 52, priceText: "₪52", category: "פיצות", confidence: 0.95 },
          { name: "פסטה רוזה", price: 58, priceText: "₪58", category: "פסטות", confidence: 0.9 },
          { name: "עוגת בוטנים", description: "עם בוטנים קלויים", price: 32, confidence: 0.85 },
          { name: "שולחן מס 4", confidence: 0.3 },
          { name: "לקוחות יקרים! המטבח נסגר ב-22:00", confidence: 0.9 },
        ],
      },
    };
  }
  if (req.schemaName === "menu_refinement") {
    return {
      content: {
        entries: [
          // `icon` is the regular board's glyph syntax — a composed one here
          // pins that a modifier survives the whole pipeline to the button.
          { index: 0, keep: true, kind: "food", icon: "pizza.olive" },
          { index: 1, keep: true, kind: "food", icon: "pasta" },
          { index: 2, keep: true, kind: "food", icon: "cake+🥜" },
          { index: 3, keep: true, kind: "unknown" },
          { index: 4, keep: false, kind: "notice" },
        ],
      },
    };
  }
  throw new Error(`unexpected schema ${req.schemaName}`);
});
jest.unstable_mockModule("../services/providers/provider-factory.js", () => ({
  getStructuredProvider: () => ({ structuredComplete }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The LIVE venue's shape: an OSM row with nothing on it but a name. */
const VENUE_ID = "v-la-pizzalia";
const LIVE_VENUE = {
  id: VENUE_ID,
  name: "לה פיצליה",
  websiteUri: null,
  countryCode: null,
  address: null,
  latitude: 32.08,
  longitude: 34.845,
};

/** The LIVE student's saved venueMenus, verbatim from staging (2026-09-01) —
 *  the OLD defaults baked in by the settings panel. THE row that kept
 *  winning against three rounds of code-default flips. */
const LIVE_SAVED_VENUE_MENUS = {
  enabled: true,
  sources: { web: true, camera: true, manual: true },
  providers: { osm: true, brightData: true },
  showPrices: "auto",
  browseRadiusM: 2500,
  categoryPages: true,
  requireReview: "auto",
  searchRadiusM: 150,
  studentBrowse: true,
  locationSearch: "precise",
  maxMenuAgeDays: 30,
  showDietaryTags: false,
  readingModeDefault: true,
  showBranchDisclaimer: true,
  requireVenueConfirmation: true,
  requireReviewWithAllergies: true,
};

const STUDENT = {
  id: "s1",
  birthDate: "2014-01-01",
  aacSettings: { venueMenus: LIVE_SAVED_VENUE_MENUS, languageLevel: 2 },
  primaryLanguage: "he",
};

const DISCLOSURE = { studentId: "s1", userId: "u1", useCase: "venue_menu_web" } as const;

const WOLT_URL = "https://wolt.com/he/isr/rishon-lezion-hashfela-area/restaurant/la-pizzalia";

/** A search-results page in the shape the parser reads (uddg redirect). */
const SEARCH_HTML = `<html><body>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(WOLT_URL)}&rut=x">לה פיצליה</a>
</body></html>`;

/** A server-rendered menu page — enough text for the fetcher's shell check. */
const MENU_HTML = `<html><body><main>
  <h1>לה פיצליה | משלוחים</h1>
  <div>פיצה מרגריטה — רוטב עגבניות, מוצרלה ₪52</div>
  <div>פסטה רוזה — שמנת עגבניות ₪58</div>
  <div>עוגת בוטנים — עם בוטנים קלויים ₪32</div>
  <div>לקוחות יקרים! המטבח נסגר ב-22:00</div>
</main></body></html>`;

// ── Wiring ──────────────────────────────────────────────────────────────────

let webMenuService: typeof import("../services/venue-menus/web-menu-service").webMenuService;
let resetWebWarmAttempts: typeof import("../services/venue-menus/web-menu-service").resetWebWarmAttempts;
let resolveVenueBoardById: typeof import("../services/venue-menus/venue-board-service").resolveVenueBoardById;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ webMenuService, resetWebWarmAttempts } = await import(
    "../services/venue-menus/web-menu-service"
  ));
  ({ resolveVenueBoardById } = await import("../services/venue-menus/venue-board-service"));
});

beforeEach(() => {
  resetWebWarmAttempts();
  venues.clear();
  venues.set(VENUE_ID, { ...LIVE_VENUE });
  menus = [];
  menuSeq = 0;
  fetchPageHtml.mockClear();
  structuredComplete.mockClear();
  // The DIRECT search path answers with the live-measured shape: a 2xx
  // challenge page with no result links, which must push discovery onto the
  // Unlocker rather than reading as "no results".
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 202,
    text: async () => "<html><body>challenge</body></html>",
  })) as unknown as typeof fetch;
  // The Unlocker: search pages resolve, the Wolt page resolves.
  pagesByUrl = new Map<RegExp, string | null>([
    [/duckduckgo\.com/, SEARCH_HTML],
    [/wolt\.com/, MENU_HTML],
  ]);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ── The cases ───────────────────────────────────────────────────────────────

describe("the live failing case, end to end", () => {
  test("the baked saved row + allergies + one shaky row still yields an APPROVED menu", async () => {
    // Every ingredient of the three live failures at once: requireReview
    // "auto" and the allergy switch baked into the row, a venue with no
    // website/country/address, a chain-level Wolt binding, and one
    // low-confidence extraction row. Under the interim ruling all of it is
    // recorded, none of it blocks.
    const outcome = await webMenuService.warmForVenue(STUDENT, VENUE_ID, DISCLOSURE);

    expect(outcome).toEqual({ kind: "ready", venueName: "לה פיצליה", itemCount: 4 });

    const row = menus[0];
    expect(row.status).toBe("approved"); // ← the assertion that failed live, three times
    expect(row.provenance).toBe("web");
    expect(row.sourceUrl).toBe(WOLT_URL);
    // The binding facts of the live row, reproduced by the REAL check.
    expect(row.bindingBasis).toBe("chain_fallback");
    expect(row.bindingBranchMatch).toBe("chain");
  });

  test("the refined menu builds a real board — every dish shown, notice gone", async () => {
    await webMenuService.warmForVenue(STUDENT, VENUE_ID, DISCLOSURE);

    const resolved = await resolveVenueBoardById(STUDENT, VENUE_ID);
    expect(resolved).not.toBeNull();

    const labels = JSON.stringify(resolved!.board);
    expect(labels).toContain("פיצה מרגריטה");
    expect(labels).toContain("פסטה רוזה");
    // The peanut cake is SHOWN despite the recorded peanut allergy — the
    // string-matching allergen filter is out of the serving path by decision
    // (2026-09-01; it erased whole categories on term collisions). Allergen
    // safety is the companion's conversation, later the AI pass or
    // ask-the-waiter buttons.
    expect(labels).toContain("עוגת בוטנים");
    // The refinement's edit stands: the notice row is not a dish.
    expect(labels).not.toContain("לקוחות יקרים");

    // Icons ride the buttons in regular-board glyph syntax, composition
    // intact, ready for the same symbol pipeline every other board uses.
    const buttons = resolved!.board!.pages.flatMap((p) => p.buttons);
    const glyphOf = (name: string) =>
      buttons.find((b) => b.spokenText === name)?.glyph;
    expect(glyphOf("פיצה מרגריטה")).toBe("pizza.olive");
    expect(glyphOf("עוגת בוטנים")).toBe("cake+🥜");
  });

  test("the exact chain: two search passes, binding before fetch, one menu write", async () => {
    await webMenuService.warmForVenue(STUDENT, VENUE_ID, DISCLOSURE);
    const fetched = fetchPageHtml.mock.calls.map((c) => String(c[0]));
    // Unlocker saw: the two search pages (wolt-targeted + general — the
    // direct path returned the challenge page), then the menu page itself.
    expect(fetched.filter((u) => u.includes("duckduckgo")).length).toBe(2);
    expect(fetched.filter((u) => u.includes("wolt.com/he/isr")).length).toBe(1);
    expect(menus).toHaveLength(1);
    // Both models consulted exactly once: extract, then refine.
    expect(structuredComplete.mock.calls.map((c: any[]) => c[0].schemaName)).toEqual([
      "web_menu_page",
      "menu_refinement",
    ]);
  });
});

describe("the endings that must stay honest", () => {
  test("nothing findable → no_source_url, and the gate stops promising", async () => {
    pagesByUrl = new Map([[/./, null]]);
    const outcome = await webMenuService.warmForVenue(STUDENT, VENUE_ID, DISCLOSURE);
    expect(outcome).toEqual({ kind: "skipped", reason: "no_source_url" });
    // A fetching screen may not be promised for a venue that just failed.
    expect(await webMenuService.canWarmForVenue(STUDENT, VENUE_ID)).toBe("no");
  });

  test("a stranded pending row from the OLD gate is rescued by a re-warm", async () => {
    // The live venue is in exactly this state: one pending_review row minted
    // before the interim ruling. The re-warm must run and land approved.
    menus.push({
      id: "m-old",
      venueId: VENUE_ID,
      language: "he",
      items: [],
      provenance: "web",
      bindingBasis: "chain_fallback",
      bindingBranchMatch: "chain",
      status: "pending_review",
      extractedAt: new Date(Date.now() - 3600_000),
    });
    const outcome = await webMenuService.warmForVenue(STUDENT, VENUE_ID, DISCLOSURE);
    expect(outcome.kind).toBe("ready");
    expect((await venueRepository.getActiveMenu(VENUE_ID))?.status).toBe("approved");
  });

  test("once an approved menu exists, nothing fetches again", async () => {
    await webMenuService.warmForVenue(STUDENT, VENUE_ID, DISCLOSURE);
    resetWebWarmAttempts(); // clear the throttle — the menu itself must gate
    fetchPageHtml.mockClear();
    const again = await webMenuService.warmForVenue(STUDENT, VENUE_ID, DISCLOSURE);
    expect(again).toEqual({ kind: "skipped", reason: "menu_exists" });
    expect(fetchPageHtml).not.toHaveBeenCalled();
    expect(await webMenuService.canWarmForVenue(STUDENT, VENUE_ID)).toBe("no");
  });
});
