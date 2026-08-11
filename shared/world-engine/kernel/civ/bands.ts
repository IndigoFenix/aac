// BANDS — mobile foragers as ENTITIES (settlement-emergence.md §3).
//
// The substrate's `forage` field is the LAND: rations a tile yields to a
// mobile taker, a resting, diffusion-free, idle-safe capacity. The PEOPLE
// who live on it cannot be a field — mobility can't live in a layer that
// must reach rest — so they are entities here, in the layer that already
// does conserving migration (composition, absorbSettlement, colonists).
//
// A band has a position, a size, a STORE and a subsistence mode. With
// bands as entities, founding stops being "harvest a field into an
// entity" and becomes an ordinary state change on an existing entity —
// gather → settle — and desettlement (Gate D) is its exact inverse,
// disperse. That symmetry is what makes the arc reversible at all.
//
// STEP ③ (behaviour-preserving): gather + settle is the founding harvest
// tri.ts always ran, bit for bit (same passes, same largest-remainder
// apportionment, same tile scan order).
//
// STEP ④ — GATE A: bands LIVE between gather and settle. Each day a band
// draws its box's forage yield, eats, banks the surplus, and the bank
// SPOILS at its staple's storage half-life (freight.ts keepDays — rot
// rides the metabolism dial). The settle decision stops being a census:
//
//   settle ⇔ store > carryCapacity   AND   pressure ≥ pressureFloor
//
// — you settle when you own more than you can carry AND there is nowhere
// comparable to walk to (circumscription). Both halves are dimensionless
// ratios of declared quantities; no rule here names a duration, distance
// or amount. The negative cases come free: a rich open frontier grows no
// cities (pressure fails — walk away and forage), and a fragile staple
// never fills a store past its own carry (pastoralists stay mobile).

import { injectTile, type CellGrid, type FoundingOpts, type FoundingSite } from "../cells/index";
import {
  REAL_PORTER_BULK, freightOf, storedFraction, type Freight,
} from "../../freight";
import { needFillDays, townSpacingM, type WorldScale } from "../../scale";

/** One wild species' presence on the grid: its key, and the capacity
 *  field its crowds are read off (the base `forage` for humans; a
 *  declared wild field per extra sapient species — economy.ts). */
export interface WildSpecies {
  key: string;
  field: string;
  /** The HABITAT the crowd field converges toward (capacity = habitat ×
   *  scale — the wild rule's own target). Band life reads THIS as the
   *  land's offer: the crowd field is a standing crop that a gather
   *  momentarily empties, but the land's rate of provision is the
   *  habitat's — a fresh band must not starve on its own harvest
   *  artifact. */
  habitat?: { field: string; scale?: number };
}

/** A capacity source for band life: a bare field name, or a field scaled
 *  (the habitat × scale form — lure × 2 is the human default). */
export type CapacityField = string | { field: string; scale?: number };

/** A mobile group — the permanent counterparty of settlements, never a
 *  transitional stage. Sizes are GRID PERSONS (the field's own unit);
 *  the composition's souls-per-grid-person scale applies at settle. */
export interface Band {
  /** The cell the band stands on (its gather site; a settle founds here). */
  cell: number;
  /** Grid persons per species key — who is actually in the band. */
  mix: Record<string, number>;
  /** Σ mix — the backs available (Gate A's carryCapacity reads this). */
  size: number;
  /** Banked rations. Inert until step ④ gives it dynamics (accumulation
   *  in the fat season, spoilage from the product's `transit`). */
  store: number;
  /** Subsistence mode — content, not a stage (settlement-emergence §8):
   *  forager / herder / fisher… become rows later; "forager" today. */
  mode: string;
}

export interface GatherOpts {
  /** Box radius the crowd is lifted from (the founding box). */
  radius: number;
  /** FOUND SMALL cap (grand-dream civilization-emergence §2a): take at
   *  most this many grid persons, apportioned across species by
   *  largest remainder; the residue stays wild and regrows. */
  maxHarvest?: number;
}

/**
 * Lift the wild crowd around `site` off the grid into a band — the
 * founding transaction's substrate side. Deterministic: species in
 * `wilds` order, tiles in `topo.disk` scan order, largest-remainder
 * under the cap (ties by species order). Conserving: the band's mix is
 * exactly what left the field. A band of size 0 means an empty box.
 */
export function gatherBand(
  grid: CellGrid, wilds: WildSpecies[], site: FoundingSite, opts: GatherOpts,
): Band {
  // Pass 1: measure every species' crowd in the box (the founding site's
  // lattice neighbourhood — same cells the density scan counted).
  const boxes = wilds.map(w => {
    const arr = grid.fields[w.field];
    const tiles: Array<{ cell: number; here: number }> = [];
    let sum = 0;
    if (arr) {
      grid.topo.disk(site.cell, opts.radius, cell => {
        const here = arr[cell];
        if (here > 0) { tiles.push({ cell, here }); sum += here; }
      });
    }
    return { w, tiles, sum };
  });
  const grand = boxes.reduce((a, b) => a + b.sum, 0);
  const cap = opts.maxHarvest;

  // Pass 2: how many each species gives up. Under the cap: largest-
  // remainder over the species sums (exact — Σ wants = cap; ties by
  // species order, deterministic).
  let wants = boxes.map(b => b.sum);
  if (cap !== undefined && grand > cap) {
    wants = boxes.map(b => Math.floor((cap * b.sum) / grand));
    let left = cap - wants.reduce((a, b) => a + b, 0);
    const order = boxes
      .map((b, i) => ({ i, rem: (cap * b.sum) / grand - wants[i] }))
      .sort((a, b) => b.rem - a.rem || a.i - b.i);
    for (const o of order) {
      if (left <= 0) break;
      if (boxes[o.i].sum > wants[o.i]) { wants[o.i]++; left--; }
    }
  }

  // Pass 3: take, tile by tile in scan order, up to each want.
  const mix: Record<string, number> = {};
  let total = 0;
  boxes.forEach((b, i) => {
    let remaining = wants[i];
    let taken = 0;
    for (const t of b.tiles) {
      if (remaining <= 0) break;
      const take = Math.min(t.here, remaining);
      injectTile(grid, t.cell, b.w.field, -take);
      remaining -= take;
      taken += take;
    }
    if (taken > 0) {
      mix[b.w.key] = taken;
      total += taken;
    }
  });
  return { cell: site.cell, mix, size: total, store: 0, mode: "forager" };
}

/**
 * The band founds: an ordinary state change on an existing entity. The
 * returned crowd is the composition's birth population (feed `mix` to
 * harvestStartpop — who was in the band decides who founds). The band
 * is spent; callers drop their reference.
 */
export function settleBand(band: Band): { total: number; mix: Record<string, number> } {
  return { total: band.size, mix: band.mix };
}

/**
 * The exact inverse of gather — Gate D's mechanism (desettlement back
 * into the wild), shipped with the data structure so the arc's
 * reversibility is pinned from day one. Returns the band's people to
 * their species' fields over the same box, tile by tile in scan order,
 * respecting each tile's headroom (the var's max — a valley can only
 * hold so many). Returns the count that found no room (still in the
 * band: a full valley is a real constraint, not a rounding loss —
 * the caller widens the radius or keeps them walking).
 */
export function disperseBand(
  grid: CellGrid, wilds: WildSpecies[], band: Band, radius: number,
): number {
  let unplaced = 0;
  for (const w of wilds) {
    let remaining = band.mix[w.key] ?? 0;
    if (remaining <= 0) continue;
    const arr = grid.fields[w.field];
    const max = grid.spec.vars?.find(v => v.name === w.field)?.max ?? Infinity;
    if (arr) {
      const room: Array<{ cell: number; free: number }> = [];
      grid.topo.disk(band.cell, radius, cell => {
        const free = max - arr[cell];
        if (free > 0) room.push({ cell, free });
      });
      for (const t of room) {
        if (remaining <= 0) break;
        const give = Math.min(t.free, remaining);
        injectTile(grid, t.cell, w.field, give);
        remaining -= give;
      }
    }
    band.mix[w.key] = remaining;
    unplaced += remaining;
  }
  band.size = Object.values(band.mix).reduce((a, b) => a + b, 0);
  return unplaced;
}

/** Disperse with escalating radius until everyone found ground (the
 *  item-conservation law: dispersal may never DELETE people — a full
 *  valley just pushes the walkers wider). Returns the count that still
 *  found no room after covering the whole grid: 0 on any world that
 *  isn't literally at carrying capacity everywhere. */
export function disperseBandFully(
  grid: CellGrid, wilds: WildSpecies[], band: Band, radius: number,
): number {
  const maxR = Math.max(grid.cols, grid.rows);
  let r = radius;
  let unplaced = disperseBand(grid, wilds, band, r);
  while (unplaced > 0 && r < maxR) {
    r *= 2;
    unplaced = disperseBand(grid, wilds, band, Math.min(r, maxR));
  }
  return unplaced;
}

// ------------------------------------------------------- the band's day (④)

/** Σ of the wild capacity fields over the band's working box — the crowd
 *  the box supports continuously, in grid persons (the field's unit). */
export function boxCapacity(
  grid: CellGrid, fields: readonly CapacityField[], cell: number, radius: number,
): number {
  let sum = 0;
  for (const f of fields) {
    const name = typeof f === "string" ? f : f.field;
    const scale = typeof f === "string" ? 1 : (f.scale ?? 1);
    const arr = grid.fields[name];
    if (!arr) continue;
    grid.topo.disk(cell, radius, c => { sum += arr[c] * scale; });
  }
  return sum;
}

/** Rations the band needs per game day — appetite over the eating period
 *  (a person eats one ration per hunger period; metabolism moves it). */
export function bandDayNeed(scale: WorldScale, band: Band): number {
  return band.size / needFillDays(scale, "hunger");
}

export interface BandDayOpts {
  scale: WorldScale;
  /** The box radius the band works (the founding radius). */
  radius: number;
  /** The capacity sources its species read (habitat × scale when the
   *  world declares one — never the drained standing crop). */
  fields: readonly CapacityField[];
  /** The staple the band banks — spoilage reads its keepDays. */
  freight: Freight;
  /** Season factor on today's draw (seasonYieldAt; 1 = no seasons). */
  yieldFactor?: number;
}

export interface BandDayReport {
  /** Rations the band needed today. */
  need: number;
  /** Rations the land yielded today (box capacity × season, per period). */
  yield: number;
  /** Rations banked (yield − need, when positive). */
  banked: number;
  /** Rations of need NOT covered by land or store — a hungry band; the
   *  caller's move is dispersal (bands WALK before they starve). */
  shortfall: number;
}

/**
 * One game day of band life, at the day boundary (like mining — surgery
 * between steps, never a rule; the substrate stays resting, only the
 * DRAW cycles). The field is a CAPACITY (rations per hunger period the
 * box offers): the band eats today's yield, banks any surplus, draws the
 * store on any deficit — and the store spoils first, at the staple's
 * half-life. Nothing is written to the grid: living off the land is the
 * flux the capacity already prices, not a stock withdrawal (overgrazing
 * is a later refinement, and it must not wake the field).
 */
export function stepBandDay(grid: CellGrid, band: Band, opts: BandDayOpts): BandDayReport {
  const fill = needFillDays(opts.scale, "hunger");
  const need = band.size / fill;
  const dayYield = (boxCapacity(grid, opts.fields, band.cell, opts.radius) * (opts.yieldFactor ?? 1)) / fill;

  // The pile rots before it feeds — a day passed over it.
  band.store *= storedFraction(opts.scale, opts.freight, 1);

  let banked = 0;
  let shortfall = 0;
  if (dayYield >= need) {
    banked = dayYield - need;
    band.store += banked;
  } else {
    const deficit = need - dayYield;
    const draw = Math.min(band.store, deficit);
    band.store -= draw;
    shortfall = deficit - draw;
  }
  return { need, yield: dayYield, banked, shortfall };
}

// ------------------------------------------------------------ Gate A (④)

export interface CarryOpts {
  /** Bulk units one back carries (default: the porter anchor). */
  portableBulk?: number;
}

/** What the band can WALK AWAY WITH, in rations-worth: backs × pack ×
 *  the staple's worth per bulk. The left side of Gate A — literally the
 *  backs available. */
export function bandCarryCapacity(band: Band, freight: Freight, opts: CarryOpts = {}): number {
  return band.size * (opts.portableBulk ?? REAL_PORTER_BULK) * freight.valueDensity;
}

export interface PressureOpts {
  /** The box radius candidates are measured at (the founding radius). */
  radius: number;
  /** Relocation reach of the scan, in cells — how far the band could
   *  walk to comparable land (the caller derives it from its scale and
   *  metre pitch; the engine never names a distance). */
  searchCells: number;
  /** Land already spoken for — settlements' charters, other bands'
   *  boxes. A claimed cell is not an escape. */
  claimed?: (cell: number) => boolean;
}

export interface PressureReading {
  /** The band's own box capacity — what staying offers. */
  current: number;
  /** The best unclaimed comparable box within reach — what walking offers. */
  best: number;
  /** 1 − best/current, clamped to [0, 1]: 0 = free land as good as home
   *  (walk away — no store binds you), →1 = nowhere to go
   *  (circumscription — the Nieboer–Domar land-per-worker variable,
   *  which is why exploitation-economics reads THIS number too). */
  pressure: number;
}

/**
 * CIRCUMSCRIPTION, measured: scan the band's relocation reach for the
 * best unclaimed box of the same capacity fields. Candidate boxes must
 * be DISJOINT from the band's own (a box overlapping home is not an
 * escape). Deterministic scan order; pure read.
 */
export function bandPressure(
  grid: CellGrid, fields: readonly CapacityField[], band: Band, opts: PressureOpts,
): PressureReading {
  const current = boxCapacity(grid, fields, band.cell, opts.radius);
  const minD2 = (2 * opts.radius + 1) ** 2; // disjoint boxes on the lattice
  let best = 0;
  grid.topo.disk(band.cell, opts.searchCells, cell => {
    if (grid.topo.dist2(cell, band.cell) < minD2) return;
    if (opts.claimed?.(cell)) return;
    const cap = boxCapacity(grid, fields, cell, opts.radius);
    if (cap > best) best = cap;
  });
  const pressure = current <= 0 ? 0 : Math.max(0, Math.min(1, 1 - best / current));
  return { current, best, pressure };
}

/** Default settle floor: the best escape must be at least a quarter worse
 *  than home before a store is worth guarding. CONTENT — a world spec
 *  tunes it (0 = any store settles; →1 = only the truly cornered do). */
export const PRESSURE_FLOOR_DEFAULT = 0.25;

/**
 * GATE A — the settle decision (settlement-emergence.md §5):
 * `store > carryCapacity` (you own more than you can carry) AND
 * `pressure ≥ floor` (and nowhere to walk to). Both dimensionless.
 */
export function gateASettles(
  band: Band, freight: Freight, pressure: PressureReading,
  opts: CarryOpts & { pressureFloor?: number } = {},
): boolean {
  return (
    band.store > bandCarryCapacity(band, freight, opts) &&
    pressure.pressure >= (opts.pressureFloor ?? PRESSURE_FLOOR_DEFAULT)
  );
}

// ------------------------------------- THE CLOSED-FORM TWIN OF GATE A (§3.1)
//
// growth-unification.md §4: `findFoundingSites` stops being an independent
// static aesthetic and becomes the CLOSED FORM of the same gate — "the scan
// places settlements where bands would have settled". Same doctrine as the
// construction director's clock twin: the observed arm iterates, the
// unobserved arm solves, and the two agree on WHERE, never byte-for-byte
// (growth-unification §8, "the scan can't be a perfect twin").
//
// THE ALGEBRA, read straight off the loop above. A band standing on a box
// gathers the FOUND-SMALL take (`GatherOpts.maxHarvest` — the residue stays
// wild) and then lives there:
//
//   yield/day   = boxCapacity / needFillDays(hunger)      (stepBandDay)
//   need/day    = size        / needFillDays(hunger)
//   store*      = (yield − need) / (1 − storedFraction(1 day))
//                 ── the geometric plateau band-gate-a.test.ts already pins
//                    ("banked/(1 − dailyKeep)"): the pile rots before it feeds
//   carry       = size × portableBulk × valueDensity      (bandCarryCapacity)
//
// so Gate A's left half, `store* > carry`, is
//
//   boxCapacity > size × (1 + needFillDays × (1 − dailyKeep) × bulk × vd)
//                        └──────────── 1 + CARRY RATIO ────────────┘
//
// and at rest the settled `forage` field IS the box capacity the scan sums
// (`FoundingSite.density`). So the scan's `threshold` and its `maxHarvest`
// are ONE relationship rather than two independent literals — which is
// exactly the incoherence the survey found (every shipped tier authored
// `maxHarvest: 600` beside thresholds of 25–100, a cap that can never bind
// and therefore a Gate A that could never fire).
//
// THE CONTENT SIDE IS THE TAKE. `foundPop` — how many grid persons one
// founding raises — is a statement about PEOPLE, which is what a tier
// genuinely declares; the density that keeps them is then Gate A's answer,
// not an aesthetic. The inverse (`gateAFoundPop`) exists because a world may
// legitimately declare the land instead.
//
// The negative cases come free, exactly as they do in the loop: a DURABLE
// staple has `dailyKeep === 1`, so the ratio is 0 and any surplus at all
// settles; a FRAGILE one (milk, keepDays 1) puts the ratio above 10, so a
// pastoral band needs an order of magnitude more crowd before its store can
// out-run its backs — and mostly never settles.

/**
 * THE CARRY RATIO: how many times its own size a band's box must feed before
 * the plateau store out-runs the backs that could carry it away.
 * Dimensionless, and a pure function of the declared dials (metabolism
 * through `needFillDays`, the staple's keeping, the pack, the staple's worth).
 */
export function gateACarryRatio(
  scale: WorldScale, freight: Freight, opts: CarryOpts = {},
): number {
  const fill = needFillDays(scale, "hunger");
  const dailyKeep = storedFraction(scale, freight, 1);
  return fill * (1 - dailyKeep) * (opts.portableBulk ?? REAL_PORTER_BULK) * freight.valueDensity;
}

/** Gate A read forward: the box capacity (= the settled `forage` sum the
 *  scan calls `density`) at which a founding of `foundPop` grid persons
 *  banks past its own carry. */
export function gateAThreshold(
  scale: WorldScale, freight: Freight, foundPop: number, opts: CarryOpts = {},
): number {
  return foundPop * (1 + gateACarryRatio(scale, freight, opts));
}

/** Gate A read back: the founding a declared density would settle. Exactly
 *  inverts `gateAThreshold` (pinned). */
export function gateAFoundPop(
  scale: WorldScale, freight: Freight, threshold: number, opts: CarryOpts = {},
): number {
  return threshold / (1 + gateACarryRatio(scale, freight, opts));
}

export interface FoundingScanOpts extends CarryOpts {
  scale: WorldScale;
  /** GRID PERSONS one founding raises — the FOUND-SMALL take (grand-dream
   *  civilization-emergence §2a). The tier's one content declaration. */
  foundPop: number;
  /** Metres per chart cell at this tier — the unit `minSpacing` is in.
   *  Omitted = the tier measures spacing in cells of its own and keeps the
   *  `minSpacing` it declares (a tier-0 chart cell IS the settlement
   *  lattice; the day's-walk law is a tier-1 fact). */
  cellSizeM?: number;
  /** The staple a band banks here (default the registry's `food`). */
  freight?: Freight;
  /** Box radius in cells (default 2 — every shipped tier's). */
  radius?: number;
  /** The narrowest gap this tier's CHART can express, in cells. A chart
   *  limit, never a spacing choice — which is why the extent that rides it
   *  reads the gap the floor actually imposes (`townExtentM(scale, spacing)`). */
  minSpacingFloorCells?: number;
  /** The WIDEST gap this tier's chart can express, in cells — the other
   *  half of the same chart limit, and load-bearing on a small world: a
   *  border band 86 cells long cannot hold a 18 000-cell gap, and asking it
   *  to sizes a grid past its own key stride (MEASURED: `borderTowns: band
   *  grid exceeds its key stride` on the 2 km test planet, whose band cell
   *  is 1.36 m against a real 25 km day's walk). Capped, the tier says the
   *  honest thing instead — the gap is wider than this chart, so at most one
   *  settlement fits in it. Absent = no cap. */
  minSpacingCapCells?: number;
  /** Kept when the tier declares no `cellSizeM` (see above). */
  minSpacing?: number;
}

/**
 * The scan's options, DERIVED: threshold from Gate A, spacing from the
 * settled map's own distance (`scale.ts townSpacingM`), harvest from the
 * declared take. `score`/`eligible`/`occupied` stay the caller's — the
 * ranking is what a tier is genuinely free to author (world-content §5's
 * supply/demand weights), the GATE is not.
 */
export function foundingScan(opts: FoundingScanOpts): FoundingOpts {
  const freight = opts.freight ?? freightOf("food");
  const spacing = opts.cellSizeM
    ? Math.min(
        opts.minSpacingCapCells ?? Infinity,
        Math.max(
          opts.minSpacingFloorCells ?? 1,
          Math.round(townSpacingM(opts.scale) / opts.cellSizeM),
        ),
      )
    : (opts.minSpacing ?? 1);
  return {
    threshold: gateAThreshold(opts.scale, freight, opts.foundPop, opts),
    radius: opts.radius ?? 2,
    minSpacing: spacing,
    maxHarvest: opts.foundPop,
  };
}
