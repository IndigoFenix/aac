/**
 * districts.ts — STEP 1 of the city fractal (city-development.md §7):
 * neighborhood markets founded by UNSERVED DEMAND, replacing "one central
 * market past a house-count threshold" as the only way a town gets shops.
 *
 * The plaza market (MARKET_MIN_HOUSES) survives as the CORE district's
 * market. Beyond it, this pass walks the lot sequence in order and
 * measures every household's walk to its nearest stable source in STREET
 * meters (`roadDistance` on the organic street tree — the metric people
 * actually walk). Households too far accumulate FOUNDING MASS per ARM of
 * town (the arterial subtree their street descends from — the natural
 * "quarter" of a grown town); when an arm's mass crosses the threshold,
 * the pending lot that minimizes the quarter's TOTAL WALKING CONVERTS into
 * a market stall — a house becomes a shop, the way neighborhoods actually
 * get their corner market. The stall keeps the lot's exact footprint and
 * door, so it stays on its street frontage untouched.
 *
 * Founding is self-limiting: a new stall immediately joins the sources,
 * and the pending mass it now serves is purged — stalls appear where
 * demand is, roughly one per walk-radius of unserved houses, and a town
 * that outgrows one market grows a polycentric set instead of a bigger
 * queue (city-development.md §2c).
 *
 * Prefix-stable by the slot discipline: processing order is lot order,
 * and every decision depends only on houses already processed — a town
 * that grows founds NEW stalls without moving the ones the player knows.
 * (A conversion does CHANGE a seen house into a stall — deliberately:
 * that is development happening on screen, §5.)
 */

import { houseDoorstep } from "./goods";
import { roadDistance, type TownStreets } from "./streets";
import { ERRAND_WALK_MPS } from "../../scale";
import type { TownHouse } from "./plan";

/** Street meters beyond which a household counts as UNSERVED — the
 *  clock-blind LEGACY radius (a plan built without a WorldScale). A
 *  scale-aware plan derives it instead (scale.ts `serviceRadiusM`):
 *  needs that drain faster mean districts small enough to serve everyone. */
export const NEIGH_CONVENIENT = 120;
/** Founding mass that opens a stall — a couple dozen households
 *  half-again too far, or fewer truly remote ones. Together with the
 *  convenience radius this sets market density: one stall per rough
 *  walk-ball of ~60–90 households. */
export const NEIGH_FOUND_MASS = 18;
/** Founding mass that digs a WELL — civic street furniture, no
 *  shopkeeper's livelihood behind it, so the bar is a third of a stall's:
 *  a handful of households past the thirst-cycle walk get their corner
 *  well long before they'd rate a shop. */
export const WELL_FOUND_MASS = 6;
/**
 * PRICE CEILING on one household's founding mass — the cap SURVIVES the
 * conversion to an honest time tax (growth phase C §1.4), with its reason
 * restated rather than inherited.
 *
 * It is NOT a claim that walking stops costing time past two budgets; the tax
 * below is linear and honest all the way out. It is a claim about what the
 * mass MEASURES: a stall opens because a CLIENTELE exists, and one household
 * stranded ten radii out is not a clientele however much time it loses. The
 * ceiling is the price a single household may bid, so founding stays a
 * statement about how many people are underserved and only secondarily about
 * how badly.
 *
 * Without it, one remote lot could out-bid nine ordinary ones and open a shop
 * with nobody to sell to — the "far-flung stragglers" failure the pass was
 * written to avoid.
 */
const MASS_CAP = 2;

/** What a service pass founds: how far its clientele may walk (one-way
 *  street metres) and how much stranded demand opens one point. */
export interface ServiceFacility {
  convenientM: number;
  foundMass: number;
  /** Round trips a household makes here per game-day — the RECURRING term of
   *  the travel tax (`scale.ts`: `dayLengthS / needFillS(scale, need)`, one
   *  trip per fill cycle). Absent = one a day, the hunger anchor. */
  tripsPerDay?: number;
  /** Walking pace, m/s (`scale.ts walkSpeedMps`). Absent = the real villager
   *  pace, the same anchor `serviceRadiusM` draws the radius with. */
  paceMps?: number;
}

/**
 * THE TRAVEL TAX, in HAND-SECONDS PER DAY: what a household `d` street metres
 * from its source really pays — the round trip, at this need's frequency,
 * every day for as long as it lives there.
 *
 * The unit is deliberately a duration and not a distance. A distance is a
 * one-off; the thing placement is spending is its residents' TIME, repeatedly
 * (the user's time-elasticity law), and the only honest way to compare a
 * far well against a near market is to price both in the same seconds.
 */
export function dailyTripTaxS(
  d: number,
  facility: Pick<ServiceFacility, "tripsPerDay" | "paceMps">,
): number {
  return ((facility.tripsPerDay ?? 1) * 2 * d) / (facility.paceMps ?? ERRAND_WALK_MPS);
}

interface Pending {
  house: TownHouse;
  /** Street distance to the nearest source at last measurement. */
  d: number;
  /** Founding mass this household contributes at distance `d`. */
  w: number;
}

const centerOf = (h: TownHouse): { x: number; y: number } => ({ x: h.dx + h.w / 2, y: h.dy + h.h / 2 });

/** Which arm of town a house belongs to: the arterial subtree its street
 *  descends from (carried on the lot), with a quadrant fallback for houses
 *  that never learned theirs — taken about the pass's OWN anchor (the
 *  town's central source), not about the frame origin, which stopped
 *  being the middle of anything when the plaza ring died. */
function armOf(h: TownHouse, about: { x: number; y: number }): number {
  if (h.arm !== undefined && h.arm >= 0) return h.arm;
  const c = centerOf(h);
  const dx = c.x - about.x;
  const dy = c.y - about.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 100 : 102) : (dy >= 0 ? 101 : 103);
}

/**
 * Returns the house lots that convert into neighborhood market stalls,
 * in founding order. `anchor` is the town-local doorstep of the central
 * source (plaza market, or the hall for market-less towns) — the ONLY
 * pre-existing source considered, because work buildings sit at street
 * tips, which move as the town grows and would break prefix stability.
 * `convenientM` defaults to the clock-blind legacy radius; a scale-aware
 * plan passes the derived one (scale.ts `serviceRadiusM`).
 */
export function foundNeighborhoodMarkets(
  houses: TownHouse[],
  anchor: { x: number; y: number },
  net: TownStreets,
  convenientM: number = NEIGH_CONVENIENT,
): TownHouse[] {
  return foundServicePoints(houses, [anchor], net, { convenientM, foundMass: NEIGH_FOUND_MASS });
}

/**
 * THE GENERAL SERVICE PASS — the same demand-founding walk for ANY
 * facility a need is served at (market stalls on the hunger radius, wells
 * on the thirst radius): lot order in, per-arm founding mass, the point
 * lands at the pending lot that costs its quarter the fewest street metres
 * of recurring walking, and every founded point immediately serves — self-limiting, prefix-stable, one point per
 * walk-ball of unserved households. The caller decides what the chosen
 * lot BECOMES (a stall converts the house; a well stands on its verge).
 */
export function foundServicePoints(
  houses: TownHouse[],
  anchors: ReadonlyArray<{ x: number; y: number }>,
  net: TownStreets,
  facility: ServiceFacility,
): TownHouse[] {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => roadDistance(net, a, b);
  /** The town-local FRAME (doorsteps are measured in it) — a coordinate
   *  convention, never a hub. */
  const origin = { x: 0, y: 0 };
  /** What the arm fallback measures quadrants about: the town's central
   *  source, or the frame origin when the caller gave none. */
  const about = anchors[0] ?? origin;
  /**
   * THE RECURRING TRAVEL TAX (user law: time elasticity — placement pays the
   * residents' repeated trips, not a one-off distance).
   *
   * A household `d` street metres from its source pays `trips/day × 2d/pace`
   * HAND-SECONDS PER DAY, forever. The convenience radius is the budget that
   * tax was allowed to reach (`scale.ts serviceRadiusM` derives it from
   * exactly this arithmetic: half a fill cycle, there and back), so a
   * household's founding mass is its tax as a MULTIPLE of that budget, less
   * the one budget it was granted.
   *
   * MEASURED CONSEQUENCE, worth stating because it is easy to mistake for an
   * omission: within one facility's bucket the frequency and the pace CANCEL
   * — every household in it walks to the same kind of place at the same rate,
   * so `(trips × 2d/pace) / (trips × 2R/pace) = d/R`. The tax is real and the
   * ratio is frequency-invariant, which is why this line looks unchanged and
   * why the pass never needed a clock to be honest. The frequency bites
   * WHERE IT SHOULD: across facilities, where a thirst cycle and a hunger
   * cycle set different radii (and the bars above price the shopkeeper's
   * livelihood on top).
   */
  const budgetS = dailyTripTaxS(facility.convenientM, facility);
  const massOf = (d: number): number =>
    Math.min(MASS_CAP, dailyTripTaxS(d, facility) / budgetS - 1);
  const sources = [...anchors];
  const stalls: TownHouse[] = [];
  // Mass gathers per ARM (arterial subtree) so opposite edges of town
  // never average a stall into the center.
  const buckets = new Map<number, Pending[]>();

  for (const h of houses) {
    const hd = houseDoorstep(origin, h);
    let d = Infinity;
    for (const s of sources) d = Math.min(d, dist(hd, s));
    if (d <= facility.convenientM) continue;
    const arm = armOf(h, about);
    let bucket = buckets.get(arm);
    if (!bucket) {
      bucket = [];
      buckets.set(arm, bucket);
    }
    bucket.push({ house: h, d, w: massOf(d) });
    if (bucket.reduce((a, p) => a + p.w, 0) < facility.foundMass) continue;

    // FOUND WHERE THE WALKING IS CHEAPEST (growth phase C §1.4): the pending
    // lot that minimizes the bucket's TOTAL RECURRING TAX — Σ over the
    // stranded households of (their mass × the street metres they would walk
    // to this lot). Not the lot nearest a chord centroid, which is what this
    // used to be and which prices a straight line nobody can walk: on an
    // organic tree the centroid of two arms lands in the fields between them,
    // and the "nearest" lot to it is whichever arm's houses happen to bulge,
    // not the one the walking converges on.
    //
    // Mass-weighted because the tax is per household and the remoter ones are
    // the reason the point is being founded at all.
    //
    // DETERMINISTIC: the bucket is in lot order (prefix-stable) and only
    // STRICT improvements move the winner, so ties fall to the earliest lot.
    const doors = bucket.map(p => houseDoorstep(origin, p.house));
    let lot = bucket[0];
    let best = Infinity;
    for (let i = 0; i < bucket.length; i++) {
      const here = doors[i];
      let cost = 0;
      for (let j = 0; j < bucket.length; j++) {
        if (j === i) continue;
        cost += bucket[j].w * dist(doors[j], here);
      }
      if (cost < best) { best = cost; lot = bucket[i]; }
    }
    stalls.push(lot.house);
    const stallDoor = houseDoorstep(origin, lot.house);
    sources.push(stallDoor);
    // The point serves its neighborhood NOW: re-measure every pending
    // household against it and drop the ones it satisfied.
    for (const [k, list] of buckets) {
      buckets.set(k, list.filter(p => {
        if (p.house === lot.house) return false;
        const d2 = dist(houseDoorstep(origin, p.house), stallDoor);
        if (d2 < p.d) { p.d = d2; p.w = massOf(d2); }
        return p.d > facility.convenientM;
      }));
    }
  }
  return stalls;
}
