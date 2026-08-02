// THE BLOCK CHAIN (rewrite phase 3 — construction-phase3-plan.md): blocks
// are the ONE construction primitive, material as a facet
// (`block.material_wood`); raws (wood, stone) refine into them at 1:1 (THE
// tree-to-city knob) through a REFINE order riding the one ConstructionOrder
// lifecycle; costs moved to `{ block: n }` head-paid; the growth twin mills
// implicitly (spendCostsChain); legacy `{ wood: n }` rows keep working —
// wood remains a real, producible item (no migration, no rename). No DOM/GL.

import { describe, it, expect } from "@jest/globals";
import {
  bankLabor,
  createTownDeltas,
  foundedProgress,
  foundedStage,
  foundingOptions,
  orderDone,
  orderStage,
  stagingMissing,
  type RefineOrder,
  type SerializedTownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  costsMet,
  resolveStructure,
  spendCostsChain,
  structureCosts,
} from "@shared/world-engine/kernel/town/structures.js";
import {
  BLOCK_GLYPH,
  buildingChainGlyphs,
  rawsForRefined,
  refinedGlyphOf,
  withRefinableCredit,
} from "@shared/world-engine/products.js";
import { freightOf } from "@shared/world-engine/freight.js";
import {
  isSiteMaterial,
  SITE_MATERIAL_GLYPHS,
} from "@shared/world-engine/interaction/town/founding.js";
import {
  TOWN_PLAY_STRUCTURES,
  townStockSeed,
} from "@shared/world-engine/interaction/town/town-play.js";
import { FURNITURE_ITEMS } from "@shared/world-engine/kernel/town/stations.js";

const SEED = 33;
const KEY = "sawbrook";
const HOUSE = resolveStructure(TOWN_PLAY_STRUCTURES, "house")!;

function lot() {
  return foundingOptions({
    seed: SEED, key: KEY, footprint: HOUSE.footprint, type: HOUSE.type,
    occupied: [], claimedSlots: new Set(),
  })[0]!;
}

function refineRow(count = 4): Omit<RefineOrder, "ord" | "kind"> {
  return {
    produces: refinedGlyphOf("wood")!,
    count,
    costs: { wood: count * 2 }, // the 2:1 refinement ratio
    pile: {},
    at: { x: 12, y: -3 },
    startedDay: 2,
    buildDays: 0.05 * count,
  };
}

describe("the chain as data (products / freight / costs)", () => {
  it("wood and stone refine into blocks at the declared ratio", () => {
    const raws = rawsForRefined(BLOCK_GLYPH);
    expect(raws.map((p) => p.glyph)).toEqual(["wood", "stone"]); // catalogue order
    // STRICTLY lossy in mass — the freight law's other half pins the value.
    // `toMatchObject`, not `toEqual`: phase 5 hung the ROUTING on the same
    // record (`refinesTo.at` — the work type that cuts the raw fast), and a
    // whole-object match here would forbid every future field this row grows
    // while claiming only to check the ratio. What this line is ABOUT is the
    // 2:1, and the two raws share it whatever else they carry.
    for (const p of raws) expect(p.refinesTo).toMatchObject({ into: "block", inPerOut: 2 });
    // The ROUTING half, pinned where the ratio is: same chain, same 2:1, but
    // wood mills at the carpentry (unmarked — the pre-split default) and stone
    // cuts at the masonry. `at` never gates; it only says WHERE.
    expect(raws.find((p) => p.glyph === "wood")!.refinesTo!.at).toBeUndefined();
    expect(raws.find((p) => p.glyph === "stone")!.refinesTo!.at).toBe("masonry");
    expect(refinedGlyphOf("wood")).toBe("block.material_wood");
    expect(refinedGlyphOf("stone")).toBe("block.material_stone");
    expect(refinedGlyphOf("apple")).toBeNull();
  });

  it("the site-yard vocabulary spans the WHOLE chain", () => {
    expect(buildingChainGlyphs()).toEqual(["wood", "block", "stone"]);
    expect(SITE_MATERIAL_GLYPHS).toContain(BLOCK_GLYPH);
    expect(isSiteMaterial("block.material_wood")).toBe(true);
    expect(isSiteMaterial("wood.wet")).toBe(true);
    expect(isSiteMaterial("apple")).toBe(false);
  });

  it("the freight value law holds for the worked-wood rung", () => {
    expect(freightOf("block").valueDensity).toBeGreaterThan(freightOf("wood").valueDensity);
    expect(freightOf("block").valueDensity).toBeGreaterThan(freightOf("stone").valueDensity);
  });

  it("every catalog cost is a block bill; furniture consumes blocks; toys keep raw wood", () => {
    for (const spec of TOWN_PLAY_STRUCTURES) {
      // PHASE 6: the block count is DERIVED from the footprint, not authored —
      // the rows carry only extras (none today), and `structureCosts` is the
      // one door every affordability question goes through.
      expect(spec.costs[BLOCK_GLYPH]).toBeUndefined();
      expect(Object.keys(structureCosts(spec))).toEqual([BLOCK_GLYPH]);
    }
    for (const f of FURNITURE_ITEMS) {
      if (f.craft) expect(Object.keys(f.craft.consumes)).toEqual([BLOCK_GLYPH]);
    }
  });

  it("the storehouse is a default catalog row — store program, no staff", () => {
    const store = resolveStructure(TOWN_PLAY_STRUCTURES, "storehouse")!;
    expect(store.default).toBe(true);
    expect(store.jobs).toBe(0);
    expect(store.program.store).toBe(true);
  });

  it("the seeded yard affords a house through the chain", () => {
    const seed = townStockSeed(6);
    expect(costsMet(HOUSE, withRefinableCredit(seed))).toBe(true);
  });
});

describe("withRefinableCredit — chain-aware affordability", () => {
  it("credits raws at their milled value, facted variants included", () => {
    const credited = withRefinableCredit({ wood: 5, "wood.wet": 1, stone: 2 });
    expect(credited[BLOCK_GLYPH]).toBe(4); // floor(6/2) wood + floor(2/2) stone
    expect(credited.wood).toBe(5); // the raws stay listed — nothing is spent
    expect(costsMet({ costs: { block: 4 } }, credited)).toBe(true);
    expect(costsMet({ costs: { block: 5 } }, credited)).toBe(false);
  });

  it("existing blocks and credit stack", () => {
    const credited = withRefinableCredit({ "block.material_wood": 3, wood: 2 });
    expect(costsMet({ costs: { block: 4 } }, credited)).toBe(true);
  });
});

describe("spendCostsChain — the twin's implicit mill", () => {
  it("spends blocks first, then mills raws at the ratio", () => {
    const stock: Record<string, number> = { "block.material_wood": 2, wood: 5 };
    expect(spendCostsChain({ costs: { block: 4 } }, stock)).toBe(true);
    expect(stock["block.material_wood"]).toBeUndefined();
    expect(stock.wood).toBe(1); // 2 milled implicitly at 2:1
  });

  it("refuses (and spends nothing) when even the chain can't cover", () => {
    const stock: Record<string, number> = { wood: 3 };
    expect(spendCostsChain({ costs: { block: 6 } }, stock)).toBe(false);
    expect(stock.wood).toBe(3);
  });
});

describe("the REFINE order — one lifecycle, one ordinal sequence", () => {
  it("posts into the one sequence beside foundings, aliased by its view", () => {
    const d = createTownDeltas();
    const b = d.foundBuilding(lot(), 1, 2, { block: 6 });
    const r = d.postRefineOrder(refineRow());
    expect(r.ord).toBe(b.ord + 1); // ONE town-wide sequence
    expect(d.orders()).toHaveLength(2);
    expect(d.refineOrders()).toHaveLength(1);
    expect(d.refineOrders()[0]).toBe(d.orders()[1]); // live view, not a copy
  });

  it("walks gather → stage → labor → done exactly like a costed room", () => {
    const d = createTownDeltas();
    const r = d.postRefineOrder(refineRow(4));
    expect(orderStage(r, 3)).toBe(0); // marked — nothing staged
    expect(stagingMissing(r)).toEqual({ wood: 8 });
    // Facted raws pay their head, exactly as a site pile does.
    r.pile["wood.wet"] = 1;
    r.pile.wood = 7;
    expect(stagingMissing(r)).toEqual({});
    d.stageOrder(r.ord, 3);
    expect(r.laborStartDay).toBe(3);
    expect(orderStage(r, 3)).toBe(1);
    expect(orderDone(r, 3)).toBe(false);
    bankLabor(r, r.buildDays / 2);
    expect(orderStage(r, 3)).toBe(2);
    bankLabor(r, r.buildDays);
    expect(orderDone(r, 3)).toBe(true);
    d.removeOrder(r.ord);
    expect(d.refineOrders()).toHaveLength(0);
    expect(d.orders()).toHaveLength(0);
  });

  it("a committed refine's ordinal is NEVER reused — not live, not across a reload", () => {
    const d = createTownDeltas();
    const r = d.postRefineOrder(refineRow(1));
    expect(r.ord).toBe(0);
    d.removeOrder(r.ord); // the commit's retirement
    const b = d.foundBuilding(lot(), 1, 2, { block: 3 });
    expect(b.ord).toBe(1); // the high-water mark holds past the transient row
    const d2 = createTownDeltas(d.toJSON());
    expect(d2.postRefineOrder(refineRow(1)).ord).toBe(2); // and survives serialization
  });

  it("round-trips byte-stably through the one `orders` field", () => {
    const d = createTownDeltas();
    d.foundBuilding(lot(), 1, 2, { block: 6 });
    const r = d.postRefineOrder(refineRow(2));
    r.pile.wood = 1;
    const json = d.toJSON();
    expect(json.orders).toHaveLength(2);
    const d2 = createTownDeltas(json);
    expect(JSON.stringify(d2.toJSON().orders)).toBe(JSON.stringify(json.orders));
    const r2 = d2.refineOrders()[0]!;
    expect(r2.produces).toBe("block.material_wood");
    expect(r2.pile).toEqual({ wood: 1 });
  });
});

describe("legacy wood-cost rows keep working (no migration, no rename)", () => {
  it("a pre-phase-3 save's wood bill stages off wood exactly as before", () => {
    const save: SerializedTownDeltas = {
      version: 7,
      buildings: {},
      orders: [
        {
          kind: "found", ord: 0, type: "house", slot: 2, dx: 10, dy: -4,
          w: 7, h: 6, door: "south", startedDay: 1, buildDays: 2,
          costs: { wood: 4 }, pile: { wood: 4 },
        },
      ],
    };
    const d = createTownDeltas(save);
    const b = d.founded()[0]!;
    expect(stagingMissing(b)).toEqual({});
    d.stageOrder(0, 5);
    bankLabor(b, 2);
    expect(foundedStage(b, 5)).toBe(3);
  });

  it("a block pile pays a block bill through the head, any material", () => {
    const d = createTownDeltas();
    const b = d.foundBuilding(lot(), 1, 2, { block: 4 });
    b.pile = { "block.material_wood": 2, "block.material_stone": 2 };
    expect(stagingMissing(b)).toEqual({});
  });
});

describe("foundedProgress — the wall-course driver", () => {
  it("mirrors foundedStage's arms as a raw fraction", () => {
    const d = createTownDeltas();
    const b = d.foundBuilding(lot(), 10, 2, { block: 6 });
    expect(foundedProgress(b, 11)).toBe(0); // unstaged — marked ground
    d.stageOrder(b.ord, 11);
    bankLabor(b, 1.5);
    expect(foundedProgress(b, 11)).toBeCloseTo(0.75);
    d.completeFounding(b.ord);
    expect(foundedProgress(b, 11)).toBe(1);
    // The unadopted no-cost row keeps its clock — same as its stage.
    const clock = d.foundBuilding(lot(), 10, 2);
    expect(foundedProgress(clock, 11)).toBeCloseTo(0.5);
    expect(foundedStage(clock, 11)).toBe(2);
  });
});
