// shared/world-engine/planet/refine.ts
//
// TIER 1 OF THE HIERARCHICAL SUBSTRATE (planning-docs/games/world-engine/
// hierarchical-cells.md): refine ONE tier-0 planet cell (~100–200 km) into
// a flat region grid (~1–4 km cells) and found the VILLAGES between the
// capitals — the settlement density no global grid can hold.
//
// The consistency contract, in code:
//  - DETERMINISM: everything derives from (planet spec, regionCell) — a
//    region is an ADDRESS, not a session artifact.
//  - TERRAIN: the child height author IS the planet's render sampler
//    (surface.heightAt at each child cell's sphere direction) — villages
//    found on the hills and rivers the player actually sees. Never a new
//    noise field.
//  - BUDGETS: the tier-0 cell's fields are budgeted as DENSITIES — child
//    crowds are RESCALED so each parent-cell slice's MEAN matches the
//    parent's value (ore passes through the same way; both are 0..n-unit
//    fields whose count-apportionment over ~9k children rounds to dust).
//    Strict COUNT conservation was probed and kills the tier: tier-0
//    `forage` is capitals-tier founding fuel, not a census — a 208-km cell
//    holds "300 grid-persons" as a ranking signal, and spreading that over
//    a region supports ~one village. The village-tier population is what
//    tier 0 never modeled; the civ layer stays at tier 0, so nothing
//    double-counts. (Count-true budgets return with the wild-population
//    question the design doc leaves open.) Fertility comes from the
//    child's own river solve — re-derived tributaries are the point.
//  - CAPITALS ARE FIXED POINTS: tier-0 sites project into the chart as
//    `occupied`, so villages space around the existing cities instead of
//    re-founding them.
//
// The region frame is a gnomonic tangent chart at the cell center (the
// town-plane precedent, one tier up): child cells are PLACED by sphere
// direction; only the solver's adjacency is flat.

import type { BuiltPlanet } from "./planet-game.js";
import { applyClimate, LAPSE_C_PER_M, THERMAL_M_PER_UNIT_CAP } from "./climate.js";
import { prepareSubstrate, type TriPrep } from "../kernel/civ/tri.js";
import {
  hubRoutes, leastCostRoute, trafficFromRoutes, commitRoads, type RoadSegment,
} from "../kernel/civ/travel.js";
import { findFoundingSites, type FoundingOpts } from "../kernel/cells/index.js";
import { foundingScan } from "../kernel/civ/bands.js";
import { SEA_HEIGHT } from "../kernel/geology/tectonics.js";
import {
  foundCitiesFromSites, REGION_FOUND_POP, spillBudget, spillFoundingSites, type PlanetCity,
} from "./cities.js";
import { RIVER_MIN_ACCUM, traceRiverPolylines, type RiverPolyline } from "./rivers.js";
import {
  chaikinSphere, portTerminateRoute, routeFromDirs, routePointAt,
  type PlanetRoute, type RouteTerminal,
} from "./routes.js";
import { borderTowns, chebyshevDistance, type BorderTown } from "./border.js";
import { REAL_SCALE, TIER_POP_CAP, tierExtentM, townExtentM, type WorldScale } from "../scale.js";

export interface RegionFrame {
  regionCell: number;
  /** Unit direction of the region center. */
  dir0: readonly [number, number, number];
  east: readonly [number, number, number];
  north: readonly [number, number, number];
  /** Chart width (m) — the parent cell's pitch at the planet radius. */
  widthM: number;
  cols: number;
  rows: number;
  cellSizeM: number;
}

export interface RefineOpts {
  /** Child grid resolution (default 96×96). */
  cols?: number;
  rows?: number;
  /** Village founding (defaults: day's-walk spacing at the child scale). */
  founding?: Partial<FoundingOpts>;
  /** Villages' farmland floor (foundCitiesFromSites). */
  minFarmland?: number;
  /** The world's space-time compression — sets village spacing
   *  (`townSpacingM`, catchment-priced at the village popCap) and, through the
   *  clip law, the extent their lanes port at (`tierExtentM("village", …)`).
   *  Absent = realism, which reproduces the historical day's-walk spacing
   *  exactly. */
  scale?: WorldScale;
}

export interface RefinedRegion {
  frame: RegionFrame;
  /** THE DERIVED VILLAGE EXTENT this region's villages build out to, and
   *  therefore the radius its lanes PORT at (scale.ts
   *  `tierExtentM("village", …)`, growth phase C §1.2 + food-scale-round ⑩:
   *  this tier founds VILLAGES, so it speaks the village body — 120 m —
   *  capped by the clip law). Carried on the region rather than re-derived
   *  per consumer so the village lanes, the cross-border stitches and
   *  anything that later reads a village's edge all name the same circle. */
  villageExtentM: number;
  /** The child substrate (rivers, fertility, crowds — the region's truth). */
  prep: TriPrep;
  /** The villages, in the demo pipeline's city shape. `cell` is the
   *  COMPOSITE key regionCell × 16384 + childCell (tiers never collide).
   *  Includes the BORDER TOWNS this region OWNS (border.ts edge pass) —
   *  their `cell` is a NEGATIVE border key, so downstream consumers can
   *  keep treating the key as opaque. */
  villages: PlanetCity[];
  /** ALL border towns of this region's edges (both owners) — the shared,
   *  symmetric edge-pass output both neighbours agree on. The subset with
   *  owner === regionCell is already appended to `villages`. */
  borderTowns: BorderTown[];
  /** Tier-0 sites that project inside the chart (the fixed points). */
  capitalCells: number[];
  /** The committed intercity road net (travel.ts): the grid's `road` and
   *  `traffic` fields are the truth renderers draw; segments carry the
   *  bridge/tunnel classification per committed cell. */
  roads: RoadSegment[];
  /** The same net as draped SPHERE POLYLINES in the planet route shape
   *  (routes.ts) — pure JSON, so it crosses the worker boundary and the
   *  flight renderer drapes it exactly like the interstate net. Endpoints
   *  carry composite village keys, so caravan phase hashes never collide
   *  across regions or tiers. */
  roadRoutes: PlanetRoute[];
  /** The region's OWN streams — the child river solve traced into sphere
   *  polylines (pure JSON, worker-safe), with accumulations converted to
   *  PARENT units and clipped to owned cells. Deliberately EXCLUDES the
   *  re-solved courses of tier-0 trunks (reaches sourced at a parent-scale
   *  inflow): the base tier already paints those, and drawing both would put
   *  the same river down twice on slightly different courses. These are the
   *  capillaries BETWEEN the trunks — the fractal tier the planet solve
   *  cannot represent. */
  rivers: RiverPolyline[];
  /** Where this region's streams cross its ownership line (both ways) — the
   *  seam anchors stream stitching joins on (stitchRegionStreams). Worker-
   *  side data; never crosses the wire itself. */
  riverCrossings: RiverCrossing[];
  /** SPILL-FOUNDING diagnostics (food-scale-round.md "# STAGE β" β3) — the
   *  ledger's measurement seam: the first-pass crowd the village tier
   *  turned away (`budget`, cities.ts spillBudget), how much marginal land
   *  the relaxed pass offered, how many spill SITES the budget took, and
   *  how many spill VILLAGES actually founded (minFarmland still gates a
   *  taken site, so `spillVillages ≤ spillSites`). Data only — nothing
   *  downstream consumes it. */
  spill: {
    budget: number;
    firstPassSites: number;
    relaxedCandidates: number;
    spillSites: number;
    spillVillages: number;
  };
}

/** A stream crossing the region's ownership line, as THIS region's solve saw
 *  it. The emitted run ends (out) or starts (in) EXACTLY at `ownCell`'s dir,
 *  so a join built from these touches the painted seam with zero slop. */
export interface RiverCrossing {
  /** true: the stream leaves this region (owned → foreign); false: enters. */
  out: boolean;
  /** The OWNED cell at the crossing. */
  ownCell: number;
  ownDir: readonly [number, number, number];
  /** The first foreign cell's dir — this solve's estimate of the course just
   *  across the line. */
  foreignDir: readonly [number, number, number];
  /** The tier-0 cell owning the far side. */
  borderWith: number;
  /** Accumulation at the crossing, PARENT units (sub-trunk by construction —
   *  trunk crossings are the base tier's rivers, not stitch material). */
  accum: number;
}

/** The composite identity of a village: unique across regions AND across
 *  tiers (tier-0 cells are < 6·faceN² < 16384·regionCell for any faceN the
 *  planet ships). Also the village town's deterministic seed. */
export const villageKey = (regionCell: number, childCell: number): number =>
  regionCell * 16384 + childCell;

const norm = (v: [number, number, number]): [number, number, number] => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};

/** Chart tile index of a direction, or −1 (far side / off the chart) —
 *  the gnomonic projection every chart consumer shares. */
function chartTile(frame: RegionFrame, R: number, d: readonly [number, number, number]): number {
  const w = d[0] * frame.dir0[0] + d[1] * frame.dir0[1] + d[2] * frame.dir0[2];
  if (w <= 0.5) return -1;
  const px = ((d[0] * frame.east[0] + d[1] * frame.east[1] + d[2] * frame.east[2]) / w) * R;
  const py = ((d[0] * frame.north[0] + d[1] * frame.north[1] + d[2] * frame.north[2]) / w) * R;
  const tx = Math.round(px / frame.cellSizeM + frame.cols / 2 - 0.5);
  const ty = Math.round(py / frame.cellSizeM + frame.rows / 2 - 0.5);
  if (tx < 0 || tx >= frame.cols || ty < 0 || ty >= frame.rows) return -1;
  return ty * frame.cols + tx;
}


/** The region's tangent frame + chart size, from the lattice itself. */
export function regionFrame(built: BuiltPlanet, regionCell: number, opts: RefineOpts = {}): RegionFrame {
  const topo = built.topo;
  if (!topo.pos3) throw new Error("refineRegion: the topology has no pos3");
  const dir0 = topo.pos3(regionCell);
  // Pitch = mean neighbour angle at this cell (the local cell size).
  const nbs: number[] = new Array(topo.maxDegree).fill(0);
  const k = topo.neighbours(regionCell, nbs);
  let pitch = 0;
  for (let j = 0; j < k; j++) {
    const q = topo.pos3(nbs[j]);
    const dp = Math.max(-1, Math.min(1, dir0[0] * q[0] + dir0[1] * q[1] + dir0[2] * q[2]));
    pitch += Math.acos(dp);
  }
  pitch = k > 0 ? pitch / k : Math.PI / 64;

  const seed: [number, number, number] = Math.abs(dir0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const east = norm([
    seed[1] * dir0[2] - seed[2] * dir0[1],
    seed[2] * dir0[0] - seed[0] * dir0[2],
    seed[0] * dir0[1] - seed[1] * dir0[0],
  ]);
  const north = norm([
    dir0[1] * east[2] - dir0[2] * east[1],
    dir0[2] * east[0] - dir0[0] * east[2],
    dir0[0] * east[1] - dir0[1] * east[0],
  ]);

  const cols = Math.max(16, Math.floor(opts.cols ?? 96));
  const rows = Math.max(16, Math.floor(opts.rows ?? 96));
  const widthM = pitch * built.spec.radius;
  return { regionCell, dir0, east, north, widthM, cols, rows, cellSizeM: widthM / cols };
}

/** Child tile (x, y) → unit sphere direction through the chart (radius =
 *  the planet radius the chart's metres live at). */
export function regionDir(
  f: RegionFrame, radius: number, x: number, y: number,
): [number, number, number] {
  const ox = (x + 0.5 - f.cols / 2) * f.cellSizeM;
  const oy = (y + 0.5 - f.rows / 2) * f.cellSizeM;
  return norm([
    f.dir0[0] * radius + f.east[0] * ox + f.north[0] * oy,
    f.dir0[1] * radius + f.east[1] * ox + f.north[1] * oy,
    f.dir0[2] * radius + f.east[2] * ox + f.north[2] * oy,
  ]);
}

export function refineRegion(built: BuiltPlanet, regionCell: number, opts: RefineOpts = {}): RefinedRegion {
  const frame = regionFrame(built, regionCell, opts);
  const R = built.spec.radius;
  const { cols, rows, cellSizeM } = frame;
  const surface = built.surface;
  const topo = built.topo;

  // ── Child cell directions (chart → sphere) ─────────────────────────────
  const dirAt = (x: number, y: number): [number, number, number] => regionDir(frame, R, x, y);

  // ── TERRAIN: render elevation → substrate units (the sampler's inverse
  //    mapping — surface.ts unitsToElev, solved for units). ────────────────
  const maxUnits = 63;
  const maxElevation = built.spec.relief * R;
  const unitElev = maxElevation / Math.max(1, maxUnits - SEA_HEIGHT);
  const maxDepth = maxElevation * 1.3;
  const elevToUnits = (elev: number): number =>
    elev >= 0 ? SEA_HEIGHT + elev / unitElev : SEA_HEIGHT + (elev / maxDepth) * SEA_HEIGHT;

  const dirs: Array<[number, number, number]> = new Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) dirs[y * cols + x] = dirAt(x, y);
  }
  // MACRO, not the carved ground: this seeds the child's `height`, which is
  // the child's own drainage potential (its re-derived tributaries are the
  // whole point of refining). Sampling the parent's carved `ground` here
  // would solve the child's rivers over the parent's riverbeds and cut a
  // valley into a valley at every tier. The child carves its own, once, from
  // its own solve — see kernel/cells/worldgen.carveValleys.
  const macroAt = surface.macroHeightAt ?? surface.heightAt;
  const height = (x: number, y: number): number => elevToUnits(macroAt(dirs[y * cols + x]));
  const oreArr = built.grid.fields.ore;
  const ore = (x: number, y: number): number => {
    // Density passthrough from the containing tier-0 cell (see header note).
    const parent = topo.cellAt!(dirs[y * cols + x]);
    return oreArr ? oreArr[parent] : 0;
  };

  // ── CAPITALS as fixed points (occupied) ─────────────────────────────────
  const occupied: Array<[number, number]> = [];
  const capitalCells: number[] = [];
  // THE PORT LAW needs each hub's TRUE centre, not its chart tile's centre:
  // a capital or border town lands anywhere inside its rounded tile (up to
  // ~a kilometre off at region resolution), and clipping a lane 450 m from
  // the wrong point would leave it painted through half the town. Villages
  // are founded ON tile centres, so they need no entry (dirs[tile] is exact).
  const hubDirs = new Map<number, readonly [number, number, number]>();
  for (const site of built.sites) {
    const d = topo.pos3!(site.cell);
    const w = d[0] * frame.dir0[0] + d[1] * frame.dir0[1] + d[2] * frame.dir0[2];
    if (w <= 0.5) continue; // far side
    // Gnomonic projection onto the chart.
    const px = ((d[0] * frame.east[0] + d[1] * frame.east[1] + d[2] * frame.east[2]) / w) * R;
    const py = ((d[0] * frame.north[0] + d[1] * frame.north[1] + d[2] * frame.north[2]) / w) * R;
    const tx = px / cellSizeM + cols / 2 - 0.5;
    const ty = py / cellSizeM + rows / 2 - 0.5;
    if (tx < -cols * 0.25 || tx > cols * 1.25 || ty < -rows * 0.25 || ty > rows * 1.25) continue;
    const cx = Math.round(tx);
    const cy = Math.round(ty);
    occupied.push([cx, cy]);
    capitalCells.push(site.cell);
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) hubDirs.set(cy * cols + cx, d);
  }

  // ── OWNERSHIP MASK + half-spacing setback ───────────────────────────────
  // The chart is a SQUARE window over a hex-ish cell, so it includes slivers
  // of land owned by neighbouring regions. A region founds ONLY on child
  // cells it owns (the refineHighways ownership rule, applied to founding),
  // and its INTERIOR villages additionally stay minSpacing/2 away from
  // non-owned territory — each side enforces the setback symmetrically, so
  // two regions' interior villages are ~minSpacing apart globally with zero
  // cross-region reads. Both go INSIDE the candidate scan (FoundingOpts.
  // eligible), never as a post-filter: a phantom sliver site accepted then
  // dropped would still consume a spacing slot and skew the traffic hubs.
  // DAY'S-WALK SPACING, derived (growth phase C §1.1): the world's own town
  // spacing in chart cells. `townSpacingM(REAL_SCALE)` IS the 25 km anchor,
  // so a world that declares no compression founds exactly where it always
  // did. The floor of 4 cells is a CHART limit, not a spacing choice — which
  // is why the extent below reads the spacing the floor actually imposes.
  // THE WHOLE SCAN IS GATE A's CLOSED FORM NOW (growth phase C §3.1): the
  // threshold is the crowd density at which a hamlet of REGION_FOUND_POP
  // banks past its own backs, the spacing is the world's day's walk, and the
  // harvest cap is the take those two are stated about. Authored `founding`
  // still wins — content outranks derivation.
  const scale = opts.scale ?? REAL_SCALE;
  // The chart CAP is the floor's other half (`border.ts` states the case that
  // forced it): a region chart `cols × rows` cells wide cannot impose a gap
  // wider than itself, and a world that asks for one is saying its regions
  // hold a single settlement — which the setback then delivers, without any
  // tier having to reason about an 18 000-cell number.
  const derivedScan = foundingScan({
    scale, foundPop: REGION_FOUND_POP, cellSizeM,
    minSpacingFloorCells: 4, minSpacingCapCells: Math.min(cols, rows),
    // THE TIER CAPACITY (food-scale-round ⑩): this scan founds VILLAGES, so
    // the staple catchment prices a village's 140 souls — at the shipped dials
    // the catchment (1 527 m) sits under the declared lattice (2 500 m) and this is
    // byte-identical; a tier big enough to out-eat its lattice would be
    // pushed apart until it can eat.
    popCap: TIER_POP_CAP.village,
  });
  const villageSpacingCells = derivedScan.minSpacing;
  // THE VILLAGE BODY, named (food-scale-round ⑩): this tier founds villages,
  // and a village declares 120 m of built radius (`REAL_TIER_EXTENT_M`), not
  // the market town's 450 — the same clip law then caps it by the gap the
  // chart actually imposed. This is the edit that delivers the user's 240 m
  // village in play.
  const villageExtentM = tierExtentM("village", scale, villageSpacingCells * cellSizeM);
  const foundingBase: FoundingOpts = {
    ...derivedScan,
    ...opts.founding,
  };
  const owned = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    owned[i] = topo.cellAt!(dirs[i]) === regionCell ? 1 : 0;
  }
  // Virtual ring probe: the owned cell can poke past the square chart, so a
  // chart-edge tile only counts as border-adjacent if the land just OFF the
  // chart beside it is actually foreign.
  const ringSeeds: number[] = [];
  const probeForeign = (x: number, y: number): boolean =>
    topo.cellAt!(dirAt(x, y)) !== regionCell;
  for (let x = 0; x < cols; x++) {
    if (probeForeign(x, -1)) ringSeeds.push(x);
    if (probeForeign(x, rows)) ringSeeds.push((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y++) {
    if (probeForeign(-1, y)) ringSeeds.push(y * cols);
    if (probeForeign(cols, y)) ringSeeds.push(y * cols + cols - 1);
  }
  const setback = Math.ceil(foundingBase.minSpacing / 2);
  const foreignDist = chebyshevDistance(cols, rows, c => owned[c] === 0, ringSeeds);
  const callerEligible = opts.founding?.eligible;
  const eligible = (c: number): boolean =>
    owned[c] === 1 && foreignDist[c] >= setback && (!callerEligible || callerEligible(c));

  // ── EDGE PASS: the setback band belongs to the border towns ─────────────
  // Each tier-0 edge founds its own towns (border.ts) — deterministic and
  // symmetric in the pair, so the neighbour region computes the identical
  // set. They project into this chart as `occupied` fixed points (the
  // capitals mechanism: interior scans keep spacing from them) and as road
  // hubs, and the ones THIS region owns join the villages output.
  const nbScratch: number[] = new Array(topo.maxDegree).fill(0);
  const nNbs = topo.neighbours(regionCell, nbScratch);
  const edgeTowns: BorderTown[] = [];
  for (let j = 0; j < nNbs; j++) {
    // NO per-region options thread through — the edge is shared data, and
    // two regions refined with different RefineOpts must still agree on it.
    edgeTowns.push(...borderTowns(built, regionCell, nbScratch[j]!));
  }
  const borderHubKeys = new Map<number, number>(); // chart tile → border key
  for (const t of edgeTowns) {
    const d = t.dir;
    const w = d[0] * frame.dir0[0] + d[1] * frame.dir0[1] + d[2] * frame.dir0[2];
    if (w <= 0.5) continue;
    const px = ((d[0] * frame.east[0] + d[1] * frame.east[1] + d[2] * frame.east[2]) / w) * R;
    const py = ((d[0] * frame.north[0] + d[1] * frame.north[1] + d[2] * frame.north[2]) / w) * R;
    const tx = px / cellSizeM + cols / 2 - 0.5;
    const ty = py / cellSizeM + rows / 2 - 0.5;
    if (tx < -cols * 0.25 || tx > cols * 1.25 || ty < -rows * 0.25 || ty > rows * 1.25) continue;
    const rx = Math.round(tx);
    const ry = Math.round(ty);
    occupied.push([rx, ry]);
    if (rx >= 0 && rx < cols && ry >= 0 && ry < rows) {
      borderHubKeys.set(ry * cols + rx, t.cell);
      hubDirs.set(ry * cols + rx, d);
    }
  }

  // ── The child substrate: rivers/fertility/crowds re-solve locally ───────
  // Day's-walk spacing: ~25 km at the child scale.
  const founding: FoundingOpts = {
    ...foundingBase,
    occupied: [...occupied, ...(opts.founding?.occupied ?? [])],
    eligible,
  };

  // ── TRUNK INFLOW: tier-0 rivers crossing INTO this chart ────────────────
  // The chart is a window: a parent trunk entering it carries catchment from
  // OUTSIDE, which the child solve cannot see — without this the Volga
  // re-enters its own valley as a nameless creek. Inject each entering
  // trunk's discharge as a point source (extra runoff) at its entry tile —
  // the classic inlet boundary condition — so the trunk holds its true width
  // across the window and the local capillaries drain into something real.
  //
  // UNITS. Parent accumulation counts parent-cell rain-shares; the child's
  // counts child-cell shares. One parent cell ≈ this whole chart, so a
  // parent unit is worth cols×rows child units. Only CHANNELIZED flow
  // (accum > the shared watercourse line) injects: a sub-threshold parent
  // cell's accumulation is diffuse drainage, not a point river — landing it
  // on one tile would mint max-width trunks out of every damp border cell.
  // Routing is potential-only, so injection changes WIDTHS (and the accum
  // classification the extraction filters on), never courses.
  const parentRiver = built.grid.fields.river;
  const parentDown = built.grid.fields.riverDown; // absent on pre-pointer bakes → no inflow (heals on rebuild)
  const rainScale = built.spec.rain > 0 ? built.spec.rain : 1;
  const childPerParent = cols * rows;
  const inflow = new Map<number, number>(); // child tile → extra runoff (child units)
  if (parentRiver && parentDown) {
    for (let c = 0; c < topo.n; c++) {
      if (!(parentRiver[c] > RIVER_MIN_ACCUM)) continue;
      const d = parentDown[c];
      if (d < 0) continue;
      const cd = topo.pos3!(c);
      if (chartTile(frame, R, cd) >= 0) continue; // upstream end must be OUTSIDE the chart
      const dd = topo.pos3!(d);
      if (chartTile(frame, R, dd) < 0) continue; // downstream end must be INSIDE
      // Bisect the drainage edge's arc for the entry point just inside.
      const mix = (t: number): [number, number, number] => norm([
        cd[0] + (dd[0] - cd[0]) * t, cd[1] + (dd[1] - cd[1]) * t, cd[2] + (dd[2] - cd[2]) * t,
      ]);
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (chartTile(frame, R, mix(mid)) < 0) lo = mid; else hi = mid;
      }
      const tile = chartTile(frame, R, mix(hi));
      if (tile < 0) continue;
      // The child's flow source multiplies runoff by spec.rain, and the
      // parent's accumulation already carries that factor — divide it out
      // so the trunk isn't rained on twice.
      inflow.set(tile, (inflow.get(tile) ?? 0) + (parentRiver[c] * childPerParent) / rainScale);
    }
  }

  // The parent's normalized runoff (planet climate rain, land-mean 1) passes
  // through like ore: a region in wet country re-solves DENSE local drainage,
  // a desert region sparse — deliberately NOT re-normalized per region, that
  // contrast is the point. Old bakes without the field fall back to uniform.
  const parentRunoff = built.grid.fields.runoff;
  const prep = prepareSubstrate({
    cols, rows,
    height,
    ore,
    founding,
    settle: true,
    rain: built.spec.rain,
    runoff: (parentRunoff || inflow.size)
      ? (x, y) => {
          const i = y * cols + x;
          const base = parentRunoff ? parentRunoff[topo.cellAt!(dirs[i])] : 1;
          return base + (inflow.get(i) ?? 0);
        }
      : undefined,
    // A region IS a window on the planet: its water leaves across the boundary
    // into the neighbouring land. Without this an inland region has no outlet
    // at all — no sea inside it, no edge to leave by — and its drainage settles
    // into hundreds of terminal puddles rather than a network.
    chart: true,
  });

  // ── BUDGET (density semantics — see header): rescale child crowds so
  //    each parent-cell slice's MEAN matches the parent's per-cell value.
  //    The parent decides HOW CROWDED its land is; the child's own river
  //    solve decides WHERE within it the crowds pool. ──────────────────────
  const parentForage = built.grid.fields.forage;
  const childForage = prep.grid.fields.forage;
  if (parentForage && childForage) {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < cols * rows; i++) {
      const parent = topo.cellAt!(dirs[i]);
      let g = groups.get(parent);
      if (!g) { g = []; groups.set(parent, g); }
      g.push(i);
    }
    for (const [parent, children] of groups) {
      let sum = 0;
      for (const i of children) sum += childForage[i];
      if (sum <= 0) continue;
      const scale = (parentForage[parent] * children.length) / sum;
      for (const i of children) childForage[i] *= scale;
    }
    // Crowds changed after the settle — re-rank the founding candidates on
    // the budgeted field (same scan, same spacing, same fixed points).
    prep.sites = findFoundingSites(prep.grid, founding);
  }

  // ── CLIMATE (planet/climate.ts): parent rain is a DENSITY passthrough
  //    like ore; temperature re-derives by the child-vs-parent elevation
  //    delta (the lapse anchor cancels in the difference). applyClimate
  //    then re-folds fertility/plant/ice onto the child's own river solve.
  //    Forage stays the budget's ("iceOnly" — the parent's crowds already
  //    carried climate at tier 0); ice still empties, so no village founds
  //    on a cap. ─────────────────────────────────────────────────────────
  const parentRain = built.grid.fields.rain;
  const parentTempC = built.grid.fields.tempC;
  if (parentRain && parentTempC) {
    const nChild = cols * rows;
    const childRain = new Float64Array(nChild);
    const childTempC = new Float64Array(nChild);
    const parentHeight = built.grid.fields.height;
    const childHeight = prep.grid.fields.height;
    const thermalM = Math.min(unitElev, THERMAL_M_PER_UNIT_CAP);
    for (let i = 0; i < nChild; i++) {
      const parent = topo.cellAt!(dirs[i]);
      childRain[i] = parentRain[parent];
      const dElevM = (Math.max(0, childHeight[i] - SEA_HEIGHT)
        - Math.max(0, parentHeight[parent] - SEA_HEIGHT)) * thermalM;
      childTempC[i] = parentTempC[parent] - LAPSE_C_PER_M * dElevM;
    }
    applyClimate(prep.grid, { rain: childRain, tempC: childTempC }, { forage: "iceOnly" });
    const ice = prep.grid.fields.ice;
    prep.sites = findFoundingSites(prep.grid, founding).filter(s => ice[s.cell] < 1);
  }

  // ── CHOKEPOINT TRAFFIC: a SCOUT net shapes the founding ─────────────────
  // Provisional routes between the projected FIXED towns (capitals AND
  // border towns — `occupied` carries both) and the region's top fertile
  // candidates price the passes/fords/isthmuses; the accumulated
  // betweenness becomes the `traffic` founding score field (route towns
  // outrank equally-crowded farmland — FoundingOpts.score, the intended
  // seam). NOTHING COMMITS HERE: the scout hubs are candidates that mostly
  // won't found, so committing their roads would draw a net that "passes
  // nearby" the real villages — the committed net re-solves below from the
  // towns that actually exist.
  const travel = { metresPerUnit: unitElev, metresPerCell: cellSizeM };
  const capHubs: number[] = [];
  for (const [tx, ty] of occupied) {
    if (tx >= 0 && tx < cols && ty >= 0 && ty < rows) capHubs.push(ty * cols + tx);
  }
  const scoutSet = new Set<number>(capHubs);
  for (const site of prep.sites.slice(0, 4)) scoutSet.add(site.cell);
  const scoutHubs = [...scoutSet];
  const scoutRoutes = scoutHubs.length >= 2 ? hubRoutes(prep.grid, scoutHubs, travel) : [];
  prep.grid.fields.traffic = trafficFromRoutes(prep.grid.topo.n, scoutRoutes);
  const childIce = prep.grid.fields.ice;
  prep.sites = findFoundingSites(prep.grid, {
    ...founding,
    score: [{ field: "traffic", weight: 3 }, ...(founding.score ?? [])],
  }).filter(s => !childIce || childIce[s.cell] < 1);

  // ── SPILL FOUNDING: the crowd the villages turn away founds MORE villages
  // (food-scale-round.md "# STAGE β" survey correction 8 + β3 — the user's
  // law: "the region answers with more towns, never overstuffed ones"). The
  // budget is the FIRST-PASS truth, computed BEFORE any spill site exists
  // (single discharge — a spill site's own potential never re-enters; see
  // cities.ts spillBudget). The second pass re-scans the SAME spacing
  // lattice at the relaxed threshold with the first-pass sites as occupied
  // fixed points, mirrors the first pass's traffic ranking and ice veto,
  // and its taken sites are APPENDED so the first-pass prefix — order AND
  // names (foundCitiesFromSites's collision fallback and `taken` set are
  // order-dependent) — stays byte-stable. This seam sits BEFORE the
  // founding/hub/road passes below, so spill villages get roads, ports and
  // stitches like any village.
  const budget = spillBudget(prep.sites);
  const firstPassSiteCount = prep.sites.length;
  const spill = spillFoundingSites(
    prep.grid,
    { ...founding, score: [{ field: "traffic", weight: 3 }, ...(founding.score ?? [])] },
    prep.sites,
    budget,
    s => !childIce || childIce[s.cell] < 1, // the first pass's own ice veto
  );
  const spillCells = new Set(spill.taken.map(s => villageKey(regionCell, s.cell)));
  prep.sites = [...prep.sites, ...spill.taken]; // APPEND-ONLY (the determinism law)

  // ── Villages through the same founding helper the capitals use ──────────
  // THE TIER, named on the row (food-scale-round ⑩): this scan founds
  // VILLAGES, and the town a visit builds from the row reads the tier back
  // (`TownPlayConfig.tier` → plan.ts `tierExtentM`), so the 120 m body laid
  // in play is the same one the lanes above ported at. ONE COMBINED ordered
  // call — first-pass sites first, spill sites appended — so first-pass
  // names stay byte-identical whether or not the region spilled.
  const villages: PlanetCity[] = foundCitiesFromSites({
    sites: prep.sites,
    grid: prep.grid,
    seedBase: (built.spec.geology.seed ^ Math.imul(regionCell, 0x85ebca6b)) >>> 0,
    dirOf: cell => dirs[cell],
    cellKey: cell => villageKey(regionCell, cell),
    minFarmland: opts.minFarmland ?? 25,
  }).map(v => ({ ...v, tier: "village" as const }));
  // The border towns THIS region owns join the output — downstream
  // consumers (geo-bake, town instantiation, stitching) see them as
  // villages with an opaque (negative) key, zero changes required. The
  // neighbour appends the towns IT owns, so nothing appears twice.
  for (const t of edgeTowns) {
    if (t.owner === regionCell) villages.push(t);
  }

  // ── THE road net: capitals + villages + border towns ────────────────────
  // Every hub is a real town, so every road ENDS at a town — a route that
  // passes a village without entering is impossible by construction. ALL
  // projected border towns hub (not just the owned ones), so the committed
  // net reaches the border and meets the neighbour's net at the same town.
  // The traffic field re-derives from these routes so what founders scored
  // and what renderers drape is the same net on the ground.
  const hubSet = new Set<number>(capHubs); // capitals + projected border towns
  for (const v of villages) {
    if (v.cell >= 0) hubSet.add(v.cell % 16384); // border tiles already hub via capHubs
  }
  const hubs = [...hubSet];
  const routes = hubs.length >= 2 ? hubRoutes(prep.grid, hubs, travel) : [];
  prep.grid.fields.traffic = trafficFromRoutes(prep.grid.topo.n, routes);
  const { segments: roads } = commitRoads(prep.grid, routes, travel);
  // The committed routes again as SPHERE polylines — the shape the flight
  // renderer drapes (and the worker ships: pure JSON, child grid left behind).
  // A border-town endpoint carries its BORDER key, so both regions' roads
  // into the same town hash the same caravan identity space.
  const keyOfTile = (tile: number): number =>
    borderHubKeys.get(tile) ?? villageKey(regionCell, tile);
  // THE PORT LAW at the village tier: every lane hub is a real town, so
  // every lane ports at that town's extent instead of driving to the tile
  // centre through its houses (planet/routes.ts portTerminateRoute).
  const terminalOfTile = (tile: number): RouteTerminal => ({
    id: keyOfTile(tile),
    dir: hubDirs.get(tile) ?? dirs[tile]!,
    extentM: villageExtentM,
  });
  const roadRoutes: PlanetRoute[] = [];
  for (const cells of routes) {
    if (cells.length < 2) continue;
    const smoothed = chaikinSphere(chaikinSphere(cells.map(c => dirs[c]!)));
    const route = routeFromDirs(
      smoothed, R,
      keyOfTile(cells[0]!),
      keyOfTile(cells[cells.length - 1]!),
    );
    if (route) {
      roadRoutes.push(portTerminateRoute(
        route, R, terminalOfTile(cells[0]!), terminalOfTile(cells[cells.length - 1]!),
      ));
    }
  }

  // ── THE REGION'S OWN STREAMS: the child solve, traced (rivers.ts) ───────
  // Same watercourse rule one tier down: 16 CHILD cells of catchment draw.
  // Accumulations convert to parent units (÷ childPerParent) so every
  // consumer shares one width calibration; OWNERSHIP clips emission to owned
  // cells (the neighbour emits its own spans of a shared stream); the
  // accumSource filter drops the re-solved TRUNKS — a reach that STARTS at
  // parent-scale flow is a tier-0 river the base tier already draws.
  const childRiver = prep.grid.fields.river;
  const childDown = prep.grid.fields.riverDown;
  const childHeight = prep.grid.fields.height;
  let rivers: RiverPolyline[] = [];
  const riverCrossings: RiverCrossing[] = [];
  if (childRiver && childDown) {
    rivers = traceRiverPolylines({
      n: cols * rows,
      river: childRiver,
      height: childHeight,
      downstream: childDown,
      posOf: cell => dirs[cell]!,
      radius: R,
      minAccum: RIVER_MIN_ACCUM,
      accumScale: 1 / childPerParent,
      include: cell => owned[cell] === 1,
      keyOf: cell => villageKey(regionCell, cell),
    }).filter(r => r.accumSource <= RIVER_MIN_ACCUM);

    // Ownership-line crossings — one O(n) pass over the drainage tree.
    // Deterministic (cell order); sea mouths are not crossings.
    for (let u = 0; u < cols * rows; u++) {
      if (!(childHeight[u] >= SEA_HEIGHT && childRiver[u] > RIVER_MIN_ACCUM)) continue;
      const v = childDown[u];
      if (v < 0) continue;
      if (!(childHeight[v] >= SEA_HEIGHT && childRiver[v] > RIVER_MIN_ACCUM)) continue;
      if (owned[u] === owned[v]) continue;
      const accum = childRiver[u] / childPerParent;
      if (accum > RIVER_MIN_ACCUM) continue; // a trunk — the base tier's river
      const out = owned[u] === 1;
      const foreignDir = out ? dirs[v]! : dirs[u]!;
      riverCrossings.push({
        out,
        ownCell: out ? u : v,
        ownDir: out ? dirs[u]! : dirs[v]!,
        foreignDir,
        borderWith: topo.cellAt!(foreignDir),
        accum,
      });
    }
  }

  return {
    frame, villageExtentM, prep, villages, borderTowns: edgeTowns,
    capitalCells, roads, roadRoutes, rivers, riverCrossings,
    spill: {
      budget,
      firstPassSites: firstPassSiteCount,
      relaxedCandidates: spill.candidates.length,
      spillSites: spill.taken.length,
      spillVillages: villages.filter(v => spillCells.has(v.cell)).length,
    },
  };
}

// ── TIER-1 HIGHWAY REFINEMENT (the interstates get physical) ───────────────

export interface HighwayRefinement {
  /** Parent tier-0 route identity (city cells, as planetRoutes emits). */
  a: number;
  b: number;
  /** Arc span [s0, s1] on the PARENT route this segment re-draws (metres). */
  s0: number;
  s1: number;
  /** The refined geometry: the same crossing re-solved on the region's
   *  child grid — real hills, real fords, and the committed village roads'
   *  discount, so the interstate MERGES with the local net near towns
   *  instead of paralleling it. RENDER-ONLY: caravans stay a closed form
   *  of the PARENT arc (the shared-clock law — clients with different
   *  regions loaded must agree on world state) and project onto this
   *  geometry per client. */
  route: PlanetRoute;
}

/**
 * Re-solve every tier-0 route's crossing of ONE region on that region's
 * child grid. Call AFTER refineRegion (the corridor prices the committed
 * village roads). The ownership rule keeps neighbouring regions disjoint:
 * a region refines only the arc inside ITS OWN tier-0 cell (∩ its chart),
 * so two loaded regions never both re-draw the same span.
 *
 * Deterministic in (built, regionCell, routes); pure — the child grid is
 * read, never written. Spans that cannot re-solve (a corner clip, an
 * open-sea entry) simply drop: the renderer keeps the tier-0 line there.
 */
export function refineHighways(
  built: BuiltPlanet,
  refined: RefinedRegion,
  routes: readonly PlanetRoute[],
  opts: { scale?: WorldScale } = {},
): HighwayRefinement[] {
  const { frame, prep } = refined;
  /** The TIER-0 extent: a parent route's pins are CITY ports, so the cells
   *  this drops are the ones inside a city, not inside a village. */
  const cityExtentM = townExtentM(opts.scale ?? REAL_SCALE);
  const R = built.spec.radius;
  const { cols, cellSizeM, regionCell } = frame;
  const topo = built.topo;
  const maxElevation = built.spec.relief * R;
  const unitElev = maxElevation / Math.max(1, 63 - SEA_HEIGHT);
  const travel = { metresPerUnit: unitElev, metresPerCell: cellSizeM };

  /** Inside = this region's OWN substrate cell AND on the chart (the child
   *  grid only exists there; cell corners can poke past the square chart). */
  const inside = (d: readonly [number, number, number]): number =>
    topo.cellAt!(d) === regionCell ? chartTile(frame, R, d) : -1;
  const dirAt = (cell: number): [number, number, number] =>
    regionDir(frame, R, cell % cols, Math.floor(cell / cols));

  // ── THE PORT LAW ALSO BINDS AGAINST THIS REGION'S OWN VILLAGES ───────────
  //
  // A refined span is priced with the committed village roads' discount, so
  // it MERGES with the local net near a town — which is the point, and which
  // is also how it ends up aimed straight at a village centre. The parent it
  // re-draws ported at CITY extents and knows nothing about villages, so
  // nothing else in the chain will stop it: phase C §3.4 made these spans
  // PAINT, and a span whose end sits 14 m from a village centre paints the
  // ground through that village's houses (MEASURED before this: region 3191,
  // a 143 m span passing 4.5 m from a village centre inside an 84.9 m
  // extent — 5 of the first 6 offenders were an END inside a village).
  //
  // So each span ports at the VILLAGE extent the same way `planetRoutes`
  // ports at the city one — the extent `refineRegion` already derived and
  // handed us (`refined.villageExtentM`), the same circle this region's own
  // lanes stop at, so highway and lane meet on one boundary.
  //
  // `s0`/`s1` DELIBERATELY DO NOT MOVE. They name the PARENT arc this span
  // stands for; shrinking them would un-suppress the parent over the village
  // and paint the unrefined line straight through it — the very thing being
  // fixed. Leaving them is what makes the clipped stretch a PORT: the parent
  // is suppressed, the span stops at the boundary, and the village's own
  // streets own the ground inside. Carts keep projecting across the arc
  // fraction (trade-roads.ts), as they already do for a refined span whose
  // length never matched its parent's.
  //
  // ENDS ONLY, and honestly so: a span that merely GRAZES a village
  // mid-course (measured: one at 81 m against a 91 m extent) would have to be
  // SPLIT to be cut, and a split span cannot be one parent override.
  const villageExtentM = refined.villageExtentM;
  const villages = refined.villages;
  const villageTerminal = (
    id: number, at: readonly [number, number, number],
  ): RouteTerminal | null => {
    let best: (typeof villages)[number] | null = null;
    let bestD = Infinity;
    for (const v of villages) {
      const d = Math.acos(Math.max(-1, Math.min(1,
        at[0] * v.dir[0] + at[1] * v.dir[1] + at[2] * v.dir[2]))) * R;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best && bestD < villageExtentM
      ? { id, dir: best.dir, extentM: villageExtentM }
      : null;
  };
  const villagePorted = (route: PlanetRoute): PlanetRoute =>
    villages.length
      ? portTerminateRoute(
          route, R,
          villageTerminal(route.a, route.dirs[0]!),
          villageTerminal(route.b, route.dirs[route.dirs.length - 1]!),
        )
      : route;

  // Vertex prefilter: a route with no vertex within the chart's padded
  // angular reach cannot cross it (vertices are ≲ the chart apart).
  const cosReach = Math.cos((frame.widthM * 1.2) / R);
  const stepM = cellSizeM / 2;
  const minSpanM = cellSizeM * 4; // corner clips aren't worth a seam

  const out: HighwayRefinement[] = [];
  for (const parent of routes) {
    let near = false;
    for (const v of parent.dirs) {
      if (v[0] * frame.dir0[0] + v[1] * frame.dir0[1] + v[2] * frame.dir0[2] > cosReach) {
        near = true;
        break;
      }
    }
    if (!near) continue;

    // Walk the arc at half-cell steps; refine each maximal inside-run.
    let runStartS = -1;
    let runStartCell = -1;
    let lastS = 0;
    let lastCell = -1;
    const flush = (): void => {
      if (runStartS < 0) return;
      const s0 = runStartS;
      const s1 = lastS;
      const startCell = runStartCell;
      const endCell = lastCell;
      runStartS = -1;
      if (s1 - s0 < minSpanM || startCell < 0 || endCell < 0 || startCell === endCell) return;
      const solved = leastCostRoute(prep.grid, startCell, endCell, travel);
      if (!solved || solved.cells.length < 2) return;
      // Endpoints PINNED to the parent's exact entry/exit points, so the
      // refined ribbon physically meets the tier-0 line at the seam.
      const pin0 = routePointAt(parent, s0);
      const pin1 = routePointAt(parent, s1);
      // THE PORT LAW survives the refinement. A span that reaches the
      // parent's END reaches a TOWN's port — and the re-solved cells are
      // child-grid CENTRES, the last of which is the town's OWN tile, whose
      // centre sits among the buildings the port exists to stay out of.
      // Drop the cells whose centre can be inside the town: the pinned port
      // already stands for that stretch.
      const atPort0 = s0 <= 0;
      const atPort1 = s1 >= parent.lengthM;
      const inTown = (
        d: readonly [number, number, number], pin: readonly [number, number, number],
      ): boolean =>
        Math.acos(Math.max(-1, Math.min(1, d[0] * pin[0] + d[1] * pin[1] + d[2] * pin[2]))) * R
          < cityExtentM * 2;
      const cells = (atPort0 || atPort1)
        ? solved.cells.filter(c => {
            const d = dirAt(c);
            return !((atPort0 && inTown(d, pin0)) || (atPort1 && inTown(d, pin1)));
          })
        : solved.cells;
      const raw: Array<readonly [number, number, number]> = [
        pin0, ...cells.map(dirAt), pin1,
      ];
      const route = routeFromDirs(chaikinSphere(chaikinSphere(raw)), R, parent.a, parent.b);
      if (route) out.push({ a: parent.a, b: parent.b, s0, s1, route: villagePorted(route) });
    };
    const nSteps = Math.ceil(parent.lengthM / stepM);
    for (let i = 0; i <= nSteps; i++) {
      const s = Math.min(parent.lengthM, i * stepM);
      const cell = inside(routePointAt(parent, s));
      if (cell >= 0) {
        if (runStartS < 0) { runStartS = s; runStartCell = cell; }
        lastS = s;
        lastCell = cell;
      } else {
        flush();
      }
    }
    flush();
  }
  return out;
}

// ── CROSS-REGION STITCHING (villages join hands across the border) ─────────

export interface StitchOpts {
  /** Villages pair only within this arc distance (default 45 km — under
   *  twice the day's-walk village spacing, so stitches read as neighbourly
   *  roads, not intercity trunks). */
  maxPairM?: number;
  /** Stitch cap per region pair (default 6). */
  maxPairs?: number;
}

/**
 * The roads between two ADJACENT refined regions: villages near the shared
 * border, matched nearest-first, each pair joined by ONE continuous road —
 * this village → the border point where THEIR OWN path crosses it → that
 * village. The halves solve on each region's own child grid (committed
 * village roads discount, so stitches ride existing lanes out of town) and
 * concatenate at the crossing, so a caravan drives straight across.
 *
 * PURE and symmetric: deterministic in (built, a, b) with the argument
 * order canonicalized, so it does not matter which region loaded first —
 * "both loaded" gates only WHEN a stitch appears, never WHAT it is.
 */
export function stitchRegions(
  built: BuiltPlanet,
  a: RefinedRegion,
  b: RefinedRegion,
  opts: StitchOpts = {},
): PlanetRoute[] {
  if (b.frame.regionCell < a.frame.regionCell) [a, b] = [b, a]; // canonical
  const cellA = a.frame.regionCell;
  const cellB = b.frame.regionCell;
  const topo = built.topo;
  if (!topo.cellAt) return [];
  const R = built.spec.radius;
  const maxPairM = opts.maxPairM ?? 45_000;
  const maxPairs = Math.max(1, Math.floor(opts.maxPairs ?? 6));

  // ── Candidate pairs by arc distance, matched greedily nearest-first ─────
  interface Cand { va: PlanetCity; vb: PlanetCity; dM: number }
  const cands: Cand[] = [];
  for (const va of a.villages) {
    for (const vb of b.villages) {
      const dp = Math.max(-1, Math.min(1,
        va.dir[0] * vb.dir[0] + va.dir[1] * vb.dir[1] + va.dir[2] * vb.dir[2]));
      const dM = Math.acos(dp) * R;
      if (dM <= maxPairM) cands.push({ va, vb, dM });
    }
  }
  cands.sort((p, q) => p.dM - q.dM || p.va.cell - q.va.cell || p.vb.cell - q.vb.cell);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const travelOf = (r: RefinedRegion) => ({
    metresPerUnit: (built.spec.relief * R) / Math.max(1, 63 - SEA_HEIGHT),
    metresPerCell: r.frame.cellSizeM,
  });
  const travelA = travelOf(a);
  const travelB = travelOf(b);
  const dirAt = (r: RefinedRegion, cell: number): [number, number, number] =>
    regionDir(r.frame, R, cell % r.frame.cols, Math.floor(cell / r.frame.cols));

  const out: PlanetRoute[] = [];
  for (const { va, vb } of cands) {
    if (out.length >= maxPairs) break;
    if (usedA.has(va.cell) || usedB.has(vb.cell)) continue;

    // The border crossing of THIS pair's own path: bisect the va→vb arc on
    // cell ownership. (The founding ownership mask keeps every village on
    // its own cell now; the guard still skips pairs whose border isn't this
    // one — e.g. a border town of a DIFFERENT edge that region owns.)
    const mix = (t: number): [number, number, number] => norm([
      va.dir[0] + (vb.dir[0] - va.dir[0]) * t,
      va.dir[1] + (vb.dir[1] - va.dir[1]) * t,
      va.dir[2] + (vb.dir[2] - va.dir[2]) * t,
    ]);
    if (topo.cellAt(va.dir) !== cellA || topo.cellAt(vb.dir) !== cellB) continue;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (topo.cellAt(mix(mid)) === cellA) lo = mid; else hi = mid;
    }
    const p = mix((lo + hi) / 2);

    // Each half on its own grid, out of town along the committed lanes.
    // Chart tiles derive from the village DIRECTIONS (chartTile inverts
    // regionDir exactly at tile centers): border towns carry negative keys
    // with no childCell inside, so `cell % 16384` no longer decodes.
    const pA = chartTile(a.frame, R, p);
    const pB = chartTile(b.frame, R, p);
    const tA = chartTile(a.frame, R, va.dir);
    const tB = chartTile(b.frame, R, vb.dir);
    if (pA < 0 || pB < 0 || tA < 0 || tB < 0) continue;
    const halfA = leastCostRoute(a.prep.grid, tA, pA, travelA);
    const halfB = leastCostRoute(b.prep.grid, tB, pB, travelB);
    if (!halfA || !halfB) continue; // water between — no stitch here

    // One continuous polyline: va … p … vb (the crossing point itself sits
    // between the two half endpoints; chaikin smooths the seam).
    const raw: Array<readonly [number, number, number]> = [
      ...halfA.cells.map(c => dirAt(a, c)),
      p,
      ...halfB.cells.map(c => dirAt(b, c)).reverse(),
    ];
    const route = routeFromDirs(chaikinSphere(chaikinSphere(raw)), R, va.cell, vb.cell);
    if (!route) continue;
    usedA.add(va.cell);
    usedB.add(vb.cell);
    // THE PORT LAW: a stitch is an ordinary road between two towns, so it
    // ends at their extents like every other one.
    out.push(portTerminateRoute(
      route, R,
      { id: va.cell, dir: va.dir, extentM: a.villageExtentM },
      { id: vb.cell, dir: vb.dir, extentM: b.villageExtentM },
    ));
  }
  return out;
}

// ── STREAM STITCHING (the rivers join hands across the border) ─────────────

export interface StreamStitchOpts {
  /** An exiting stream joins the neighbour's nearest stream START within this
   *  arc distance (default 12 child cells). It has to reach INSIDE the
   *  neighbour — see the asymmetry note below. Beyond the cap they are
   *  different streams, not two views of one. */
  maxJoinM?: number;
}

/**
 * The JOINS between two adjacent regions' streams: each region's solve traced
 * its own capillaries and stopped at its ownership line (refineRegion), so a
 * stream crossing the border exists as two runs from two DIFFERENT solves —
 * near each other (both follow the same macro valley) but not touching.
 *
 * THE ASYMMETRY THAT SHAPES THIS (measured, faceN 48: 20–34 out-crossings
 * per border, 0–3 in-crossings): the UPSTREAM side sees the stream at the
 * border with its full interior catchment, but the DOWNSTREAM side's window
 * has only the thin foreign sliver upstream of that point, so its
 * accumulation sits below the wet threshold AT the line — its version of the
 * stream only SURFACES a few cells inside. Matching crossings to crossings
 * therefore pairs almost nothing. Instead a join anchors on the upstream
 * side's crossing (exact: that run ENDS at the crossing cell) and reaches to
 * the downstream side's nearest emitted run START, threaded through the
 * upstream solve's estimate of the course across the line. Chaikin preserves
 * endpoints, so the join touches both painted runs with zero slop.
 *
 * PURE and symmetric, the stitchRegions contract: deterministic in
 * (built, a, b) with argument order canonicalized — "both loaded" gates only
 * WHEN a join appears, never WHAT it is. An exiting stream with no start in
 * reach (the other solve routed that water elsewhere) stays unmatched: the
 * run keeps ending at the border, today's look.
 */
export function stitchRegionStreams(
  built: BuiltPlanet,
  a: RefinedRegion,
  b: RefinedRegion,
  opts: StreamStitchOpts = {},
): RiverPolyline[] {
  if (b.frame.regionCell < a.frame.regionCell) [a, b] = [b, a]; // canonical
  const R = built.spec.radius;
  const maxJoinM = opts.maxJoinM ?? 12 * Math.max(a.frame.cellSizeM, b.frame.cellSizeM);

  // Run ends by owned cell (route keys are villageKey composites, so the
  // child cell decodes exactly — no geometric tolerance at the seam).
  const endsOf = (r: RefinedRegion): Map<number, RiverPolyline> => {
    const byEnd = new Map<number, RiverPolyline>();
    for (const p of r.rivers) byEnd.set(p.route.b % 16384, p);
    return byEnd;
  };
  const endsA = endsOf(a);
  const endsB = endsOf(b);

  const joins: RiverPolyline[] = [];
  /** One direction: streams flowing OUT of `x` INTO `y`. */
  const pass = (
    x: RefinedRegion, ex: Map<number, RiverPolyline>,
    y: RefinedRegion,
  ): void => {
    interface Cand { xc: RiverCrossing; to: RiverPolyline; dM: number }
    const cands: Cand[] = [];
    for (const xc of x.riverCrossings) {
      if (!xc.out || xc.borderWith !== y.frame.regionCell) continue;
      if (!ex.has(xc.ownCell)) continue; // run too short to emit — nothing to join
      for (const to of y.rivers) {
        const s = to.route.dirs[0]!;
        const dp = Math.max(-1, Math.min(1,
          xc.foreignDir[0] * s[0] + xc.foreignDir[1] * s[1] + xc.foreignDir[2] * s[2]));
        const dM = Math.acos(dp) * R;
        if (dM <= maxJoinM) cands.push({ xc, to, dM });
      }
    }
    cands.sort((p, q) => p.dM - q.dM || p.xc.ownCell - q.xc.ownCell || p.to.route.a - q.to.route.a);
    const usedX = new Set<number>();
    const usedTo = new Set<number>();
    for (const { xc, to } of cands) {
      if (usedX.has(xc.ownCell) || usedTo.has(to.route.a)) continue;
      const from = ex.get(xc.ownCell)!;
      // Run end → the upstream solve's estimate across the line → run start.
      const raw: Array<readonly [number, number, number]> = [
        from.route.dirs[from.route.dirs.length - 1]!,
        xc.foreignDir,
        to.route.dirs[0]!,
      ];
      const route = routeFromDirs(chaikinSphere(chaikinSphere(raw)), R, from.route.b, to.route.a);
      if (!route) continue;
      usedX.add(xc.ownCell);
      usedTo.add(to.route.a);
      joins.push({ route, accumSource: xc.accum, accumMouth: Math.max(xc.accum, to.accumSource) });
    }
  };
  pass(a, endsA, b);
  pass(b, endsB, a);
  return joins;
}
