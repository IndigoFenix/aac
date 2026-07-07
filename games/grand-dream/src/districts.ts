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
 * the pending lot nearest the mass's centroid CONVERTS into a market
 * stall — a house becomes a shop, the way neighborhoods actually get
 * their corner market. The stall keeps the lot's exact footprint and
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

import { houseDoorstep } from "./food";
import { roadDistance, type TownStreets } from "./streets";
import type { TownHouse } from "./zoom";

/** Street meters beyond which a household counts as UNSERVED. */
export const NEIGH_CONVENIENT = 120;
/** Founding mass that opens a stall — a couple dozen households
 *  half-again too far, or fewer truly remote ones. Together with the
 *  convenience radius this sets market density: one stall per rough
 *  walk-ball of ~60–90 households. */
export const NEIGH_FOUND_MASS = 18;
/** Mass cap per household: remoteness makes founding likelier, but a
 *  handful of far-flung stragglers can't open a shop alone. */
const MASS_CAP = 2;

interface Pending {
  house: TownHouse;
  /** Street distance to the nearest source at last measurement. */
  d: number;
  /** Founding mass this household contributes at distance `d`. */
  w: number;
}

const massOf = (d: number): number => Math.min(MASS_CAP, d / NEIGH_CONVENIENT - 1);
const centerOf = (h: TownHouse): { x: number; y: number } => ({ x: h.dx + h.w / 2, y: h.dy + h.h / 2 });

/** Which arm of town a house belongs to: the arterial subtree its street
 *  descends from (carried on the lot), with a bearing-quadrant fallback
 *  for houses that never learned theirs. */
function armOf(h: TownHouse): number {
  if (h.arm !== undefined && h.arm >= 0) return h.arm;
  const c = centerOf(h);
  return Math.abs(c.x) >= Math.abs(c.y) ? (c.x >= 0 ? 100 : 102) : (c.y >= 0 ? 101 : 103);
}

/**
 * Returns the house lots that convert into neighborhood market stalls,
 * in founding order. `anchor` is the town-local doorstep of the central
 * source (plaza market, or the hall for market-less towns) — the ONLY
 * pre-existing source considered, because work buildings sit at street
 * tips, which move as the town grows and would break prefix stability.
 */
export function foundNeighborhoodMarkets(
  houses: TownHouse[],
  anchor: { x: number; y: number },
  net: TownStreets,
): TownHouse[] {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => roadDistance(net, a, b);
  const origin = { x: 0, y: 0 };
  const sources = [anchor];
  const stalls: TownHouse[] = [];
  // Mass gathers per ARM (arterial subtree) so opposite edges of town
  // never average a stall into the center.
  const buckets = new Map<number, Pending[]>();

  for (const h of houses) {
    const hd = houseDoorstep(origin, h);
    let d = Infinity;
    for (const s of sources) d = Math.min(d, dist(hd, s));
    if (d <= NEIGH_CONVENIENT) continue;
    const arm = armOf(h);
    let bucket = buckets.get(arm);
    if (!bucket) {
      bucket = [];
      buckets.set(arm, bucket);
    }
    bucket.push({ house: h, d, w: massOf(d) });
    if (bucket.reduce((a, p) => a + p.w, 0) < NEIGH_FOUND_MASS) continue;

    // Found: convert the pending lot nearest the mass-weighted centroid.
    let sx = 0, sy = 0, sw = 0;
    for (const p of bucket) {
      const pc = centerOf(p.house);
      sx += pc.x * p.w;
      sy += pc.y * p.w;
      sw += p.w;
    }
    const cx = sx / sw, cy = sy / sw;
    let lot = bucket[0];
    let best = Infinity;
    for (const p of bucket) {
      const pc = centerOf(p.house);
      const dd = Math.hypot(pc.x - cx, pc.y - cy);
      if (dd < best) { best = dd; lot = p; }
    }
    stalls.push(lot.house);
    const stallDoor = houseDoorstep(origin, lot.house);
    sources.push(stallDoor);
    // The stall serves its neighborhood NOW: re-measure every pending
    // household against it and drop the ones it satisfied.
    for (const [k, list] of buckets) {
      buckets.set(k, list.filter(p => {
        if (p.house === lot.house) return false;
        const d2 = dist(houseDoorstep(origin, p.house), stallDoor);
        if (d2 < p.d) { p.d = d2; p.w = massOf(d2); }
        return p.d > NEIGH_CONVENIENT;
      }));
    }
  }
  return stalls;
}
