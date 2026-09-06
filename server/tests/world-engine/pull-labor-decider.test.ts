/**
 * ⚖️ PULL-MODEL LABOR (task #51, Stage 1) — THE READER AND THE DECIDER.
 *
 * USER RULING (2026-09-04, near-verbatim): *"it's not an order, it's a PERSONAL
 * DECISION."* A need exists as a QUANTITY — a stocking bill with its full
 * chain. A body with nothing more urgent SEES the open bills, walks the chain
 * to the deepest link it can serve, sizes a slice from its OWN carry, reserves
 * it, and issues the task to ITSELF.
 *
 * The laws this file pins:
 *
 *  ① VISIBILITY IS A SCOPE WALK, never a radius (feedback_context_via_scope_walk:
 *    smallest containing scope, then up, tolerating absence at every rung). A
 *    body ON the lot and a body on OPEN GROUND in the settlement both see the
 *    site's bill; a body inside somebody else's building whose walk does not
 *    reach the bill's rung does not.
 *
 *  ② THE CASCADE — links come back MOST DOWNSTREAM FIRST (build → haul →
 *    refine → fell), which is what makes the chain flow without anybody
 *    ordering it.
 *
 *  ③ THE SLICE IS THE BODY'S OWN CARRY. Bagless is ONE WHOLE THING; a basket
 *    is its remaining room. (`haulTripUnits`' catalogue optimism retires.)
 *
 *  ④ ATOMIC. `reserve` CANNOT FAIL (reservations.ts:118 — it merges, there is
 *    no stack check and no compare-and-swap), so the read and the reservation
 *    happen in one synchronous step and two bodies deciding in one sweep can
 *    never speak for the same units. Σ reserved ≤ free, always.
 *
 *  ⑤ FALSIFICATION — off the `pullLabor` capability NOTHING happens: no
 *    pursuit, no agreement, no reservation. This is what holds the jx-doll
 *    bench byte-identical by construction.
 *
 *  ⑥ A PARKED/BLOCKED NEED LOSES TO AN OPEN BILL — the measured frontier
 *    defect (two residents sitting `[sit]` / "I'm bored." while 42 hauls
 *    expired unclaimed), stated as arithmetic: a want with no plan cannot be
 *    what the body does instead.
 *
 *  ⑦ 🚨 A SETTLER IS NEVER HOUSE N. `settler_3` parses as house index 3 in the
 *    resident walker; a contribute pursuit puts settlers in `liveNeedBodies`,
 *    which is that walker's own cid set — so the guard is now load-bearing.
 *
 *  ⑧ ABANDON RELEASES THE SLICE — a body redirected by a command must not
 *    leave a phantom agreement holding units nobody is walking toward.
 *
 * SHAPE: laws ①–⑥ ride a SYNTHETIC session and a stub `ContributeDeps` — the
 * decider takes its whole world through that object precisely so it can be
 * asked these questions without booting one (and a jest suite that
 * value-imports quest-host pays a heavy per-worker transform tax). Laws ⑦–⑧
 * need the host itself, so they share ONE frontier boot at the end.
 *
 * DB-free / GL-free — `npm run test:engine -- decider`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import {
  decideContribution,
  visibleBills,
  type BillLink,
  type ContributeDeps,
} from "@shared/world-engine/interaction/quest/contribute.js";
import {
  CONTRIBUTE_PRIORITY,
  isContributePursuit,
  pullLaborOn,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import { NEED_PRESSURE_S } from "@shared/world-engine/interaction/behavior/needs.js";
import { driveValueS } from "@shared/world-engine/kernel/town/pricing.js";
import { defaultAnnounceCriteria } from "@shared/world-engine/interaction/dialogue/intent-lines.js";
import { seatsOfRect } from "@shared/world-engine/interaction/quest/construction-director.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import { createReservationLedger, freeUnits } from "@shared/world-engine/kernel/town/reservations.js";
import { createTransferLedger } from "@shared/world-engine/kernel/town/transfer.js";
import type { ConstructionOrder } from "@shared/world-engine/kernel/town/construction.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";

// ═══════════════════════════════════════════════════════════════════════════
// THE FIXTURE — one founded order, one crate, one forest, three bodies.
//
// Deliberately hand-built rather than booted: every input the decider reads is
// then VISIBLE in the test, so a pin that moves says which input moved. The
// scope shape is the frontier's own — the site's pile hangs off the town, the
// lot rung sits under it, and open ground answers null.
// ═══════════════════════════════════════════════════════════════════════════

const SITE_AT = { x: 100, y: 0 };
const CRATE_AT = { x: 90, y: 0 };
const FOREST_AT = { x: 200, y: 0 };
const CRATE = "furn_0_crate";
const FOREST = "wild:area:home";

interface Fixture {
  session: QuestSession;
  deps: ContributeDeps;
  /** Where each body stands — mutate to move one. */
  at: Map<string, { x: number; y: number }>;
  /** What each body is holding — mutate to give one a basket. */
  carry: Map<string, BodyCarry>;
  /** The best idle basket in reach (0 = none) — the trip's bag ceiling. */
  bagCeiling: { n: number };
  /** The scope `scopeOfPoint` answers for each body — the world half of ①. */
  scopeAt: (x: number, y: number) => string | null;
  orders: ConstructionOrder[];
  crateStock: Record<string, number>;
  forestStock: Record<string, number>;
  drawn: Array<{ key: string; goods: Record<string, number> }>;
  hauled: string[];
  worked: Array<{ cid: string; at: { x: number; y: number } }>;
  announced: string[];
  /** Make the site's row STAGED (materials in) so the build link opens. */
  stage(): void;
}

const bare = (): BodyCarry => ({ inHand: null, worn: null });
const withBasket = (capacity: number): BodyCarry => ({
  inHand: { objId: "basket_1", glyph: "basket", bag: { objId: "basket_1", glyph: "basket", stock: {}, capacity } },
  worn: null,
});

function makeFixture(opts?: { pullOn?: boolean }): Fixture {
  const orders: ConstructionOrder[] = [
    {
      kind: "found",
      ord: 1,
      type: "house",
      slot: 0,
      dx: 100,
      dy: 0,
      w: 8,
      h: 6,
      door: "south",
      startedDay: 0,
      buildDays: 4,
      costs: { block: 120 },
      pile: { block: 100 },
    } as ConstructionOrder,
  ];
  const crateStock: Record<string, number> = { block: 20 };
  const forestStock: Record<string, number> = { wood: 40 };
  const at = new Map<string, { x: number; y: number }>();
  const carry = new Map<string, BodyCarry>();
  // The best idle basket in reach — 0 = none, which is the fixture default.
  const bagCeiling = { n: 0 };
  const drawn: Fixture["drawn"] = [];
  const hauled: string[] = [];
  const worked: Fixture["worked"] = [];
  const announced: string[] = [];

  // The SCOPE SHAPE: the site's lot covers the site rect; everything else in
  // the settlement is open ground (null — "counts for nobody"), which the walk
  // must tolerate; the far forest sits inside a foreign building.
  const scopeAt = (x: number, y: number): string | null => {
    if (Math.abs(x - SITE_AT.x) <= 6 && Math.abs(y - SITE_AT.y) <= 6) return "lot:1";
    if (x >= 300) return "h_9"; // the building the ⑦-negative bill hangs inside
    if (x <= -300) return "h_5"; // …and a different one, for a body that cannot see it
    return null;
  };

  const session = {
    // ⑤ THE CAPABILITY, derived from the session's own shape — a town WITH a
    // wilderness scatter is the frontier homestead; `pullOn: false` strips the
    // scatter, which is exactly the dollhouse.
    town: {} as unknown,
    wilderness: (opts?.pullOn ?? true) ? ({} as unknown) : null,
    foundedSite: null,
    scale: DOLLHOUSE_SCALE,
    taskClock: 100,
    transfers: createTransferLedger(),
    reservations: createReservationLedger(),
    pursuits: new Map(),
    walk: new Map(),
    liveNeedBodies: new Set<string>(),
    npcTasks: new Map(),
    lastDrive: new Map(),
  } as unknown as QuestSession;

  const deps: ContributeDeps = {
    deltasOf: () => ({ orders: () => orders }),
    // The containment answers: a lot hangs off the town, and this session's
    // town id is the root the pile also hangs off.
    scopeCtxOf: () => ({ townId: () => "town" }),
    scopeOfPoint: (_s, x, y) => scopeAt(x, y),
    orderPileIds: (o) => ({ pileId: `orderpile:${o.ord}` }),
    endpointAt: (_s, id) =>
      id === `orderpile:1` ? SITE_AT : id === CRATE ? CRATE_AT : id === FOREST ? FOREST_AT : null,
    pileWordOf: () => "house",
    bodyAt: (_s, cid) => at.get(cid) ?? null,
    carryOf: (_s, cid) => carry.get(cid) ?? bare(),
    bagCeilingOf: () => bagCeiling.n,
    orderSiteId: (ord) => `o:${ord}`,
    // 🔁 MOVED (Stage 2, S1/S2): seats are a required dep now, and they come
    // from the REAL bay derivation over this fixture's own 8×6 plot so a change
    // to the bay arithmetic moves these pins with it. `pull-labor-seats.test.ts`
    // owns the seat laws themselves.
    seatsOf: (_s, siteId) =>
      siteId === "o:1"
        ? seatsOfRect(siteId, { x: SITE_AT.x - 4, y: SITE_AT.y - 3, w: 8, h: 6 }, 0)
        : [],
    buildworkSiteAt: (_s, siteId) => {
      const o = orders.find((q) => `o:${q.ord}` === siteId);
      if (!o || o.kind === "demolish") return null;
      if (o.laborStartDay === undefined) return null;
      if ((o.labor ?? 0) >= o.buildDays - 1e-9) return null;
      return SITE_AT;
    },
    siteMaterialSources: () => [
      { id: CRATE, stack: crateStock, d: 10 },
      { id: FOREST, stack: forestStock, d: 100 },
    ],
    // The director's own non-reserving number, over the same two sources —
    // read, never re-derived (1a's contract).
    freeHeadStockWithinReach: (s, _at, head) =>
      freeUnits(crateStock, s.reservations, CRATE, head) +
      freeUnits(forestStock, s.reservations, FOREST, head),
    agrHolder: (id) => `agr:${id}`,
    billIssuer: () => "player",
    drawSourceShelf: (_s, key, goods) => void drawn.push({ key, goods: { ...goods } }),
    issueTransferHaul: (_s, cid, agreementId) => void hauled.push(`${cid}|${agreementId}`),
    standAndWork: (_s, cid, spot) => void worked.push({ cid, at: spot }),
    // The FELL executor (task #51 item 1d) — never reached by these cases (no
    // row source here mints a mark), and required by the contract, so it is
    // stubbed rather than left out. `pull-labor-fell.test.ts` owns its pins.
    chopAt: () => {},
    announce: (_s, cid) => void announced.push(cid),
    motiveWeight: () => 1,
    forgoneS: () => 0,
  };

  return {
    session,
    deps,
    at,
    carry,
    bagCeiling,
    scopeAt,
    orders,
    crateStock,
    forestStock,
    drawn,
    hauled,
    worked,
    announced,
    stage() {
      const o = orders[0] as { laborStartDay?: number; pile?: Record<string, number> };
      o.laborStartDay = 1;
      o.pile = { block: 120 };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("① visibility is a SCOPE WALK, not a radius", () => {
  it("a body ON THE LOT sees the site's bill", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", { x: SITE_AT.x + 2, y: SITE_AT.y });
    expect(f.scopeAt(SITE_AT.x + 2, SITE_AT.y)).toBe("lot:1"); // the fixture's own premise
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.siteId === "o:1")).toBe(true);
  });

  it("a body on OPEN GROUND sees it too — null is a rung, not a refusal", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", { x: 40, y: 40 });
    // The premise: this ground is governed by no charter at all.
    expect(f.scopeAt(40, 40)).toBeNull();
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links.length).toBeGreaterThan(0);
  });

  it("a bill INSIDE ANOTHER BUILDING is invisible — and visible from inside it", () => {
    const f = makeFixture();
    // The bill's pile now hangs off building `h_9` (an annex's heap stands in
    // the building it grows), so the walk — not a radius — decides who sees it.
    const inside: ContributeDeps = {
      ...f.deps,
      scopeCtxOf: () => ({ townId: () => "town", buildingOfOrder: () => "h_9" }),
    };
    f.at.set("far", { x: -400, y: 0 }); // inside `h_5`
    expect(f.scopeAt(-400, 0)).toBe("h_5");
    expect(visibleBills(f.session, "far", inside)).toEqual([]);
    // …and the same bill, read by a body standing in `h_9`, is right there.
    f.at.set("near", { x: 400, y: 0 });
    expect(f.scopeAt(400, 0)).toBe("h_9");
    expect(visibleBills(f.session, "near", inside).length).toBeGreaterThan(0);
  });

  it("no bodyless body decides — the pull model governs BODIES", () => {
    const f = makeFixture();
    expect(visibleBills(f.session, "resident_9_9", f.deps)).toEqual([]);
  });
});

describe("② the cascade — most downstream first", () => {
  it("an UNSTAGED bill offers HAUL before FELL", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    // One head short (`block`), served by the crate — the nearest source with
    // free units. The forest holds `wood`, which this bill does not want.
    expect(links.map((l) => l.link)).toEqual(["haul"]);
    expect(links[0]!.from).toBe(CRATE);
    expect(links[0]!.head).toBe("block");
    expect(links[0]!.units).toBe(20); // 120 wanted − 100 in the pile
  });

  it("a STAGED bill puts BUILD ahead of every material link", () => {
    const f = makeFixture();
    f.stage();
    // …and re-open a material gap on top of it, so both links exist at once.
    (f.orders[0] as { costs?: Record<string, number> }).costs = { block: 130 };
    f.at.set("resident_0_0", SITE_AT);
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links.map((l) => l.link)).toEqual(["build", "haul"]);
  });

  it("a WILD source reads as FELL, and it is the LEAST downstream link", () => {
    const f = makeFixture();
    // Empty the crate: the only source left for `block` is the forest.
    f.crateStock.block = 0;
    f.forestStock.block = 12;
    f.at.set("resident_0_0", SITE_AT);
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links.map((l) => l.link)).toEqual(["fell"]);
    expect(links[0]!.wildTag).toBe("home");
  });

  it("a bill with nothing missing offers nothing", () => {
    const f = makeFixture();
    (f.orders[0] as { pile?: Record<string, number> }).pile = { block: 120 };
    f.at.set("resident_0_0", SITE_AT);
    expect(visibleBills(f.session, "resident_0_0", f.deps)).toEqual([]);
  });

  it("in-flight hauls COUNT AGAINST the bill — nobody double-orders the load", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    f.session.transfers.post({
      from: CRATE,
      to: "orderpile:1",
      goods: { block: 20 },
      issuer: "player",
      mode: "haul",
      now: 1,
    });
    expect(visibleBills(f.session, "resident_0_0", f.deps)).toEqual([]);
  });
});

describe("③ the slice is the body's OWN carry", () => {
  it("BAGLESS is one whole thing", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    const a = f.session.transfers.active()[0]!;
    expect(a.goods).toEqual({ block: 1 });
    expect(f.session.reservations.reservedUnits(CRATE, "block")).toBe(1);
  });

  it("A BASKET carries its remaining room", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    f.carry.set("resident_0_0", withBasket(8));
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.transfers.active()[0]!.goods).toEqual({ block: 8 });
  });

  it("A BODY WITH ITS HANDS FULL takes no haul slice — refusal conserves", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    f.carry.set("resident_0_0", { inHand: { objId: "rock_1", glyph: "stone" }, worn: null });
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(false);
    expect(f.session.transfers.active()).toEqual([]);
  });

  it("a FELL slice DRAWS THE SHELF ITSELF before it posts", () => {
    const f = makeFixture();
    f.crateStock.block = 0;
    f.forestStock.block = 12;
    f.at.set("resident_0_0", SITE_AT);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.drawn).toEqual([{ key: "home", goods: { block: 1 } }]);
    expect(f.session.transfers.active()[0]!.from).toBe(FOREST);
  });

  it("a BUILD seat stands at the work and announces, posting no agreement", () => {
    const f = makeFixture();
    f.stage();
    f.at.set("resident_0_0", SITE_AT);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    // 🔁 MOVED PIN (Stage 2, S1/S2): the dwell used to stand at the SITE ANCHOR
    // — one point, however many bodies. A body now stands at the BAY it
    // claimed, which is what makes many hands on one shell a picture rather
    // than a pile. The anchor still prices the walk; only the standing point
    // moved. (Both are inside the site rect, so the presence sweep is
    // untouched — `pull-labor-seats.test.ts` pins that.)
    const bay0 = seatsOfRect("o:1", { x: SITE_AT.x - 4, y: SITE_AT.y - 3, w: 8, h: 6 }, 0)[0]!;
    expect(f.worked).toEqual([{ cid: "resident_0_0", at: bay0.at }]);
    expect(f.session.pursuits.get("resident_0_0")!.bill!.seatKey).toBe("o:1#seat0");
    expect(f.session.transfers.active()).toEqual([]);
    const p = f.session.pursuits.get("resident_0_0");
    expect(isContributePursuit(p)).toBe(true);
    expect(p!.bill!.link).toBe("build");
    expect(p!.bill!.siteId).toBe("o:1");
    expect(f.announced).toEqual(["resident_0_0"]);
    expect(f.session.liveNeedBodies.has("resident_0_0")).toBe(true);
  });

  it("🔁 the SEAT bound holds — and it is the WORK's, so a fourth body builds too", () => {
    // 🔁 MOVED PIN (Stage 2, S1–S3). This asserted `BUILD_SEATS = 3`: three
    // builders, and the fourth body pushed onto a material link. That integer
    // is GONE — a seat is a PLACE, and this 8×6 plot has 22 of them (2×3 floor +
    // 2×3 roof + 10 wall bays), so the fourth body builds. The LAW the pin
    // guards is unchanged and re-stated below: a bounded number of bodies may
    // work one site, and the surplus takes the next link. `pull-labor-seats`
    // owns the bound-exhausted case (a 1×1 shell, six bays, eight bodies).
    const f = makeFixture();
    f.stage();
    (f.orders[0] as { costs?: Record<string, number> }).costs = { block: 130 };
    const cids = ["resident_0_0", "resident_0_1", "resident_0_2", "resident_0_3"];
    for (const cid of cids) f.at.set(cid, SITE_AT);
    for (const cid of cids) {
      expect(decideContribution(f.session, cid, f.deps, { beatS: -Infinity })).toBe(true);
    }
    const links = cids.map((c) => f.session.pursuits.get(c)!.bill!.link);
    expect(links).toEqual(["build", "build", "build", "build"]);
    // …each on its OWN bay, lowest index first, and never two on one.
    const keys = cids.map((c) => f.session.pursuits.get(c)!.bill!.seatKey);
    expect(keys).toEqual(["o:1#seat0", "o:1#seat1", "o:1#seat2", "o:1#seat3"]);
    expect(new Set(keys).size).toBe(4);
  });
});

describe("④ ATOMIC — read and reserve in one step", () => {
  it("bodies deciding in one sweep never speak for the same units", () => {
    const f = makeFixture();
    f.crateStock.block = 5;
    const cids = ["resident_0_0", "resident_0_1", "resident_0_2", "resident_0_3", "resident_0_4", "resident_0_5"];
    for (const cid of cids) {
      f.at.set(cid, SITE_AT);
      f.carry.set(cid, withBasket(2));
      decideContribution(f.session, cid, f.deps, { beatS: -Infinity });
    }
    // Σ reserved ≤ the stack, always — five units, never six.
    expect(f.session.reservations.reservedUnits(CRATE, "block")).toBeLessThanOrEqual(5);
    expect(freeUnits(f.crateStock, f.session.reservations, CRATE, "block")).toBeGreaterThanOrEqual(0);
    // …and every unit reserved is carried by exactly one live agreement.
    const promised = f.session.transfers
      .active()
      .reduce((s, a) => s + (a.goods.block ?? 0), 0);
    expect(promised).toBe(f.session.reservations.reservedUnits(CRATE, "block"));
    // Nobody was handed a slice of nothing.
    for (const a of f.session.transfers.active()) expect(a.goods.block).toBeGreaterThan(0);
  });

  it("a body that already holds a slice is not asked to hold a second", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    const before = f.session.transfers.active().length;
    // `session.pursuits` is ONE SLOT PER CID — a second install would silently
    // orphan the first slice, so the seam that prevents it is the caller's
    // (stepNeeds/stepPursuit own the body). The pin here is the conservation
    // half: re-deciding must not double the promise against the same stock.
    decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity });
    const promised = f.session.transfers.active().reduce((s, a) => s + (a.goods.block ?? 0), 0);
    expect(promised).toBe(f.session.reservations.reservedUnits(CRATE, "block"));
    expect(f.session.transfers.active().length).toBeGreaterThanOrEqual(before);
  });
});

describe("⑤ FALSIFICATION — off the capability, nothing happens", () => {
  it("`pullLaborOn` false ⇒ no pursuit, no agreement, no reservation", () => {
    const f = makeFixture({ pullOn: false });
    expect(pullLaborOn(f.session)).toBe(false);
    f.stage();
    f.at.set("resident_0_0", SITE_AT);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(false);
    expect(f.session.pursuits.size).toBe(0);
    expect(f.session.transfers.active()).toEqual([]);
    expect(f.session.reservations.reservedUnits(CRATE, "block")).toBe(0);
    expect(f.worked).toEqual([]);
    expect(f.announced).toEqual([]);
  });

  it("…and the capability is ON for the frontier shape it was written for", () => {
    expect(pullLaborOn(makeFixture().session)).toBe(true);
  });
});

describe("⑥ the argmax — a blocked need loses, a valuable one wins", () => {
  it("a want with NO PLAN loses to an open bill", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    // `-Infinity` IS the parked/blocked reading (`needRivalNetS`): a want that
    // could not compile is not what this body does instead.
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
  });

  it("a need worth MORE than the slice keeps the body", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    const ceiling = Math.max(...links.map((l) => l.unitValueS));
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: ceiling * 10 })).toBe(false);
    expect(f.session.pursuits.size).toBe(0);
  });

  it("the WORTHWHILE gate is the sign — an unaffordable trip is refused", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    // Price the claim above anything the bill is worth (the `claimForgoneS`
    // seat: what taking this slice would destroy).
    const costly: ContributeDeps = { ...f.deps, forgoneS: () => 1e9 };
    expect(decideContribution(f.session, "resident_0_0", costly, { beatS: -Infinity })).toBe(false);
  });

  it("a SPOKEN bill outweighs an ambient one through the motive weight", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    const weighted: ContributeDeps = { ...f.deps, motiveWeight: (_s, _c, l: BillLink) => (l.spoken ? 2 : 1) };
    const base = visibleBills(f.session, "resident_0_0", weighted)[0]!.unitValueS;
    // 🔁 MOVED PIN (F2): the rival is now met in the BODY's currency, so the
    // bar is the bill's own body-rung value — which a civic bill cannot clear
    // (its cost is positive) and a doubled spoken one can. The LAW is
    // unchanged; only the currency the bar is quoted in moved.
    const bar = CONTRIBUTE_PRIORITY * NEED_PRESSURE_S * bill(f).urgency;
    expect(decideContribution(f.session, "resident_0_0", weighted, { beatS: bar })).toBe(false);
    (f.orders[0] as { spoken?: boolean }).spoken = true;
    // The weight is applied by the decider, not the reader — the reader's
    // number stays the pool's own.
    expect(visibleBills(f.session, "resident_0_0", weighted)[0]!.unitValueS).toBe(base);
    expect(decideContribution(f.session, "resident_0_0", weighted, { beatS: bar })).toBe(true);
  });

  it("🔭 the SALIENCE hook multiplies value, and its absence weighs 1", () => {
    const plain = makeFixture();
    plain.at.set("resident_0_0", SITE_AT);
    const bar = CONTRIBUTE_PRIORITY * NEED_PRESSURE_S * bill(plain).urgency;
    // Default (no hook): the bill cannot beat a rival worth its own full value.
    expect(decideContribution(plain.session, "resident_0_0", plain.deps, { beatS: bar })).toBe(false);
    // With the hook raising this link's salience, the same bill wins.
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    const salient: ContributeDeps = { ...f.deps, salience: () => 4 };
    expect(decideContribution(f.session, "resident_0_0", salient, { beatS: bar })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑨ F2 — CONTRIBUTE IS A NEED ROW WITH A DECLARED PRIORITY (MAIN RULING,
// 2026-09-04). Before this, a slice was priced at the TOWN rung — one block
// worth a whole street-day (240 s), ×8 for a basket trip — while a full hunger
// is priced at the BODY rung and capped by its own fill clock. An open bill
// outbid every personal need by 3-24×, so ruling ③'s "a bored resident works
// and a HUNGRY ONE EATS FIRST" was false at the shipped constants (measured on
// the frontier arc: SAY 135 → 5, the food bubbles gone for the build window).
//
// The exchange rate is now DECLARED, once, exactly as every need template
// declares its `priority`:
//     valueS = CONTRIBUTE_PRIORITY × NEED_PRESSURE_S × urgency(bill) × w × salience
// and the town rung keeps its own job: ranking the LINKS of a chain.
// ═══════════════════════════════════════════════════════════════════════════

/** A NEED ROW'S OWN VALUE, by `rowValueS`' arithmetic verbatim (needs.ts) —
 *  `driveValueS(urgency × priority × NEED_PRESSURE_S / fillS, fillS)`, i.e.
 *  the ladder capped by the drive's own fill clock. Written out here so the
 *  rival numbers below are the engine's, not the test's invention. */
const needRowS = (urgency: number, priority: number, fillS: number): number =>
  driveValueS((urgency * priority * NEED_PRESSURE_S) / fillS, fillS);

/** The single link the default fixture offers. */
const bill = (f: Fixture): BillLink => visibleBills(f.session, "resident_0_0", f.deps)[0]!;

describe("⑨ F2 — the two currencies meet on ONE ladder", () => {
  /** A bill nothing has landed on yet: it presses FLAT OUT (urgency 1), which
   *  is the ruling's own wording and the hardest case for a need to win. */
  function freshBill(f: Fixture): void {
    (f.orders[0] as { pile?: Record<string, number> }).pile = {};
    f.crateStock.block = 200;
  }

  it("the urgency term IS the bill's shortfall fraction, 1 while nothing has landed", () => {
    const f = makeFixture();
    f.at.set("resident_0_0", SITE_AT);
    // 100 of 120 landed ⇒ 20/120 short.
    expect(bill(f).urgency).toBeCloseTo(20 / 120, 6);
    freshBill(f);
    expect(bill(f).urgency).toBe(1);
    // …and a bill four fifths served presses at a fifth.
    (f.orders[0] as { pile?: Record<string, number> }).pile = { block: 96 };
    expect(bill(f).urgency).toBeCloseTo(0.2, 6);
  });

  it("🚨 A HUNGRY BODY EATS FIRST — the defect this ruling exists to fix", () => {
    const f = makeFixture();
    freshBill(f);
    f.at.set("resident_0_0", SITE_AT);
    // A full hunger: priority 5, urgency 1, one street-day fill clock ⇒ 200 s.
    const hunger = needRowS(1, 5, 240);
    expect(hunger).toBeCloseTo(200, 6);
    // The bill at FULL pressure is a chore's 2 × 40 = 80 s. It loses.
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: hunger })).toBe(false);
    expect(f.session.pursuits.size).toBe(0);
    expect(f.session.transfers.active()).toEqual([]);
  });

  it("…and under the OLD town-rung price it would have won — the arithmetic that failed", () => {
    const f = makeFixture();
    freshBill(f);
    f.at.set("resident_0_0", SITE_AT);
    // One block, priced as the pool priced it: a whole street day of a hand.
    expect(bill(f).unitValueS).toBeCloseTo(240, 6);
    expect(bill(f).unitValueS).toBeGreaterThan(needRowS(1, 5, 240));
  });

  it("a body whose FUN IS BLOCKED works — a want with no plan is not an activity", () => {
    const f = makeFixture();
    freshBill(f);
    f.at.set("resident_0_0", SITE_AT);
    // `needRivalNetS` answers −∞ for a parked/blocked/idle row.
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.pursuits.get("resident_0_0")!.bill!.link).toBe("haul");
  });

  it("a MILD need loses to a bill pressing flat out", () => {
    const f = makeFixture();
    freshBill(f);
    f.at.set("resident_0_0", SITE_AT);
    const mild = needRowS(0.3, 5, 240); // 60 s
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: mild })).toBe(true);
  });

  it("a SPOKEN order at FAMILY compliance outbids a mild need, but NOT a hungry body", () => {
    const mild = needRowS(0.3, 5, 240); // 60 s
    const hunger = needRowS(1, 5, 240); // 200 s
    // `w = 1 + compliance(relationToward(cid, issuer))`; family ≈ 1.68, which
    // puts a spoken bill at ≈ 3.4 rungs — the host owns those books, so the
    // weight is stubbed at the number the ruling quotes.
    const spoken = (f: Fixture): ContributeDeps => ({ ...f.deps, motiveWeight: () => 1.68 });
    const a = makeFixture();
    freshBill(a);
    a.at.set("resident_0_0", SITE_AT);
    expect(decideContribution(a.session, "resident_0_0", spoken(a), { beatS: mild })).toBe(true);
    const b = makeFixture();
    freshBill(b);
    b.at.set("resident_0_0", SITE_AT);
    expect(decideContribution(b.session, "resident_0_0", spoken(b), { beatS: hunger })).toBe(false);
  });

  it("LINK RANKING IS UNCHANGED — the town rung still picks which link of a chain", () => {
    const f = makeFixture();
    f.stage();
    // A staged row with a material gap on top: BUILD (labour left × the day)
    // and HAUL (one block) are both open, and the town rung prefers the build.
    (f.orders[0] as { costs?: Record<string, number> }).costs = { block: 130 };
    f.at.set("resident_0_0", SITE_AT);
    const links = visibleBills(f.session, "resident_0_0", f.deps);
    expect(links.map((l) => l.link)).toEqual(["build", "haul"]);
    expect(decideContribution(f.session, "resident_0_0", f.deps, { beatS: -Infinity })).toBe(true);
    expect(f.session.pursuits.get("resident_0_0")!.bill!.link).toBe("build");
    // …and the cascade's own ranking numbers are still the POOL's: per-unit
    // goods value and labour-left, untouched by the body-rung price.
    expect(links[1]!.unitValueS).toBeCloseTo(240, 6);
    expect(links[0]!.unitValueS).toBeCloseTo(4 * 240, 6); // 4 build-days left
  });

  it("the WORTHWHILE gate still guards the TOWN's side — an unaffordable trip is refused", () => {
    const f = makeFixture();
    freshBill(f);
    f.at.set("resident_0_0", SITE_AT);
    // ⚖️ The gate deliberately did NOT move to the body rung: a bill's urgency
    // decays as it fills, so a body-rung sign test would abandon the last
    // blocks of EVERY order (at 118/120 the bill is worth 1.3 s against a
    // 40 s walk). An idle body — `beatS` −∞ — must still finish the job.
    const costly: ContributeDeps = { ...f.deps, forgoneS: () => 1e9 };
    expect(decideContribution(f.session, "resident_0_0", costly, { beatS: -Infinity })).toBe(false);
    const tail = makeFixture();
    (tail.orders[0] as { pile?: Record<string, number> }).pile = { block: 118 };
    tail.at.set("resident_0_0", SITE_AT);
    expect(bill(tail).urgency).toBeCloseTo(2 / 120, 6);
    expect(decideContribution(tail.session, "resident_0_0", tail.deps, { beatS: -Infinity })).toBe(true);
  });

  it("R3 — a self-issued slice announces as `contribute`, and the criteria lets it through", () => {
    // The LINE is unchanged: `announceIntent` derives it from the goal and the
    // bill and never reads `source` — this is the gate the source feeds.
    expect(defaultAnnounceCriteria({ creatureId: "c", goal: { kind: "buildwork", site: "o:1" }, source: "contribute" })).toBe(true);
    expect(defaultAnnounceCriteria({ creatureId: "c", goal: { kind: "buildwork", site: "o:1" }, source: "task-claim" })).toBe(true);
    expect(defaultAnnounceCriteria({ creatureId: "c", goal: { kind: "buildwork", site: "o:1" }, source: "need" })).toBe(false);
    expect(defaultAnnounceCriteria({ creatureId: "c", goal: { kind: "buildwork", site: "o:1" }, source: "command" })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑦⑧ — THE HOST'S OWN TWO. ONE BOOT, the shipped frontier document.
// ═══════════════════════════════════════════════════════════════════════════

const doc = JSON.parse(
  readFileSync(join(process.cwd(), "scripts", "worlds", "frontier.spec.json"), "utf8"),
) as Record<string, unknown>;

describe("⑦⑧ the host: a settler is never house N, and an abandoned slice is released", () => {
  let run: TextQuestRun;

  beforeAll(() => {
    run = bootTextQuest({ world: doc, seed: 11, dt: 0.5 });
    run.advance(10);
  }, 600_000);

  afterAll(() => run?.dispose());

  it("the capability is ON for this world (the premise every pin below stands on)", () => {
    expect(pullLaborOn(run.session)).toBe(true);
  }, 600_000);

  it("🚨 a SETTLER in the live set never adopts a house row", () => {
    const s = run.session;
    // A contribute pursuit marks its body live, and `liveNeedBodies` IS the
    // resident walker's cid set — so this is the exact state #51 makes
    // reachable. `settler_3` parses as house index 3.
    s.liveNeedBodies.add("settler_3");
    const houseKeys0 = [...s.needMeters.keys()].filter((k) => k.startsWith("resident_3_")).length;
    run.advance(4);
    expect([...s.needMeters.keys()].some((k) => k.startsWith("settler_3|"))).toBe(false);
    expect(s.blockedNeeds.has("settler_3")).toBe(false);
    expect(s.needStep.has("settler_3")).toBe(false);
    // …and house 3's own book was not disturbed by the impostor.
    expect([...s.needMeters.keys()].filter((k) => k.startsWith("resident_3_")).length).toBe(houseKeys0);
    s.liveNeedBodies.delete("settler_3");
  }, 600_000);

  it("⑧ a contribute haul that is ABANDONED leaves no phantom agreement", () => {
    const s = run.session;
    run.speak("build + house");
    // Give the order a chance to stake ground and open a bill, then let the
    // residents decide against it.
    for (let i = 0; i < 400 && !hauler(s); i++) run.stepFrame();
    const cid = hauler(s);
    if (!cid) {
      // No body took a slice in the window — say so rather than pass vacuously.
      throw new Error("no contribute haul was taken in 200 sim-s — fixture or decider, not a pass");
    }
    const bill = s.pursuits.get(cid)!.bill!;
    const agrId = bill.agreementId!;
    const holder = `agr:${agrId}`;
    expect(s.reservations.holderRows(holder).length).toBeGreaterThan(0);

    // THE REDIRECT: a spoken command takes the body (the pursuit yields to it
    // exactly as a need pursuit does).
    s.pursuits.set(cid, { source: "command", goal: { kind: "goTo", place: { kind: "home" } }, glyph: "go" });
    run.advance(2);

    // The slice is gone: no reservation, and the agreement is not sitting
    // pending against the pile forever.
    expect(s.reservations.holderRows(holder)).toEqual([]);
    const st = s.transfers.get(agrId)?.status;
    expect(st === "failed" || st === "done").toBe(true);
  }, 600_000);
});

/** The first body holding a contribute HAUL slice, if any. */
function hauler(s: QuestSession): string | null {
  for (const [cid, p] of s.pursuits) {
    if (isContributePursuit(p) && p.bill.agreementId) return cid;
  }
  return null;
}
