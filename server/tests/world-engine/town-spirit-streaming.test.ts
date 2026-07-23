// SPIRIT-VIEW STREAMING (the dollhouse 7 fps collapse, 2026-07-23): a spirit
// camera's visibleR covers the WHOLE town (quest-host passes
// max(240, plan.radius*2+80)), so there is no invisible open ground inside
// candidacy — the resident model's generic view-guard relocation ("walk in
// from just past the view edge") flings a body to a ring PAST candidacy and
// off the walkable town, where it is girth-rejected or culled at dwell expiry
// and re-desired forever: a spawn/despawn churn loop per body, each cycle
// re-routing its walk and rebuilding its model. Pins the fix at the shared
// resident model (kernel/town/residents.ts): candidacy covers the spawn ring
// (`peopleR`), and every in-view entry is THROUGH a concealed building —
// open-air (stall/well) trip phases enter via the body's own home, a return
// leg with no cover stays abstract, and mid-shift workers enter through
// their workplace instead of materializing on its doorstep.
import { describe, it, expect } from "@jest/globals";
import { compileEconomy, type EconomyDoc } from "@shared/world-engine/kernel/modules/economy/index.js";
import { createTownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { townPlan, type TownPlan } from "@shared/world-engine/kernel/town/plan.js";
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
  const side = plan.radius * 2 + 80; // town-stage's window
  const center = { x: side / 2, y: side / 2 };
  return { plan, center, spiritR: Math.max(240, side) }; // quest-host's spirit reach
};

/** An OPEN-AIR errand clock: every house's runner is out at a plaza stall
 *  (`source.work` undefined — nothing to enter the world through), frozen in
 *  the given phase. Only the fields the resident model reads. */
const openAirGoods = (
  center: { x: number; y: number },
  phase: () => "to_source" | "at_source" | "to_home",
): TownGoods[] => {
  const stall = { x: center.x, y: center.y };
  return [
    {
      good: { key: "food", slot: 0 },
      errand: () => ({
        phase: phase(),
        cycle: 1,
        pos: { x: stall.x + 4, y: stall.y },
        source: { x: stall.x, y: stall.y }, // no `work` — open air
        walkTo: [{ x: stall.x, y: stall.y, dwell: 5 }],
      }),
      sourceOf: () => ({ x: stall.x, y: stall.y }),
    } as unknown as TownGoods,
  ];
};

/** Inside the body's own house footprint? */
const inOwnHouse = (plan: TownPlan, center: { x: number; y: number }, houseIdx: number, pt: { x: number; y: number }): boolean => {
  const h = plan.houses.find(hh => hh.index === houseIdx)!;
  return (
    pt.x > center.x + h.dx && pt.x < center.x + h.dx + h.w &&
    pt.y > center.y + h.dy && pt.y < center.y + h.dy + h.h
  );
};

describe("spirit-view streaming — every entry is through a building, never the ring", () => {
  it("an open-air trip (to the stall) enters the world through its OWN concealed home", () => {
    const { plan, center, spiritR } = setup();
    const model = createResidentModel({ center, plan, goods: openAirGoods(center, () => "at_source"), seed: 11 });
    const far = { x: center.x + 5000, y: center.y };
    const plaza = { x: center.x, y: center.y + 8 };
    // Prime: first frame from far away (nothing in range) — the pop-in
    // guards only arm AFTER the first update.
    expect(model.update(far, 0, 8, () => null, undefined, () => false).spawn).toHaveLength(0);
    const f = model.update(plaza, 1, 8, () => null, spiritR, () => false);
    expect(f.spawn.length).toBeGreaterThan(0);
    for (const s of f.spawn) {
      // Never the wilderness ring (visibleR + 8 ≈ past the whole town):
      // every body enters INSIDE a building of the town.
      expect(Math.hypot(s.x - plaza.x, s.y - plaza.y)).toBeLessThan(plan.radius + 60);
      if (s.walkTo && s.id.match(/^resident_\d+_\d+$/)) {
        // A trip entry starts in its own concealed house and WALKS out.
        if (s.walkTo.some(pt => pt.dwell !== undefined)) {
          expect(inOwnHouse(plan, center, s.house, s)).toBe(true);
        }
      }
    }
  });

  it("a return leg (to_home) has no concealed cover — it finishes ABSTRACT, never a ring spawn", () => {
    const { plan, center, spiritR } = setup();
    const model = createResidentModel({ center, plan, goods: openAirGoods(center, () => "to_home"), seed: 11 });
    const far = { x: center.x + 5000, y: center.y };
    const plaza = { x: center.x, y: center.y + 8 };
    model.update(far, 0, 8, () => null, undefined, () => false);
    const f = model.update(plaza, 1, 8, () => null, spiritR, () => false);
    // The runners (mid-return, open air, in view) must NOT embody — and
    // whoever does (mid-shift workers through their workplace) enters
    // inside the town, never at the ring.
    const runnerIds = new Set(plan.houses.map(h => model.runnerId(h.index, 0)).filter(Boolean));
    for (const s of f.spawn) {
      expect(runnerIds.has(s.id)).toBe(false);
      expect(Math.hypot(s.x - plaza.x, s.y - plaza.y)).toBeLessThan(plan.radius + 60);
    }
  });

  it("no churn: over a sim-minute nobody re-embodies more than a couple of times", () => {
    const { plan, center, spiritR } = setup();
    const model = createResidentModel({ center, plan, goods: openAirGoods(center, () => "at_source"), seed: 11 });
    const plaza = { x: center.x, y: center.y + 8 };
    const live = new Map<string, { x: number; y: number }>();
    const spawns = new Map<string, number>();
    for (let t = 0; t <= 60; t += 0.5) {
      const f = model.update(plaza, t, 8, id => live.get(id) ?? null, spiritR, () => false);
      for (const s of f.spawn) {
        live.set(s.id, { x: s.x, y: s.y });
        spawns.set(s.id, (spawns.get(s.id) ?? 0) + 1);
      }
      for (const id of f.despawn) live.delete(id);
    }
    // The bug signature was a body respawning every ABSTRACT_HOLD beat
    // (~20+/minute); legitimate streaming embodies once, maybe twice.
    for (const [, n] of spawns) expect(n).toBeLessThanOrEqual(2);
    expect(spawns.size).toBeGreaterThan(0);
  });
});
