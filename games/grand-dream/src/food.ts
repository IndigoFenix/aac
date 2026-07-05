/**
 * food.ts — the STREET-LEVEL FOOD ECONOMY, a deterministic projection.
 *
 * PopuSim treats resources ABSTRACTLY: traits declare per-person daily
 * intake (`demand` in the tri worlds — the economy signal; `consume`
 * impacts in stockpile worlds), the flow net delivers what it can, and
 * `fill = food_got / food_need` already sustains or starves the aggregate
 * (the dual vitals). This module is an ADD-ON to that consume behavior:
 * it renders the SAME numbers at individual scale and never introduces a
 * second food ledger. The unit throughout is the RATION — one person-day
 * of whatever the traits declared — so the projection is correct whatever
 * the abstract per-person rate is.
 *
 * Inelastic supply and demand, per the aggregate:
 *   demand = food_need — people need what they need, regardless of price
 *            or stock (there is no price; quantity is the whole story).
 *   supply = food_got  — what the flow net actually delivered today; the
 *            shelves hold that much no matter how many people queue.
 *   fill   = got/need  — the ONE degree of freedom. At fill 1 pantries
 *            are full and market trips are lazy; under scarcity each trip
 *            brings home less, so pantries sit emptier and trips come
 *            MORE often. Scarcity is visible as bustle, not numbers.
 *
 * Everything here is a closed-form function of (site scalars, house
 * index, wall-clock seconds): the pantry box in a house, where its
 * resident is in their shopping cycle, and the market's stock. No stored
 * state — it streams like the rest of the world, is identical on every
 * visit, and a resident spawning mid-cycle spawns mid-errand, DOING the
 * thing the numbers say they're doing.
 */

import type { TriWorld } from "./tri";
import type { TownHouse, TownPlan, TownWork } from "./zoom";
import { buildTownRoads, roadRoute, routeLength, type TownRoads } from "./town-roads";

/** Souls per house (a household) — houses = round(pop / this). Lives here
 *  (the consume-behavior module) and re-exports through zoom.ts. */
export const HOUSEHOLD = 5;

/** One domestic day of the street clock, in real seconds. The aggregate
 *  sim has its own day; this clock only paces visible routines. */
export const FOOD_DAY_SEC = 240;
/** The pantry box holds this many days of food for the household. */
export const PANTRY_DAYS = 3;
/** Rations (person-days) a full pantry box holds. */
export const PANTRY_CAP = HOUSEHOLD * PANTRY_DAYS;
/** Walking pace of a villager (m/s) — unhurried, groceries in hand. The
 *  cycle clock AND the body use this same value (`behavior.speed`), so a
 *  shopper's projected position and their embodied position agree: the
 *  pantry box visibly fills as they step back in their door. */
export const ERRAND_WALK = 1.6;
/** Time spent at the stall / farm gate (seconds). */
const SHOP_SEC = 18;
/** Trip-frequency floor: below this fill, trips stop getting more
 *  frequent (there is nothing left to fetch more often). */
const FILL_FLOOR = 0.25;

function hashSeed(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface FoodSource {
  /** Markets and farms sell; the hall is the imports depot of a town
   *  with neither (a mining town lives off the flow net). */
  kind: "market" | "farm" | "hall";
  /** Doorstep of the source, world meters — where a shopper stands. */
  x: number;
  y: number;
}

export interface HouseErrand {
  phase: "home" | "to_source" | "at_source" | "to_home";
  /** Canonical position NOW — doorstep when home, en-route/at-stall
   *  otherwise. Streaming ranks and spawns unspawned residents here. */
  pos: { x: number; y: number };
  /** Remaining waypoints of the trip (ending back home), for
   *  `host.setNpcErrand` — null when the resident is home. The stall
   *  point carries the shop `dwell` (engine NpcErrandPoint). */
  walkTo: Array<{ x: number; y: number; dwell?: number }> | null;
  /** Which trip this is (monotone counter) — edge-detect to send an
   *  already-embodied resident off shopping exactly once per cycle. */
  cycle: number;
  source: FoodSource;
  home: { x: number; y: number };
}

export interface TownFood {
  key: string;
  /** Live aggregate fill = food_got / food_need, clamped [0,1]. */
  fill(): number;
  /** All food sources of the town (world meters). */
  sources: FoodSource[];
  /** The nearest source for a house — market, farm gate, or the hall. */
  sourceOf(house: TownHouse): FoodSource;
  /** Rations in the house's food box at time t (0..PANTRY_CAP). */
  pantry(house: TownHouse, t: number): number;
  /** Where the resident of `house` is in their shopping cycle at t. */
  errand(house: TownHouse, t: number): HouseErrand;
  /** Rations on the market shelves at t — the day's delivered share,
   *  stocked at dawn and drawn down by shoppers. 0 for market-less towns. */
  marketStock(t: number): number;
  /** Households whose nearest source is the market. */
  marketServed(): number;
}

/** Doorstep of a work building (1.5 m out from its door edge midpoint). */
function workDoorstep(center: { x: number; y: number }, wk: TownWork): { x: number; y: number } {
  const cx = center.x + wk.dx + wk.w / 2;
  const cy = center.y + wk.dy + wk.h / 2;
  switch (wk.door) {
    case "north": return { x: cx, y: center.y + wk.dy - 1.5 };
    case "south": return { x: cx, y: center.y + wk.dy + wk.h + 1.5 };
    case "west": return { x: center.x + wk.dx - 1.5, y: cy };
    default: return { x: center.x + wk.dx + wk.w + 1.5, y: cy };
  }
}

/** Doorstep of a house — 1.2 m out from its DOOR edge (houses face
 *  their nearest road, so this is where their street begins). Also the
 *  streaming spawn point. */
export function houseDoorstep(center: { x: number; y: number }, h: TownHouse): { x: number; y: number } {
  const cx = center.x + h.dx + h.w / 2;
  const cy = center.y + h.dy + h.h / 2;
  switch (h.door) {
    case "north": return { x: cx, y: center.y + h.dy - 1.2 };
    case "south": return { x: cx, y: center.y + h.dy + h.h + 1.2 };
    case "west": return { x: center.x + h.dx - 1.2, y: cy };
    default: return { x: center.x + h.dx + h.w + 1.2, y: cy };
  }
}

export function createTownFood(
  tri: TriWorld,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  roads?: TownRoads,
): TownFood {
  const { key, center, plan } = town;
  const net = roads ?? buildTownRoads(plan);

  const sources: FoodSource[] = [];
  for (const wk of plan.works) {
    if (wk.type === "market" || wk.type === "farm") {
      const d = workDoorstep(center, wk);
      sources.push({ kind: wk.type, x: d.x, y: d.y });
    }
  }
  if (sources.length === 0) {
    // No market, no farm: the town eats what the roads bring — rations
    // are handed out at the hall.
    const hall = plan.works.find(wk => wk.type === "hall");
    const d = hall ? workDoorstep(center, hall) : { x: center.x, y: center.y };
    sources.push({ kind: "hall", x: d.x, y: d.y });
  }

  const fill = (): number => {
    const need = tri.dual.settlementScalar(key, "food_need");
    if (!(need > 0)) return 1;
    const got = tri.dual.settlementScalar(key, "food_got");
    return Math.max(0, Math.min(1, got / need));
  };
  /** Fill quantized to quarters for CYCLE GEOMETRY, so a slowly drifting
   *  aggregate doesn't re-phase every resident's routine each sim day. */
  const qfill = (): number => Math.max(FILL_FLOOR, Math.ceil(fill() * 4) / 4);

  const srcCache = new Map<number, FoodSource>();
  const sourceOf = (house: TownHouse): FoodSource => {
    const hit = srcCache.get(house.index);
    if (hit) return hit;
    const home = houseDoorstep(center, house);
    let best = sources[0];
    let bestD = Infinity;
    for (const s of sources) {
      const d = Math.hypot(s.x - home.x, s.y - home.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    srcCache.set(house.index, best);
    return best;
  };

  /** The ROAD ROUTE of a house's shopping trip (doorstep → source, on
   *  streets — town-roads.ts), cached with cumulative distances so the
   *  cycle can place the walker anywhere along it in O(points). */
  interface TripRoute {
    pts: Array<{ x: number; y: number }>;
    cum: number[];
    len: number;
  }
  const routeCache = new Map<number, TripRoute>();
  const routeOf = (house: TownHouse): TripRoute => {
    const hit = routeCache.get(house.index);
    if (hit) return hit;
    const home = houseDoorstep(center, house);
    const src = sourceOf(house);
    const local = roadRoute(
      net,
      { x: home.x - center.x, y: home.y - center.y },
      { x: src.x - center.x, y: src.y - center.y },
    );
    const pts = local.map(p => ({ x: p.x + center.x, y: p.y + center.y }));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const route = { pts, cum, len: cum[cum.length - 1] };
    routeCache.set(house.index, route);
    return route;
  };

  /** Point at distance d along the route; `idx` = last passed point. */
  const alongRoute = (route: TripRoute, d: number): { pos: { x: number; y: number }; idx: number } => {
    const dd = Math.max(0, Math.min(route.len, d));
    let i = 0;
    while (i < route.cum.length - 1 && route.cum[i + 1] < dd) i++;
    const a = route.pts[i];
    const b = route.pts[Math.min(i + 1, route.pts.length - 1)];
    const seg = route.cum[Math.min(i + 1, route.cum.length - 1)] - route.cum[i];
    const f = seg > 1e-9 ? (dd - route.cum[i]) / seg : 0;
    return { pos: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, idx: i };
  };

  /** The shopping cycle of one house: period (s), trip legs (s), phase
   *  offset. Walk time follows the ROAD route (people take streets, not
   *  chords). Period scales with fill — a trip that nets fewer rations
   *  must come sooner (inelastic demand: the household still eats
   *  HOUSEHOLD rations a day). */
  const cycleOf = (house: TownHouse): { period: number; walk: number; trip: number; offset: number } => {
    const walk = routeOf(house).len / ERRAND_WALK;
    const trip = walk * 2 + SHOP_SEC;
    const period = Math.max(trip * 1.5, PANTRY_DAYS * FOOD_DAY_SEC * qfill());
    const offset = (hashSeed(seed, `${key}:food:${house.index}`) / 4294967296) * period;
    return { period, walk, trip, offset };
  };

  const errand = (house: TownHouse, t: number): HouseErrand => {
    const { period, walk, trip, offset } = cycleOf(house);
    const home = houseDoorstep(center, house);
    const src = sourceOf(house);
    const route = routeOf(house);
    const back = (fromIdx: number): Array<{ x: number; y: number }> =>
      route.pts.slice(0, fromIdx + 1).reverse();
    const raw = t + offset;
    const u = ((raw % period) + period) % period;
    const cycle = Math.floor(raw / period);
    if (u >= trip) {
      return { phase: "home", pos: home, walkTo: null, cycle, source: src, home };
    }
    if (u < walk) {
      const { pos, idx } = alongRoute(route, u * ERRAND_WALK);
      // The rest of the way there, then the whole way back — with the
      // shop dwell marked on the stall point, so the BODY stands at the
      // source exactly as long as the cycle says (people AT the market).
      const out: Array<{ x: number; y: number; dwell?: number }> = route.pts.slice(idx + 1);
      if (out.length) out[out.length - 1] = { ...out[out.length - 1], dwell: SHOP_SEC };
      return {
        phase: "to_source",
        pos,
        walkTo: [...out, ...back(route.pts.length - 2)],
        cycle, source: src, home,
      };
    }
    if (u < walk + SHOP_SEC) {
      // Mid-shop: stand out the REMAINING dwell, then head home.
      return {
        phase: "at_source",
        pos: { x: src.x, y: src.y },
        walkTo: [{ x: src.x, y: src.y, dwell: walk + SHOP_SEC - u }, ...back(route.pts.length - 2)],
        cycle, source: src, home,
      };
    }
    const { pos, idx } = alongRoute(route, route.len - (u - walk - SHOP_SEC) * ERRAND_WALK);
    return { phase: "to_home", pos, walkTo: back(idx), cycle, source: src, home };
  };

  const pantry = (house: TownHouse, t: number): number => {
    const { period, trip, offset } = cycleOf(house);
    const u = (((t + offset) % period) + period) % period;
    if (u < trip) return 0; // the box ran dry — that's why they're out
    // Restocked to fill × capacity on return; eaten down linearly.
    const homeFrac = (u - trip) / Math.max(1e-9, period - trip);
    return fill() * PANTRY_CAP * (1 - homeFrac);
  };

  const served = plan.houses.filter(h => sourceOf(h).kind === "market").length;
  const dawnOffset = hashSeed(seed, `${key}:dawn`) / 4294967296;

  const marketStock = (t: number): number => {
    if (!sources.some(s => s.kind === "market")) return 0;
    // The day's delivered share: every served household draws HOUSEHOLD
    // rations a day, and the flow net delivered `fill` of that. Stocked
    // a little over daily draw at dawn, drawn down across the day.
    const daily = served * HOUSEHOLD * fill();
    const dayFrac = (((t / FOOD_DAY_SEC + dawnOffset) % 1) + 1) % 1;
    return Math.max(0, daily * (1.15 - 0.95 * dayFrac));
  };

  return {
    key,
    fill,
    sources,
    sourceOf,
    pantry,
    errand,
    marketStock,
    marketServed: () => served,
  };
}
