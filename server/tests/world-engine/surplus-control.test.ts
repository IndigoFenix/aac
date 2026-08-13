// SURPLUS CONTROL — the commons reserve (user addendum 2026-08-12, recorded in
// planning-docs/games/world-engine/growth-phase-c-founding-loops.md under
// "### Surplus-control patch"; memory feedback_order_scoping_and_growth_motive):
//
//   "For now, the current reservation system is fine — but the fact that there
//    aren't enough blocks to go around suggests that either the town isn't
//    stockpiling a surplus or that the town's own demands are exceeding its
//    capacity. This is probably patchable with a simple surplus control, with
//    the actual machinery going into the detailed supply and demand economics."
//
// THE PATCH, in one sentence: AUTOMATED bills draw only the stock ABOVE a
// reserve floor on the town's own shelf; SPOKEN orders may draw the reserve;
// ambient growth will not LAUNCH a bill the spare cannot feed. It is the G1/G2
// spare pattern at a third rung — a creature keeps at least one of anything and
// gives its surplus (`hasSurplus`), a town keeps its PAR and spends above it.
//
// 🚨 WHAT IT IS NOT, and every one of these has a case below: it is not a
// reordering (first-come reservations STAND — no preemption of an existing
// hold), not a refusal (a designation that CAN eventually be fed still posts
// and waits — pipeline ⑥), not a floor on every stack (a household box, a
// neighbour's crate and a standing tree are not the commons — the frontier must
// keep harvesting), and not a new number (the floor IS `STOREHOUSE_RAW_PAR`).
//
// No DOM / GL. The harness is `order-scoping.test.ts`'s, verbatim in shape.

import { describe, it, expect } from "@jest/globals";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  TOWN_YARD_EP,
  annexOptions,
  constructionStep,
  roomOrderCosts,
  PROSPERITY_THRESHOLD,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import { spareStock, createReservationLedger } from "@shared/world-engine/kernel/town/reservations.js";
import { houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import {
  FOUNDING_PROSPERITY_THRESHOLD,
  foundingGrowthStep,
} from "@shared/world-engine/kernel/town/zoning.js";
import {
  STOREHOUSE_RAW_PAR,
  commonsReserveOf,
  createConstructionDirector,
  storehouseRawParAt,
  type ConstructionDirectorCtx,
} from "@shared/world-engine/interaction/quest/construction-director.js";
import type { QuestSession } from "@shared/world-engine/interaction/quest/quest-host.js";
import type { TownWork } from "@shared/world-engine/kernel/town/plan.js";
import type { StructureSpec } from "@shared/world-engine/kernel/town/structures.js";
import { REAL_SCALE } from "@shared/world-engine/scale.js";

const CONFIG = { seed: 5, days: 30, questCount: 0, key: "smalltown", startPop: 20 };

const workRow = (type: string, dx: number, dy: number): TownWork =>
  ({ type, dx, dy, w: 10, h: 8, door: "north", color: "#888" });

const YARD_AT = { x: 12, y: -7 };

/** order-scoping.test.ts's stub harness — the two seams the refinement chain
 *  reads, plus a toast tape. */
function harness(
  works: TownWork[],
  boxes: Record<string, { at: { x: number; y: number }; stack: Record<string, number> }> = {},
) {
  const play = buildTownPlay(CONFIG);
  (play.plan as { works: TownWork[] }).works = works;
  const toasts: string[] = [];
  const anchors = new Map(Object.entries(boxes).map(([id, b]) => [id, b.at]));
  const session = {
    town: play,
    townClock: 0,
    scale: REAL_SCALE,
    containerRecords: new Map(
      Object.entries(boxes).map(([id, b]) => [
        id,
        { mount: "standing" as const, relation: "in" as const, stock: b.stack, owner: null },
      ]),
    ),
    wornBagIndex: new Map<string, string>(),
    marketStore: new Map<string, unknown>(),
    produceBox: new Map<string, unknown>(),
    houseShown: new Set<number>(),
    transfers: play.deltas.transfers,
    reservations: play.deltas.reservations,
    taskClock: 0,
  } as unknown as QuestSession;
  const ctx = {
    presenter: { toast: (m: string) => { toasts.push(m); } },
    familyOf: () => null,
    npcChatBubble: () => {},
    spawnLooseProp: () => null,
    removeLooseProp: () => {},
    postPooledTask: () => {},
    stockEndpointOf: () => null,
    containerAnchor: (_s: unknown, id: string) => anchors.get(id) ?? null,
    houseContainerKeys: () => [],
    playerWorldPos: () => null,
    playerFocusArea: () => null,
    townShortage: () => 0,
    invalidateTownJobs: () => {},
    questViewOf: () => null,
    spiritFocusOf: () => null,
    convoNodeId: () => null,
    handIsFree: () => true,
    townHandPool: () => ({ total: play.plan.houses.length, free: play.plan.houses.length }),
  } as unknown as ConstructionDirectorCtx;
  const addBox = (id: string, at: { x: number; y: number }, stack: Record<string, number> = {}) => {
    anchors.set(id, at);
    session.containerRecords.set(id, { mount: "standing", relation: "in", stock: stack, owner: null });
  };
  return { play, session, toasts, addBox, director: createConstructionDirector(ctx) };
}

/** A wood-milling town: one carpentry, and a yard holding `wood`. */
const woodTown = (wood: number) =>
  harness([workRow("workshop", -40, -40)], { [TOWN_YARD_EP]: { at: YARD_AT, stack: { wood } } });

describe("the reserve floor is DERIVED — it is the par, not a number", () => {
  it("a head has a reserve exactly when the par loop restocks it", () => {
    // The whole argument for STOREHOUSE_RAW_PAR being the honest floor: the
    // town already declares this to be what it wants on the shelf, and already
    // works to restore it. Nothing else needed a number invented for it.
    expect(commonsReserveOf("wood")).toBe(STOREHOUSE_RAW_PAR);
    expect(commonsReserveOf("stone")).toBe(STOREHOUSE_RAW_PAR);
    // A REFINED head has no par, so no reserve — its raws carry the floor and
    // the chain passes it upward (a mill may only eat spare wood).
    expect(commonsReserveOf("block")).toBe(0);
    // …and neither does anything that is not a construction raw at all.
    expect(commonsReserveOf("apple")).toBe(0);
    // Facted variants pay their head, the spendCosts convention.
    expect(commonsReserveOf("wood.wet")).toBe(STOREHOUSE_RAW_PAR);
  });

  it("spareStock takes the floor out of a COPY — free ⊇ spare, the input untouched", () => {
    const stock = { wood: 20, apple: 3 };
    const spare = spareStock(stock, commonsReserveOf);
    expect(spare).toEqual({ wood: 20 - STOREHOUSE_RAW_PAR, apple: 3 });
    expect(stock).toEqual({ wood: 20, apple: 3 }); // never mutated
    // A shelf already under par reads EMPTY, never negative — the same floor
    // discipline `freeUnits`/`unreservedStock` keep.
    expect(spareStock({ wood: 4 }, commonsReserveOf).wood ?? 0).toBe(0);
  });
});

describe("S1 — an AUTOMATED bill draws SPARE, a SPOKEN one may draw the reserve", () => {
  it("🚨 THE ACCEPTANCE, in miniature: the town's mill leaves the family its wood", () => {
    // 20 wood on the shelf. The town's own appetite is 20 blocks (40 wood) —
    // far more than the shelf holds — and the shipped code would have posted
    // the whole thing and reserved every stick behind it.
    const { play, session, director } = woodTown(20);
    director.ensureRefineOrders(session, { block: 20 }); // automated, town book
    const townRow = play.deltas.refineOrders()[0]!;
    // SIZED TO THE SPARE: (20 − 12) wood ÷ 2 per block = 4 blocks, 8 wood.
    expect(townRow.count).toBe(4);
    expect(townRow.costs).toEqual({ wood: 8 });
    expect(townRow.spoken).toBeUndefined(); // ambient rows write no key

    // …and the reserve is exactly what the family's spoken order now finds.
    const hi = play.plan.houses[0]!.index;
    const spoken = director.ensureRefineOrders(
      session, { block: 4 }, undefined, `house:${hi}`, true,
    );
    expect(spoken).toEqual({ milling: 4, rest: {} });
    const mine = play.deltas.refineOrders().find((r) => r.scope === `house:${hi}`)!;
    expect(mine.count).toBe(4);        // the FULL family bill, not a capped one
    expect(mine.costs).toEqual({ wood: 8 });
    expect(mine.spoken).toBe(true);    // …and it inherits the standing that bought it
  });

  it("a spare of zero posts NOTHING, and says `milling`, not `there is none to fetch`", () => {
    // Below par the town mills nothing of its own — but the bill is KNOWN and
    // the chain IS still the answer, so the caller is told it is milling rather
    // than told the world is empty (which would be a lie over a stocked shelf).
    const { play, session, director } = woodTown(STOREHOUSE_RAW_PAR);
    expect(director.ensureRefineOrders(session, { block: 6 })).toEqual({ milling: 6, rest: {} });
    expect(play.deltas.refineOrders()).toHaveLength(0);
  });

  it("the same shelf, SPOKEN: the reserve is drawable and the order posts in full", () => {
    const { play, session, director } = woodTown(STOREHOUSE_RAW_PAR);
    expect(
      director.ensureRefineOrders(session, { block: 6 }, undefined, "town", true),
    ).toEqual({ milling: 6, rest: {} });
    expect(play.deltas.refineOrders()[0]!.count).toBe(6); // ⑥ — a designation never refuses
  });

  it("🚨 THE FLOOR IS THE COMMONS', NOT EVERY STACK'S — the frontier keeps harvesting", () => {
    // A stand of trees and a neighbour's crate are not the town's shelf. If the
    // floor rode every source, an automated site would stop felling oaks the
    // moment 12 wood was left standing, which is the harvest chain the
    // order-scoping round had just proved (hx-frontier-farm: 52 loads).
    const { play, session, addBox, director } = harness([workRow("workshop", -40, -40)]);
    addBox("wild:oak_3", { x: 20, y: 20 }, { wood: 20 });
    // No yard at all — every stick is off-commons, so nothing is held back.
    expect(director.ensureRefineOrders(session, { block: 10 })).toEqual({ milling: 10, rest: {} });
    expect(play.deltas.refineOrders()[0]!.count).toBe(10);
    expect(play.deltas.refineOrders()[0]!.costs).toEqual({ wood: 20 });
  });

  it("first-come reservations STAND — the floor never releases another holder's units", () => {
    // The user's ruling, pinned: no reordering, no preemption. The reserve is a
    // cap on the NEXT draw and nothing else, so a hold placed before it is
    // still there afterwards, at its full size.
    const { play, session, director } = woodTown(40);
    session.reservations.reserve("someone:else", TOWN_YARD_EP, "wood", 30);
    director.ensureRefineOrders(session, { block: 20 });
    expect(session.reservations.reservedUnits(TOWN_YARD_EP, "wood")).toBe(30);
    // Free = 10, spare = 0 → the town mills nothing rather than jumping the
    // queue. (CONTESTED is not dead: the bill still reads as milling.)
    expect(play.deltas.refineOrders()).toHaveLength(0);
  });
});

describe("S2 — ambient growth may not LAUNCH a bill that would exhaust the commons", () => {
  /** A one-structure catalog whose bill is exactly `blocks` blocks (an
   *  authored block cost short-circuits `structureCosts`' geometry pricing —
   *  the bill under test is the number written here). A HOUSE role, because a
   *  producerless work row is not admitted on open ground at all (`consider`),
   *  and crowding 1.0 clears OPEN_GROWTH_MIN without turning URGENT. */
  const catalogOf = (blocks: number): StructureSpec[] => [
    {
      type: "shed", label: "shed", glyph: "building", color: "#777",
      w: 4, h: 4, buildDays: 1, costs: { block: blocks },
      role: "house",
    } as unknown as StructureSpec,
  ];

  const growth = (deltas: TownDeltas, catalog: StructureSpec[], reserve?: (h: string) => number) =>
    foundingGrowthStep({
      deltas,
      catalog,
      gain: 0, // the bank is pre-filled by `stocked()` — the CLOCK is not the pin
      day: 1,
      pipeline: true,
      signals: { crowding: 1, shortage: () => 0 },
      economyOf: () => null,
      capValueOf: () => 99,
      countOf: () => 0,
      candidatesFor: () => [
        { type: "shed", dx: 0, dy: 0, w: 4, h: 4, door: "north", slot: 1 } as never,
      ],
      ...(reserve ? { reserve } : {}),
    });

  it("the yard's SPARE is the growth gate; without the reserve input nothing changed", () => {
    // 20 wood ⇒ 10 blocks of refinable credit, but only 4 above the floor.
    const stocked = () => {
      const play = buildTownPlay(CONFIG);
      for (const g of Object.keys(play.deltas.stock)) delete play.deltas.stock[g];
      Object.assign(play.deltas.stock, { wood: 20 });
      // The BANK is not what this pins — hand it a full threshold so the only
      // thing left to decide is the materials.
      play.deltas.civic.prosperity = FOUNDING_PROSPERITY_THRESHOLD;
      return play.deltas;
    };
    // BEFORE (no reserve supplied — every worldgen/twin caller, every fixture):
    // a 10-block shed is affordable, exactly as it shipped.
    expect(growth(stocked(), catalogOf(10))).not.toBeNull();
    // AFTER (the live town's gate): the same shed is not started, because
    // starting it would eat the shelf the spoken orders draw from.
    expect(growth(stocked(), catalogOf(10), commonsReserveOf)).toBeNull();
    // …and growth is not STOPPED, only made to wait for a surplus: a bill the
    // spare covers founds as it always did.
    expect(growth(stocked(), catalogOf(4), commonsReserveOf)).not.toBeNull();
  });

  it("the ambient ANNEX asks BEFORE it spends — a poor day costs the household nothing", () => {
    const play = buildTownPlay(CONFIG);
    const hi = play.plan.houses[0]!.index;
    const key = `h_${hi}`;
    const bank = () =>
      play.deltas.mutate(key, (d) => { d.prosperity = PROSPERITY_THRESHOLD + 1; });
    const prosperityOf = () => play.deltas.get(key)?.prosperity ?? 0;

    // REFUSED BY THE GATE: no request, and the threshold is still banked — the
    // shipped path spent it and staked a plot nothing could stock.
    bank();
    const before = prosperityOf();
    const none = constructionStep(
      play.stage.center, play.plan, play.deltas, () => [], 1, [],
      { canAfford: () => false },
    );
    expect(none).toHaveLength(0);
    expect(prosperityOf()).toBe(before);

    // …and with no gate at all (every pre-patch caller) the same day builds.
    const built = constructionStep(play.stage.center, play.plan, play.deltas, () => [], 1);
    expect(built.length).toBeGreaterThan(0);
    expect(prosperityOf()).toBeLessThan(before);
  });

  it("annexWithinSpare reads the yard through the same lens the founding gate does", () => {
    const { play, session, director } = harness([]);
    // A real candidate off the enumeration, so the bill under test is the one
    // a growth day would actually order (never a literal invented here).
    const house = play.plan.houses[0]!;
    const candidate = annexOptions(
      play.stage.center,
      house,
      houseRoomPlan(play.stage.center, house),
      [],
      undefined,
      "sleep",
    )[0]!;
    expect(candidate).toBeDefined();
    const bill = roomOrderCosts(candidate);
    expect(Object.keys(bill)).toContain("block");

    // A shelf holding NOTHING BUT the reserve ⇒ no room may be launched…
    for (const g of Object.keys(play.deltas.stock)) delete play.deltas.stock[g];
    Object.assign(play.deltas.stock, { wood: STOREHOUSE_RAW_PAR });
    expect(director.annexWithinSpare(session, candidate)).toBe(false);
    // …and a genuinely stocked one opens the gate again (the chain counts:
    // the bill is in blocks and the spare is in wood).
    Object.assign(play.deltas.stock, { wood: STOREHOUSE_RAW_PAR + bill.block! * 2 });
    expect(director.annexWithinSpare(session, candidate)).toBe(true);
  });
});

describe("S3 — a loose prop is STOCK for the availability question", () => {
  it("wood on the ground makes a bill SLOW, never DEAD (the refusal stops lying)", () => {
    // The order-scoping round's handoff item 4: the barren refusal said "there
    // is none to fetch" with a `wood-1` prop lying in view. The pipeline was
    // right (a prop is not a haul source) and the SENTENCE was wrong.
    const { play, session, director } = harness([workRow("workshop", -40, -40)]);
    const at = play.stage.center;
    const spec = { costs: { block: 40 } };
    const missing = director.buildMissingMaterials(session, spec, at);
    expect(missing).toEqual({ block: 40 });
    const sources = director.siteMaterialSources(session, at);
    // Nothing in any container ⇒ DEAD, and the refusal fires. (Unchanged.)
    expect(director.deadBillHeads(session, missing, sources)).toEqual({ block: 40 });

    // Now put one stick of wood on the floor, as the barren world had.
    const objects: Record<string, unknown> = { "small:wood-1": { x: at.x, y: at.y } };
    director.setWorld({ state: { objects } } as never);
    session.containerRecords.set("small:wood-1", { mount: "loose", glyph: "wood" });
    // …and the same bill is SHORT: a mill away, exactly like a stick in a crate.
    expect(director.deadBillHeads(session, missing, sources)).toEqual({});

    // 🚫 …but STILL NOT A HAUL SOURCE (the recorded remainder): the source walk
    // is unchanged, because drawing from a prop needs a take that DELETES the
    // world object or the unit exists twice (the item-conservation law).
    expect(director.siteMaterialSources(session, at).map((s) => s.id))
      .not.toContain("small:wood-1");
  });

  it("a prop in somebody's hands or already in a box is not lying about", () => {
    const { play, session, director } = harness([workRow("workshop", -40, -40)]);
    const at = play.stage.center;
    director.setWorld({
      state: { objects: { "small:wood-1": { x: at.x, y: at.y, carriedBy: "resident_0_0" } } },
    } as never);
    session.containerRecords.set("small:wood-1", { mount: "loose", glyph: "wood" });
    expect(
      director.deadBillHeads(session, { block: 40 }, director.siteMaterialSources(session, at)),
    ).toEqual({ block: 40 });
  });
});

describe("S&D S3 — the par≡reserve coupling rides the resource-conversion dial", () => {
  it("dial 1 is byte-identical to the pre-S3 constant", () => {
    expect(storehouseRawParAt()).toBe(STOREHOUSE_RAW_PAR);
    expect(storehouseRawParAt(1)).toBe(STOREHOUSE_RAW_PAR);
    expect(commonsReserveOf("wood")).toBe(STOREHOUSE_RAW_PAR);
    expect(commonsReserveOf("wood", 1)).toBe(STOREHOUSE_RAW_PAR);
  });

  it("THE COUPLING: moving the par with the dial moves the reserve floor by construction", () => {
    // Bills ÷ dial — a world whose buildings need less raw material per
    // block also needs a smaller shelf buffer. Both read the SAME function.
    expect(storehouseRawParAt(2)).toBe(6);
    expect(commonsReserveOf("wood", 2)).toBe(6);
    expect(commonsReserveOf("stone", 2)).toBe(6);
    // Floored at 1 — the par may shrink, never vanish (an ambient gather
    // that never fires at all would be a silent behavior change, not a
    // compression).
    expect(storehouseRawParAt(1000)).toBe(1);
    // Below 1 is legal too (a WORLD that wants scarcer conversion) — the
    // par GROWS, same direction as every other bill.
    expect(storehouseRawParAt(0.5)).toBe(24);
  });

  it("a refined head still has no par, at any dial (unchanged)", () => {
    expect(commonsReserveOf("block", 2)).toBe(0);
    expect(commonsReserveOf("apple", 2)).toBe(0);
  });
});

/** The ledger helper the reserve composes with, asserted once so the two
 *  subtractions can never be confused for one another. */
describe("free and spare are different subtractions", () => {
  it("free removes what OTHERS spoke for; spare removes what the town keeps back", () => {
    const led = createReservationLedger();
    led.reserve("other", TOWN_YARD_EP, "wood", 5);
    // free = 30 − 5 = 25 (a fact about other orders)…
    expect(30 - led.reservedUnits(TOWN_YARD_EP, "wood")).toBe(25);
    // …spare = free − 12 = 13 (a policy about this one). Composed, never merged.
    expect(spareStock({ wood: 25 }, commonsReserveOf).wood).toBe(25 - STOREHOUSE_RAW_PAR);
  });
});
