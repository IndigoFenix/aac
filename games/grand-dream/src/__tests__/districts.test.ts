/**
 * Neighborhood markets (districts.ts) — city-development.md §7 step 1.
 * Markets are FOUNDED BY UNSERVED DEMAND instead of granted one-per-town:
 * households too far (by street) from any source accumulate founding mass
 * in their quarter, a pending lot converts into a stall where the mass
 * centers, and food catchments bind each house to ITS market. Founding is
 * prefix-stable (growth appends stalls, never moves known ones).
 */

import { describe, expect, it } from "vitest";
import { foundNeighborhoodMarkets, NEIGH_FOUND_MASS } from "../districts";
import { createTownFood, houseDoorstep } from "../food";
import { growStreets, roadRoute, routeLength, type TownStreets } from "../streets";
import { MARKET_MIN_HOUSES, townPlan, type TownHouse } from "../zoom";
import type { TriWorld } from "../tri";

/** Houses on a grown street tree's frontage slots (no jitter — the
 *  founding rule cares about street distance, not wobble). */
function grownHouses(net: TownStreets, count: number): TownHouse[] {
  const houses: TownHouse[] = [];
  for (let k = 0; k < count && k < net.slots.length; k++) {
    const slot = net.slots[k];
    const fdx = slot.ax - slot.x;
    const fdy = slot.ay - slot.y;
    const door: TownHouse["door"] =
      Math.abs(fdx) > Math.abs(fdy) ? (fdx > 0 ? "east" : "west") : (fdy > 0 ? "south" : "north");
    const sideways = door === "east" || door === "west";
    const w = sideways ? 5.5 : 8;
    const h = sideways ? 8 : 5.5;
    houses.push({
      index: k, dx: slot.x - w / 2, dy: slot.y - h / 2, w, h, door,
      color: "#a8875f", floors: 1, arm: slot.arm,
    });
  }
  return houses;
}

/** Town-local doorstep of the plaza market (zoom.ts places it at dy 6.5,
 *  h 10, door south → doorstep 1.5 m past the south edge). */
const ANCHOR = { x: 0, y: 18 };

/** Just enough tri for townPlan + createTownFood: a farmland town of
 *  `pop` souls, comfortably fed (fill = 1). */
const fakeTri = (pop: number): TriWorld =>
  ({
    cities: [{ key: "metro", x: 40, y: 30 }],
    charterOf: () => ({ farmland: 240, ore_access: 30, timberland: 100 }),
    dual: {
      settlementScalar: (_k: string, f: string): number =>
        ({ population: pop, farms: 4, mines: 0, smelters: 0, food_need: pop / 1000, food_got: pop / 1000 }[f] ?? 0),
    },
  }) as unknown as TriWorld;

describe("neighborhood market founding (city fractal step 1)", () => {
  it("a big town founds stalls in its far quarters, each a converted lot", () => {
    const net = growStreets(7, "metro", 400);
    const houses = grownHouses(net, 400);
    const stalls = foundNeighborhoodMarkets(houses, ANCHOR, net);
    expect(stalls.length).toBeGreaterThanOrEqual(2);
    // Self-limiting: roughly one stall per NEIGH_FOUND_MASS of unserved
    // households, never one per house.
    expect(stalls.length).toBeLessThanOrEqual(Math.ceil(houses.length / NEIGH_FOUND_MASS));
    for (const s of stalls) {
      expect(houses).toContain(s); // identity: stalls ARE input lots
      // Founded out along the arms (the unserved zone), not downtown.
      expect(Math.hypot(s.dx + s.w / 2, s.dy + s.h / 2)).toBeGreaterThan(50);
    }
  });

  it("founding is prefix-stable: a grown town keeps its old stalls and appends", () => {
    // The nets themselves are prefix-stable (streets.ts), so the small
    // town's founding decisions replay identically inside the big one.
    const netSmall = growStreets(7, "metro", 400);
    const netBig = growStreets(7, "metro", 700);
    const small = grownHouses(netSmall, 400);
    const big = grownHouses(netBig, 700);
    const before = foundNeighborhoodMarkets(small, ANCHOR, netSmall);
    const after = foundNeighborhoodMarkets(big, ANCHOR, netBig);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    before.forEach((s, i) => expect(after[i].index).toBe(s.index));
  });

  it("stalls actually shorten the walk: mean street distance to food drops", () => {
    const net = growStreets(7, "metro", 400);
    const houses = grownHouses(net, 400);
    const stalls = foundNeighborhoodMarkets(houses, ANCHOR, net);
    const origin = { x: 0, y: 0 };
    const nearest = (h: TownHouse, sources: Array<{ x: number; y: number }>): number => {
      const hd = houseDoorstep(origin, h);
      let d = Infinity;
      for (const s of sources) d = Math.min(d, routeLength(roadRoute(net, hd, s)));
      return d;
    };
    const withStalls = [ANCHOR, ...stalls.map(s => houseDoorstep(origin, s))];
    let plazaOnly = 0;
    let polycentric = 0;
    for (const h of houses) {
      plazaOnly += nearest(h, [ANCHOR]);
      polycentric += nearest(h, withStalls);
    }
    expect(polycentric).toBeLessThan(plazaOnly * 0.8);
  });

  it("townPlan integrates: polycentric markets, converted lots, per-stall stock", () => {
    const tri = fakeTri(3000);
    const plan = townPlan(tri, "metro", 7);
    expect(plan.houses.length).toBeGreaterThan(MARKET_MIN_HOUSES);
    const markets = plan.works.filter(w => w.type === "market");
    expect(markets.length).toBeGreaterThan(1);

    // The plaza market keeps its shipped spot; stalls sit out among the
    // rings, each on a lot no house occupies anymore.
    const plaza = markets[0];
    expect(plaza.dx).toBe(-10); // -marketW/2 (dimensions.ts)
    expect(plaza.dy).toBe(8); // plazaClear
    for (const m of markets.slice(1)) {
      expect(Math.hypot(m.dx + m.w / 2, m.dy + m.h / 2)).toBeGreaterThan(43);
      expect(plan.houses.some(h => h.dx === m.dx && h.dy === m.dy)).toBe(false);
    }

    // Street-distance catchments: more than one market actually serves
    // houses, and each stall's shelf carries its catchment's share.
    const food = createTownFood(tri, { key: "metro", center: { x: 0, y: 0 }, plan }, 7);
    const bound = new Set(plan.houses.map(h => food.sourceOf(h)).filter(s => s.kind === "market"));
    expect(bound.size).toBeGreaterThan(1);
    const t = 37;
    const sum = food.sources.reduce((a, s) => a + food.stockOf(s, t), 0);
    expect(sum).toBeCloseTo(food.marketStock(t), 9);
    const farm = food.sources.find(s => s.kind === "farm");
    expect(farm).toBeDefined();
    expect(food.stockOf(farm!, t)).toBe(0);
  });

  it("townPlan founding is prefix-stable across population growth", () => {
    const smallPlan = townPlan(fakeTri(1500), "metro", 7);
    const bigPlan = townPlan(fakeTri(3000), "metro", 7);
    const stallsOf = (p: typeof smallPlan): Array<{ dx: number; dy: number }> =>
      p.works.filter(w => w.type === "market").slice(1);
    const before = stallsOf(smallPlan);
    const after = stallsOf(bigPlan);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    before.forEach((s, i) => {
      expect(after[i].dx).toBeCloseTo(s.dx, 9);
      expect(after[i].dy).toBeCloseTo(s.dy, 9);
    });
  });
});
