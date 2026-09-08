/**
 * 🪚 TRIP DAMPING — A HALF-EMPTY TRIP FROM A SHELF THAT IS STILL FILLING IS
 * WORTH LESS TO THE TOWN.
 *
 * USER, 2026-09-06 (the block-cadence round's own second half): *"there would
 * have to be a system to mitigate people wasting time carrying one block at a
 * time as they become available."* Measured on the mill world: 52 of 60 block
 * deliveries carried a SINGLE unit over a full round trip a body could have
 * made once with eight.
 *
 * 🚨 THE SHAPE THIS IS NOT, AND WHY (pull-labor-round.md, "Trip damping
 * (follow-up)"). The first build DECLINED the trickle link — projected the load
 * over the walk and skipped when it would still be under half a load. It was
 * reverted: **a declined link does not hand the body to another link, it hands
 * the tick to the NEED LOOP.** The damped console carried 83 `[needs] settler_N
 * took 0.2×food from flora:…` lines against 0 undamped — the settlers walked
 * off to forage and the town lost the hands that were also its bench crew,
 * costing +960 s on staging. So the shipped shape is a DOWN-WEIGHT, and every
 * pin below exists to keep it one:
 *
 *  ① THE TRICKLE IS PRICED DOWN, MONOTONICALLY. A haul of `slice` out of a
 *    producing shelf keeps `slice / (0.5 × room)` of its town value, so 1-of-8
 *    prices at or below 2-of-8, at or below 3-of-8 — and a rival link that
 *    sits between them wins exactly the ones it outprices.
 *  ② IT NEVER SKIPS, EVER. The weight rides the TOWN rung only; `bodyNetS` and
 *    the beat are untouched, and the value is FLOORED at the claim's own cost,
 *    so `net > 0` survives and the body still takes A link whenever an undamped
 *    run would have taken one. This is the whole difference from the reverted
 *    shape.
 *  ③ A NON-PRODUCING SOURCE IS BYTE-IDENTICAL TO TODAY. Rate 0 ⇒ weight 1 ⇒ the
 *    decider is the shipped one. That is every source in the world except a
 *    mill's own shelf while its bench is in labour.
 *  ④ A HALF LOAD OR MORE IS A REAL TRIP and is never damped.
 *  ⑤ THE RATE IS A CLOSED FORM OVER THE REFINE ROW — `buildDays / count`
 *    build-days a unit (the identity `mintDueRefineUnits` mints on) under
 *    `laborRatePerS`. No sampling, no new constant. On the mill world
 *    (`construction: 720` ⇒ 0.0125 game-days a unit, 240 s a day) that is
 *    ≈0.333 units a second with one hand at the bench and ≈0.267 on the
 *    schedule arm.
 *
 * SHAPE: PURE. ①–④ ride a synthetic session and a hand-built `ContributeDeps`
 * (the decider takes its whole world through that object precisely so it can be
 * asked without booting one); ⑤ rides the REAL director on a real town play,
 * the `block-cadence.test.ts` harness pattern. No quest-host value import, no
 * DOM/GL, no DB.
 *
 * Run it with:  npm run test:engine -- trip-damping
 */
import { describe, it, expect } from "@jest/globals";
import {
  decideContribution,
  visibleBills,
  type ContributeDeps,
} from "@shared/world-engine/interaction/quest/contribute.js";
import {
  createConstructionDirector,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import { createTaskPool } from "@shared/world-engine/interaction/behavior/task-pool.js";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import { createReservationLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { createTransferLedger } from "@shared/world-engine/kernel/town/transfer.js";
import { TOWN_YARD_EP, type ConstructionOrder } from "@shared/world-engine/kernel/town/construction.js";
import { CONTRIBUTE_TPL_KEY } from "@shared/world-engine/kernel/town/pull-labor.js";
import { refinedGlyphOf } from "@shared/world-engine/products.js";
import { DOLLHOUSE_SCALE } from "@shared/world-engine/scale.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { ContainerRecord } from "@shared/world-engine/kernel/town/containers.js";
import type { StockEndpoint } from "@shared/world-engine/kernel/town/transfer.js";
import type { BodyCarry } from "@shared/world-engine/kernel/town/scope-shape.js";

// ═══════════════════════════════════════════════════════════════════════════
// ①–④ THE DECIDER FIXTURE — two bills, two sources, one body, ZERO DISTANCE.
//
// Both sources sit under the body's feet, so `claimCost` is 0 and every net
// below IS its link's town value: the arithmetic the pins measure is visible
// rather than inferred. Two bills rather than one because the whole claim of
// the shipped shape is that only WHICH LINK WINS moves — a fixture with one
// link could not tell a down-weight from a skip.
// ═══════════════════════════════════════════════════════════════════════════

const HERE = { x: 0, y: 0 };
const MILL_SHELF = "furn_0_millshelf"; // the deposit a bench is filling
const CRATE = "furn_0_crate"; // an ordinary shelf nothing fills
const CID = "settler_0";

/** One unit of a head the town is completely out of, in hand-seconds:
 *  `goodsValueS(1, 1, townFillS(scale), 1)` = the street day. Written out so
 *  the ladder below is readable without running the pricer. */
const UNIT_S = DOLLHOUSE_SCALE.dayLengthS; // 240

interface Fixture {
  session: QuestSession;
  deps: ContributeDeps;
  /** Free units of `block` on the producing shelf — this IS `link.units`. */
  millStock: Record<string, number>;
  /** …and of `wood` on the ordinary one, for the rival link. */
  crateStock: Record<string, number>;
  /** Units a second the mill shelf is being filled at (0 = nothing fills it). */
  rate: { n: number };
  /** The rival bill's motive weight — the dial that separates the ladder. */
  rivalWeight: { n: number };
  /** What a claim DESTROYS, for the floor pin. */
  forgone: { n: number };
  /** The head the body committed to, or null when it took nothing. */
  took(): { head?: string; units?: number } | null;
}

const bare = (): BodyCarry => ({ inHand: null, worn: null });

function makeFixture(): Fixture {
  // TWO UNSTAGED BILLS. Unstaged so neither offers a dwell link — the pins are
  // about hauls, and a build link would out-price both by construction.
  const orders: ConstructionOrder[] = [
    {
      kind: "found", ord: 1, type: "house", slot: 0, dx: 0, dy: 0, w: 8, h: 6,
      door: "south", startedDay: 0, buildDays: 4, costs: { block: 120 }, pile: {},
    } as ConstructionOrder,
    {
      kind: "found", ord: 2, type: "house", slot: 1, dx: 0, dy: 0, w: 8, h: 6,
      door: "south", startedDay: 0, buildDays: 4, costs: { wood: 120 }, pile: {},
    } as ConstructionOrder,
  ];
  const millStock: Record<string, number> = { block: 1 };
  const crateStock: Record<string, number> = { wood: 1 };
  const rate = { n: 0 };
  const rivalWeight = { n: 1 };
  const forgone = { n: 0 };

  const session = {
    // The capability, derived from the session's own shape (a town WITH a
    // wilderness scatter is the frontier homestead — `pullLaborOn`).
    town: {} as unknown,
    wilderness: {} as unknown,
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
    scopeCtxOf: () => ({ townId: () => "town" }),
    scopeOfPoint: () => null, // open ground everywhere — the walk's own root
    orderPileIds: (o) => ({ pileId: `orderpile:${o.ord}` }),
    endpointAt: () => HERE, // every endpoint under the body's feet ⇒ cost 0
    pileWordOf: () => "house",
    bodyAt: () => HERE,
    carryOf: () => bare(),
    // A BASKET IN REACH: room 8, so half a load is 4 — the mill world's own
    // shape (`haulTripUnits`), and the number every weight below divides by.
    bagCeilingOf: () => 8,
    orderSiteId: (ord) => `o:${ord}`,
    seatsOf: () => [],
    buildworkSiteAt: () => null, // nothing is staged — no dwell link exists
    siteMaterialSources: (_s, _at, _v) => [
      { id: MILL_SHELF, stack: millStock, d: 0 },
      { id: CRATE, stack: crateStock, d: 0 },
    ],
    freeHeadStockWithinReach: (_s, _at, head) =>
      (millStock[head] ?? 0) + (crateStock[head] ?? 0),
    agrHolder: (id) => `agr:${id}`,
    billIssuer: () => "player",
    drawSourceShelf: () => {},
    issueTransferHaul: () => {},
    standAndWork: () => {},
    chopAt: () => {},
    announce: () => {},
    // The RIVAL DIAL: the block bill weighs 1, the wood bill weighs whatever
    // the case sets. Motive weight is the one per-link multiplier the shipped
    // decider already carries, so nothing is invented to separate them.
    motiveWeight: (_s, _cid, link) => (link.head === "wood" ? rivalWeight.n : 1),
    forgoneS: () => forgone.n,
    // 🪚 THE PRODUCING-RATE SEAM. Only the mill shelf is ever being filled.
    refineRateAt: (_s, endpointId, head) =>
      endpointId === MILL_SHELF && head === "block" ? rate.n : 0,
  };

  return {
    session,
    deps,
    millStock,
    crateStock,
    rate,
    rivalWeight,
    forgone,
    took: () => {
      const p = session.pursuits.get(CID) as { bill?: { head?: string; units?: number } } | undefined;
      return p?.bill ?? null;
    },
  };
}

/** Decide once with nothing else to do, and say what the body committed to. */
function decideHead(f: Fixture): string | null {
  const ok = decideContribution(f.session, CID, f.deps, { beatS: -Infinity });
  return ok ? (f.took()?.head ?? null) : null;
}

describe("the fixture's own premises", () => {
  it("offers exactly two haul links, block first, each priced per unit at the street day", () => {
    const f = makeFixture();
    const links = visibleBills(f.session, CID, f.deps);
    expect(links.map((l) => `${l.link}:${l.head}`)).toEqual(["haul:block", "haul:wood"]);
    expect(links.every((l) => l.unitValueS === UNIT_S)).toBe(true);
    expect(links.every((l) => l.urgency === 1)).toBe(true); // nothing has landed
    // `servable` is clamped by the reach stock, so the link wants what is there.
    expect(links[0]!.units).toBe(1);
  });
});

describe("① the trickle is priced DOWN, and only which link wins moves", () => {
  it("1-of-8 out of a PRODUCING shelf loses a rival it beat when nothing was filling it", () => {
    const f = makeFixture();
    // UNDAMPED: the two links tie at 240 s and the FIRST one wins (`net >
    // best.net` is strict), which is the block link.
    expect(decideHead(f)).toBe("block");

    // …and the same world with the bench running. 1 of a 4-unit half load keeps
    // a QUARTER of its value (60 s), so the untouched wood link takes the body.
    const g = makeFixture();
    g.rate.n = 0.333; // the mill world's own rate, one hand at the bench
    expect(decideHead(g)).toBe("wood");
  });

  it("MONOTONE — a rival pitched at 0.8 of a unit takes the 1-, 2- and 3-unit trips and none of the ≥4 ones", () => {
    // The rival is worth 192 s (0.8 × 240). The damped block link is worth
    // `slice / 4 × 240 × slice`… no: `slice × 240 × (slice / 4)`, which is the
    // ladder this case walks. Written as the explicit expectation per slice so
    // a change to the weight moves a NAMED number.
    const priced = (slice: number) => slice * UNIT_S * Math.min(1, slice / 4);
    expect([1, 2, 3, 4, 8].map(priced)).toEqual([60, 240, 540, 960, 1920]);
    for (const slice of [1, 2, 3, 4, 8]) {
      const f = makeFixture();
      f.millStock.block = slice;
      f.rate.n = 0.333;
      f.rivalWeight.n = 0.8; // 192 s — between the 1-unit and the 2-unit rungs
      expect(`${slice}:${decideHead(f)}`).toBe(`${slice}:${priced(slice) > 192 ? "block" : "wood"}`);
    }
  });
});

describe("② IT NEVER SKIPS — the floor holds the sign", () => {
  it("takes the damped link anyway when it is the ONLY link, even under a cost that swallows the weight", () => {
    const f = makeFixture();
    f.crateStock.wood = 0; // one link in the world, and it is the trickle
    f.rate.n = 0.333;
    // A claim that DESTROYS 200 s: the undamped 240 s trip still pays (net 40),
    // the quartered 60 s one would not — so the floor is what stands between
    // this world and the reverted skip.
    f.forgone.n = 200;
    expect(decideHead(f)).toBe("block");
  });

  it("takes A link in every damped case an undamped run would have taken one in", () => {
    for (const slice of [1, 2, 3, 4, 8]) {
      for (const forgone of [0, 100, 200]) {
        const plain = makeFixture();
        plain.millStock.block = slice;
        plain.forgone.n = forgone;
        const damped = makeFixture();
        damped.millStock.block = slice;
        damped.forgone.n = forgone;
        damped.rate.n = 0.333;
        const a = decideHead(plain);
        const b = decideHead(damped);
        expect(`${slice}/${forgone}: ${a === null}`).toBe(`${slice}/${forgone}: ${b === null}`);
      }
    }
  });

  it("does not RESURRECT a link the worthwhile gate refuses — the gate reads the undamped value", () => {
    const f = makeFixture();
    f.crateStock.wood = 0;
    f.rate.n = 0.333;
    f.forgone.n = 1000; // 240 s of value against a 1000 s claim: not worth doing
    expect(decideHead(f)).toBeNull();
  });
});

describe("③ a NON-PRODUCING source is byte-identical to the shipped decider", () => {
  it("every slice takes the same link with rate 0 as it does with no seam at all", () => {
    for (const slice of [1, 2, 3, 4, 8]) {
      const withSeam = makeFixture();
      withSeam.millStock.block = slice;
      withSeam.rate.n = 0; // nothing is filling this shelf
      const noSeam = makeFixture();
      noSeam.millStock.block = slice;
      // …and a deps object that never heard of the seam (every suite that
      // builds its own): the optional member is simply absent.
      const stripped = { ...noSeam.deps } as ContributeDeps & { refineRateAt?: unknown };
      delete stripped.refineRateAt;
      expect(decideHead(withSeam)).toBe(
        decideContribution(noSeam.session, CID, stripped, { beatS: -Infinity })
          ? (noSeam.took()?.head ?? null)
          : null,
      );
    }
  });

  it("a producing shelf of a DIFFERENT head is not this link's business", () => {
    const f = makeFixture();
    f.rate.n = 0.333;
    // The seam answers per (endpoint, head); the wood link reads 0 whatever the
    // block bench is doing, which is why it can still be the rival above.
    expect(f.deps.refineRateAt?.(f.session, MILL_SHELF, "wood")).toBe(0);
    expect(f.deps.refineRateAt?.(f.session, CRATE, "block")).toBe(0);
  });
});

describe("④ a HALF LOAD OR MORE is a real trip", () => {
  it("is untouched at exactly half, and above it", () => {
    for (const slice of [4, 5, 8]) {
      const f = makeFixture();
      f.millStock.block = slice;
      f.rate.n = 0.333;
      f.rivalWeight.n = 3; // 720 s — a rival that beats every DAMPED reading
      expect(`${slice}:${decideHead(f)}`).toBe(`${slice}:${slice * UNIT_S > 720 ? "block" : "wood"}`);
    }
  });

  it("and the slice is still the BODY'S OWN CARRY — a 40-unit shelf is an 8-unit trip", () => {
    const f = makeFixture();
    f.millStock.block = 40;
    f.rate.n = 0.333;
    expect(decideHead(f)).toBe("block");
    expect(f.took()?.units).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ THE RATE — the REAL director on a real town play (the cadence harness).
// ═══════════════════════════════════════════════════════════════════════════

const BLOCK = refinedGlyphOf("wood")!; // "block.material_wood"
const MILL_AT = { x: 12, y: -3 };
/** The mill world's own per-unit rate: `REFINE_UNIT_BUILD_DAYS(0.05) ×
 *  REAL_HOUSE_BUILD_DAYS(180) / scale.construction(720)`. Written out because
 *  it is the number the closed form below divides by. */
const MILL_WORLD_DAYS_PER_UNIT = 0.0125;

function rateHarness() {
  const play = buildTownPlay({ seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 } as never);
  // A yard record with a stock map IS the deposit (`refineDepositId`'s own last
  // arm: this town plan has no storehouse), which is what the rate is keyed on.
  const containerRecords = new Map<string, ContainerRecord>([
    [TOWN_YARD_EP, { stock: {} } as ContainerRecord],
  ]);
  const session = {
    town: play,
    townClock: 0,
    taskClock: 0,
    scale: DOLLHOUSE_SCALE,
    containerRecords,
    wornBagIndex: new Map<string, string>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskPool: createTaskPool(),
    buildTaskOrds: new Map<string, number>(),
    npcTasks: new Map<string, unknown[]>(),
    needPoseShow: new Map<string, unknown>(),
    pursuits: new Map<string, unknown>(),
    party: new Set<string>(),
    escorting: new Set<string>(),
    creatures: null,
    addressedFamily: null,
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: () => {} },
    familyOf: () => null,
    avatarIdOf: (cid: string) => cid,
    buildingUnits: () => 0,
    npcChatBubble: () => {},
    gazeCreature: () => null,
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    containerAnchor: (_s: QuestSession, id: string) => (id === TOWN_YARD_EP ? { x: 0, y: 0 } : null),
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    issueTransferHaul: () => {},
    handIsFree: () => true,
    townHandPool: () => ({ total: 1, free: 1 }),
    bumpStockEpoch: () => {},
    bodyCarryOf: () => ({ inHand: null, worn: null }),
    takeUnitsFromBody: () => 0,
    stockEndpointOf: (_s: QuestSession, id: string): StockEndpoint | null => {
      const stock = containerRecords.get(id)?.stock;
      return stock ? { id, kind: "yard", at: { x: 0, y: 0 }, stack: stock, owner: null } : null;
    },
  } as unknown as ConstructionDirectorCtx;
  const director = createConstructionDirector(ctx);
  director.setWorld({
    state: { avatars: {}, objects: {}, spec: { objects: [] } },
    npcRadiusOf: () => 0.3,
    npcErrandActive: () => false,
    removeObject: () => {},
    setDragZones: () => {},
  } as never);
  /** A STAGED refine row at the mill-world per-unit rate. */
  const staged = (count = 12) => {
    const r = play.deltas.postRefineOrder({
      produces: BLOCK,
      count,
      costs: { wood: count * 2 },
      pile: { wood: count * 2 },
      at: MILL_AT,
      startedDay: 0,
      buildDays: MILL_WORLD_DAYS_PER_UNIT * count,
    });
    play.deltas.stageOrder(r.ord, 0);
    return r;
  };
  /** Put one body at this row's bench, the way a contribute pursuit does. */
  const stand = (ord: number) =>
    (session.pursuits as Map<string, unknown>).set("settler_0", {
      tplKey: CONTRIBUTE_TPL_KEY,
      bill: { siteId: `o:${ord}`, link: "refine", issuer: "player", spoken: false },
    });
  return { play, session, director, staged, stand };
}

describe("⑤ the producing rate is a CLOSED FORM over the refine row", () => {
  it("the deposit this town mills into is the yard — the premise the rate is keyed on", () => {
    const h = rateHarness();
    expect(h.director.clearingDepositId(h.session)).toBe(TOWN_YARD_EP);
  });

  it("one hand at the bench cuts 1/0.0125 of a build-day a second — ≈0.333 units a second", () => {
    const h = rateHarness();
    const r = h.staged();
    h.stand(r.ord);
    // (crew 1 / 240 s a day) / 0.0125 build-days a unit
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBeCloseTo(
      1 / DOLLHOUSE_SCALE.dayLengthS / MILL_WORLD_DAYS_PER_UNIT,
      6,
    );
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBeCloseTo(0.3333, 3);
  });

  it("an EMPTY bench falls back to the schedule arm — ×0.8, ≈0.267 units a second", () => {
    const h = rateHarness();
    h.staged();
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBeCloseTo(0.2667, 3);
  });

  it("scales with the WORLD, not with a constant — half the per-unit days is twice the rate", () => {
    const h = rateHarness();
    const r = h.staged();
    (r as { buildDays: number }).buildDays = (MILL_WORLD_DAYS_PER_UNIT / 2) * r.count;
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBeCloseTo(0.5333, 3);
  });

  it("answers ZERO for every shelf and every head that is not being filled", () => {
    const h = rateHarness();
    h.staged();
    expect(h.director.refineProductionUnitsPerS(h.session, "furn_9_chest_food", "block")).toBe(0);
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "wood")).toBe(0);
  });

  it("answers ZERO before the pile covers the bill — a GATHERING row is not producing", () => {
    const h = rateHarness();
    const r = h.play.deltas.postRefineOrder({
      produces: BLOCK,
      count: 12,
      costs: { wood: 24 },
      pile: {}, // nothing staged — `laborStartDay` never stamped
      at: MILL_AT,
      startedDay: 0,
      buildDays: MILL_WORLD_DAYS_PER_UNIT * 12,
    });
    expect(r.laborStartDay).toBeUndefined();
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBe(0);
  });

  it("answers ZERO once the labour is banked — a cold bench is not producing", () => {
    const h = rateHarness();
    const r = h.staged();
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBeGreaterThan(0);
    (r as { labor?: number }).labor = r.buildDays;
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBe(0);
  });

  it("answers ZERO once every unit is cut, whatever the books still say", () => {
    const h = rateHarness();
    const r = h.staged();
    (r as { minted?: number }).minted = r.count;
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBe(0);
  });

  it("SUMS two benches filling the same shelf — a rate is a rate", () => {
    const h = rateHarness();
    h.staged();
    h.staged();
    expect(h.director.refineProductionUnitsPerS(h.session, TOWN_YARD_EP, "block")).toBeCloseTo(
      2 * 0.2667,
      3,
    );
  });
});
