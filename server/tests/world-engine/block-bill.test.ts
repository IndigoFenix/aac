// WHAT A BUILDING COSTS (construction phase 6 — block-bill.ts). A house cost
// three blocks, which is a thing you could carry in two trips; bills are now
// DERIVED from geometry — one bay of floor, roof and wall at a time — so a
// structure's material follows its size and no catalog row needs a guessed
// number. These tests pin the arithmetic, the one resolver every affordability
// question goes through, and the invariants that keep build/demolish honest.
// No DOM/GL.

import { describe, it, expect } from "@jest/globals";
import {
  BLOCKS_PER_BAY,
  BLOCK_SIZE_M,
  BUILD_BAY_M,
  annexBill,
  baysAcross,
  blockCosts,
  furnitureBlocks,
  partitionBill,
  shellBill,
} from "@shared/world-engine/kernel/town/block-bill.js";
import {
  costsMet,
  resolveStructure,
  structureCosts,
} from "@shared/world-engine/kernel/town/structures.js";
import {
  MIN_ROOM_COSTS,
  annexCosts,
  baseRoomCosts,
  interiorCosts,
  roomOrderCosts,
  type AnnexCandidate,
  type InteriorCandidate,
} from "@shared/world-engine/kernel/town/construction.js";
import { TOWN_PLAY_STRUCTURES } from "@shared/world-engine/interaction/town/town-play.js";
import { FURNITURE_ITEMS } from "@shared/world-engine/kernel/town/stations.js";
import { BLOCK_GLYPH, naturalSourceOf } from "@shared/world-engine/products.js";

describe("the bay — the unit a bill is counted in", () => {
  it("spans a run, never rounds a real wall down to nothing", () => {
    expect(baysAcross(BUILD_BAY_M)).toBe(1);
    expect(baysAcross(BUILD_BAY_M * 2)).toBe(2);
    expect(baysAcross(BUILD_BAY_M * 2 + 0.1)).toBe(3);
    // A wall shorter than a bay is still a wall.
    expect(baysAcross(0.4)).toBe(1);
    expect(baysAcross(0)).toBe(1);
  });

  it("does not buy an extra bay off float noise", () => {
    // 9 / 3 must be 3 bays, not 4, however the division lands.
    expect(baysAcross(9)).toBe(3);
    expect(baysAcross(BUILD_BAY_M * 5)).toBe(5);
  });
});

describe("shellBill — a whole building from its footprint", () => {
  it("tiles floor and roof, and rings the perimeter with wall bays", () => {
    const b = shellBill({ w: 9, h: 8 }); // 3 × 3 bays
    expect(b.floorBays).toBe(9);
    expect(b.roofBays).toBe(9);
    expect(b.wallBays).toBe(2 * (3 + 3));
    expect(b.floor).toBe(9 * BLOCKS_PER_BAY.floor);
    expect(b.roof).toBe(9 * BLOCKS_PER_BAY.roof);
    expect(b.wall).toBe(12 * BLOCKS_PER_BAY.wall);
    expect(b.total).toBe(b.floor + b.roof + b.wall);
  });

  it("a bigger footprint always costs more — the whole point of deriving it", () => {
    const small = shellBill({ w: 9, h: 8 });
    const big = shellBill({ w: 18, h: 12 });
    expect(big.total).toBeGreaterThan(small.total);
  });

  it("a second storey adds a floor and walls, but never a second roof", () => {
    const one = shellBill({ w: 9, h: 8 }, 1);
    const two = shellBill({ w: 9, h: 8 }, 2);
    expect(two.roof).toBe(one.roof);
    expect(two.floor).toBe(one.floor * 2);
    expect(two.wall).toBe(one.wall * 2);
  });

  it("a house is a real undertaking now, not three blocks", () => {
    // The complaint this phase answers, as an assertion: whatever the knobs
    // are tuned to, a dwelling must never again be carryable in a trip.
    const house = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
    expect(structureCosts(house)[BLOCK_GLYPH]).toBeGreaterThan(50);
  });
});

describe("structureCosts — the one resolver", () => {
  it("derives the block bill from the footprint and passes extras through", () => {
    const spec = { costs: { iron: 2 }, footprint: { w: 9, d: 8 } };
    const costs = structureCosts(spec);
    expect(costs.iron).toBe(2);
    expect(costs[BLOCK_GLYPH]).toBe(shellBill({ w: 9, h: 8 }).total);
  });

  it("an authored block count OVERRIDES the derivation (the world-doc hatch)", () => {
    const spec = { costs: { [BLOCK_GLYPH]: 2 }, footprint: { w: 40, d: 40 } };
    expect(structureCosts(spec)[BLOCK_GLYPH]).toBe(2);
  });

  it("a bare costs map with no footprint is taken as given", () => {
    // An annex bill, a partition bill, a test literal — these are already
    // resolved and must not be billed a second time for geometry they lack.
    expect(structureCosts({ costs: { [BLOCK_GLYPH]: 7 } })).toEqual({ [BLOCK_GLYPH]: 7 });
    expect(structureCosts({ costs: {} })).toEqual({});
  });

  it("costsMet on a REAL catalog row prices the geometry, never the extras alone", () => {
    // The reason the resolver keys on the footprint's presence: passing a full
    // spec to an affordability check must never quote it as free.
    const house = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
    expect(house.costs[BLOCK_GLYPH]).toBeUndefined();
    expect(costsMet(house, { [BLOCK_GLYPH]: 1 })).toBe(false);
    expect(costsMet(house, { [BLOCK_GLYPH]: structureCosts(house)[BLOCK_GLYPH]! })).toBe(true);
  });

  it("every default catalog row derives a bill", () => {
    for (const spec of TOWN_PLAY_STRUCTURES) {
      expect(structureCosts(spec)[BLOCK_GLYPH]).toBeGreaterThan(0);
    }
  });
});

describe("rooms — an annex, a partition, and what each gives back", () => {
  const rear: AnnexCandidate = {
    side: "rear", cluster: "sleep", u0: 0, u1: 6, v0: 8, v1: 11.5,
    doorInto: "h_0", doorAt: { u: 3, v: 8, width: 1.8 },
  };

  it("an annex builds floor, roof and every wall BUT the shared one", () => {
    const b = annexBill(rear);
    const free = shellBill({ w: 6, h: 3.5 });
    expect(b.floorBays).toBe(free.floorBays);
    expect(b.roofBays).toBe(free.roofBays);
    // Shares its full `u` extent with the house — 2 bays of wall not built.
    expect(b.wallBays).toBe(free.wallBays - baysAcross(6));
  });

  it("an interior cut is a partition and NOTHING else", () => {
    const b = partitionBill({ u0: 0, u1: 4, v0: 0, v1: 2.5 });
    expect(b.floor).toBe(0);
    expect(b.roof).toBe(0);
    expect(b.wallBays).toBe(baysAcross(4)); // runs along the longer span
    expect(b.total).toBe(b.wall);
  });

  it("subdividing is dramatically cheaper than annexing — and now says so", () => {
    const cut: InteriorCandidate = {
      hostId: "h_0", kind: "bedroom", u0: 0, u1: 4, v0: 0, v1: 2.5,
      doorAt: { u: 2, v: 2.5, width: 1.8 },
    };
    expect(interiorCosts(cut)[BLOCK_GLYPH]!).toBeLessThan(annexCosts(rear)[BLOCK_GLYPH]!);
  });

  it("roomOrderCosts discriminates on the candidate's own shape", () => {
    const cut: InteriorCandidate = {
      hostId: "h_0", kind: "bedroom", u0: 0, u1: 4, v0: 0, v1: 2.5,
      doorAt: { u: 2, v: 2.5, width: 1.8 },
    };
    expect(roomOrderCosts(rear)).toEqual(annexCosts(rear));
    expect(roomOrderCosts(cut)).toEqual(interiorCosts(cut));
  });

  it("MIN_ROOM_COSTS is a floor no orderable room undercuts", () => {
    const min = MIN_ROOM_COSTS[BLOCK_GLYPH]!;
    expect(min).toBeGreaterThan(0);
    expect(annexCosts(rear)[BLOCK_GLYPH]!).toBeGreaterThanOrEqual(min);
    expect(
      interiorCosts({
        hostId: "h_0", kind: "bath", u0: 0, u1: 1.5, v0: 0, v1: 1.5,
        doorAt: { u: 0.75, v: 1.5, width: 1.2 },
      })[BLOCK_GLYPH]!,
    ).toBeGreaterThanOrEqual(min);
  });

  it("CONSERVATION: a base room refunds its partition, never a whole annex", () => {
    // The exploit this closes: cut the cheapest room, tear it down, bank a
    // building's worth of blocks. The refund is what the room actually cost.
    const refund = baseRoomCosts({ w: 4, h: 2.5 })[BLOCK_GLYPH]!;
    expect(refund).toBe(partitionBill({ u0: 0, u1: 4, v0: 0, v1: 2.5 }).total);
    expect(refund).toBeLessThan(annexCosts(rear)[BLOCK_GLYPH]!);
  });
});

describe("furniture is made of blocks too, sized by the piece", () => {
  it("scales with footprint — a table is not a waste bin", () => {
    const of = (kind: string): number =>
      Object.values(FURNITURE_ITEMS.find((f) => f.kind === kind)!.craft!.consumes)[0]!;
    expect(of("table")).toBeGreaterThan(of("chair"));
    expect(of("bed")).toBeGreaterThan(of("bin"));
  });

  it("never free, however small the piece", () => {
    expect(furnitureBlocks(0)).toBeGreaterThanOrEqual(1);
    expect(furnitureBlocks(0.01)).toBeGreaterThanOrEqual(1);
    for (const f of FURNITURE_ITEMS) {
      if (!f.craft) continue;
      expect(Object.values(f.craft.consumes)[0]!).toBeGreaterThanOrEqual(1);
    }
  });

  it("the derived recipe rides EVERY craftable row, at the workbench", () => {
    // `FURNITURE_ITEMS` means "a piece of furniture"; the CRAFTABLE ones are
    // the `f.craft` subset. An oven is a piece you cannot make at a bench, and
    // reading the two as the same list is what left a deconstructed one
    // rendering as a question mark (item-prop-spec.test.ts).
    const craftable = FURNITURE_ITEMS.filter((f) => f.craft);
    expect(craftable.length).toBeGreaterThan(0);
    for (const f of craftable) {
      expect(f.craft!.at).toBe("workbench");
      expect(f.craft!.consumes[BLOCK_GLYPH]).toBe(furnitureBlocks(f.radius));
    }
  });
});

describe("the chain stays affordable — bills and yields move together", () => {
  it("a tree is worth felling against a real house bill", () => {
    // The coherence check the phase turns on: a cottage at ~15 trees, not 80.
    // If either knob moves without the other, this is what catches it.
    const house = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;
    const blocks = structureCosts(house)[BLOCK_GLYPH]!;
    const oak = naturalSourceOf("oak")!.products.find((p) => p.glyph === "wood")!;
    const perTree = (oak.yield.min + oak.yield.max) / 2;
    const woodPerBlock = oak.refinesTo!.inPerOut;
    const trees = (blocks * woodPerBlock) / perTree;
    expect(trees).toBeGreaterThan(4); // a house is a project, not an afternoon
    expect(trees).toBeLessThan(40); // ...but not a deforestation
  });
});

describe("the block as an object", () => {
  it("is a squared unit a body could carry, longer than it is thick", () => {
    expect(BLOCK_SIZE_M.l).toBeGreaterThan(BLOCK_SIZE_M.w);
    expect(BLOCK_SIZE_M.l).toBeLessThan(1.5);
    expect(blockCosts(3)).toEqual({ [BLOCK_GLYPH]: 3 });
    expect(blockCosts(shellBill({ w: 9, h: 8 }))).toEqual({
      [BLOCK_GLYPH]: shellBill({ w: 9, h: 8 }).total,
    });
  });
});

// ── S&D S3 H1 — multiplier ③ (BLOCKS_PER_BAY × BUILD_BAY_M), wired at
// ⚖️ S3 REVIEW CORRECTION — BILLS ARE DIAL-FREE. The resource_compression
// dial applies at exactly ONE boundary (effectiveInPerOut / storehouseRawParAt
// / farmAcresPerPerson). A bill is construction ambition, not natural→usable
// conversion; the reviewed draft's bills ÷ dial compounded with the refine
// side (~dial² and worse). These pins hold the INVARIANCE.
describe("blockCosts — dial-INVARIANT bills (one-application law)", () => {
  it("blockCosts is a pure function of the bill", () => {
    const bill = shellBill({ w: 9, h: 8 });
    expect(blockCosts(bill)).toEqual({ [BLOCK_GLYPH]: bill.total });
    expect(blockCosts(40)).toEqual({ [BLOCK_GLYPH]: 40 });
  });

  it("the wrapper params are INERT: a passed dial changes nothing", () => {
    const cut: InteriorCandidate = {
      hostId: "h_0", kind: "bedroom", u0: 0, u1: 4, v0: 0, v1: 2.5,
      doorAt: { u: 2, v: 2.5, width: 1.8 },
    };
    expect(interiorCosts(cut, 2)).toEqual(interiorCosts(cut));
    expect(roomOrderCosts(cut, 2)).toEqual(roomOrderCosts(cut));
    expect(baseRoomCosts({ w: 4, h: 2.5 }, 2)).toEqual(baseRoomCosts({ w: 4, h: 2.5 }));
  });
});
