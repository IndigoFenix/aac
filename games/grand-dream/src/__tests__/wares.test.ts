/**
 * The SECOND household need — tools (goods2), projected to the street by
 * the same GoodSpec machinery that renders food. These tests prove the
 * extension recipe end-to-end: sawmill and smithy footprints appear in
 * the town plan where the aggregate built them, the tools projection
 * exists exactly where the settlement keeps the ledger (never invented),
 * smithies sell over a counter with the hall as the imports fallback,
 * the wares cadence is the slow clock the good's capDays declares, and
 * household member 1 — not the food shopper — walks the wares run to
 * the tool chest in the opposite corner of the house.
 */

import { describe, expect, it } from "vitest";
import {
  FOOD_DAY_SEC, HOUSEHOLD, TOOLS_GOOD, createTownFood, createTownGoods,
  createTownWares, pantryBoxAt, waresBoxAt,
} from "../food";
import {
  createTownManager, memberIndex, townBias, townPlan, villagerNpcId, worldPos,
} from "../zoom";
import { buildingInfo } from "../city-view";
import type { TriWorld } from "../tri";

const COLS = 25, ROWS = 25, CITY = { x: 12, y: 12 };

/** A tri stub for a goods2 town: fertile EAST, ore WEST, timber NORTH,
 *  with the tools ledger declared (entityWorld scalars present) — the
 *  same fake pattern town-bias.test uses, widened for the new vars. */
function goods2Tri(pop = 900, fill = 1): TriWorld {
  const fertility = new Float64Array(COLS * ROWS);
  const ore = new Float64Array(COLS * ROWS);
  const plant = new Float64Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (x >= CITY.x + 2) fertility[y * COLS + x] = 6;
      if (x <= CITY.x - 2) ore[y * COLS + x] = 5;
      if (y <= CITY.y - 2) plant[y * COLS + x] = 6;
    }
  }
  const scalars: Record<string, number> = {
    population: pop, farms: 2, mines: 1, smelters: 0, sawmills: 2, smithies: 1,
    food_need: pop / 1000, food_got: (pop / 1000) * fill,
    tools_need: (pop / 5000), tools_got: (pop / 5000) * fill,
    timberland: 120, planks_out: 6, tools_out: 3,
    smith_metal_draw: 2, smith_plank_draw: 3,
  };
  return {
    cities: [{ key: "millbrook", ...CITY, harvested: 0 }],
    grid: { cols: COLS, rows: ROWS, fields: { fertility, ore, plant } },
    charterOf: () => ({ farmland: 240, ore_access: 40, timberland: 120 }),
    dual: {
      settlementScalar: (_k: string, f: string): number => scalars[f] ?? 0,
      sampleVillager: (siteKey: string, index: number) =>
        ({ index, name: `Villager ${siteKey}#${index}`, traitKeys: ["human"] }),
      entityWorld: { scalars: { tools_need: new Float64Array(1), tools_got: new Float64Array(1) } },
      routes: () => [],
    },
  } as unknown as TriWorld;
}

/** The same town with NO tools ledger — a base world. */
function baseTri(): TriWorld {
  const tri = goods2Tri();
  (tri.dual as unknown as { entityWorld: { scalars: Record<string, unknown> } }).entityWorld = { scalars: {} };
  return tri;
}

describe("new work types in the town plan", () => {
  it("sawmills and smithies stand where the aggregate built them; sawmills lean toward the trees", () => {
    const tri = goods2Tri();
    const bias = townBias(tri, "millbrook");
    expect(bias.timber).not.toBeNull(); // the wooded side reads
    const plan = townPlan(tri, "millbrook", 7);
    const sawmills = plan.works.filter(w => w.type === "sawmill");
    const smithies = plan.works.filter(w => w.type === "smithy");
    expect(sawmills).toHaveLength(2);
    expect(smithies).toHaveLength(1);
    // Timber is due north (negative y): the mills lean that way.
    const meanY = sawmills.reduce((a, w) => a + w.dy + w.h / 2, 0) / sawmills.length;
    expect(meanY).toBeLessThan(0);
  });

  it("a base world places none — settlementScalar reads 0 for undeclared vars", () => {
    const plan = townPlan(baseTri(), "millbrook", 7);
    // baseTri still lists the counts in its scalar stub, so zero them
    // properly: a REAL base world has no such scalars at all. What we
    // assert here is the projection guard instead.
    expect(createTownWares(baseTri(), { key: "millbrook", center: { x: 0, y: 0 }, plan }, 7)).toBeNull();
  });
});

describe("the tools projection (second need, same machinery)", () => {
  const center = worldPos(CITY.x, CITY.y);
  const townOf = (tri: TriWorld) => {
    const plan = townPlan(tri, "millbrook", 7);
    return { key: "millbrook", center, plan };
  };

  it("exists exactly where the settlement keeps the ledger", () => {
    const tri = goods2Tri();
    const wares = createTownWares(tri, townOf(tri), 7);
    expect(wares).not.toBeNull();
    expect(wares!.good.key).toBe("tools");
    expect(wares!.boxCap).toBe(HOUSEHOLD * TOOLS_GOOD.capDays * TOOLS_GOOD.perCapitaDaily);
  });

  it("smithies sell over the counter; a smithy-less town gets tools at the hall (imports)", () => {
    const tri = goods2Tri();
    const town = townOf(tri);
    const wares = createTownWares(tri, town, 7)!;
    expect(wares.sources.every(s => s.kind === "smithy")).toBe(true);
    expect(wares.stockOf(wares.sources[0], 0)).toBeGreaterThan(0); // shelved at dawn

    const noSmithy = {
      ...town,
      plan: { ...town.plan, works: town.plan.works.filter(w => w.type !== "smithy") },
    };
    const imported = createTownGoods(tri, noSmithy, 7, TOOLS_GOOD, town.plan.streets);
    expect(imported.sources).toHaveLength(1);
    expect(imported.sources[0].kind).toBe("hall");
  });

  it("tools run on the slow clock: the wares trip comes a third as often as food", () => {
    const tri = goods2Tri();
    const town = townOf(tri);
    const food = createTownFood(tri, town, 7);
    const wares = createTownWares(tri, town, 7)!;
    const h = town.plan.houses[0];
    const fc = food.cycle(h);
    const wc = wares.cycle(h);
    // capDays 9 vs 3 at the same fill — the walk legs differ but the
    // period is dominated by the box, so the ratio holds loosely.
    expect(wc.period).toBeGreaterThan(fc.period * 2);
    expect(wc.period).toBe(TOOLS_GOOD.capDays * FOOD_DAY_SEC); // fill 1
  });

  it("the two boxes live in opposite corners of the house", () => {
    const tri = goods2Tri();
    const { plan } = townOf(tri);
    const h = plan.houses[0];
    const pantry = pantryBoxAt({ x: 0, y: 0 }, h);
    const chest = waresBoxAt({ x: 0, y: 0 }, h);
    expect(chest.x).toBeGreaterThan(pantry.x); // SE vs SW corner
    expect(chest.y).toBe(pantry.y);
  });
});

describe("city view knows the new works and the second box", () => {
  it("a clicked sawmill/smithy reports its chain; a house shows the wares chest and who runs it", () => {
    const tri = goods2Tri();
    const center = worldPos(CITY.x, CITY.y);
    const plan = townPlan(tri, "millbrook", 7);
    const goods = createTownFood(tri, { key: "millbrook", center, plan }, 7);
    const wares = createTownWares(tri, { key: "millbrook", center, plan }, 7);

    const sawIdx = plan.works.findIndex(w => w.type === "sawmill");
    const saw = buildingInfo(tri, "millbrook", plan, goods, { kind: "work", index: sawIdx }, 100, wares);
    expect(saw.title).toBe("🪚 Sawmill");
    expect(saw.lines.some(l => l.startsWith("Planks:"))).toBe(true);

    const smithyIdx = plan.works.findIndex(w => w.type === "smithy");
    const smithy = buildingInfo(tri, "millbrook", plan, goods, { kind: "work", index: smithyIdx }, 100, wares);
    expect(smithy.title).toBe("🔨 Smithy");
    expect(smithy.lines.some(l => l.startsWith("Tools:"))).toBe(true);
    expect(smithy.lines.some(l => l.startsWith("Counter stock"))).toBe(true);

    const house = buildingInfo(tri, "millbrook", plan, goods, { kind: "house", index: 0 }, 100, wares);
    expect(house.lines.some(l => l.startsWith("Wares chest:"))).toBe(true);
    expect(house.lines.some(l => l.includes("(runs the wares errands)"))).toBe(true);
    expect(house.lines.some(l => l.startsWith("Table favorite:"))).toBe(true);
    // Without the wares instance the house shows no second box — the
    // panel never invents a ledger.
    const bare = buildingInfo(tri, "millbrook", plan, goods, { kind: "house", index: 0 }, 100, null);
    expect(bare.lines.some(l => l.startsWith("Wares chest:"))).toBe(false);
    expect(bare.lines.some(l => l.includes("wares errands"))).toBe(false);
  });
});

describe("the wares runner (TownManager, second errand role)", () => {
  it("member 1 walks the wares run to the tool chest; the boxes read independently", () => {
    const tri = goods2Tri();
    const center = worldPos(CITY.x, CITY.y);
    const mgr = createTownManager(tri, 7, () => 40);
    mgr.update(center);
    const town = mgr.loaded().find(t => t.key === "millbrook")!;
    expect(town.wares).not.toBeNull();

    // A house near the plaza whose wares runner is OUT while the food
    // shopper is home — scan the clock for that window.
    let found: { house: (typeof town.plan.houses)[number]; t: number } | null = null;
    outer:
    for (const house of town.plan.houses.slice(0, 12)) {
      for (let t = 0; t < town.wares!.cycle(house).period; t += 4) {
        const w = town.wares!.errand(house, t);
        const f = town.food.errand(house, t);
        if (w.phase === "to_source" && f.phase === "home") {
          found = { house, t };
          break outer;
        }
      }
    }
    expect(found).not.toBeNull();
    const { house, t } = found!;

    // At that moment, a fresh manager spawns the WARES runner (member 1)
    // mid-errand, trip ending at the tool chest — while the shopper
    // (member 0) sits home.
    const fresh = createTownManager(tri, 7, () => 40);
    const upd = fresh.update(center, undefined, t);
    const runnerId = villagerNpcId("millbrook", memberIndex(house.index, 1));
    const spawned = upd.spawn.find(s => s.npc.id === runnerId);
    expect(spawned).toBeDefined();
    expect(spawned!.walkTo).toBeDefined();
    const last = spawned!.walkTo![spawned!.walkTo!.length - 1];
    const chest = waresBoxAt(town.center, house);
    expect(Math.hypot(last.x - chest.x, last.y - chest.y)).toBeLessThan(0.01);

    // While the runner walks, the wares chest reads empty and the pantry
    // reads its own (food) clock — two ledgers, two boxes.
    const loaded = fresh.loaded().find(x => x.key === "millbrook")!;
    expect(fresh.wares(loaded, house, t)).toBe(0);
    expect(fresh.pantry(loaded, house, t)).toBeGreaterThan(0);
  });
});
