/**
 * City view (city-view.ts) — the data layer, headless: the overview reads
 * the settlement's live books, the chronicle reads the city's own column of
 * the recorded history, hit-testing maps town meters to buildings, and a
 * clicked building reports its production / household deterministically.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildAcceptanceTri, type AcceptanceWorld } from "../tri-worlds";
import { townPlan, HOUSEHOLD } from "../zoom";
import { createTownFood, type TownFood } from "../food";
import { worldPos } from "../zoom";
import type { TownPlan } from "../zoom";
import { cityOverview, cityChronicle, hitTestBuilding, buildingInfo } from "../city-view";

let world: AcceptanceWorld;
let plan: TownPlan;
let goods: TownFood;

beforeAll(async () => {
  world = await buildAcceptanceTri(1206);
  await world.tri.advanceDays(40);
  const city = world.tri.cities.find(c => c.key === "riverton")!;
  plan = townPlan(world.tri, "riverton", 7);
  goods = createTownFood(world.tri, { key: "riverton", center: worldPos(city.x, city.y), plan }, 7);
}, 120000);

describe("city view: the settlement's books", () => {
  it("overview mirrors the live scalars and declares only what exists", () => {
    const ov = cityOverview(world.tri, "riverton");
    expect(ov.name).toBe("Riverton");
    expect(ov.pop).toBe(world.tri.dual.settlementPop("riverton"));
    expect(ov.charter).toEqual(world.tri.charterOf("riverton"));
    expect(ov.civ?.name).toBe("Aurelia");
    expect(ov.dead).toBeNull();
    expect(ov.tier).toBeNull(); // the acceptance world declares no tiers

    // Farms exist and match; goods2 vars are absent here, so the planks
    // and tools rows must not be invented. Supply rows come from the
    // world's registry now — the base world's three flows, no more.
    const farms = ov.buildings.find(b => b.label === "Farms");
    expect(farms?.count).toBe(world.tri.dual.settlementScalar("riverton", "farms"));
    expect(ov.fills.map(f => f.good)).toEqual(["food", "ore", "metal"]);
    expect(ov.stockpiles).toEqual([]); // no construction ⇒ no granary
    for (const f of ov.fills) {
      expect(f.fill).toBeGreaterThanOrEqual(0);
      expect(f.fill).toBeLessThanOrEqual(1);
    }
  });

  it("the chronicle is the city's own column of the recorded history", () => {
    const chron = cityChronicle(world.tri, "riverton");
    const hist = world.tri.history()!;
    expect(chron.days.length).toBe(hist.frames.length); // present from frame 0
    expect(chron.pops[chron.pops.length - 1]).toBe(world.tri.dual.settlementPop("riverton"));
    expect(chron.events[0].label).toContain("founded");
    expect(chron.events[0].day).toBe(0);
  });

  it("hit-testing maps town meters to buildings, works first", () => {
    const wk = plan.works[0];
    expect(hitTestBuilding(plan, wk.dx + wk.w / 2, wk.dy + wk.h / 2)).toEqual({ kind: "work", index: 0 });
    const house = plan.houses[0];
    const hit = hitTestBuilding(plan, house.dx + house.w / 2, house.dy + house.h / 2);
    expect(hit).not.toBeNull();
    // The house's own center may sit under a work only if footprints
    // overlap (they don't); expect the house itself.
    expect(hit).toEqual({ kind: "house", index: 0 });
    expect(hitTestBuilding(plan, 10_000, 10_000)).toBeNull();
    // A near-miss (just outside the footprint) still lands — the padded
    // second pass for pixel-small houses at full-town zoom.
    expect(hitTestBuilding(plan, wk.dx - 1.5, wk.dy + wk.h / 2)).toEqual({ kind: "work", index: 0 });
  });

  it("a clicked house reports its household — the same residents, every time", () => {
    const ref = { kind: "house" as const, index: plan.houses[0].index };
    const a = buildingInfo(world.tri, "riverton", plan, goods, { kind: "house", index: 0 }, 100);
    const b = buildingInfo(world.tri, "riverton", plan, goods, { kind: "house", index: 0 }, 100);
    expect(a.title).toBe(`🏠 House #${ref.index}`);
    expect(a.lines).toEqual(b.lines); // deterministic residents (zero storage)
    const members = a.lines.filter(l => l.startsWith("  "));
    expect(members.length).toBe(HOUSEHOLD);
    expect(members[0]).toContain("(the shopper)");
    const pantryLine = a.lines.find(l => l.startsWith("Pantry:"))!;
    const [got, cap] = pantryLine.replace("Pantry: ", "").replace(" rations.", "").split(" / ").map(Number);
    expect(got).toBeGreaterThanOrEqual(0);
    expect(got).toBeLessThanOrEqual(cap);
  });

  it("a clicked work reports its production from the live scalars", () => {
    const farmIdx = plan.works.findIndex(w => w.type === "farm");
    expect(farmIdx).toBeGreaterThanOrEqual(0);
    const info = buildingInfo(world.tri, "riverton", plan, goods, { kind: "work", index: farmIdx }, 100);
    expect(info.title).toContain("Farmstead");
    const farms = world.tri.dual.settlementScalar("riverton", "farms");
    expect(info.lines[0]).toContain(`${farms} farms`);
  });
});
