/**
 * city-districts.ts — TIER B of the city fractal (city-development.md §7
 * step 2, food commodity): the city's coarse anatomy as a GRAPH OF PARTS
 * with a conserving flow allocation over it.
 *
 * A district is a step-1 catchment promoted to a node: the houses bound
 * to one food source, the works assigned to it, a type mix read off
 * those works, and a SUPPLY DISTANCE — street meters from the nearest
 * producer (farm gate, or the hall for import towns) to the district's
 * source. Districts are a DERIVED DECOMPOSITION (§2a): re-derived with
 * the town plan, never persisted; their vector sum equals the site's
 * scalars by construction (apportionment, not new state).
 *
 * The tier-B statement: FILL VARIES BY DISTRICT. The site's delivered
 * food (`fill × need`, the aggregate truth) is allocated across
 * districts by supply order — everyone holds a floor share, then the
 * remainder pours nearest-producer-first. At fill 1 every district gets
 * 1 (the allocator is exact); under scarcity the quarter farthest from
 * the granaries visibly runs lean — emptier pantries, thinner shelves,
 * more frequent trips. The POOR QUARTER is a spatial fact that emerges
 * from geometry, not a flag (§5 decline, first rung).
 *
 * Conservation invariant (tested): Σ district_need × district_fill =
 * site got (clamped to capacity). Nobody above the seam can tell the
 * allocation apart from the aggregate — provenance-independence again.
 */

import type { FoodSource } from "./food";
import { roadDistance, type TownStreets } from "./streets";
import type { TownHouse, TownPlan, TownWork } from "./zoom";

export type DistrictKind = "core" | "farm" | "mining" | "residential";

export interface CityDistrict {
  index: number;
  /** The food source this district gathers around. */
  source: FoodSource;
  /** Lot indices of the houses in the catchment. */
  houseIdx: number[];
  /** Souls apportioned here (houses × HOUSEHOLD). */
  population: number;
  /** Rations/day this district draws. */
  need: number;
  /** Indices into plan.works assigned to this district. */
  works: number[];
  kind: DistrictKind;
  /** Street meters from the nearest producer to this district's source. */
  supplyDist: number;
  /** Town-local doorstep of that nearest producer — where this
   *  district's supply hauls set out from. */
  supplyFrom: { x: number; y: number };
  /** Today's service level (0..1) — allocateDistrictFill's output. */
  fill: number;
}

/** Extra fill a well-supplied district may hold above the site average —
 *  scarcity skews toward the granaries, but bounded: downtown does not
 *  feast while the fringe starves outright. */
const FILL_SPREAD = 0.35;
/** Floor share: every district keeps at least this fraction of the fair
 *  (site-average) fill before the remainder pours by supply order. */
const FILL_FLOOR_FRAC = 0.5;

/**
 * Allocate the site's delivered rations across districts, nearest
 * producer first, conserving exactly. Pure — the testable heart.
 * `needs[i]` and `supplyDist[i]` describe district i; `fair` is the
 * site-level fill (got/need, ≤ 1). Returns per-district fill in [0,1].
 */
export function allocateDistrictFill(needs: number[], supplyDist: number[], fair: number): number[] {
  const n = needs.length;
  if (n === 0) return [];
  const totalNeed = needs.reduce((a, b) => a + b, 0);
  if (!(totalNeed > 0)) return needs.map(() => fair);
  const got = fair * totalNeed;

  const floor = fair * FILL_FLOOR_FRAC;
  const cap = Math.min(1, fair + FILL_SPREAD);
  const fill = needs.map(() => floor);
  let remaining = got - floor * totalNeed;

  const order = needs.map((_, i) => i).sort((a, b) => supplyDist[a] - supplyDist[b] || a - b);
  for (const i of order) {
    if (remaining <= 1e-12) break;
    const room = needs[i] * (cap - fill[i]);
    const take = Math.min(room, remaining);
    if (take > 0) {
      fill[i] += take / needs[i];
      remaining -= take;
    }
  }
  // Cap headroom left rations undealt (only when fair ≈ 1): deal them
  // round-robin up to 1 so the allocator stays exact.
  for (const i of order) {
    if (remaining <= 1e-12) break;
    const room = needs[i] * (1 - fill[i]);
    const take = Math.min(room, remaining);
    if (take > 0) {
      fill[i] += take / needs[i];
      remaining -= take;
    }
  }
  return fill;
}

/** The dominant character of a district, read off its assigned works. */
function kindOf(source: FoodSource, works: number[], plan: TownPlan): DistrictKind {
  if (source.kind === "hall") return "core";
  let farms = 0;
  let mines = 0;
  for (const wi of works) {
    const t = plan.works[wi]?.type;
    if (t === "farm") farms++;
    else if (t === "mine" || t === "smelter") mines++;
  }
  if (mines > farms) return "mining";
  if (farms > 0) return "farm";
  // The plaza market's own catchment is the town core.
  const wk = source.work !== undefined ? plan.works[source.work] : undefined;
  if (wk && wk.type === "market" && Math.hypot(wk.dx + wk.w / 2, wk.dy + wk.h / 2) < 30) return "core";
  return "residential";
}

/** Doorstep of a work building, town-local (mirrors food.ts). */
function workDoor(wk: TownWork): { x: number; y: number } {
  const cx = wk.dx + wk.w / 2;
  const cy = wk.dy + wk.h / 2;
  switch (wk.door) {
    case "north": return { x: cx, y: wk.dy - 1.5 };
    case "south": return { x: cx, y: wk.dy + wk.h + 1.5 };
    case "west": return { x: wk.dx - 1.5, y: cy };
    default: return { x: wk.dx + wk.w + 1.5, y: cy };
  }
}

/**
 * Derive the district decomposition from the plan and the step-1 food
 * bindings. `catchments` maps each source to its bound houses (from
 * food.ts `sourceOf`); positions are TOWN-LOCAL meters throughout.
 */
export function deriveDistricts(
  plan: TownPlan,
  net: TownStreets,
  catchments: Array<{ source: FoodSource; houses: TownHouse[]; local: { x: number; y: number } }>,
  household: number,
  fair: number,
): CityDistrict[] {
  const populated = catchments.filter(c => c.houses.length > 0);
  if (populated.length === 0) return [];

  // Producers: farm gates grow food; the hall lands the imports. Supply
  // distance = street meters from the nearest producer to the source.
  const producers: Array<{ x: number; y: number }> = [];
  for (const wk of plan.works) {
    if (wk.type === "farm" || wk.type === "hall") producers.push(workDoor(wk));
  }
  if (producers.length === 0) producers.push({ x: 0, y: 0 });

  const districts: CityDistrict[] = populated.map((c, index) => {
    let supplyDist = Infinity;
    let supplyFrom = producers[0];
    for (const p of producers) {
      const d = roadDistance(net, p, c.local);
      if (d < supplyDist) { supplyDist = d; supplyFrom = p; }
    }
    return {
      index,
      source: c.source,
      houseIdx: c.houses.map(h => h.index),
      population: c.houses.length * household,
      need: c.houses.length * household,
      works: [],
      kind: "residential" as DistrictKind,
      supplyDist,
      supplyFrom,
      fill: fair,
    };
  });

  // Assign every production work to the district whose source is street-
  // nearest to it — the pithead belongs to the quarter around it.
  plan.works.forEach((wk, wi) => {
    if (wk.type !== "farm" && wk.type !== "mine" && wk.type !== "smelter") return;
    const door = workDoor(wk);
    let best = 0;
    let bestD = Infinity;
    for (const d of districts) {
      const dd = roadDistance(net, door, populated[d.index].local);
      if (dd < bestD) { bestD = dd; best = d.index; }
    }
    districts[best].works.push(wi);
  });
  for (const d of districts) d.kind = kindOf(d.source, d.works, plan);

  // The tier-B allocation: fill varies by supply order, conserving.
  const fills = allocateDistrictFill(
    districts.map(d => d.need),
    districts.map(d => d.supplyDist),
    fair,
  );
  districts.forEach((d, i) => { d.fill = fills[i]; });
  return districts;
}
