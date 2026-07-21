/**
 * The STANDALONE TOWN (shared/engine/town/town-world.ts): one
 * settlement's books over a compiled economy, no composition layer —
 * the engine's smallest inhabited world. NOTE what this file does NOT
 * import: no popusim, no dual, no tri — the town lives on the shared
 * engine alone, which is the whole point (the symbol-learning game
 * hosts exactly this).
 */

import { describe, expect, it } from "vitest";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world";
import { townPlan } from "@shared/world-engine/kernel/town/plan";
import { streetGoods } from "@shared/world-engine/kernel/town/goods";
import { compileEconomy } from "@shared/world-engine/kernel/modules/economy";
import { CORE_BASE, CORE_GOODS2 } from "../economy-core";

const ECO = compileEconomy([CORE_BASE, CORE_GOODS2], { construction: true });

/** A fertile valley site; one founding farm (grand-dream's villageSeed
 *  shape — the seed is content's call, so the test states it). */
const VALLEY = {
  economy: ECO,
  charter: { farmland: 420, ore_access: 120, timberland: 100 },
  startPop: 60,
  seedScalars: { farms: 1 },
  key: "milltown",
};

describe("town-world: a settlement alive without a composition layer", () => {
  it("feeds itself, funds construction to its charter caps, and grows", () => {
    const town = createTownWorld(VALLEY);
    town.step(400);
    expect(town.day).toBe(400);

    // INDUSTRY AFTER SUBSISTENCE ran off the granary drift: the farm
    // stack reached its charter cap (420 farmland / 60), mines theirs.
    expect(town.scalar("farms")).toBe(7);
    expect(town.scalar("mines")).toBe(3);
    expect(town.scalar("farm_cap")).toBe(7);

    // Fed at fill 1, the population compounds (birth 2% − death 1%).
    const pop = town.scalar("population");
    expect(pop).toBeGreaterThan(VALLEY.startPop * 10);
    const need = town.scalar("food_need");
    const got = town.scalar("food_got");
    expect(need).toBeGreaterThan(0);
    expect(got / need).toBeGreaterThanOrEqual(0.99);
  });

  it("a town seeded with nothing that grows food starves, honestly", () => {
    const town = createTownWorld({ ...VALLEY, seedScalars: {}, key: "dustbowl" });
    town.step(100);
    // No farms ⇒ no grain ⇒ fill 0 ⇒ starvation outpaces births. The
    // granary drift never runs, so construction can't rescue it either.
    expect(town.scalar("farms")).toBe(0);
    expect(town.scalar("population")).toBeLessThan(VALLEY.startPop);
  });

  it("rest-jumps: an empty town settles, then a long absence is one leap", () => {
    const town = createTownWorld({ ...VALLEY, startPop: 0, key: "ghostfort" });
    // With nobody home the books settle (production drifts to stock
    // caps, construction finishes) and the population is still — a
    // 5000-day absence must cost days, not five thousand steps.
    const t0 = Date.now();
    town.step(5000);
    const ms = Date.now() - t0;
    expect(town.day).toBe(5000);
    expect(town.scalar("population")).toBe(0);
    expect(ms).toBeLessThan(2000); // rest-jump, not 5000 live steps
  });

  it("is deterministic: same charter, same seed, same town", () => {
    const a = createTownWorld(VALLEY);
    const b = createTownWorld(VALLEY);
    a.step(200);
    b.step(200);
    expect(a.scalar("population")).toBe(b.scalar("population"));
    expect(a.scalar("farms")).toBe(b.scalar("farms"));
    expect(a.scalar("granary")).toBe(b.scalar("granary"));
  });

  it("projects a full street town: plan, goods, errands — no dual, no popusim", () => {
    const town = createTownWorld(VALLEY);
    town.step(300);

    const plan = townPlan(town, ECO, "milltown", 7);
    expect(plan.biome).toBe("farmland");
    expect(plan.houses.length).toBeGreaterThanOrEqual(6);
    expect(plan.works.some(w => w.type === "hall")).toBe(true);
    expect(plan.works.filter(w => w.type === "farm").length).toBeGreaterThan(0);

    // The street projects every ledger the settlement keeps — food and
    // tools both compiled, so both goods exist (hasLedger reads the
    // entity world the town exposes).
    const goods = streetGoods(town, ECO, { key: "milltown", center: { x: 500, y: 500 }, plan }, 7);
    expect(goods.map(g => g.good.key)).toEqual(["food", "tools"]);
    for (const g of goods) {
      const fill = g.fill();
      expect(fill).toBeGreaterThanOrEqual(0);
      expect(fill).toBeLessThanOrEqual(1);
      const errand = g.errand(plan.houses[0], 120);
      expect(Number.isFinite(errand.pos.x)).toBe(true);
      expect(Number.isFinite(errand.pos.y)).toBe(true);
      const pantry = g.pantry(plan.houses[0], 120);
      expect(pantry).toBeGreaterThanOrEqual(0);
      expect(pantry).toBeLessThanOrEqual(g.boxCap);
    }
  });
});
