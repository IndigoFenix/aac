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
  FOOD_DAY_SEC, FOOD_GOOD, HOUSEHOLD, PANTRY_CAP, PANTRY_DAYS, SURPLUS_FRAC_MAX,
  createTownFood, createTownGoods, pantryBoxAt, workDoorstep, type GoodSpec,
} from "../food";
import { PLAZA_R, growStreets, project } from "../streets";
import {
  MARKET_MIN_HOUSES, PEOPLE_R, createTownManager, houseIndexOf, townPlan, villagerOf,
  worldPos, type TownHouse, type TownPlan,
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
  ({ index, dx, dy, w: 7, h: 5, door: "south", color: "#a8875f", floors: 1 });

/** A grown street net for the synthetic plans (source selection rides
 *  street distance, so even a stub plan needs streets to walk). */
const STUB_NET = growStreets(7, "stub", 40);

/** A synthetic plan: a ring of houses around a plaza market, farm far out. */
const marketPlan = (houses = 30): TownPlan => ({
  key: "stub", biome: "farmland", groundColor: "#8fae62", radius: 120,
  want: houses, built: houses, streets: STUB_NET,
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
    // RE-PINNED (growth-phase-B §1.6): there is no plaza RING and no
    // berth inside it. The market and the hall are ordinary buildings on
    // the frontage lots nearest the town's busiest junction — so what is
    // pinned is that they stand AT the plaza (a footprint's reach of the
    // clearing) and FRONT their own street, not that they sit at fixed
    // coordinates facing south and north.
    const sq = plan.plaza!;
    const hall = plan.works.find(w => w.type === "hall")!;
    for (const wk of [market!, hall]) {
      const corners = [
        [wk.dx, wk.dy], [wk.dx + wk.w, wk.dy],
        [wk.dx, wk.dy + wk.h], [wk.dx + wk.w, wk.dy + wk.h],
      ];
      for (const [cx, cy] of corners) {
        expect(Math.hypot(cx - sq.x, cy - sq.y)).toBeLessThan(PLAZA_R + Math.hypot(wk.w, wk.h) / 2);
      }
      // Its door opens onto a street a step away, like any other building.
      expect(project(plan.streets, workDoorstep({ x: 0, y: 0 }, wk)).d).toBeLessThan(9);
    }
    // They are DIFFERENT lots — the square has two sides, not one berth.
    expect(market!.dx !== hall.dx || market!.dy !== hall.dy).toBe(true);
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
    // so when each trip nets a quarter, trips come more often (up to 4× —
    // the walk-time floor caps how often a long trip CAN repeat).
    // RE-PINNED (growth-phase-B): 1.4×, not 2×. This is a SYNTHETIC plan —
    // a ring of houses at r=45 that never sat on the street tree at all;
    // the retired plaza ring road happened to run right under it, so the
    // walk was short. On the seeded net this house walks 163 street metres
    // to its market and the walk-time floor (which this pin's own comment
    // names as the cap) binds first. A fixture artifact, not a kernel
    // regression: the real towns' houses stand ON their frontage.
    const trips = (f: typeof full): number => {
      const T = 6 * PANTRY_DAYS * FOOD_DAY_SEC;
      return f.errand(h, T).cycle - f.errand(h, 0).cycle;
    };
    expect(trips(lean)).toBeGreaterThan(trips(full) * 1.4);

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

  it("the shopping cycle is a deterministic loop: home → to a market STAND → home, box empty while out", () => {
    const plan = marketPlan();
    const food = createTownFood(triWith(10, 10), { key: "stub", center: { x: 0, y: 0 }, plan }, 7);
    const h = plan.houses[0];
    const src = food.sourceOf(h);
    // The household shops at ONE of the market's stands (spread along the
    // stall so the crowd doesn't pile in a corner), not the door point.
    const stands = food.stands(src);
    expect(stands.length).toBeGreaterThan(1);
    const near = (p: { x: number; y: number }): boolean =>
      stands.some(s => Math.hypot(p.x - s.x, p.y - s.y) < 0.01);

    const seen = new Set<string>();
    for (let t = 0; t < PANTRY_DAYS * FOOD_DAY_SEC * 1.2; t += 2) {
      const e = food.errand(h, t);
      expect(JSON.stringify(food.errand(h, t))).toBe(JSON.stringify(e)); // pure
      seen.add(e.phase);
      if (e.phase === "home") {
        expect(e.walkTo).toBeNull();
        expect(e.pos).toEqual(e.home);
      } else {
        // Out shopping: the box at home has run LOW — down toward the
        // household's SURPLUS BUFFER (§13a; en route it still holds the
        // buffer plus the trip's not-yet-eaten margin, never half-full).
        // That's WHY they went.
        expect(food.pantry(h, t)).toBeLessThan(food.boxCap * (SURPLUS_FRAC_MAX + 0.15));
        const wt = e.walkTo!;
        const last = wt[wt.length - 1];
        expect(Math.hypot(last.x - e.home.x, last.y - e.home.y)).toBeLessThan(0.01);
        // At the stall: standing at ONE stand (the same one all cycle).
        if (e.phase === "at_source") expect(near(e.pos)).toBe(true);
        // Outbound: the route still reaches that stand before turning home.
        if (e.phase === "to_source") {
          expect(wt.some(p => near(p))).toBe(true);
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
    // each exactly once per cycle. The bodies are parked on open plaza
    // ground beside the player: an OUTDOOR body beside you holds its
    // slot (indoor idlers yield theirs to street life).
    const plan = townPlan(a.tri, "riverton", 7);
    const mgr = createTownManager(a.tri, 7, () => 6);
    const first = mgr.update(home, undefined, 0);
    const live = new Map(first.spawn.map(({ npc: n }, i) => [n.id, { x: home.x + 2 + i * 1.5, y: home.y }]));
    const sentAt = new Map<string, number[]>();
    for (let t = 10; t < PANTRY_DAYS * FOOD_DAY_SEC * 1.5; t += 10) {
      const d = mgr.update(home, live, t);
      for (const e of d.errands) {
        expect(live.has(e.id)).toBe(true);
        // A road route out and back — at least there-and-home.
        expect(e.points.length).toBeGreaterThanOrEqual(2);
        // Bracketed by DOOR TRANSITS: the trip leaves through the
        // shopper's own door and returns through it (the first waypoint
        // and the second-to-last are the SAME spot just inside their
        // door — the wall is crossed at the doorway, not ground into),
        // while the stall dwell in the middle is far away. The FINAL
        // waypoint is the pantry box itself: reaching it is what fills
        // the crate.
        const p0 = e.points[0];
        const pIn = e.points[e.points.length - 2];
        const pN = e.points[e.points.length - 1];
        expect(Math.hypot(p0.x - pIn.x, p0.y - pIn.y)).toBeLessThan(0.01);
        const who = villagerOf(e.id)!;
        const h = plan.houses.find(x => x.index === houseIndexOf(who.index))!;
        const box = pantryBoxAt(home, h);
        expect(Math.hypot(pN.x - box.x, pN.y - box.y)).toBeLessThan(0.01);
        expect(pN.dwell).toBeGreaterThan(0);
        const dwell = e.points.find(pt => pt.dwell !== undefined)!;
        expect(Math.hypot(dwell.x - p0.x, dwell.y - p0.y)).toBeGreaterThan(5);
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

describe("the witnessed pantry (boxes fill when the shopper reaches them, not by the clock)", () => {
  it("holds a refill for the real body and commits it at the actual arrival, however late", async () => {
    const a = await buildAcceptanceTri(42);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const home = worldPos(rc.x, rc.y);
    const mgr = createTownManager(a.tri, 7, () => 6);
    const first = mgr.update(home, undefined, 0);
    // Outdoor bodies beside the player hold their slots — the witness
    // needs the shopper to stay embodied across their trip.
    const live = new Map(first.spawn.map(({ npc: n }, i) => [n.id, { x: home.x + 2 + i * 1.5, y: home.y }]));
    const town = mgr.loaded().find(t => t.key === "riverton")!;

    // Walk the clock until a trip is issued to one of them.
    let sent: { id: string; t: number } | null = null;
    for (let t = 10; !sent && t < PANTRY_DAYS * FOOD_DAY_SEC * 2; t += 10) {
      const d = mgr.update(home, live, t);
      if (d.errands.length) sent = { id: d.errands[0].id, t };
    }
    expect(sent).not.toBeNull();
    const who = villagerOf(sent!.id)!;
    const house = town.plan.houses.find(h => h.index === houseIndexOf(who.index))!;
    const { period, trip, offset } = town.food.cycle(house);
    const cyc = Math.floor((sent!.t + offset) / period);

    // A moment when the CLOCK says the box already refilled...
    const tFull = cyc * period - offset + trip + 5;
    expect(town.food.pantry(house, tFull)).toBeGreaterThan(0);
    // ...but the witness holds it empty: the real body hasn't arrived.
    expect(mgr.pantry(town, house, tFull)).toBe(0);

    // The shopper reaches the crate 40 s late (steering, door jams):
    // the box fills THEN — one full boxful — and decays from that
    // moment at the closed form's own rate.
    mgr.tripArrived(sent!.id, tFull + 40);
    const filled = mgr.pantry(town, house, tFull + 40);
    expect(filled).toBeCloseTo(town.food.fillOf(house) * PANTRY_CAP, 5);
    const halfway = mgr.pantry(town, house, tFull + 40 + (period - trip) / 2);
    expect(halfway).toBeCloseTo(filled / 2, 1);
  });

  it("a watched box never fills on its own — it catches up only once the player looks away", async () => {
    const a = await buildAcceptanceTri(42);
    const rc = a.tri.cities.find(c => c.key === "riverton")!;
    const home = worldPos(rc.x, rc.y);
    const mgr = createTownManager(a.tri, 7, () => 0); // nobody embodies
    mgr.update(home, undefined, 0, 600); // the player sees 600 m around
    const town = mgr.loaded().find(t => t.key === "riverton")!;
    const house = town.plan.houses[0]; // plaza-adjacent: well inside view
    const { period, trip, offset } = town.food.cycle(house);
    const crossT = period + trip - offset; // cycle 1's clock-refill moment

    // Watched continuously across the flip (display calls every ~1 s):
    // the closed form refills, the box on screen does NOT.
    expect(mgr.pantry(town, house, crossT - 1)).toBe(0);
    expect(town.food.pantry(house, crossT + 1)).toBeGreaterThan(0);
    expect(mgr.pantry(town, house, crossT + 1)).toBe(0);
    expect(mgr.pantry(town, house, crossT + 2)).toBe(0);

    // The player walks out of sight (still in town-data range): the next
    // look finds the off-screen truth caught up.
    mgr.update({ x: home.x + 900, y: home.y }, undefined, crossT + 30, 600);
    expect(mgr.pantry(town, house, crossT + 30)).toBeGreaterThan(0);

    // Priming: a box FIRST seen mid-decay reads the closed form straight
    // away — deferral is for flips that happen before the player's eyes,
    // not a fake empty on arrival in town.
    const fresh = createTownManager(a.tri, 7, () => 0);
    fresh.update(home, undefined, crossT + 60, 600);
    const ftown = fresh.loaded().find(t => t.key === "riverton")!;
    const fhouse = ftown.plan.houses[0];
    expect(fresh.pantry(ftown, fhouse, crossT + 60)).toBeGreaterThan(0);
  });
});

describe("the good descriptor (food is just the first instance)", () => {
  /** A second commodity: sold only at the hall counter (no shelves),
   *  drawn slowly, hoarded long — clothing-shaped, none of food's
   *  numbers. */
  const CLOTH: GoodSpec = {
    key: "cloth",
    needScalar: "cloth_need",
    gotScalar: "cloth_got",
    sellers: ["hall"],
    shelved: [],
    producers: ["farm"],
    perCapitaDaily: 0.05,
    capDays: 40,
    shopSec: 30,
    cartRations: 60,
  };
  const triCloth = (need: number, got: number): TriWorld =>
    ({
      dual: {
        settlementScalar: (_k: string, s: string): number =>
          s === "cloth_need" ? need : s === "cloth_got" ? got : 0,
      },
    }) as unknown as TriWorld;

  it("a non-food good reads ITS scalars, sells at ITS counters, sizes ITS boxes", () => {
    const center = { x: 0, y: 0 };
    const plan = marketPlan();
    const cloth = createTownGoods(triCloth(10, 5), { key: "stub", center, plan }, 7, CLOTH);

    // Fill comes from cloth scalars — the food stub would read 0 need ⇒ 1.
    expect(cloth.fill()).toBe(0.5);
    // Sources: the hall counter, not the market or the farm gate.
    expect(cloth.sources).toHaveLength(1);
    expect(cloth.sources[0].kind).toBe("hall");
    // No shelves anywhere: nothing is dawn-stocked.
    expect(cloth.marketStock(0)).toBe(0);
    expect(cloth.stallDaily(cloth.sources[0])).toBe(0);
    // Box capacity follows the descriptor, not PANTRY_CAP.
    expect(cloth.boxCap).toBeCloseTo(HOUSEHOLD * 40 * 0.05, 9);
    expect(cloth.boxCap).not.toBe(PANTRY_CAP);

    const h = plan.houses[3];
    let hi = 0;
    const { period } = cloth.cycle(h);
    for (let t = 0; t < period * 2; t += period / 50) hi = Math.max(hi, cloth.pantry(h, t));
    expect(hi).toBeLessThanOrEqual(cloth.boxCap + 1e-9);
    expect(hi).toBeGreaterThan(0);
  });

  it("cycles are the good's own: longer hoard ⇒ rarer trips, offsets decorrelated from food", () => {
    const center = { x: 0, y: 0 };
    const plan = marketPlan();
    const food = createTownFood(triWith(10, 10), { key: "stub", center, plan }, 7);
    const cloth = createTownGoods(triCloth(10, 10), { key: "stub", center, plan }, 7, CLOTH);

    const h = plan.houses[3];
    // capDays 40 vs 3 on the same street clock: an order of magnitude
    // between errand periods.
    expect(cloth.cycle(h).period).toBeGreaterThan(food.cycle(h).period * 5);
    // The phase draws are namespaced by good key — households don't run
    // all their errands in lockstep. (Fractions of period, so the raw
    // magnitudes don't mask a shared draw.)
    const fFrac = plan.houses.map(x => food.cycle(x).offset / food.cycle(x).period);
    const cFrac = plan.houses.map(x => cloth.cycle(x).offset / cloth.cycle(x).period);
    const same = fFrac.filter((v, i) => Math.abs(v - cFrac[i]) < 1e-9).length;
    expect(same).toBeLessThan(plan.houses.length / 4);
  });

  it("the food wrapper IS the descriptor path: same numbers either way", () => {
    const center = { x: 0, y: 0 };
    const plan = marketPlan();
    const tri = triWith(10, 7);
    const viaWrapper = createTownFood(tri, { key: "stub", center, plan }, 7);
    const viaSpec = createTownGoods(tri, { key: "stub", center, plan }, 7, FOOD_GOOD);
    const h = plan.houses[11];
    expect(viaWrapper.boxCap).toBe(PANTRY_CAP);
    expect(viaSpec.cycle(h)).toEqual(viaWrapper.cycle(h));
    expect(viaSpec.pantry(h, 500)).toBe(viaWrapper.pantry(h, 500));
    expect(viaSpec.errand(h, 500).phase).toBe(viaWrapper.errand(h, 500).phase);
    expect(viaSpec.marketStock(500)).toBe(viaWrapper.marketStock(500));
  });
});
