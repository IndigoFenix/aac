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
import { roadDistance, roadRoute, roadStreetPath, type TownStreets } from "./streets";
import { allocateDistrictFill, deriveDistricts, type CityDistrict } from "./city-districts";

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
  /** Index of this source's building in `plan.works` (renderer match). */
  work?: number;
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
  /** The nearest source for a house BY STREET (road-route meters) —
   *  market stall, farm gate, or the hall. With neighborhood markets
   *  these bindings are the step-1 district catchments. */
  sourceOf(house: TownHouse): FoodSource;
  /** Rations in the house's food box at time t (0..PANTRY_CAP). */
  pantry(house: TownHouse, t: number): number;
  /** Where the resident of `house` is in their shopping cycle at t. */
  errand(house: TownHouse, t: number): HouseErrand;
  /** Rations on ONE source's shelves at t — its catchment's delivered
   *  share, stocked at dawn and drawn down by shoppers. 0 for non-market
   *  sources (farm gates sell from the field, not a shelf). */
  stockOf(src: FoodSource, t: number): number;
  /** Rations across ALL market shelves at t. 0 for market-less towns. */
  marketStock(t: number): number;
  /** Households whose nearest source is a market. */
  marketServed(): number;
  /** Shopping trips riding each street (street id → households) — the
   *  traffic field: street WEAR follows use (city-development.md §3b),
   *  so arterials aren't drawn as arterials, they become them. Includes
   *  the supply hauls (producer → market) on top of shopper trips. */
  streetTraffic(): ReadonlyMap<number, number>;
  /** The tier-B district decomposition (city-districts.ts), fills
   *  tracking the LIVE aggregate: under scarcity the quarter farthest
   *  from the producers runs visibly lean. */
  districts(): CityDistrict[];
  /** The district a house belongs to (by its step-1 catchment). */
  districtOf(house: TownHouse): CityDistrict | undefined;
  /** The house's own service level — its district's fill. */
  fillOf(house: TownHouse): number;
  /** The STANDS of a market source (world meters): stall tables spread
   *  along the building's door side. Shoppers dwell at THEIR stand
   *  (hashed per household), so a busy market is a row of small queues
   *  instead of one corner pile-up. Non-markets get their doorstep. */
  stands(src: FoodSource): Array<{ x: number; y: number }>;
  /** Rations this stall stocks at dawn on a full day (its catchment's
   *  daily draw × its district's fill) — the renderer's sack scale. */
  stallDaily(src: FoodSource): number;
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

/** The two waypoints of a DOOR TRANSIT: the space just inside the door
 *  and the space just outside it. Bodies entering or leaving a building
 *  walk this sandwich (inside → outside or the reverse) so steering
 *  crosses the wall AT the doorway instead of grinding beside it —
 *  short-range pathfinding for the one obstacle towns actually have. */
export function doorTransit(
  center: { x: number; y: number },
  b: { dx: number; dy: number; w: number; h: number; door: "north" | "south" | "east" | "west" },
): { inside: { x: number; y: number }; outside: { x: number; y: number } } {
  const cx = center.x + b.dx + b.w / 2;
  const cy = center.y + b.dy + b.h / 2;
  switch (b.door) {
    case "north": return {
      inside: { x: cx, y: center.y + b.dy + 1.0 },
      outside: { x: cx, y: center.y + b.dy - 1.2 },
    };
    case "south": return {
      inside: { x: cx, y: center.y + b.dy + b.h - 1.0 },
      outside: { x: cx, y: center.y + b.dy + b.h + 1.2 },
    };
    case "west": return {
      inside: { x: center.x + b.dx + 1.0, y: cy },
      outside: { x: center.x + b.dx - 1.2, y: cy },
    };
    default: return {
      inside: { x: center.x + b.dx + b.w - 1.0, y: cy },
      outside: { x: center.x + b.dx + b.w + 1.2, y: cy },
    };
  }
}

export function createTownFood(
  tri: TriWorld,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  roads?: TownStreets,
): TownFood {
  const { key, center, plan } = town;
  const net = roads ?? plan.streets;

  const sources: FoodSource[] = [];
  plan.works.forEach((wk, i) => {
    if (wk.type === "market" || wk.type === "farm") {
      const d = workDoorstep(center, wk);
      sources.push({ kind: wk.type, x: d.x, y: d.y, work: i });
    }
  });
  if (sources.length === 0) {
    // No market, no farm: the town eats what the roads bring — rations
    // are handed out at the hall.
    const hallIdx = plan.works.findIndex(wk => wk.type === "hall");
    const d = hallIdx >= 0 ? workDoorstep(center, plan.works[hallIdx]) : { x: center.x, y: center.y };
    sources.push({ kind: "hall", x: d.x, y: d.y, work: hallIdx >= 0 ? hallIdx : undefined });
  }

  const fill = (): number => {
    const need = tri.dual.settlementScalar(key, "food_need");
    if (!(need > 0)) return 1;
    const got = tri.dual.settlementScalar(key, "food_got");
    return Math.max(0, Math.min(1, got / need));
  };
  /** A house's fill quantized to quarters for CYCLE GEOMETRY, so a
   *  slowly drifting aggregate doesn't re-phase every resident's routine
   *  each sim day. Reads the DISTRICT allocation (tier B): the poor
   *  quarter's households shop more often for less. Declared below,
   *  after the district machinery it reads. */
  const qfillOf = (house: TownHouse): number => Math.max(FILL_FLOOR, Math.ceil(fillOf(house) * 4) / 4);

  // STANDS: stall tables along the market building's door side. Each
  // shopping household is hashed onto one, so the crowd spreads into
  // small queues and the sacks sit where people actually pick them up.
  const standCache = new Map<FoodSource, Array<{ x: number; y: number }>>();
  const standsOf = (src: FoodSource): Array<{ x: number; y: number }> => {
    const hit = standCache.get(src);
    if (hit) return hit;
    let out: Array<{ x: number; y: number }>;
    const wk = src.work !== undefined ? plan.works[src.work] : undefined;
    if (src.kind !== "market" || !wk) {
      out = [{ x: src.x, y: src.y }];
    } else {
      const K = Math.max(2, Math.min(4, Math.ceil((servedBy.get(src) ?? 0) / 15)));
      out = [];
      for (let i = 0; i < K; i++) {
        const f = (i + 1) / (K + 1);
        switch (wk.door) {
          case "north": out.push({ x: center.x + wk.dx + wk.w * f, y: center.y + wk.dy - 1.6 }); break;
          case "south": out.push({ x: center.x + wk.dx + wk.w * f, y: center.y + wk.dy + wk.h + 1.6 }); break;
          case "west": out.push({ x: center.x + wk.dx - 1.6, y: center.y + wk.dy + wk.h * f }); break;
          default: out.push({ x: center.x + wk.dx + wk.w + 1.6, y: center.y + wk.dy + wk.h * f });
        }
      }
    }
    standCache.set(src, out);
    return out;
  };
  /** The stand THIS household shops at (stable per house). */
  const standFor = (house: TownHouse): { x: number; y: number } => {
    const stands = standsOf(sourceOf(house));
    return stands[hashSeed(seed, `${key}:stand:${house.index}`) % stands.length];
  };

  /** The ROAD ROUTE of a house's shopping trip (doorstep → their stand,
   *  on streets), cached with cumulative distances so the cycle can
   *  place the walker anywhere along it in O(points). */
  interface TripRoute {
    pts: Array<{ x: number; y: number }>;
    cum: number[];
    len: number;
  }
  /** A house binds to the nearest source BY STREET: with neighborhood
   *  stalls, chord distance would shop across a quarter the streets
   *  don't connect that way. Selection uses the closed-form
   *  `roadDistance` (cheap, no waypoints); the winner's route
   *  materializes lazily when the errand needs it. */
  const srcCache = new Map<number, FoodSource>();
  const sourceOf = (house: TownHouse): FoodSource => {
    const hit = srcCache.get(house.index);
    if (hit) return hit;
    const home = houseDoorstep(center, house);
    const local = { x: home.x - center.x, y: home.y - center.y };
    let best = sources[0];
    let bestD = Infinity;
    for (const s of sources) {
      const d = roadDistance(net, local, { x: s.x - center.x, y: s.y - center.y });
      if (d < bestD) { bestD = d; best = s; }
    }
    srcCache.set(house.index, best);
    return best;
  };
  const routeCache = new Map<number, TripRoute>();
  const routeOf = (house: TownHouse): TripRoute => {
    const hit = routeCache.get(house.index);
    if (hit) return hit;
    const home = houseDoorstep(center, house);
    const stand = standFor(house);
    const local = roadRoute(
      net,
      { x: home.x - center.x, y: home.y - center.y },
      { x: stand.x - center.x, y: stand.y - center.y },
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
    const period = Math.max(trip * 1.5, PANTRY_DAYS * FOOD_DAY_SEC * qfillOf(house));
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
      // Mid-shop: stand out the REMAINING dwell AT THEIR STAND, then
      // head home.
      const stand = standFor(house);
      return {
        phase: "at_source",
        pos: stand,
        walkTo: [{ x: stand.x, y: stand.y, dwell: walk + SHOP_SEC - u }, ...back(route.pts.length - 2)],
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
    // Restocked to the DISTRICT's fill × capacity on return; eaten down
    // linearly. A poor quarter's boxes sit visibly emptier.
    const homeFrac = (u - trip) / Math.max(1e-9, period - trip);
    return fillOf(house) * PANTRY_CAP * (1 - homeFrac);
  };

  // Catchments: households per source (bound by street distance). This
  // is the step-1 district decomposition — each market's stock is ITS
  // catchment's share of the town's delivered food, so a big town's
  // stalls carry neighborhood-sized stock, not the whole town's.
  const servedBy = new Map<FoodSource, number>();
  const catchHouses = new Map<FoodSource, TownHouse[]>();
  for (const h of plan.houses) {
    const s = sourceOf(h);
    servedBy.set(s, (servedBy.get(s) ?? 0) + 1);
    const list = catchHouses.get(s);
    if (list) list.push(h);
    else catchHouses.set(s, [h]);
  }
  let served = 0;
  for (const s of sources) if (s.kind === "market") served += servedBy.get(s) ?? 0;

  // TIER B (city-districts.ts): the catchments promoted to districts,
  // with FILL ALLOCATED BY SUPPLY ORDER — the aggregate's delivered food
  // is the only truth; districts share it out nearest-producer-first, so
  // scarcity shows WHERE it bites. Structure derives once; the fills
  // re-allocate when the live aggregate moves (quantized, so a slowly
  // drifting fill doesn't re-phase every routine each sim day).
  let structure: CityDistrict[] | null = null;
  const byHouse = new Map<number, CityDistrict>();
  const bySource = new Map<FoodSource, CityDistrict>();
  let lastFq = -1;
  const districts = (): CityDistrict[] => {
    if (!structure) {
      structure = deriveDistricts(
        plan, net,
        sources.map(s => ({
          source: s,
          houses: catchHouses.get(s) ?? [],
          local: { x: s.x - center.x, y: s.y - center.y },
        })),
        HOUSEHOLD, 1,
      );
      for (const d of structure) {
        bySource.set(d.source, d);
        for (const hi of d.houseIdx) byHouse.set(hi, d);
      }
      lastFq = -1;
    }
    const fq = Math.round(Math.max(0, Math.min(1, fill())) * 8) / 8;
    if (fq !== lastFq) {
      lastFq = fq;
      const fills = allocateDistrictFill(
        structure.map(d => d.need),
        structure.map(d => d.supplyDist),
        fq,
      );
      structure.forEach((d, i) => { d.fill = fills[i]; });
    }
    return structure;
  };
  const districtOf = (house: TownHouse): CityDistrict | undefined => {
    districts();
    return byHouse.get(house.index);
  };
  /** The house's service level: its district's share of the delivery. */
  const fillOf = (house: TownHouse): number => districtOf(house)?.fill ?? fill();

  /** The catchment's daily draw × the DISTRICT's fill: what the dawn
   *  cart actually delivers to this stall's stands. */
  const stallDaily = (src: FoodSource): number => {
    if (src.kind !== "market") return 0;
    districts();
    const dFill = bySource.get(src)?.fill ?? fill();
    return (servedBy.get(src) ?? 0) * HOUSEHOLD * dFill;
  };

  const stockOf = (src: FoodSource, t: number): number => {
    if (src.kind !== "market") return 0;
    // Stocked a little over daily draw at dawn (each stall's dawn cart
    // on its own offset), drawn down across the day.
    const daily = stallDaily(src);
    const dawn = hashSeed(seed, `${key}:dawn:${sources.indexOf(src)}`) / 4294967296;
    const dayFrac = (((t / FOOD_DAY_SEC + dawn) % 1) + 1) % 1;
    return Math.max(0, daily * (1.15 - 0.95 * dayFrac));
  };
  const marketStock = (t: number): number => {
    let sum = 0;
    for (const s of sources) sum += stockOf(s, t);
    return sum;
  };

  // Traffic: how many households' shopping trips ride each street. Built
  // lazily from the SAME bindings the errands use, so the streets that
  // widen on screen are exactly the ones people walk. Supply hauls ride
  // on top: every market's stock arrives from its nearest producer, and
  // those cart routes wear the streets too (tier B — the first flows
  // that are CITY logistics rather than household errands).
  let traffic: Map<number, number> | null = null;
  const streetTraffic = (): ReadonlyMap<number, number> => {
    if (traffic) return traffic;
    traffic = new Map();
    for (const h of plan.houses) {
      const home = houseDoorstep(center, h);
      const src = sourceOf(h);
      const ids = roadStreetPath(
        net,
        { x: home.x - center.x, y: home.y - center.y },
        { x: src.x - center.x, y: src.y - center.y },
      );
      for (const id of ids) traffic.set(id, (traffic.get(id) ?? 0) + 1);
    }
    for (const d of districts()) {
      if (d.source.kind !== "market") continue;
      // A cart carries ~25 rations; weight hauls like the crowd they
      // feed so the supply arteries read on the map.
      const hauls = Math.max(2, Math.ceil(d.need / 25) * 3);
      const ids = roadStreetPath(net, d.supplyFrom, {
        x: d.source.x - center.x,
        y: d.source.y - center.y,
      });
      for (const id of ids) traffic!.set(id, (traffic!.get(id) ?? 0) + hauls);
    }
    return traffic;
  };

  return {
    key,
    fill,
    sources,
    sourceOf,
    pantry,
    errand,
    stockOf,
    marketStock,
    marketServed: () => served,
    streetTraffic,
    districts,
    districtOf,
    fillOf,
    stands: standsOf,
    stallDaily,
  };
}
