// Cell Systems — CONSTRAINT CEILINGS (resources-and-trade.md §④).
//
// A town's size is the MINIMUM OF ITS CONSTRAINTS, not an authored number:
// food within reach, fuel within reach, water on the spot. Two or three
// factors — the ledger stays simple enough for the idle-safety validator
// to certify — and every one is a ratio of declared quantities:
//
//   • the REACH of each constraint comes from the freight arithmetic
//     (carryReachM of the good that must make the trip: the caloric
//     anchor for food, the wood row for fuel — raw bulk dies young, so
//     the fuel disc is SMALLER than the food disc, which is the
//     Grainbound fuel-crisis geometry falling out of the tables);
//   • the SUPPLY ZONE is that reach walked over the actual terrain — a
//     land disc stretched along river ribbons at the world's declared
//     asymmetry (downstream ≫ upstream ≫ land), so a river town eats
//     from a tributary-shaped hinterland and a dry-plain town from a
//     circle;
//   • the CEILING is Σ(field over the zone) × a content-declared
//     heads-per-unit rate, minimized across constraints. RATIOS IN THE
//     ENGINE, ABSOLUTES IN THE SPEC: the engine owns the min() and the
//     zone shape; every rate and every good is content.
//
// The WATER-FIRST VETO (node-typing's `freshWater: false`) becomes a real
// cap here: a dry site is a WAYSTATION whatever its land could feed —
// §②'s recorded fact, §④'s consequence.
//
// This is what "the anchor stops being hand-authored" means at city
// scale: the ceiling feeds the anchors the machinery already consumes
// (a settlement scalar for `vitals.capacity` births-gating in the tri
// worlds; the startPop clamp at the planet tier) — ANCHORED CAPACITY
// keeps holding, the number is just derived now. A city ABOVE its
// ceiling is a PARASITE — legal, but only while a bound partner covers
// the gap (§⑤'s business; here it is a printed diagnostic, never an
// ambush — the scaleWarnings doctrine).
//
// Ceilings read the RESTING fields (fertility, plant), not the seasonal
// draw: a ceiling is annualized capacity — the granary crosses the
// winter (freight.ts keepThroughLean is that diagnostic), so the lean
// months cap the STORE, not the head-count.

import {
  carryReachM, freightOf, REAL_ASYMMETRY,
  type Freight, type TransportAsymmetry,
} from "../../freight";
import type { WorldScale } from "../../scale";
import type { NodeGrid } from "./node-typing";

// ------------------------------------------------------------ the supply zone

export interface SupplyZoneOpts {
  /** Travel budget in LAND-cell units (a water cell costs 1/multiplier). */
  reachCells: number;
  /** The world's declared mode asymmetry (default the Earth anchor). */
  asym?: TransportAsymmetry;
  /** Flow at/over which a cell carries a watercourse (default 16 — the
   *  fording line, node-typing's own threshold). */
  watercourse?: number;
  /** Safety budget on zone size (default 4096) — a compressed world's
   *  reach can dwarf a chart; a truncated zone says so. */
  maxCells?: number;
}

export interface SupplyZone {
  /** Zone cells in settlement order (cheapest first; ties by index —
   *  deterministic). Includes the origin at cost 0. */
  cells: number[];
  /** Travel cost per zone cell, in land-cell units. */
  cost: Map<number, number>;
  /** The maxCells budget cut the zone short — the sums under-read. */
  truncated: boolean;
}

/**
 * THE SUPPLY ZONE: every cell whose produce can reach `cell` within
 * `reachCells` land-cell units of travel. A step between two watercourse
 * cells is cheap by the asymmetry — and DIRECTION-AWARE via the height
 * field: cargo bound for the town moves downstream when the far cell sits
 * HIGHER (it floats down, ÷downstream), upstream when it sits lower (it
 * must be rowed up, ÷upstream), and takes the worse water rate on a flat
 * tie (conservative — the route graph's true directions are §⑤'s).
 * Everything else is a land step at cost 1. Dijkstra, deterministic.
 */
export function supplyZone(grid: NodeGrid, cell: number, opts: SupplyZoneOpts): SupplyZone {
  const asym = opts.asym ?? REAL_ASYMMETRY;
  const wc = opts.watercourse ?? 16;
  const maxCells = opts.maxCells ?? 4096;
  const budget = opts.reachCells;
  const river = grid.fields.river;
  const height = grid.fields.height;
  const cost = new Map<number, number>();
  const cells: number[] = [];

  // A grid too thin to walk (no neighbour access) degrades to the bare
  // land disc — no ribbons, honest circle.
  if (!grid.topo.neighbours) {
    grid.topo.disk(cell, Math.max(0, Math.floor(budget)), (c, d) => {
      if (d <= budget && !cost.has(c)) { cost.set(c, d); cells.push(c); }
    });
    return { cells, cost, truncated: false };
  }

  const tieWater = Math.min(asym.downstream, asym.upstream);
  // Frontier as a sorted-insert array of [cost, cell] — zones are small
  // (maxCells-bounded), and the pop order (cost asc, cell asc) is the
  // determinism contract.
  const frontier: Array<[number, number]> = [[0, cell]];
  const best = new Map<number, number>([[cell, 0]]);
  const nb: number[] = new Array(grid.topo.maxDegree ?? 8).fill(0);
  let truncated = false;

  while (frontier.length > 0) {
    // Lowest cost, then lowest cell index.
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i][0] < frontier[bi][0] ||
          (frontier[i][0] === frontier[bi][0] && frontier[i][1] < frontier[bi][1])) bi = i;
    }
    const [c, cur] = frontier.splice(bi, 1)[0];
    if (cost.has(cur) && cost.get(cur)! <= c) continue; // stale entry
    cost.set(cur, c);
    cells.push(cur);
    if (cells.length >= maxCells) { truncated = frontier.length > 0; break; }
    if (c >= budget) continue; // at the rim: counted, not expanded

    const k = grid.topo.neighbours(cur, nb);
    for (let j = 0; j < k; j++) {
      const b = nb[j];
      const water = !!river && river[cur] >= wc && river[b] >= wc;
      let step = 1;
      if (water) {
        const mult = !height || height[b] === height[cur]
          ? tieWater
          : height[b] > height[cur] ? asym.downstream : asym.upstream;
        step = 1 / Math.max(1, mult);
      }
      const nc = c + step;
      if (nc > budget) continue;
      const prev = best.get(b);
      if (prev !== undefined && prev <= nc) continue;
      best.set(b, nc);
      frontier.push([nc, b]);
    }
  }
  return { cells, cost, truncated };
}

// ------------------------------------------------------------ the constraints

/** One constraint of a town's existence — CONTENT, never engine data:
 *  the vocabulary ("food", "fuel") is free, the rate is declared, and
 *  the reach comes from the freight row of the good that must make the
 *  trip. */
export interface ConstraintDef {
  key: string;
  /** Substrate field summed over the supply zone (fertility, plant…) —
   *  the field IS the biome's productivity. */
  field: string;
  /** Souls one unit of the field supports — the content calibration. */
  headsPerUnit: number;
  /** The freight row pricing this constraint's haul (default: the
   *  caloric anchor — value density 1, selfConsuming — i.e. raw staple
   *  bulk). "wood" prices a SHORTER disc than food: the fuel crisis is
   *  geometry, not a rule. */
  good?: string;
}

/** The caloric anchor as a freight: the unit good every reach is
 *  measured against (node-typing's rawBulkReachCells uses the same). */
const CALORIC_ANCHOR: Freight = { valueDensity: 1, transit: "selfConsuming" };

/** A constraint's reach in cells on this world — freight arithmetic over
 *  the lattice pitch, clamped to the chart (`maxReachCells`). */
export function constraintReachCells(
  scale: WorldScale,
  cellM: number,
  c: ConstraintDef,
  asym: TransportAsymmetry = REAL_ASYMMETRY,
  maxReachCells = 24,
): number {
  const f = c.good ? freightOf(c.good) : CALORIC_ANCHOR;
  return Math.min(maxReachCells, carryReachM(scale, f, "land", asym) / Math.max(1e-9, cellM));
}

// --------------------------------------------------------------- the ceiling

/** Content default for the water-vetoed site: the well-less crossroads
 *  inn — a waystation's worth of souls, overridable per world. */
export const WAYSTATION_HEADS = 40;

export interface CeilingOpts {
  scale: WorldScale;
  /** Metres per grid cell (the caller knows its pitch). */
  cellM: number;
  /** The factors — two or three, per the doc; at least one (a ceiling
   *  of nothing would be infinite, which is not a ceiling). */
  constraints: ConstraintDef[];
  asym?: TransportAsymmetry;
  watercourse?: number;
  /** Reach clamp in cells (default 24 — grids are windows; a real-scale
   *  reach would swallow the chart and the sums with it). */
  maxReachCells?: number;
  maxZoneCells?: number;
  /** The §② veto, passed through from the node reading: false = no
   *  fresh water in the charter box ⇒ the site caps at a waystation
   *  regardless of what its land could feed. Absent = watered. */
  freshWater?: boolean;
  waystationHeads?: number;
}

export interface CeilingFactor {
  key: string;
  field: string;
  reachCells: number;
  /** Cells of the zone within THIS constraint's reach. */
  zoneCells: number;
  sum: number;
  heads: number;
}

export interface CeilingReading {
  /** Souls the worst constraint supports — the derived anchor. */
  ceiling: number;
  /** The binding constraint's key, or "water" when the veto binds. */
  binding: string;
  factors: CeilingFactor[];
  /** The zone hit its size budget — the sums (and ceiling) under-read. */
  truncated: boolean;
  /** The printed derivation (the fractal job-description law). */
  sentence: string;
}

/**
 * THE MIN-OF-CONSTRAINTS CEILING: one supply-zone walk (at the widest
 * constraint's reach), each factor summed over the cells within its own
 * reach, the smallest head-count binding. Ties bind to the first-declared
 * constraint — deterministic, and priority-as-declaration-order is the
 * allocator's own idiom.
 */
export function constraintCeiling(grid: NodeGrid, cell: number, opts: CeilingOpts): CeilingReading {
  if (!opts.constraints.length) {
    throw new Error("constraintCeiling: at least one constraint (a ceiling of nothing is infinite)");
  }
  const asym = opts.asym ?? REAL_ASYMMETRY;
  const maxReach = opts.maxReachCells ?? 24;
  const reaches = opts.constraints.map(c =>
    constraintReachCells(opts.scale, opts.cellM, c, asym, maxReach));
  const zone = supplyZone(grid, cell, {
    reachCells: Math.max(...reaches),
    asym,
    ...(opts.watercourse !== undefined ? { watercourse: opts.watercourse } : {}),
    ...(opts.maxZoneCells !== undefined ? { maxCells: opts.maxZoneCells } : {}),
  });

  const factors: CeilingFactor[] = opts.constraints.map((c, i) => {
    const arr = grid.fields[c.field];
    let sum = 0;
    let zoneCells = 0;
    if (arr) {
      for (const z of zone.cells) {
        if (zone.cost.get(z)! <= reaches[i]) { sum += arr[z]; zoneCells++; }
      }
    }
    return {
      key: c.key, field: c.field, reachCells: reaches[i], zoneCells, sum,
      heads: Math.floor(sum * c.headsPerUnit),
    };
  });

  let bind = factors[0];
  for (const f of factors) if (f.heads < bind.heads) bind = f;
  let ceiling = bind.heads;
  let binding = bind.key;

  if (opts.freshWater === false) {
    const ws = opts.waystationHeads ?? WAYSTATION_HEADS;
    if (ws < ceiling) { ceiling = ws; binding = "water"; }
  }

  const sentence = binding === "water"
    ? `is a waystation (${ceiling} souls) — no fresh water, whatever the land within reach could feed`
    : `is capped at ${ceiling} souls by ${binding} — the ${bind.field} within reach feeds it no further`;

  return { ceiling, binding, factors, truncated: zone.truncated, sentence };
}

// --------------------------------------------------------------- the parasite

/**
 * A city above its ceiling is a PARASITE — legal, but only while a bound
 * trade partner covers the gap (§⑤ makes the lane real; until then this
 * is the readable diagnostic, never an ambush). Sever the lane and the
 * population doesn't riot — it leaves (Gate D is already the mechanism).
 */
export function parasiteReading(
  pop: number,
  r: CeilingReading,
  /** ⚖️ R&T ⑤ (T4) — WHO is covering the gap, when the caller knows (the
   *  bound trade partner's key). Diagnostic only: the verdict, the strain
   *  and the mechanism are unchanged, the sentence simply stops saying "a
   *  partner" about a partner it can name. Absent ⇒ the shipped wording. */
  partnerKey?: string,
): { parasite: boolean; strain: number; sentence: string } {
  const strain = pop / Math.max(1, r.ceiling);
  if (pop > r.ceiling) {
    return {
      parasite: true,
      strain,
      sentence:
        `lives ${strain.toFixed(1)}× beyond its ${r.binding} — a parasite: legal only while ` +
        `${partnerKey ? `${partnerKey} covers` : "a partner covers"} the gap; ` +
        `sever the lane and the population leaves, not riots`,
    };
  }
  return {
    parasite: false,
    strain,
    sentence: `lives within its ${r.binding} (${Math.round(pop)} of ${r.ceiling} souls)`,
  };
}
