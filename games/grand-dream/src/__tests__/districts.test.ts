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
import { TOWN_DIMS } from "@shared/world-engine/kernel/town/dimensions";
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

  it("founding only ever GROWS, and most of a town's stalls survive its growth", () => {
    // 🚨 RE-PINNED, growth phase C stage 2 (LOOPS). This test used to assert
    // a POSITIONAL PREFIX — `after[i].index === before[i].index` for every i —
    // and it held because the street tree's routing answers were prefix-stable:
    // a bigger town's extra streets are LEAVES, and a tree path between two
    // lots that both towns already had can never run through a leaf. So the
    // founding walk, which prices lots by `roadDistance`, replayed verbatim.
    //
    // A LINK IS NOT A LEAF. Loops only ever append (measured: a 700-slot
    // town's link list extends a 400-slot town's, 35/35 fixtures), but an
    // appended link SHORTENS a walk between two lots that both towns already
    // had — which is the entire point of cutting it — so the argmin that
    // chooses where a stall opens can legitimately move. MEASURED over 60
    // (town × growth) pairs, 12 towns from 400 slots to 450/500/600/700/850:
    //   full positional prefix still held   18/60
    //   stall count never shrank            60/60
    //   worst set survival                  56.3%
    // This is the honest price of loops and it is recorded in the phase
    // ledger; the durable fix is to persist founded service points as deltas
    // (the `foundedSlots` pipe plan.ts already takes) rather than re-deriving
    // them, which is construction's job and not streets'.
    const netSmall = growStreets(7, "metro", 400);
    const netBig = growStreets(7, "metro", 700);
    const small = grownHouses(netSmall, 400);
    const big = grownHouses(netBig, 700);
    const before = foundNeighborhoodMarkets(small, ANCHOR, netSmall);
    const after = foundNeighborhoodMarkets(big, ANCHOR, netBig);
    expect(before.length).toBeGreaterThanOrEqual(1);
    // The list only GROWS — a town that doubles never closes a shop.
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    // …and MOST of what it opened it keeps, wherever in the list it now sits.
    const survived = before.filter(s => after.some(a => a.index === s.index));
    expect(survived.length * 2).toBeGreaterThan(before.length);
    // The pass is still a pure function of its inputs (this is what the pin
    // above was really guarding: no hidden state, no run-to-run drift).
    expect(foundNeighborhoodMarkets(small, ANCHOR, netSmall).map(s => s.index))
      .toEqual(before.map(s => s.index));
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

    // RE-PINNED (growth-phase-B §1.6): the plaza market has no berth any
    // more — it is an ordinary building on the frontage lot nearest the
    // town's busiest junction, so its spot is an OUTPUT. What holds is
    // that it stands AT the plaza (inside the clearing), while the founded
    // stalls sit far out among the quarters, each on a lot no house
    // occupies any more.
    const sq = plan.plaza!;
    const plaza = markets[0];
    expect(Math.hypot(plaza.dx + plaza.w / 2 - sq.x, plaza.dy + plaza.h / 2 - sq.y))
      .toBeLessThan(TOWN_DIMS.plazaR);
    for (const m of markets.slice(1)) {
      expect(Math.hypot(m.dx + m.w / 2 - sq.x, m.dy + m.h / 2 - sq.y)).toBeGreaterThan(43);
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

  it("townPlan founding only grows, and most stalls keep their ground", () => {
    // 🚨 RE-PINNED with the pass above, and for the same measured reason:
    // once the town cuts loops, a bigger town routes its households over a
    // shorter network, so where a stall best serves its quarter is allowed
    // to move. What must not happen — a town that grows CLOSING a shop —
    // still cannot.
    const smallPlan = townPlan(fakeTri(1500), "metro", 7);
    const bigPlan = townPlan(fakeTri(3000), "metro", 7);
    const stallsOf = (p: typeof smallPlan): Array<{ dx: number; dy: number }> =>
      p.works.filter(w => w.type === "market").slice(1);
    const before = stallsOf(smallPlan);
    const after = stallsOf(bigPlan);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    const stood = before.filter(s =>
      after.some(a => Math.abs(a.dx - s.dx) < 1e-9 && Math.abs(a.dy - s.dy) < 1e-9));
    expect(stood.length * 2).toBeGreaterThan(before.length);
  });
});
