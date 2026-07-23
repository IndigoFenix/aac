// shared/world-engine/planet/refine.ts
//
// TIER 1 OF THE HIERARCHICAL SUBSTRATE (planning-docs/games/
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
//    `people` is capitals-tier founding fuel, not a census — a 208-km cell
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
import { SEA_HEIGHT } from "../kernel/geology/tectonics.js";
import { foundCitiesFromSites, type PlanetCity } from "./cities.js";
import { chaikinSphere, routeFromDirs, routePointAt, type PlanetRoute } from "./routes.js";
import { borderTowns, chebyshevDistance, type BorderTown } from "./border.js";
import { REAL_TOWN_SPACING_M } from "../scale.js";

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
}

export interface RefinedRegion {
  frame: RegionFrame;
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
    occupied.push([Math.round(tx), Math.round(ty)]);
    capitalCells.push(site.cell);
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
  const foundingBase: FoundingOpts = {
    threshold: 25,
    radius: 2,
    minSpacing: Math.max(4, Math.round(REAL_TOWN_SPACING_M / cellSizeM)),
    maxHarvest: 600,
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
    if (rx >= 0 && rx < cols && ry >= 0 && ry < rows) borderHubKeys.set(ry * cols + rx, t.cell);
  }

  // ── The child substrate: rivers/fertility/crowds re-solve locally ───────
  // Day's-walk spacing: ~25 km at the child scale.
  const founding: FoundingOpts = {
    ...foundingBase,
    occupied: [...occupied, ...(opts.founding?.occupied ?? [])],
    eligible,
  };
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
    runoff: parentRunoff
      ? (x, y) => parentRunoff[topo.cellAt!(dirs[y * cols + x])]
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
  const parentPeople = built.grid.fields.people;
  const childPeople = prep.grid.fields.people;
  if (parentPeople && childPeople) {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < cols * rows; i++) {
      const parent = topo.cellAt!(dirs[i]);
      let g = groups.get(parent);
      if (!g) { g = []; groups.set(parent, g); }
      g.push(i);
    }
    for (const [parent, children] of groups) {
      let sum = 0;
      for (const i of children) sum += childPeople[i];
      if (sum <= 0) continue;
      const scale = (parentPeople[parent] * children.length) / sum;
      for (const i of children) childPeople[i] *= scale;
    }
    // Crowds changed after the settle — re-rank the founding candidates on
    // the budgeted field (same scan, same spacing, same fixed points).
    prep.sites = findFoundingSites(prep.grid, founding);
  }

  // ── CLIMATE (planet/climate.ts): parent rain is a DENSITY passthrough
  //    like ore; temperature re-derives by the child-vs-parent elevation
  //    delta (the lapse anchor cancels in the difference). applyClimate
  //    then re-folds fertility/plant/ice onto the child's own river solve.
  //    People stay the budget's ("iceOnly" — the parent's crowds already
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
    applyClimate(prep.grid, { rain: childRain, tempC: childTempC }, { people: "iceOnly" });
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

  // ── Villages through the same founding helper the capitals use ──────────
  const villages = foundCitiesFromSites({
    sites: prep.sites,
    grid: prep.grid,
    seedBase: (built.spec.geology.seed ^ Math.imul(regionCell, 0x85ebca6b)) >>> 0,
    dirOf: cell => dirs[cell],
    cellKey: cell => villageKey(regionCell, cell),
    minFarmland: opts.minFarmland ?? 25,
  });
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
  const roadRoutes: PlanetRoute[] = [];
  for (const cells of routes) {
    if (cells.length < 2) continue;
    const smoothed = chaikinSphere(chaikinSphere(cells.map(c => dirs[c]!)));
    const route = routeFromDirs(
      smoothed, R,
      keyOfTile(cells[0]!),
      keyOfTile(cells[cells.length - 1]!),
    );
    if (route) roadRoutes.push(route);
  }

  return { frame, prep, villages, borderTowns: edgeTowns, capitalCells, roads, roadRoutes };
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
): HighwayRefinement[] {
  const { frame, prep } = refined;
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
      const raw: Array<readonly [number, number, number]> = [
        routePointAt(parent, s0),
        ...solved.cells.map(dirAt),
        routePointAt(parent, s1),
      ];
      const route = routeFromDirs(chaikinSphere(chaikinSphere(raw)), R, parent.a, parent.b);
      if (route) out.push({ a: parent.a, b: parent.b, s0, s1, route });
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
    out.push(route);
  }
  return out;
}
