// CIVIC RECRUITMENT (construction pipeline ⑥), the kernel half — THE BUSY
// PIN on the resident streamer: a street body the host has claimed for real
// work (a pooled civic task, a moving haul) is NEVER culled while it works,
// however far it walks (a hauler vanishing mid-carry strands its agreement),
// and the clock hands it no fresh trips or commutes (the host owns its
// feet). The frame the work ends, the normal cull resumes. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan } from "@shared/world-engine/kernel/town/plan.js";
import type { TownGoods } from "@shared/world-engine/kernel/town/goods.js";
import { createResidentModel } from "@shared/world-engine/kernel/town/residents.js";

const DOC: EconomyDoc = {
  stockpiles: [{ key: "granary", max: 400, construction: true }],
  commodities: [
    {
      key: "food", scalarMax: 200, perPersonDaily: 0.001,
      transport: { drift: "granary", driftRequiresConstruction: true },
      street: {
        capDays: 3, shopSec: 18, cartRations: 25, unit: "rations", producers: ["farm"], market: true,
        stockColor: "#e0b25c", boxLabel: "Pantry", errandName: "shopping",
      },
    },
  ],
  buildings: [
    {
      key: "farm", countScalar: "farms", cap: { by: "farmland", rate: 1 / 60 },
      processes: [
        { id: "farm", input: "farmland", output: "grain_out", efficiency: 0.08, capacityRate: 5 },
        { id: "mill", input: "grain_out", output: "food_out", efficiency: 1 },
      ],
      vars: [{ name: "grain_out", max: 200 }],
      construction: { tier: "base", costs: [{ stockpile: "granary", amount: 20 }] },
      sells: ["food"], leansToward: "fertility", mapCap: 8, district: "farm",
      style: { color: "#7d9c53", w: 18, h: 12 }, vignette: { w: 5, h: 4 },
      glyph: "🌾", title: "🌾 Farmstead", info: ["{farms} farms."],
    },
  ],
};
const ECO = compileEconomy([DOC], { construction: true });

/** A mid-trip errand clock — every runner is out on the street, so bodies
 *  embody by plain proximity. The CYCLE advances every 100 s, so a fresh
 *  trip becomes due each century mark (the once-per-cycle gate opens). */
const streetGoods = (center: { x: number; y: number }): TownGoods[] => {
  const stall = { x: center.x, y: center.y };
  return [
    {
      good: { key: "food", slot: 0 },
      errand: (_h: unknown, now: number) => ({
        phase: "to_source" as const,
        cycle: Math.floor(now / 100),
        pos: { x: stall.x + 4, y: stall.y },
        source: { x: stall.x, y: stall.y },
        walkTo: [{ x: stall.x, y: stall.y, dwell: 5 }],
      }),
      sourceOf: () => ({ x: stall.x, y: stall.y }),
    } as unknown as TownGoods,
  ];
};

const setup = () => {
  const town = createTownWorld({
    economy: ECO,
    charter: { farmland: 420, ore_access: 0 },
    startPop: 120,
    seedScalars: { farms: 1 },
    key: "haywick",
  });
  town.step(250);
  const plan = townPlan(town, ECO, "haywick", 11);
  const side = plan.radius * 2 + 80;
  const center = { x: side / 2, y: side / 2 };
  const model = createResidentModel({ center, plan, goods: streetGoods(center), seed: 11 });
  // First frame: mid-errand clocks populate the streets around the plaza.
  const f0 = model.update(center, 0, 8, () => null);
  expect(f0.spawn.length).toBeGreaterThan(0);
  return { model, center, worker: f0.spawn[0]!.id };
};

describe("the busy pin (⑥ — recruited civic workers)", () => {
  it("a busy body is NEVER culled, however far it hauls; the cull resumes when freed", () => {
    const { model, center, worker } = setup();
    // The recruited hauler walked FAR outside candidacy (past peopleR, out
    // of view) — position reported live, well past every despawn band.
    const farPos = { x: center.x + 4000, y: center.y };
    const at = (id: string) => (id === worker ? farPos : null);
    // Past the embodiment dwell (now = 100), busy: it must keep its body.
    const busy = model.update(center, 100, 8, at, 120, () => false, undefined, undefined, (id) => id === worker);
    expect(busy.despawn).not.toContain(worker);
    // Same frame shape, work done: the normal cull takes it.
    const freed = model.update(center, 200, 8, at, 120, () => false, undefined, undefined, () => false);
    expect(freed.despawn).toContain(worker);
  });

  it("a busy body takes no fresh trips — the host owns its feet", () => {
    const { model, center } = setup();
    const at = () => ({ x: center.x + 10, y: center.y });
    // A NEW cycle opens (now crosses 100) with everyone busy ⇒ the clock
    // issues NOBODY a shopping trip.
    const allBusy = model.update(center, 150, 8, at, 120, () => false, undefined, undefined, () => true);
    expect(allBusy.trips).toHaveLength(0);
    // The next cycle opens with everyone free ⇒ street trips flow again.
    const free = model.update(center, 250, 8, at, 120, () => false, undefined, undefined, () => false);
    expect(free.trips.length).toBeGreaterThan(0);
  });
});
