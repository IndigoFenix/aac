/**
 * goods.ts — the STREET-LEVEL HOUSEHOLD-GOODS ECONOMY, a deterministic
 * projection (grand-dream's food.ts until the engine carve; that file
 * now re-exports this plus the founding FOOD/TOOLS descriptors). FOOD
 * was the first (and founding) instance; the machinery is parameterized
 * over a `GoodSpec` so bread, clothing, and whatever else the aggregate
 * learns to flow reuse the same closed forms.
 *
 * PopuSim treats resources ABSTRACTLY: traits declare per-person daily
 * intake (`demand` in the tri worlds — the economy signal; `consume`
 * impacts in stockpile worlds), the flow net delivers what it can, and
 * `fill = got / need` already sustains or starves the aggregate (the
 * dual vitals). This module is an ADD-ON to that consume behavior: it
 * renders the SAME numbers at individual scale and never introduces a
 * second ledger per good. The unit throughout is the RATION — one
 * person-day of whatever the traits declared — so the projection is
 * correct whatever the abstract per-person rate is.
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

import type { TownHost } from "./host";
import type { TownHouse, TownPlan, TownWork } from "./plan";
import { HOUSEHOLD } from "./stations";
import { houseRoomPlan, type HouseShape } from "./rooms";
import { goodBoxPlacement } from "./placement";
import { roadDistance, roadRoute, roadStreetPath, type TownStreets } from "./streets";
import { allocateDistrictFill, deriveDistricts, type CityDistrict } from "./city-districts";
import type { CompiledEconomy, GoodSpec } from "../modules/economy/economy";
import { DAY_S, ERRAND_WALK_MPS } from "../../scale";

export type { GoodSpec };

/** Souls per house (a household) — DEFINED in stations.ts (occupancy is
 *  the building program's input, §9); re-exported here for the economy's
 *  consumers (and onward through zoom.ts). */
export { HOUSEHOLD };

/** One domestic day of the street clock, in real seconds — THE canonical
 *  game-day (scale.ts DAY_S; space-time-compression.md §6). The aggregate
 *  sim has its own day; this clock only paces visible routines. */
export const FOOD_DAY_SEC = DAY_S;
/** The pantry box holds this many days of food for the household. */
export const PANTRY_DAYS = 3;
/** Rations (person-days) a full pantry box holds. */
export const PANTRY_CAP = HOUSEHOLD * PANTRY_DAYS;
/** Walking pace of a villager (m/s) — unhurried, groceries in hand. The
 *  cycle clock AND the body use this same value (`behavior.speed`), so a
 *  shopper's projected position and their embodied position agree: the
 *  pantry box visibly fills as they step back in their door. */
export const ERRAND_WALK = ERRAND_WALK_MPS;
/** Time spent at the stall / farm gate (seconds) — the standard dwell
 *  the founding FOOD descriptor uses (content mirrors this value). */
export const SHOP_SEC = 18;

// -------------------------- store consumption ---------------------------
// The shelf stock (`stockOf`/`marketStock`) is TIME-PURE — a sawtooth that
// refills at dawn and drains across the day AS THE MODELLED SHOPPERS BUY
// (so NPC purchases are ALREADY in the base). To let a discrete taker (the
// player pulling an item out of a store CONTAINER) deplete the SAME shelf
// without mutating the pure economy, a caller holds a tiny consumed OFFSET
// per store and subtracts it from the base. The offset resets each economy
// day (the dawn cart restocks), so the store refills on its own clock.

/** Which economy day time `t` falls in (dawn-to-dawn buckets). */
export function economyDay(t: number): number {
  return Math.floor(t / FOOD_DAY_SEC);
}

/** A store's player-consumed offset for one day: how many units have been
 *  pulled out since that day's dawn refill. */
export interface StoreConsumption {
  day: number;
  units: number;
}

/** Units still on a store's shelf: the time-pure base MINUS what's been
 *  consumed THIS day (a stale prior-day offset counts as zero — refilled).
 *  Clamped ≥ 0. NPC draw is intrinsic to `base`; `consumed` is the player's. */
export function storeUnitsLeft(base: number, consumed: StoreConsumption | undefined, t: number): number {
  const used = consumed && consumed.day === economyDay(t) ? consumed.units : 0;
  return Math.max(0, base - used);
}

/** Record one more unit pulled from a store, resetting the tally when the
 *  day has rolled over since the offset was last touched. */
export function addStoreConsumption(consumed: StoreConsumption | undefined, t: number, n = 1): StoreConsumption {
  const day = economyDay(t);
  const used = consumed && consumed.day === day ? consumed.units : 0;
  return { day, units: used + n };
}

// ── Surplus preference → shopping frequency (npc-behavior-and-town-economy.md §13a) ──
// A household keeps a SAFETY BUFFER of its pantry (a fraction that varies per household),
// shops when the pantry falls to that buffer rather than to empty, and refills toward
// full. A hoarder shops sooner and oftener and never runs dry; a lean household cuts it
// close. Consumption is the SAME steady rate (HOUSEHOLD rations/day) either way.

/** Fraction of a full pantry a household likes to keep on hand (hashed per household). */
export const SURPLUS_FRAC_MIN = 0.1;
export const SURPLUS_FRAC_MAX = 0.4;

/** The shopping-cycle length (seconds): time to eat from FULL down to the surplus buffer
 *  — `capDays·(1−surplusFrac)` days, scaled by scarcity `qfill`, floored so a trip always
 *  fits. Higher surplus ⇒ shorter period ⇒ more frequent, never-empty trips. Pure. */
export function shopPeriod(trip: number, capDays: number, surplusFrac: number, qfill: number): number {
  return Math.max(trip * 1.5, capDays * (1 - surplusFrac) * FOOD_DAY_SEC * qfill);
}

/** The pantry level at cycle position `u` (seconds into `period`): a sawtooth that is FULL
 *  (`boxCap`) at the refill (u = `trip`, the return home) and drains at the steady household
 *  rate down to the `surplus` buffer just before the next return — never to 0. Pure; the
 *  caller scales by the district's fill. */
export function pantryLevel(boxCap: number, surplus: number, period: number, trip: number, u: number): number {
  const elapsed = (((u - trip) % period) + period) % period; // seconds since the last refill
  const drain = (boxCap - surplus) / Math.max(1e-9, period); // rations/sec — eaten continuously
  return Math.max(surplus, boxCap - drain * elapsed);
}
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

export interface GoodSource {
  /** The selling work's type (a good's `sellers`); the hall is the
   *  imports depot of a town with none (it lives off the flow net). */
  kind: TownWork["type"];
  /** Doorstep of the source, world meters — where a shopper stands. */
  x: number;
  y: number;
  /** Index of this source's building in `plan.works` (renderer match). */
  work?: number;
}
/** The pre-genericization name — food was the first good. */
export type FoodSource = GoodSource;

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

export interface TownGoods {
  key: string;
  /** The commodity this instance projects. */
  good: GoodSpec;
  /** Units a full house box holds (HOUSEHOLD × capDays × perCapitaDaily
   *  — for food this equals PANTRY_CAP). */
  boxCap: number;
  /** Live aggregate fill = got / need, clamped [0,1]. */
  fill(): number;
  /** The cycle geometry of a house's shopping routine (seconds + phase
   *  offset) — the SAME clock `pantry`/`errand` run on, exposed so the
   *  witnessed-pantry overlay (zoom.ts TownManager) can re-time a refill
   *  around a real body's actual arrival. */
  cycle(house: TownHouse): { period: number; walk: number; trip: number; offset: number };
  /** All food sources of the town (world meters). */
  sources: FoodSource[];
  /** The nearest source for a house BY STREET (road-route meters) —
   *  market stall, farm gate, or the hall. With neighborhood markets
   *  these bindings are the step-1 district catchments. */
  sourceOf(house: TownHouse): FoodSource;
  /** Units in the house's box of this good at time t (surplus..boxCap; never 0). */
  pantry(house: TownHouse, t: number): number;
  /** The SURPLUS buffer (rations) this household keeps on hand — the pantry floor and the
   *  level at which it shops (drives frequency; §13a). Varies per household. */
  surplusUnits(house: TownHouse): number;
  /** The same buffer expressed in days of consumption (surplusUnits ÷ HOUSEHOLD·perCapitaDaily). */
  surplusDays(house: TownHouse): number;
  /** Where the resident of `house` is in their shopping cycle at t. */
  errand(house: TownHouse, t: number): HouseErrand;
  /** RE-ANCHOR (npc-behavior-and-town-economy.md §13, the DEMOTE step): shift THIS
   *  house's cycle phase so `pantry(house, t)` reads ≈ `units` from now on — called when
   *  a LIVE household (real hunger, real box counts, player gifts/thefts) hands control
   *  back to the clock, so its next shopping trip reflects reality (a topped-up box ⇒ a
   *  full period away; a drained one ⇒ imminent). Only disrupted households ever carry a
   *  shift; the rest of the crowd stays time-pure. Always lands in the HOME phase — a
   *  re-anchored body is never teleported mid-trip. */
  reanchor(house: TownHouse, units: number, t: number): void;
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
  /** Plan indices of this good's PRODUCER works (farms for food…). */
  producerWorks(): number[];
  /** Units piled up at producer work `w` at time `t`: production ACCUMULATES
   *  across the street day and the dawn cart takes it — the inverse sawtooth of
   *  the shelf. The visible "the farm made this" box. */
  produceAt(workIdx: number, t: number): number;
  /** The DAWN-CART haul serving a SHELVED source: a carrier's round trip
   *  producer → source (roads) each street day. Null for sources that need no
   *  haul (unshelved gates; a producer selling its own shelf). */
  haul(src: FoodSource, t: number): HaulTrip | null;
}

/** One dawn-cart round trip, time-pure like the shopping errand: mid-trip the
 *  carrier is ON the road (streaming spawns it there); idle = no body. */
export interface HaulTrip {
  phase: "idle" | "to_market" | "unloading" | "to_producer";
  /** Canonical position NOW (mid-trip). The producer doorstep when idle. */
  pos: { x: number; y: number };
  /** Remaining waypoints (ending back at the producer), for `setNpcErrand` —
   *  null when idle. The unload point carries a dwell. */
  walkTo: Array<{ x: number; y: number; dwell?: number }> | null;
  /** Street day of this trip (edge detection — one trip per day). */
  day: number;
  /** The carrier's pace (m/s) — carts are FASTER than strolling shoppers, and
   *  a long route speeds up further so the round trip always fits its day.
   *  Streaming must give the body THIS speed or it lags the closed form. */
  speed: number;
  /** Trip endpoints (world meters). */
  producer: { x: number; y: number };
  market: { x: number; y: number };
}
/** The pre-genericization name — every existing call site is the food
 *  instance, and stays typed as such. */
export type TownFood = TownGoods;

/** Doorstep of a work building (1.5 m out from its door edge midpoint).
 *  Exported since the jobs slice — commute trips and workplace spawn spots
 *  (roster job duties) stand people exactly where shoppers stand. */
export function workDoorstep(center: { x: number; y: number }, wk: TownWork): { x: number; y: number } {
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

/** The household FOOD BOX (pantry crate) center — slot 0's corner of the
 *  LIVING room. The renderer draws the crate here AND a returning
 *  shopper's trip ends here (throughDoor appends it), so the box fills
 *  exactly where — and when — the body actually stops. */
export function pantryBoxAt(
  center: { x: number; y: number },
  h: { index: number; dx: number; dy: number; w: number; h: number; door: "north" | "south" | "east" | "west" },
): { x: number; y: number } {
  return goodBoxAt(center, h, 0);
}

/** A good's house box corner by SLOT (registration order): 0 SW (the
 *  pantry), 1 SE, 2 NE, 3 NW — four goods before corners run out, and
 *  each good's returning shopper ends at their own crate. The room and
 *  corner come from placement.ts's goodBoxPlacement (THE single source): the
 *  pantry lands in the KITCHEN when the house has one, every other good
 *  in the LIVING ROOM — so the chest, the drawn crate and the trip end
 *  can never drift, and a returning shopper walks all the way to the
 *  fridge wherever it stands. */
export function goodBoxAt(
  center: { x: number; y: number },
  h: { index: number; dx: number; dy: number; w: number; h: number; door: "north" | "south" | "east" | "west" },
  slot: number,
): { x: number; y: number } {
  const { room, corner } = goodBoxPlacement(center, h as HouseShape, houseRoomPlan(center, h as HouseShape), slot);
  const r = room.rect;
  const west = r.x + 1.75;
  const east = r.x + r.w - 1.75;
  const north = r.y + 1.75;
  const south = r.y + r.h - 1.75;
  switch (corner) {
    case 0: return { x: west, y: south };
    case 1: return { x: east, y: south };
    case 2: return { x: east, y: north };
    default: return { x: west, y: north };
  }
}

/** The household WARES BOX (tool chest) — slot 1, the pantry crate's
 *  opposite corner. */
export function waresBoxAt(
  center: { x: number; y: number },
  h: { index: number; dx: number; dy: number; w: number; h: number; door: "north" | "south" | "east" | "west" },
): { x: number; y: number } {
  return goodBoxAt(center, h, 1);
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

export function createTownGoods(
  tri: TownHost,
  eco: CompiledEconomy,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  good: GoodSpec,
  roads?: TownStreets,
): TownGoods {
  const { key, center, plan } = town;
  const net = roads ?? plan.streets;
  /** Units a full house box holds of THIS good. */
  const boxCap = HOUSEHOLD * good.capDays * good.perCapitaDaily;
  // Per-household surplus preference (safety buffer) → shopping frequency (§13a).
  const surplusFracOf = (house: TownHouse): number =>
    SURPLUS_FRAC_MIN +
    (hashSeed(seed, `${key}:surplus:${good.key}:${house.index}`) / 4294967296) * (SURPLUS_FRAC_MAX - SURPLUS_FRAC_MIN);
  const surplusUnitsOf = (house: TownHouse): number => surplusFracOf(house) * boxCap;

  const sources: GoodSource[] = [];
  plan.works.forEach((wk, i) => {
    if (good.sellers.includes(wk.type)) {
      const d = workDoorstep(center, wk);
      sources.push({ kind: wk.type, x: d.x, y: d.y, work: i });
    }
  });
  if (sources.length === 0) {
    // No seller in town: households live off what the roads bring —
    // rations are handed out at the hall.
    const hallIdx = plan.works.findIndex(wk => wk.type === "hall");
    const d = hallIdx >= 0 ? workDoorstep(center, plan.works[hallIdx]) : { x: center.x, y: center.y };
    sources.push({ kind: "hall", x: d.x, y: d.y, work: hallIdx >= 0 ? hallIdx : undefined });
  }

  const fill = (): number => {
    const need = tri.dual.settlementScalar(key, good.needScalar);
    if (!(need > 0)) return 1;
    const got = tri.dual.settlementScalar(key, good.gotScalar);
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
    if (!good.shelved.includes(src.kind) || !wk) {
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
  // Per-house RE-ANCHOR shifts (§13 demote) — added to the hashed phase offset. Sparse:
  // only households a live episode disrupted have an entry.
  const cycleShift = new Map<number, number>();
  const cycleOf = (house: TownHouse): { period: number; walk: number; trip: number; offset: number } => {
    const walk = routeOf(house).len / ERRAND_WALK;
    const trip = walk * 2 + good.shopSec;
    // The interval to eat from full DOWN TO the household's surplus buffer, then refill.
    const period = shopPeriod(trip, good.capDays, surplusFracOf(house), qfillOf(house));
    // SELF-HEAL a poisoned shift (a NaN written before reanchor guarded the
    // flat-sawtooth case) — a non-finite offset makes errand().cycle NaN and
    // the trip gate re-emit every frame; drop it rather than carry it forever.
    const shift = cycleShift.get(house.index) ?? 0;
    if (!Number.isFinite(shift)) cycleShift.delete(house.index);
    const offset =
      (hashSeed(seed, `${key}:${good.key}:${house.index}`) / 4294967296) * period +
      (Number.isFinite(shift) ? shift : 0);
    return { period, walk, trip, offset };
  };

  /** Solve the pantry sawtooth for the phase that reads `units` NOW, and shift this
   *  house's cycle onto it. Clamped into the HOME (draining) segment: a box below the
   *  surplus floor anchors to "trip imminent", a topped-up one to "just refilled". */
  const reanchor = (house: TownHouse, units: number, t: number): void => {
    const f = fillOf(house);
    if (!(f > 1e-6)) return; // starved district: the sawtooth is flat — nothing to anchor
    const { period, trip, offset } = cycleOf(house);
    const surplus = surplusUnitsOf(house);
    const level = Math.max(surplus, Math.min(boxCap, units / f));
    const drain = (boxCap - surplus) / Math.max(1e-9, period);
    // FLAT SAWTOOTH (boxCap ≈ surplus — a good this house barely buffers):
    // nothing to anchor, and pressing on divides 0/0 → the shift goes NaN and
    // POISONS the house's offset FOREVER — `errand().cycle` turns NaN, the
    // once-per-cycle trip gate (`tripSent.get(id) === cycle`) never matches
    // again (NaN ≠ NaN), and the runner re-emits a fresh trip EVERY FRAME (the
    // permanent street-walker / errand-router storm).
    if (!(drain > 1e-9)) return;
    // Seconds since a refill that leave `level` in the box, kept short of the segment
    // end so the next trip is due soon-but-not-mid-air when the box is at the floor.
    const elapsed = Math.min((boxCap - level) / drain, Math.max(0, period - trip - 1));
    const target = trip + elapsed;
    const cur = (((t + offset) % period) + period) % period;
    const shift = target - cur;
    if (!Number.isFinite(shift)) return; // never let a degenerate anchor poison the offset
    cycleShift.set(house.index, (cycleShift.get(house.index) ?? 0) + shift);
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
      if (out.length) out[out.length - 1] = { ...out[out.length - 1], dwell: good.shopSec };
      return {
        phase: "to_source",
        pos,
        walkTo: [...out, ...back(route.pts.length - 2)],
        cycle, source: src, home,
      };
    }
    if (u < walk + good.shopSec) {
      // Mid-shop: stand out the REMAINING dwell AT THEIR STAND, then
      // head home.
      const stand = standFor(house);
      return {
        phase: "at_source",
        pos: stand,
        walkTo: [{ x: stand.x, y: stand.y, dwell: walk + good.shopSec - u }, ...back(route.pts.length - 2)],
        cycle, source: src, home,
      };
    }
    const { pos, idx } = alongRoute(route, route.len - (u - walk - good.shopSec) * ERRAND_WALK);
    return { phase: "to_home", pos, walkTo: back(idx), cycle, source: src, home };
  };

  const pantry = (house: TownHouse, t: number): number => {
    const { period, trip, offset } = cycleOf(house);
    const u = (((t + offset) % period) + period) % period;
    // A sawtooth: full (× the district's fill) on the return home, drained at the steady
    // household rate down to the SURPLUS buffer just before the next return — never to 0.
    return fillOf(house) * pantryLevel(boxCap, surplusUnitsOf(house), period, trip, u);
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
  for (const s of sources) if (good.shelved.includes(s.kind)) served += servedBy.get(s) ?? 0;

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
        // Quarters classify by THIS world's work registry.
        type => eco.works.find(w => w.key === type)?.district ?? null,
        good.producers,
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
    if (!good.shelved.includes(src.kind)) return 0;
    districts();
    const dFill = bySource.get(src)?.fill ?? fill();
    return (servedBy.get(src) ?? 0) * HOUSEHOLD * good.perCapitaDaily * dFill;
  };

  // ── The dawn-cart HAUL + the producer's produce pile ─────────────────────
  // The supply leg made VISIBLE: what streetTraffic only weights, `haul` walks —
  // a carrier's daily round trip from each shelved source's nearest producer
  // (the district's supplyFrom), on roads, unloading at the stall. `produceAt`
  // is the matching pile at the producer: it grows all day, the cart empties it.

  const producerWorksList = (): number[] => {
    const out: number[] = [];
    plan.works.forEach((wk, i) => {
      if (good.producers.includes(wk.type)) out.push(i);
    });
    return out;
  };

  const produceAt = (workIdx: number, t: number): number => {
    const producers = producerWorksList();
    if (!producers.includes(workIdx)) return 0;
    // The town's whole daily draw, split across its producers.
    const daily = (served * HOUSEHOLD * good.perCapitaDaily * fill()) / Math.max(1, producers.length);
    const dawn = hashSeed(seed, `${key}:pile:${workIdx}`) / 4294967296;
    const dayFrac = (((t / FOOD_DAY_SEC + dawn) % 1) + 1) % 1;
    return daily * dayFrac;
  };

  interface HaulGeom {
    pts: Array<{ x: number; y: number }>;
    cum: number[];
    len: number;
    producer: { x: number; y: number };
  }
  const haulCache = new Map<FoodSource, HaulGeom | null>();
  const haulGeom = (src: FoodSource): HaulGeom | null => {
    if (haulCache.has(src)) return haulCache.get(src)!;
    let out: HaulGeom | null = null;
    // Only shelved sources are stocked by a cart, and a producer selling its
    // own shelf needs no haul.
    if (good.shelved.includes(src.kind) && !good.producers.includes(src.kind)) {
      districts();
      const d = bySource.get(src);
      if (d) {
        const local = roadRoute(net, d.supplyFrom, { x: src.x - center.x, y: src.y - center.y });
        const pts = local.map((p) => ({ x: p.x + center.x, y: p.y + center.y }));
        if (pts.length >= 2) {
          const cum = [0];
          for (let i = 1; i < pts.length; i++) {
            cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
          }
          out = { pts, cum, len: cum[cum.length - 1], producer: pts[0] };
        }
      }
    }
    haulCache.set(src, out);
    return out;
  };

  const HAUL_UNLOAD_SEC = 20;
  /** A cart's base pace — brisker than a strolling shopper. */
  const CART_SPEED = 3.2;
  const haul = (src: FoodSource, t: number): HaulTrip | null => {
    const geom = haulGeom(src);
    if (!geom || geom.len < 1e-3) return null;
    // The round trip must FIT its day (≤ ~70% of it + the unload): a long route
    // just moves faster — the dawn cart always makes its delivery.
    const speed = Math.max(
      CART_SPEED,
      (geom.len * 2) / Math.max(30, FOOD_DAY_SEC * 0.7 - HAUL_UNLOAD_SEC),
    );
    const walk = geom.len / speed;
    const dawn = (hashSeed(seed, `${key}:haul:${sources.indexOf(src)}`) / 4294967296) * 0.1 + 0.02;
    const day = Math.floor(t / FOOD_DAY_SEC);
    const u = ((t / FOOD_DAY_SEC) % 1) - dawn; // seconds-in-day past departure, as day frac
    const uSec = u * FOOD_DAY_SEC;
    const market = geom.pts[geom.pts.length - 1];
    const base = { day, speed, producer: geom.producer, market };
    const along = (d: number): { pos: { x: number; y: number }; idx: number } => {
      const dd = Math.max(0, Math.min(geom.len, d));
      let i = 0;
      while (i < geom.cum.length - 1 && geom.cum[i + 1] < dd) i++;
      const a = geom.pts[i];
      const b = geom.pts[Math.min(i + 1, geom.pts.length - 1)];
      const seg = geom.cum[Math.min(i + 1, geom.cum.length - 1)] - geom.cum[i];
      const f = seg > 1e-9 ? (dd - geom.cum[i]) / seg : 0;
      return { pos: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, idx: i };
    };
    if (uSec < 0 || uSec >= walk * 2 + HAUL_UNLOAD_SEC) {
      return { ...base, phase: "idle", pos: geom.producer, walkTo: null };
    }
    if (uSec < walk) {
      const { pos, idx } = along(uSec * speed);
      const out: Array<{ x: number; y: number; dwell?: number }> = geom.pts.slice(idx + 1);
      if (out.length) out[out.length - 1] = { ...out[out.length - 1], dwell: HAUL_UNLOAD_SEC };
      return { ...base, phase: "to_market", pos, walkTo: [...out, ...geom.pts.slice(0, -1).reverse()] };
    }
    if (uSec < walk + HAUL_UNLOAD_SEC) {
      return {
        ...base,
        phase: "unloading",
        pos: market,
        walkTo: [
          { x: market.x, y: market.y, dwell: walk + HAUL_UNLOAD_SEC - uSec },
          ...geom.pts.slice(0, -1).reverse(),
        ],
      };
    }
    const back = (uSec - walk - HAUL_UNLOAD_SEC) * speed;
    const { pos, idx } = along(geom.len - back);
    return { ...base, phase: "to_producer", pos, walkTo: geom.pts.slice(0, Math.max(1, idx)).reverse() };
  };

  const stockOf = (src: FoodSource, t: number): number => {
    if (!good.shelved.includes(src.kind)) return 0;
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
      if (!good.shelved.includes(d.source.kind)) continue;
      // A cart carries `cartRations`; weight hauls like the crowd they
      // feed so the supply arteries read on the map.
      const hauls = Math.max(2, Math.ceil((d.need * good.perCapitaDaily) / good.cartRations) * 3);
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
    good,
    boxCap,
    fill,
    cycle: cycleOf,
    sources,
    sourceOf,
    pantry,
    surplusUnits: surplusUnitsOf,
    surplusDays: (house: TownHouse) => surplusUnitsOf(house) / (HOUSEHOLD * good.perCapitaDaily),
    errand,
    reanchor,
    producerWorks: producerWorksList,
    produceAt,
    haul,
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

/** Does the settlement keep this good's ledger? (ONE-VOCABULARY law:
 *  the street never invents one.) Stub hosts without an entityWorld
 *  project only the founding good. */
export function hasLedger(tri: TownHost, spec: GoodSpec): boolean {
  const vars = (tri.dual as unknown as { entityWorld?: { scalars: Record<string, unknown> } }).entityWorld?.scalars;
  if (!vars) return spec.slot === 0 || spec.key === "food";
  return !!vars[spec.needScalar] && !!vars[spec.gotScalar];
}

/** ALL of a town's street goods, in slot order — the given registry
 *  filtered to the ledgers this settlement actually keeps. Food (slot 0)
 *  is the founding good and always projects. */
export function streetGoods(
  tri: TownHost,
  eco: CompiledEconomy,
  town: { key: string; center: { x: number; y: number }; plan: TownPlan },
  seed: number,
  roads?: TownStreets,
): TownGoods[] {
  return eco.goods
    .filter(spec => spec.slot === 0 || hasLedger(tri, spec))
    .map(spec => createTownGoods(tri, eco, town, seed, spec, roads));
}
