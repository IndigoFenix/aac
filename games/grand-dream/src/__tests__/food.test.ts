/**
 * The street-level food economy (food.ts) — an ADD-ON to PopuSim's
 * abstract consume behavior. The aggregate already decides how much food
 * a site needs (trait-declared demand → food_need) and how much arrived
 * (flow net → food_got); these tests prove the street projection renders
 * exactly those numbers: markets where towns are big, pantry boxes that
 * hold fill × capacity, trips that come MORE often under scarcity
 * (inelastic demand — quantity adjusts, there is no price), and streamed
 * residents who spawn mid-errand doing what the numbers say.
 */

import { describe, expect, it } from "vitest";
import { buildAcceptanceTri } from "../tri-worlds";
import {
  FOOD_DAY_SEC, HOUSEHOLD, PANTRY_CAP, PANTRY_DAYS, createTownFood,
} from "../food";
import {
  MARKET_MIN_HOUSES, PEOPLE_R, createTownManager, townPlan, worldPos,
  type TownHouse, type TownPlan,
} from "../zoom";
import type { TriWorld } from "../tri";

/** A tri stub exposing just the two scalars the projection reads. */
const triWith = (need: number, got: number): TriWorld =>
  ({
    dual: {
      settlementScalar: (_k: string, s: string): number =>
        s === "food_need" ? need : s === "food_got" ? got : 0,
    },
  }) as unknown as TriWorld;

const house = (index: number, dx: number, dy: number): TownHouse =>
  ({ index, dx, dy, w: 7, h: 5, door: "south", color: "#a8875f" });

/** A synthetic plan: a ring of houses around a plaza market, farm far out. */
const marketPlan = (houses = 30): TownPlan => ({
  key: "stub", biome: "farmland", groundColor: "#8fae62", radius: 120,
  houses: Array.from({ length: houses }, (_, i) => {
    const a = (i / houses) * Math.PI * 2;
    return house(i, Math.cos(a) * 45 - 3.5, Math.sin(a) * 45 - 2.5);
  }),
  works: [
    { type: "hall", dx: -8, dy: -40, w: 16, h: 12, door: "south", color: "#8a6d3b" },
    { type: "market", dx: -8, dy: 28, w: 16, h: 10, door: "north", color: "#c9803a" },
    { type: "farm", dx: 300, dy: 0, w: 13, h: 9, door: "west", color: "#c9a94e" },
  ],
  fields: [],
});

describe("street-level food economy (add-on to the consume behavior)", () => {
  it("a town past the market threshold gets a plaza market; riverton has one", async () => {
    const a = await buildAcceptanceTri(42);
    const plan = townPlan(a.tri, "riverton", 7);
    expect(plan.houses.length).toBeGreaterThan(MARKET_MIN_HOUSES);
    const market = plan.works.find(w => w.type === "market");
    expect(market).toBeDefined();
    // INSIDE the plaza (clear of the plaza ring road at 22), fronting
    // the south street mouth; the hall backs onto it fronting north.
    expect(market!.door).toBe("south");
    const corners = [
      [market!.dx, market!.dy], [market!.dx + market!.w, market!.dy],
      [market!.dx, market!.dy + market!.h], [market!.dx + market!.w, market!.dy + market!.h],
    ];
    for (const [cx, cy] of corners) expect(Math.hypot(cx, cy)).toBeLessThan(22);
    expect(plan.works.find(w => w.type === "hall")!.door).toBe("north");
  });

  it("sources fall back logically: market → farm gate → the hall (imports)", () => {
    const tri = triWith(10, 10);
    const center = { x: 0, y: 0 };

    // Market present: ring houses shop there, not at the distant farm.
    const withMarket = createTownFood(tri, { key: "stub", center, plan: marketPlan() }, 7);
    expect(withMarket.sources.some(s => s.kind === "market")).toBe(true);
    expect(withMarket.sourceOf(marketPlan().houses[0]).kind).toBe("market");
    expect(withMarket.marketServed()).toBe(30);

    // No market (small town): the farm gate sells.
    const farmOnly: TownPlan = { ...marketPlan(6), works: marketPlan().works.filter(w => w.type !== "market") };
    const farmFood = createTownFood(tri, { key: "stub", center, plan: farmOnly }, 7);
    expect(farmFood.sourceOf(farmOnly.houses[0]).kind).toBe("farm");
    expect(farmFood.marketStock(0)).toBe(0);

    // Neither (a mining town living off the roads): rations at the hall.
    const hallOnly: TownPlan = {
      ...marketPlan(6),
      works: marketPlan().works.filter(w => w.type === "hall"),
    };
    const hallFood = createTownFood(tri, { key: "stub", center, plan: hallOnly }, 7);
    expect(hallFood.sources).toHaveLength(1);
    expect(hallFood.sources[0].kind).toBe("hall");
  });

  it("fill anchors everything: pantries hold fill × capacity, shelves scale with fill, scarcity means MORE trips", () => {
    const center = { x: 0, y: 0 };
    const plan = marketPlan();
    const full = createTownFood(triWith(10, 10), { key: "stub", center, plan }, 7);
    const lean = createTownFood(triWith(10, 2.5), { key: "stub", center, plan }, 7);
    expect(full.fill()).toBe(1);
    expect(lean.fill()).toBe(0.25);
    expect(PANTRY_CAP).toBe(HOUSEHOLD * PANTRY_DAYS);

    const h = plan.houses[3];
    const maxPantry = (f: typeof full): number => {
      let m = 0;
      for (let t = 0; t < PANTRY_DAYS * FOOD_DAY_SEC * 2; t += 5) m = Math.max(m, f.pantry(h, t));
      return m;
    };
    // The box refills to fill × capacity — never above, visibly less when lean.
    expect(maxPantry(full)).toBeLessThanOrEqual(PANTRY_CAP + 1e-9);
    expect(maxPantry(full)).toBeGreaterThan(PANTRY_CAP * 0.9);
    expect(maxPantry(lean)).toBeLessThanOrEqual(PANTRY_CAP * 0.25 + 1e-9);

    // Inelastic demand: the household still eats HOUSEHOLD rations a day,
    // so when each trip nets a quarter, trips come ~4× as often.
    const trips = (f: typeof full): number => {
      const T = 6 * PANTRY_DAYS * FOOD_DAY_SEC;
      return f.errand(h, T).cycle - f.errand(h, 0).cycle;
    };
    expect(trips(lean)).toBeGreaterThan(trips(full) * 2.5);

    // The market's day: stocked just over the served daily draw at dawn,
    // drawn down across the day; the whole curve scales with fill.
    const daily = 30 * HOUSEHOLD;
    let hi = 0, lo = Infinity, hiLean = 0;
    for (let t = 0; t < FOOD_DAY_SEC; t += 2) {
      hi = Math.max(hi, full.marketStock(t));
      lo = Math.min(lo, full.marketStock(t));
      hiLean = Math.max(hiLean, lean.marketStock(t));
    }
    expect(hi).toBeGreaterThan(daily);
    expect(hi).toBeLessThanOrEqual(daily * 1.15 + 1e-9);
    expect(lo).toBeLessThan(daily * 0.25);
    expect(hiLean).toBeLessThan(hi * 0.3);
  });

  it("the shopping cycle is a deterministic loop: home → to market → at the stall → home, box empty while out", () => {
    const plan = marketPlan();
    const food = createTownFood(triWith(10, 10), { key: "stub", center: { x: 0, y: 0 }, plan }, 7);
    const h = plan.houses[0];
    const src = food.sourceOf(h);

    const seen = new Set<string>();
    for (let t = 0; t < PANTRY_DAYS * FOOD_DAY_SEC * 1.2; t += 2) {
      const e = food.errand(h, t);
      expect(JSON.stringify(food.errand(h, t))).toBe(JSON.stringify(e)); // pure
      seen.add(e.phase);
      if (e.phase === "home") {
        expect(e.walkTo).toBeNull();
        expect(e.pos).toEqual(e.home);
      } else {
        // Out shopping: the box at home is empty — that's WHY they went.
        expect(food.pantry(h, t)).toBe(0);
        const wt = e.walkTo!;
        const last = wt[wt.length - 1];
        expect(Math.hypot(last.x - e.home.x, last.y - e.home.y)).toBeLessThan(0.01);
        if (e.phase === "at_source") expect(e.pos).toEqual({ x: src.x, y: src.y });
        // Outbound: the route still passes the stall before turning home.
        if (e.phase === "to_source") {
          expect(wt.some(p => Math.hypot(p.x - src.x, p.y - src.y) < 0.6)).toBe(true);
        }
      }
    }
    expect([...seen].sort()).toEqual(["at_source", "home", "to_home", "to_source"]);
  });

  it("streams into the world: residents spawn mid-errand, and embodied ones are sent shopping when their box runs dry", async () => {
    const a = await buildAcceptanceTri(42);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const home = worldPos(rc.x, rc.y);

    // Somewhere in the first few domestic days there is a moment when one
    // of the six nearest residents is mid-trip — a FRESH manager at that
    // moment must embody them EN ROUTE, with the rest of the trip attached.
    let midTrip: { id: string; walkTo: Array<{ x: number; y: number }> } | null = null;
    for (let t = 0; t < PANTRY_DAYS * FOOD_DAY_SEC * 2 && !midTrip; t += 15) {
      const d = createTownManager(a.tri, 7, () => 6).update(home, undefined, t);
      const sp = d.spawn.find(x => x.walkTo);
      if (sp) midTrip = { id: sp.npc.id, walkTo: sp.walkTo! };
    }
    expect(midTrip).not.toBeNull();
    expect(midTrip!.walkTo.length).toBeGreaterThan(0);

    // Live trips: hold six residents embodied and let the clock run —
    // pantries drain, and the manager sends them out (source, then home),
    // each exactly once per cycle.
    const mgr = createTownManager(a.tri, 7, () => 6);
    const first = mgr.update(home, undefined, 0);
    const live = new Map(first.spawn.map(({ npc: n }) => [n.id, { x: n.x, y: n.y }]));
    const sentAt = new Map<string, number[]>();
    for (let t = 10; t < PANTRY_DAYS * FOOD_DAY_SEC * 1.5; t += 10) {
      const d = mgr.update(home, live, t);
      for (const e of d.errands) {
        expect(live.has(e.id)).toBe(true);
        // A road route out and back — at least there-and-home.
        expect(e.points.length).toBeGreaterThanOrEqual(2);
        sentAt.set(e.id, [...(sentAt.get(e.id) ?? []), t]);
      }
    }
    expect(sentAt.size).toBeGreaterThan(0);
    // Once per CYCLE: two trips for the same person are a full pantry
    // apart, never back-to-back re-issues of the same window.
    for (const times of sentAt.values()) {
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThan(100);
    }
    expect(PEOPLE_R).toBeGreaterThan(0); // radii still exported/coherent
  });
});
