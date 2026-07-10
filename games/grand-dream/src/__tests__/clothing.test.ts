/**
 * CLOTHING — the first PURE-CONTENT chain (step 6d): everything below
 * runs off economy-clothing.ts + the compiler; no engine, street or
 * renderer code knows the words "wool" or "weaver". The aggregate half
 * is the calibration probe (does the chain actually GROW inside the
 * fed-transient economy?); the street half proves the third good picks
 * up its errand role, box corner and panel lines by registration alone.
 */

import { describe, expect, it } from "vitest";
import { foundTri, prepareSubstrate } from "../tri";
import {
  FOUNDING, TIERS, TREELINE, pickBiomes, ridgeValley,
  triBase, triEconomy, villageSeed,
} from "../tri-worlds";
import { citizenStartpop, compileEconomy } from "../economy";
import { CORE_BASE, CORE_GOODS2 } from "../economy-core";
import { CLOTHING } from "../economy-clothing";
import { goodBoxAt, pantryBoxAt, streetGoodsFor } from "../food";
import { townPlan, worldPos } from "../zoom";
import { buildingInfo } from "../city-view";

const OPTS = { construction: true, goods2: true, clothing: true };

describe("clothing (step 6d): a chain born as content", () => {
  it("compiles into the settlement spec: chain, stagger, gates, coupling", () => {
    const eco = triEconomy(OPTS);
    // The chain's processes exist with the weaver's own count as capacity.
    const weave = eco.processes.find(p => p.id === "weave")!;
    expect(weave.input).toBe("wool_got");
    expect(weave.capacityBy).toBe("weavers");
    // Funding stagger APPENDS to the industry tier: 25/55/75/100.
    const thresholds = eco.rules
      .filter(r => r.id?.startsWith("build-"))
      .map(r => {
        const all = (r.when as { all: Array<{ left?: { scalar?: string }; right?: { const?: number } }> }).all;
        return [r.id, all.find(c => c.left?.scalar === "granary")?.right?.const];
      });
    expect(thresholds).toContainEqual(["build-sheepfold", 75]);
    expect(thresholds).toContainEqual(["build-weaver", 100]);
    // Cloth demand joins the coupling; wool (an intermediate) does not.
    expect(eco.demandInputs).toContainEqual({ resource: "cloth", scalar: "cloth_need" });
    expect(eco.traitDemands).toContainEqual({ resource: "cloth", value: 0.0003 });
    expect(eco.demandInputs.some(d => d.resource === "wool")).toBe(false);
    // The wool net ships against the weavers' draw (the planks pattern).
    expect(eco.flownets.find(f => f.id === "wool")).toEqual({
      id: "wool", source: "wool_out", demand: "weaver_wool_draw", by: "road", satisfied: "wool_got",
    });
    // Third street good, third slot.
    expect(eco.goods.map(g => [g.key, g.slot])).toEqual([["food", 0], ["tools", 1], ["cloth", 2]]);
  });

  it("grows from a village and clothes it (the calibration probe)", { timeout: 240000 }, async () => {
    const prep = prepareSubstrate({ cols: 48, rows: 32, height: ridgeValley, treeline: TREELINE, founding: FOUNDING, oreSeed: 7 });
    const { valley } = pickBiomes(prep);
    const eco = triEconomy(OPTS);
    // The founding crowd carries the content's species mix — the flock
    // walks in with its shepherds (2% sheep).
    const citizens = { startpop: citizenStartpop(eco, ["member_x"]) };
    const tri = await foundTri(prep, {
      base: triBase(OPTS),
      economy: eco,
      cities: [{ at: valley, key: "valley", name: "Valleyton", scalars: villageSeed, site: citizens }],
      edges: [],
      peopleScale: 25,
      seed: 11,
      tiers: TIERS,
      mining: { oreOutScalar: "ore_out", rate: 0.3 },
    });
    const d = tri.dual;
    const scal = (s: string): number => d.settlementScalar("valley", s);
    for (let day = 0; day < 400 && scal("weavers") === 0; day += 10) {
      await tri.advanceDays(10);
    }
    await tri.advanceDays(60); // let the flows settle

    // The chain GREW (industry after subsistence — base was complete first).
    expect(scal("sheepfolds")).toBeGreaterThan(0);
    expect(scal("weavers")).toBeGreaterThan(0);
    expect(scal("farms")).toBeGreaterThanOrEqual(scal("farm_cap") - 0.01);
    // Wool moved and cloth reached the households.
    expect(scal("wool_got")).toBeGreaterThan(0);
    expect(scal("cloth_out")).toBeGreaterThan(0);
    expect(scal("cloth_need")).toBeGreaterThan(0);
    expect(scal("cloth_got") / scal("cloth_need")).toBeGreaterThan(0.5);

    // --- The street picks it all up by registration alone. ---
    const city = tri.cities.find(c => c.key === "valley")!;
    const center = worldPos(city.x, city.y);
    const plan = townPlan(tri, "valley", 7);
    expect(plan.works.some(w => w.type === "sheepfold")).toBe(true);
    expect(plan.works.some(w => w.type === "weaver")).toBe(true);

    const goods = streetGoodsFor(tri, { key: "valley", center, plan }, 7);
    expect(goods.map(g => g.good.key)).toEqual(["food", "tools", "cloth"]);
    const cloth = goods[2];
    expect(cloth.sources.every(s => s.kind === "weaver")).toBe(true);
    expect(cloth.stockOf(cloth.sources[0], 0)).toBeGreaterThan(0); // shelved counter

    // Third box corner (NE) — not the pantry's, not the wares chest's.
    const h = plan.houses[0];
    const chest = goodBoxAt(center, h, 2);
    const pantry = pantryBoxAt(center, h);
    expect(chest.y).toBeLessThan(pantry.y);
    expect(chest.x).toBeGreaterThan(pantry.x);

    // Panel: the weaver reports its templates + live counter; the house
    // shows the linen chest and names member 2 the cloth runner.
    const weaverIdx = plan.works.findIndex(w => w.type === "weaver");
    const info = buildingInfo(tri, "valley", plan, goods[0], { kind: "work", index: weaverIdx }, 100, goods.slice(1));
    expect(info.title).toBe("🧵 Weaver's hall");
    expect(info.lines.some(l => l.startsWith("Cloth:"))).toBe(true);
    expect(info.lines.some(l => l.startsWith("Counter stock now:") && l.includes("garment-days"))).toBe(true);

    const house = buildingInfo(tri, "valley", plan, goods[0], { kind: "house", index: 0 }, 100, goods.slice(1));
    expect(house.lines.some(l => l.startsWith("Linen chest:"))).toBe(true);
    expect(house.lines.some(l => l.startsWith("Cloth from: weaver"))).toBe(true);
    const members = house.lines.filter(l => l.startsWith("  "));
    expect(members[1]).toContain("(runs the wares errands)");
    expect(members[2]).toContain("(runs the cloth errands)");
  });

  it("a base world compiled WITHOUT the clothing doc knows nothing of it", () => {
    const eco = compileEconomy([CORE_BASE, CORE_GOODS2], { construction: true });
    expect(eco.works.some(w => w.key === "weaver")).toBe(false);
    expect(eco.goods.some(g => g.key === "cloth")).toBe(false);
    expect(compileEconomy([CORE_BASE, CORE_GOODS2, CLOTHING], { construction: true }).goods).toHaveLength(3);
  });
});
