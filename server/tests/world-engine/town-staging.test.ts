// MATERIAL STAGING (construction pipeline ②), at the pure layer — a build
// order is a DESIGNATION: costs ride the FoundedBuilding row, materials
// arrive into its site pile, and the labor clock runs from the STAGED day
// (never from the order). Legacy rows (no costs) keep the pre-pipeline
// clock byte-identically. Growth's collapsed twin still pays at order —
// but only from FREE yard stock: what a pending haul has spoken for is
// invisible to it. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  bankLabor,
  createTownDeltas,
  foundedBuildingDone,
  foundingOptions,
  pendingLaborDone,
  requestAnnex,
  stagingMissing,
  TOWN_YARD_EP,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  candidateInZone,
  categoriesOfSpec,
  foundingGrowthStep,
  FOUNDING_PROSPERITY_DAILY_CAP,
  FOUNDING_PROSPERITY_THRESHOLD,
  slotZoningFn,
  type FoundingGrowthInput,
} from "@shared/world-engine/kernel/town/zoning.js";
import { resolveStructure, structureCosts } from "@shared/world-engine/kernel/town/structures.js";
import { BLOCK_GLYPH } from "@shared/world-engine/products.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { putStock } from "@shared/world-engine/kernel/town/transfer.js";

const SEED = 21;
const KEY = "millbrook";
const HOUSE = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
/** The house's RESOLVED bill (phase 6 — derived from its footprint, not
 *  authored on the row). Every assertion below reads this rather than
 *  `HOUSE.costs`, which now carries only a structure's extras. */
const HOUSE_COSTS = structureCosts(HOUSE);
const HOUSE_BLOCKS = HOUSE_COSTS[BLOCK_GLYPH]!;

function lot(occupied: Array<{ x: number; y: number; w: number; h: number }> = []) {
  return foundingOptions({
    seed: SEED, key: KEY, footprint: HOUSE.footprint, type: HOUSE.type,
    occupied, claimedSlots: new Set(),
  })[0]!;
}

/** A crowded town that wants a house urgently — materials are the only gate.
 *  Shared by the F1 seam pin and the collapsed-twin suite below, so both
 *  describe the SAME founding through the same input. */
function makeGrowthInput(
  deltas: ReturnType<typeof createTownDeltas>,
  day: number,
): FoundingGrowthInput {
  const districtOf = () => null;
  return {
    deltas,
    catalog: TOWN_PLAY_STRUCTURES,
    gain: 99, // the daily cap holds accrual honest
    day,
    signals: { crowding: 2, shortage: () => 0 },
    economyOf: () => null,
    capValueOf: () => 200,
    countOf: () => 0,
    candidatesFor: (spec, zone) => {
      const cands = foundingOptions({
        seed: SEED, key: KEY, footprint: spec.footprint, type: spec.type,
        occupied: deltas.founded().map((b) => ({ x: b.dx, y: b.dy, w: b.w, h: b.h })),
        claimedSlots: new Set(deltas.founded().map((b) => b.slot)),
        zoning: slotZoningFn(deltas.zones(), categoriesOfSpec(spec, districtOf)),
      });
      return zone === null ? cands : cands.filter((c) => candidateInZone(deltas.zones(), zone, c));
    },
  };
}

describe("the staged labor clock (FoundedBuilding.costs / pile / laborStartDay)", () => {
  it("a designation records its costs with an empty pile and NEVER completes unstaged", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(lot(), 0, 2, HOUSE_COSTS);
    expect(b.costs).toEqual(HOUSE_COSTS);
    expect(b.pile).toEqual({});
    expect(b.laborStartDay).toBeUndefined();
    // The waiting staked plot is honest: no materials, no walls — ever.
    expect(foundedBuildingDone(b, 1_000_000)).toBe(false);
    expect(stagingMissing(b)).toEqual(HOUSE_COSTS);
  });

  it("the pile fills (facted variants pay their head), staging stamps, BUILDERS work it off", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(lot(), 0, 2, { wood: 3 });
    putStock({ stack: b.pile! }, { "wood.wet": 1 });
    expect(stagingMissing(b)).toEqual({ wood: 2 });
    putStock({ stack: b.pile! }, { wood: 2 });
    expect(stagingMissing(b)).toEqual({});
    deltas.stageFounded(b.ord, 5);
    expect(b.laborStartDay).toBe(5);
    // ⑥ BUILDERS MAKE BUILDINGS: a staged site with nobody at it never
    // completes — the clock may run forever, no one worked it.
    expect(foundedBuildingDone(b, 1_000_000)).toBe(false);
    // Banked labor is what raises it (the sweep credits builders-present
    // × elapsed; more builders bank faster).
    bankLabor(b, 1.9);
    expect(foundedBuildingDone(b, 7)).toBe(false);
    bankLabor(b, 0.11);
    expect(foundedBuildingDone(b, 7)).toBe(true);
    // Idempotent — a re-stamp never moves the staging day.
    deltas.stageFounded(b.ord, 9);
    expect(b.laborStartDay).toBe(5);
  });

  it("a LEGACY row (no costs — growth's collapsed twin) keeps the pre-pipeline clock", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(lot(), 3, 2);
    expect(b.costs).toBeUndefined();
    expect(foundedBuildingDone(b, 4.9)).toBe(false);
    expect(foundedBuildingDone(b, 5.01)).toBe(true);
  });

  it("completion consumes the pile — the materials ARE the building", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(lot(), 0, 1, { wood: 1 });
    putStock({ stack: b.pile! }, { wood: 1 });
    deltas.stageFounded(b.ord, 0);
    deltas.completeFounding(b.ord);
    expect(b.pile).toBeUndefined();
    expect(b.completed).toBe(true);
  });

  it("costs, pile, laborStartDay and BANKED LABOR ride the toJSON round-trip", () => {
    const deltas = createTownDeltas();
    const b = deltas.foundBuilding(lot(), 0, 2, { wood: 3, stone: 1 });
    putStock({ stack: b.pile! }, { wood: 2 });
    deltas.stageFounded(b.ord, 0);
    bankLabor(b, 0.75); // half-built walls survive a reload
    const reloaded = createTownDeltas(deltas.toJSON());
    const rb = reloaded.founded()[0]!;
    expect(rb.costs).toEqual({ wood: 3, stone: 1 });
    expect(rb.pile).toEqual({ wood: 2 });
    expect(rb.laborStartDay).toBe(0);
    expect(rb.labor).toBe(0.75);
    expect(stagingMissing(rb)).toEqual({ wood: 1, stone: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 🚨 THE BILL THE **CALLERS** WRITE (GL fix round — F1)
//
// Every assertion above hands `foundBuilding` a bill this file resolved for
// it, which is precisely the shape of the bug it could not see: since the
// phase-6 split a catalog row's `costs` is the EXTRAS map — `{}` for every
// shipped structure — and the blocks live only in `structureCosts`. Three
// callers passed the raw map (`executeBuildOrder`, the affordability probe,
// this pipeline founding), so a player-ordered building was founded with an
// EMPTY bill: `stagingMissing` answered {}, the plot staged the same tick, no
// haul was ever posted and the walls rose out of nothing.
//
// MEASURED: the frontier farm finished in 60 sim-s with the yard's 14 wood and
// 6 stone untouched (dx-frontier-farm, 2026-08-11); after the fix the same run
// stakes out, demands 272 block, mills, and hauls (fx-frontier-farm).
//
// The pin is the SEAM, not the resolver: what the row ENDS UP with must be
// what the resolver would say — a test that resolves the costs itself and
// hands them in can never catch a caller that doesn't.
// ─────────────────────────────────────────────────────────────────────────
describe("a founded row's bill is the RESOLVER's, never the row's extras map", () => {
  it("the trap is real: a catalog row authors no blocks of its own", () => {
    // If this ever stops being true the pin below stops being a pin — the two
    // maps would agree by accident and the seam would go untested again.
    expect(HOUSE.costs[BLOCK_GLYPH]).toBeUndefined();
    expect(HOUSE_BLOCKS).toBeGreaterThan(0);
  });

  it("PIPELINE founding writes structureCosts(spec) — the designation the affordability check admitted", () => {
    const deltas = createTownDeltas();
    // Enough free wood for the twin's 2:1 mill to cover the real bill.
    deltas.stock.wood = HOUSE_BLOCKS * 2 + 10;
    deltas.stock.stone = 40;
    const input: FoundingGrowthInput = { ...makeGrowthInput(deltas, 1), pipeline: true };
    const order = foundingGrowthStep(input);
    expect(order).not.toBeNull();
    const b = order!.building;
    // THE ROW CARRIES THE RESOLVED BILL…
    expect(b.costs).toEqual(structureCosts(order!.spec));
    expect(b.costs![BLOCK_GLYPH]).toBeGreaterThan(0);
    // …NOT the extras map, which would have been {} and staged instantly.
    expect(b.costs).not.toEqual(order!.spec.costs);
    expect(Object.keys(stagingMissing(b)).length).toBeGreaterThan(0);
    expect(b.laborStartDay).toBeUndefined(); // nothing staged, nothing paid
    expect(foundedBuildingDone(b, 1_000_000)).toBe(false);
    // A PIPELINE designation still pays nothing up front — the hauls do.
    expect(deltas.stock.wood).toBe(HOUSE_BLOCKS * 2 + 10);
  });
});

describe("pending annexes (pipeline ⑤ — annex staging)", () => {
  const CANDIDATE = {
    side: "rear" as const,
    cluster: "sleep" as const,
    u0: 0, u1: 3.2, v0: 6, v1: 9,
    doorInto: "r0",
    doorAt: { u: 1.6, v: 6, width: 0.9 },
  };

  it("a posted designation gathers into its pile, stages, and commits via requestAnnex", () => {
    const deltas = createTownDeltas();
    const p = deltas.postAnnexSite({
      buildingKey: "h_2",
      cluster: "sleep",
      candidate: CANDIDATE,
      costs: { wood: 2 },
      pile: {},
      startedDay: 1,
      buildDays: 0.125,
    });
    expect(p.ord).toBe(0);
    expect(stagingMissing(p)).toEqual({ wood: 2 });
    // Materials arrive (facted pays its head, same law as buildings).
    putStock({ stack: p.pile }, { "wood.wet": 2 });
    expect(stagingMissing(p)).toEqual({});
    deltas.stageAnnexSite(p.ord, 2);
    expect(p.laborStartDay).toBe(2);
    deltas.stageAnnexSite(p.ord, 9); // idempotent
    expect(p.laborStartDay).toBe(2);
    // ⑥ BUILDERS MAKE BUILDINGS: staged but unworked is never done —
    // banked labor is what raises the room.
    expect(pendingLaborDone(p)).toBe(false);
    bankLabor(p, p.buildDays);
    expect(pendingLaborDone(p)).toBe(true);
    // COMMIT — the exact candidate becomes the annex row, the pending
    // row is dropped.
    expect(requestAnnex(deltas, p.buildingKey, p.candidate).ok).toBe(true);
    deltas.removeAnnexSite(p.ord);
    expect(deltas.annexSites()).toHaveLength(0);
    expect(deltas.get("h_2")!.annexes).toHaveLength(1);
    expect(deltas.get("h_2")!.annexes[0]).toMatchObject({ ord: 0, cluster: "sleep" });
  });

  it("rides the toJSON round-trip mid-gather (pile, clock, ordinals)", () => {
    const deltas = createTownDeltas();
    const p = deltas.postAnnexSite({
      buildingKey: "h_0", cluster: "kitchen", candidate: { ...CANDIDATE, cluster: "kitchen" },
      costs: { wood: 2 }, pile: { wood: 1 }, startedDay: 3, buildDays: 0.125,
    });
    deltas.postAnnexSite({
      buildingKey: "h_1", cluster: "store", candidate: { ...CANDIDATE, cluster: "store" },
      costs: { wood: 2 }, pile: {}, startedDay: 3, buildDays: 0.125,
    });
    const back = createTownDeltas(deltas.toJSON());
    expect(back.annexSites()).toHaveLength(2);
    expect(back.annexSites()[0]).toEqual(p);
    expect(stagingMissing(back.annexSites()[0]!)).toEqual({ wood: 1 });
    // Ordinals stay monotone across the reload.
    const fresh = back.postAnnexSite({
      buildingKey: "h_9", cluster: "sleep", candidate: CANDIDATE,
      costs: { wood: 2 }, pile: {}, startedDay: 4, buildDays: 0.125,
    });
    expect(fresh.ord).toBe(2);
  });
});

describe("growth's collapsed twin spends only FREE yard stock", () => {
  const makeInput = makeGrowthInput;

  it("reserved wood halts growth; releasing it restarts growth; the spend never eats reserved units", () => {
    // Phase 3: the bill is BLOCKS; a wood-only yard pays through the
    // twin's implicit mill at 2:1 — one house = costs.block × 2 wood.
    const houseWood = HOUSE_BLOCKS * 2;
    expect(houseWood).toBeGreaterThan(0);
    const deltas = createTownDeltas();
    // Exactly one house's wood in the yard — and every unit spoken for.
    deltas.stock.wood = houseWood;
    deltas.reservations.reserve("agr_x", TOWN_YARD_EP, "wood", houseWood);
    expect(foundingGrowthStep(makeInput(deltas, 1))).toBeNull(); // free stock is 0
    expect(deltas.founded()).toHaveLength(0);
    expect(deltas.stock.wood).toBe(houseWood); // nothing spent
    // One more unit than is reserved still can't cover the bill…
    deltas.stock.wood = houseWood + 1;
    expect(foundingGrowthStep(makeInput(deltas, 2))).toBeNull();
    // …but a released reservation frees the yard and growth builds.
    deltas.reservations.release("agr_x");
    const order = foundingGrowthStep(makeInput(deltas, 3));
    expect(order).not.toBeNull();
    expect(order!.spec.role).toBe("house");
    expect(deltas.stock.wood ?? 0).toBe(houseWood + 1 - houseWood);
    // The collapsed twin stays a LEGACY row: paid at order, clock from today.
    const b = deltas.founded()[0]!;
    expect(b.costs).toBeUndefined();
    expect(foundedBuildingDone(b, 3 + b.buildDays + 0.01)).toBe(true);
  });

  it("a reservation smaller than the surplus leaves growth untouched (free covers the bill)", () => {
    // Phase 3: the bill is BLOCKS; a wood-only yard pays through the
    // twin's implicit mill at 2:1 — one house = costs.block × 2 wood.
    const houseWood = HOUSE_BLOCKS * 2;
    const deltas = createTownDeltas();
    deltas.stock.wood = houseWood + 2;
    deltas.stock.stone = 20; // cover any stone in richer catalogs
    deltas.reservations.reserve("agr_x", TOWN_YARD_EP, "wood", 2);
    const order = foundingGrowthStep(makeInput(deltas, 1));
    expect(order).not.toBeNull();
    // The reserved 2 survive the spend untouched.
    expect(deltas.stock.wood ?? 0).toBeGreaterThanOrEqual(2);
    expect(deltas.reservations.reservedUnits(TOWN_YARD_EP, "wood")).toBe(2);
  });

  it("banked (non-urgent) growth respects reservations identically", () => {
    // Phase 3: the bill is BLOCKS; a wood-only yard pays through the
    // twin's implicit mill at 2:1 — one house = costs.block × 2 wood.
    const houseWood = HOUSE_BLOCKS * 2;
    const deltas = createTownDeltas();
    deltas.stock.wood = houseWood;
    deltas.reservations.reserve("agr_x", TOWN_YARD_EP, "wood", houseWood);
    const days = Math.ceil(FOUNDING_PROSPERITY_THRESHOLD / FOUNDING_PROSPERITY_DAILY_CAP) + 2;
    for (let d = 1; d <= days; d++) {
      const input = makeInput(deltas, d);
      input.signals = { crowding: 2, shortage: () => 0 };
      expect(foundingGrowthStep(input)).toBeNull();
    }
    expect(deltas.founded()).toHaveLength(0);
  });
});
