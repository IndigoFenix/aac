/**
 * `warmForVenue` — cache-once-on-first-ask (the background half of §4.2b).
 *
 * The design was always that a web menu is fetched once and cached for
 * everyone after; what never existed was a trigger other than the companion's
 * button. This suite pins the trigger's rails, because a background paid
 * fetch on an app-open path is exactly the kind of thing that goes quietly
 * wrong in both directions:
 *
 *   - too eager, and a student dwelling on place buttons runs up Web Unlocker
 *     and LLM bills, or a settings screen a clinician configured is overruled
 *     by a code path they cannot see;
 *   - too shy, and the student is back to "no menu yet, forever", which is
 *     the bug this exists to fix.
 *
 * DB-free: the repository and allergy read are mocked; the fetch itself is
 * spied on the service instance so the whole fetch→bind→cache pipeline stays
 * out of scope (it has its own suites).
 */

import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from "@jest/globals";

const listMenus = jest.fn(async (_id: string) => [] as any[]);
const getActiveMenu = jest.fn(async (_id: string) => undefined as any);
const getById = jest.fn(async (_id: string) => ({ id: "v1", name: "La Pizzalia" }) as any);
const getStudentAllergies = jest.fn(async (_id: string) => [] as string[]);

jest.unstable_mockModule("../db", () => ({ db: {} }));
jest.unstable_mockModule("../repositories/venueRepository.js", () => ({
  venueRepository: { listMenus, getActiveMenu, getById },
}));
jest.unstable_mockModule("../services/venue-menus/student-allergies.js", () => ({
  getStudentAllergies,
}));
// Imported by web-menu-service but never reached in this suite — the fetch is
// spied at the service boundary below.
jest.unstable_mockModule("../services/venue-menus/web-menu-fetcher.js", () => ({
  fetchWebMenu: jest.fn(),
}));
jest.unstable_mockModule("../services/venue-menus/menu-cache.js", () => ({
  cacheMenu: jest.fn(),
}));

let webMenuService: typeof import("../services/venue-menus/web-menu-service").webMenuService;
let resetWebWarmAttempts: typeof import("../services/venue-menus/web-menu-service").resetWebWarmAttempts;
let WEB_WARM_ATTEMPT_TTL_MS: number;

beforeAll(async () => {
  ({ webMenuService, resetWebWarmAttempts, WEB_WARM_ATTEMPT_TTL_MS } = await import(
    "../services/venue-menus/web-menu-service"
  ));
});

const NOW = new Date("2026-09-01T18:00:00Z");
const DISCLOSURE = { studentId: "s1", userId: "u1", useCase: "venue_menu_web" } as const;

/** A student whose clinician turned the web source ON. */
function student(venueMenus: Record<string, unknown> = { enabled: true, sources: { web: true } }) {
  return {
    id: "s1",
    birthDate: "2014-01-01",
    aacSettings: { venueMenus, languageLevel: 3 },
    primaryLanguage: "he",
  };
}

let fetchSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetWebWarmAttempts();
  listMenus.mockReset().mockResolvedValue([]);
  getActiveMenu.mockReset().mockResolvedValue(undefined);
  getById.mockReset().mockResolvedValue({ id: "v1", name: "La Pizzalia" });
  getStudentAllergies.mockReset().mockResolvedValue([]);
  fetchSpy = jest.spyOn(webMenuService, "fetchForVenue").mockResolvedValue({
    ok: true,
    menu: { id: "m1" },
    items: [{ name: "Margherita" }],
    status: "approved",
    reviewReasons: [],
    sourceUrl: "https://lapizzalia.example/menu",
    droppedByRefinement: [],
  } as any);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("the gates", () => {
  test("the clinician's web-source switch rules — off means no fetch, ever", async () => {
    // A background path does not get to overrule a settings screen. `sources.web`
    // ships false, so this is also the DEFAULT outcome.
    const outcome = await webMenuService.warmForVenue(
      student({ enabled: true, sources: { web: false } }),
      "v1",
      DISCLOSURE,
      NOW,
    );
    expect(outcome).toEqual({ kind: "skipped", reason: "web_source_off" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("an APPROVED menu means no fetch — there is nothing to add", async () => {
    getActiveMenu.mockResolvedValue({ id: "m0", status: "approved" });
    const outcome = await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    expect(outcome).toEqual({ kind: "skipped", reason: "menu_exists" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a PENDING-only venue re-warms under review-off — the re-fetch will approve", async () => {
    // The earlier fetch landed pending under a stricter gate (2026-09-01: one
    // shaky row parked a whole 40-row menu). With review off, refusing the
    // re-fetch would strand the venue behind a review nobody is doing.
    listMenus.mockResolvedValue([{ id: "m0", status: "pending_review" }]);
    const outcome = await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    expect(outcome.kind).toBe("ready");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a PENDING-only venue re-warms even with a saved review policy — the interim force", async () => {
    // Under INTERIM_REVIEW_OFF every saved policy resolves to "never" (the
    // settings panel baked old defaults into every existing row), so the
    // pending-row block for review policies is dormant. The mechanism it
    // protects (no minting pending rows for a queue) is pinned in the service
    // logic and springs back with the flip; today, the stranded pending rows
    // the OLD gate created are exactly what this re-warm exists to rescue.
    listMenus.mockResolvedValue([{ id: "m0", status: "pending_review" }]);
    const outcome = await webMenuService.warmForVenue(
      student({ enabled: true, sources: { web: true }, requireReview: "web_only" }),
      "v1",
      DISCLOSURE,
      NOW,
    );
    expect(outcome.kind).toBe("ready");
  });

  test("one attempt per venue per window — success or failure alike", async () => {
    fetchSpy.mockResolvedValue({ ok: false, reason: "no_source_url" } as any);
    await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    // A place with no website fails the same way ten minutes later; a student
    // pressing the button again must not re-spend the attempt.
    const again = await webMenuService.warmForVenue(
      student(),
      "v1",
      DISCLOSURE,
      new Date(NOW.getTime() + 10 * 60 * 1000),
    );
    expect(again).toEqual({ kind: "skipped", reason: "recently_attempted" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("the attempt is marked BEFORE the await, so concurrent presses collapse", async () => {
    // Two presses land inside the same event-loop turn — the second must find
    // the mark the first set synchronously, not race past it.
    const [a, b] = await Promise.all([
      webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW),
      webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["ready", "skipped"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("the window expires — a venue can be retried tomorrow", async () => {
    fetchSpy.mockResolvedValue({ ok: false, reason: "fetch_failed" } as any);
    await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    await webMenuService.warmForVenue(
      student(),
      "v1",
      DISCLOSURE,
      new Date(NOW.getTime() + WEB_WARM_ATTEMPT_TTL_MS + 1),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("different venues do not share an attempt", async () => {
    await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    await webMenuService.warmForVenue(student(), "v2", DISCLOSURE, NOW);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("the outcomes", () => {
  test("an approved fetch reports ready, named for the Speaker", async () => {
    const outcome = await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    expect(outcome).toEqual({ kind: "ready", venueName: "La Pizzalia", itemCount: 1 });
    // The student's language rides down so the board renders in it.
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: "v1", targetLanguage: "he", disclosure: DISCLOSURE }),
    );
  });

  test("a menu that lands in review is reported as such, not as ready", async () => {
    // The Speaker must not be handed a "ready" it would announce — review
    // might trim the menu, and a promise ahead of review is the false-promise
    // shape again.
    fetchSpy.mockResolvedValue({
      ok: true,
      menu: { id: "m1" },
      items: [{ name: "Margherita" }],
      status: "pending_review",
      reviewReasons: ["chain_binding"],
      sourceUrl: "https://lapizzalia.example/menu",
      droppedByRefinement: [],
    } as any);
    const outcome = await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    expect(outcome).toEqual({ kind: "pending_review" });
  });

  test("under the shipped defaults, the warm asks for NO review and no binding gate", async () => {
    // The interim works-first call (2026-09-01): requireReview ships "never"
    // and requireReviewWithAllergies ships false, so a warm goes live on the
    // extractor's sanity check alone. The allergen FILTER still runs at board
    // build regardless — review was never what filtered.
    getStudentAllergies.mockResolvedValue(["peanut"]);
    await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requireReview: false, gateDoubt: false }),
    );
  });

  test("saved review switches are PINNED OFF while the interim holds — the baked-row case", async () => {
    // 🚨 This exact shape kept failing live: the panel had saved
    // requireReview:"auto" + requireReviewWithAllergies:true into the student
    // row (verified against staging 2026-09-01), so flipped code DEFAULTS
    // never reached them and every fetch landed pending. The resolve-layer
    // force is what covers a baked row.
    getStudentAllergies.mockResolvedValue(["peanut"]);
    await webMenuService.warmForVenue(
      student({
        enabled: true,
        sources: { web: true },
        requireReview: "auto",
        requireReviewWithAllergies: true,
      }),
      "v1",
      DISCLOSURE,
      NOW,
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requireReview: false, gateDoubt: false }),
    );
  });

  test("it never throws — a repository outage is a skip", async () => {
    getActiveMenu.mockRejectedValue(new Error("db down"));
    const outcome = await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    expect(outcome).toEqual({ kind: "skipped", reason: "error" });
  });
});

describe("canWarmForVenue — what a screen may promise", () => {
  // The "getting the menu…" pane is only shown when a fetch WILL run (or is
  // running). These pin the peek's answers, and that peeking marks nothing.

  test("yes when a warm would run — and the peek marks nothing", async () => {
    expect(await webMenuService.canWarmForVenue(student(), "v1", NOW)).toBe("yes");
    // Still yes: asking did not spend the attempt.
    expect(await webMenuService.canWarmForVenue(student(), "v1", NOW)).toBe("yes");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no when the web source is off", async () => {
    expect(
      await webMenuService.canWarmForVenue(
        student({ enabled: true, sources: { web: false } }),
        "v1",
        NOW,
      ),
    ).toBe("no");
  });

  test("no when an approved menu exists", async () => {
    getActiveMenu.mockResolvedValue({ id: "m0", status: "approved" });
    expect(await webMenuService.canWarmForVenue(student(), "v1", NOW)).toBe("no");
  });

  test("yes for a pending-only venue under review-off — mirrors the warm", async () => {
    listMenus.mockResolvedValue([{ id: "m0", status: "pending_review" }]);
    expect(await webMenuService.canWarmForVenue(student(), "v1", NOW)).toBe("yes");
  });

  test("no after a recent failed attempt — 'tried and failed' is a message, not a spinner", async () => {
    fetchSpy.mockResolvedValue({ ok: false, reason: "no_source_url" } as any);
    await webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    expect(
      await webMenuService.canWarmForVenue(student(), "v1", new Date(NOW.getTime() + 60_000)),
    ).toBe("no");
  });

  test("in_flight while one is executing — same screen, no second fetch", async () => {
    let release!: (v: any) => void;
    fetchSpy.mockReturnValue(new Promise((resolve) => { release = resolve; }) as any);
    const running = webMenuService.warmForVenue(student(), "v1", DISCLOSURE, NOW);
    // Let the warm reach its fetch before peeking.
    await new Promise((r) => setTimeout(r, 0));
    expect(await webMenuService.canWarmForVenue(student(), "v1", NOW)).toBe("in_flight");
    release({ ok: false, reason: "fetch_failed" });
    await running;
    // Settled: now it is a recent attempt, not a flight.
    expect(await webMenuService.canWarmForVenue(student(), "v1", NOW)).toBe("no");
  });
});
