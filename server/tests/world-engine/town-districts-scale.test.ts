// NEEDS-AWARE TOWN CONSTRUCTION (space-time compression meets districts.ts):
// the service radius of a district DERIVES from the served need's fill cycle —
// the intercity "a day's walk apart" law one rung down ("a need cycle's walk
// across"). A faster clock lays a denser town: more market stalls, wells past
// the plaza one. Under REAL_SCALE the radius exceeds any town, so realism
// keeps the historical village — one central market, one well on the square.
// Pure logic — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan, townPlaza } from "@shared/world-engine/kernel/town/plan.js";
import { TOWN_DIMS } from "@shared/world-engine/kernel/town/dimensions.js";
import {
  NEIGH_CONVENIENT, WELL_FOUND_MASS, foundServicePoints,
} from "@shared/world-engine/kernel/town/districts.js";
import { houseDoorstep } from "@shared/world-engine/kernel/town/goods.js";
import { roadDistance } from "@shared/world-engine/kernel/town/streets.js";
import {
  DOLLHOUSE_SCALE, REAL_SCALE, ERRAND_SHARE, ERRAND_WALK_MPS, needFillS, serviceRadiusM,
} from "@shared/world-engine/scale.js";

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

/** A grown town, big enough that its fringe lives past the street-clock radii. */
const grownTown = () => {
  const town = createTownWorld({
    economy: ECO,
    charter: { farmland: 420, ore_access: 0 },
    startPop: 120,
    seedScalars: { farms: 1 },
    key: "haywick",
  });
  town.step(250);
  return town;
};

describe("serviceRadiusM: the district sizer", () => {
  it("derives from walk speed × the need's fill cycle × the errand share", () => {
    // The dollhouse hunger cycle (240 s) at 1.6 m/s with a half-cycle
    // round-trip budget: 96 m one-way. Thirst (300 s): 120 m.
    expect(serviceRadiusM(DOLLHOUSE_SCALE, "hunger")).toBeCloseTo(
      (ERRAND_WALK_MPS * needFillS(DOLLHOUSE_SCALE, "hunger") * ERRAND_SHARE) / 2,
    );
    expect(serviceRadiusM(DOLLHOUSE_SCALE, "hunger")).toBeCloseTo(96);
    expect(serviceRadiusM(DOLLHOUSE_SCALE, "thirst")).toBeCloseTo(120);
  });

  it("a faster clock means smaller districts; realism means ONE district per town", () => {
    expect(serviceRadiusM(DOLLHOUSE_SCALE, "hunger")).toBeLessThan(serviceRadiusM(REAL_SCALE, "hunger"));
    // The real-clock radius dwarfs the hard town-radius cap — every house is
    // "served" by the plaza, and the plan founds nothing: the historical
    // village with its one market and one well.
    expect(serviceRadiusM(REAL_SCALE, "hunger")).toBeGreaterThan(TOWN_DIMS.townRMax * 10);
  });
});

describe("needs-aware plan: wells and stalls from the clock", () => {
  it("a scale-blind plan is the legacy town — no wells laid", () => {
    const plan = townPlan(grownTown(), ECO, "haywick", 11);
    expect(plan.wells).toBeUndefined();
  });

  it("the street clock founds neighborhood wells past the thirst radius", () => {
    const plan = townPlan(grownTown(), ECO, "haywick", 11, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const wells = plan.wells ?? [];
    expect(wells.length).toBeGreaterThan(0);
    // Every well stands inside the built-up town, out of the plaza's own
    // clearing — measured from the PLAZA (growth-phase-B: the widened
    // junction the plan founded), which is no longer the frame origin.
    const sq = townPlaza(plan);
    for (const w of wells) {
      expect(Math.hypot(w.x - sq.x, w.y - sq.y)).toBeGreaterThan(TOWN_DIMS.plazaR);
      expect(Math.hypot(w.x, w.y)).toBeLessThan(plan.radius + 20);
    }
  });

  it("the founded wells SERVE: rerunning the pass over the served town nearly converges", () => {
    // MOVED (growth phase C §1.4, WITH WHY). This used to assert the re-run
    // founds EXACTLY ZERO, which read as a structural guarantee and was not
    // one: after the pass ~66 of 276 households still live past the thirst
    // radius, and the pass stopped only because no single ARM's residual mass
    // still cleared WELL_FOUND_MASS. The old zero was the residual sitting a
    // hair UNDER the bar; the time-tax siting (argmin street metres) re-shapes
    // which households each well captures and one arm now sits a hair OVER it.
    //
    // What the pass actually promises is SELF-LIMITATION, so that is what is
    // pinned: a founded point really does serve, so the second pass has almost
    // nothing left to do — an order of magnitude fewer than the first.
    const town = grownTown();
    const plan = townPlan(town, ECO, "haywick", 11, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const first = plan.wells ?? [];
    expect(first.length).toBeGreaterThan(0);
    const more = foundServicePoints(plan.houses, [townPlaza(plan), ...first], plan.streets, {
      convenientM: serviceRadiusM(DOLLHOUSE_SCALE, "thirst"),
      foundMass: WELL_FOUND_MASS,
    });
    expect(more.length).toBeLessThanOrEqual(1);
    expect(more.length * 4).toBeLessThan(first.length);
  });

  it("wells cut the worst walk to water", () => {
    const town = grownTown();
    const plan = townPlan(town, ECO, "haywick", 11, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const worst = (points: Array<{ x: number; y: number }>): number => {
      let m = 0;
      for (const h of plan.houses) {
        const d0 = houseDoorstep({ x: 0, y: 0 }, h);
        let d = Infinity;
        for (const p of points) d = Math.min(d, roadDistance(plan.streets, d0, p));
        m = Math.max(m, d);
      }
      return m;
    };
    const plazaOnly = worst([townPlaza(plan)]);
    const withWells = worst([townPlaza(plan), ...(plan.wells ?? [])]);
    expect(withWells).toBeLessThan(plazaOnly);
  });

  it("the tighter hunger radius founds at least the legacy stall count", () => {
    const town = grownTown();
    const stallsOf = (p: ReturnType<typeof townPlan>): number =>
      p.works.filter((w) => w.type === "market").length;
    const legacy = townPlan(town, ECO, "haywick", 11);
    const street = townPlan(town, ECO, "haywick", 11, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    expect(serviceRadiusM(DOLLHOUSE_SCALE, "hunger")).toBeLessThan(NEIGH_CONVENIENT);
    expect(stallsOf(street)).toBeGreaterThanOrEqual(stallsOf(legacy));
  });

  it("deterministic: the same scale lays the same wells", () => {
    const a = townPlan(grownTown(), ECO, "haywick", 11, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    const b = townPlan(grownTown(), ECO, "haywick", 11, 0, undefined, [], undefined, undefined, DOLLHOUSE_SCALE);
    expect(a.wells).toEqual(b.wells);
  });

  it("REAL_SCALE lays the historical village — no wells, no stalls", () => {
    const plan = townPlan(grownTown(), ECO, "haywick", 11, 0, undefined, [], undefined, undefined, REAL_SCALE);
    expect(plan.wells).toEqual([]);
    // One market at most (the plaza's, past MARKET_MIN_HOUSES) — never a
    // demand-founded stall: under realism nobody lives past the radius.
    expect(plan.works.filter((w) => w.type === "market").length).toBeLessThanOrEqual(1);
  });
});
