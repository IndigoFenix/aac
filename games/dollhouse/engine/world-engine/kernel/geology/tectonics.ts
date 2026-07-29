/**
 * Plate tectonics — the Geology→Substrate provider (timescales.md §8).
 *
 * A deterministic, path-dependent STEPPER whose output is the seam the
 * substrate already reads: `height` (0..63) and `ore` (0..15, finite).
 * The shipped procedural cheat (`seedOreAboveTreeline`) paints ore above
 * the treeline by fiat; this provider makes the same distribution CAUSAL:
 *
 *   - Plates are Voronoi blobs on a torus, each carrying a continental cap
 *     on oceanic floor, drifting with a fixed velocity. Integer shifts move
 *     the crust rasters themselves — continents genuinely travel.
 *   - Convergent boundaries consume the loser's crust: ocean-under-anything
 *     subducts (modest uplift + VOLCANIC ARC ore), continent-on-continent
 *     collides (heavy thickening + deep SUTURE ore). Mountains are where
 *     collisions happened, not where a noise function was tall.
 *   - Vacated cells behind a drifting plate become fresh ocean floor
 *     (seafloor spreading), with occasional shallow RIFT ore.
 *   - Fixed mantle HOTSPOTS build volcano chains through whatever crust
 *     drifts over them, rarely leaving deep ore.
 *   - EROSION sheds steep relief into the lowlands (foothills, coastal
 *     shelves) and strips the rock COVER off deposits: ore is emplaced at
 *     depth and only mining-visible once exhumed. Young ranges hide their
 *     lodes; old worn ranges are mining country.
 *
 * Everything is keyed hashes + fixed scan orders: same opts ⇒ bit-identical
 * history, which is what lets the civ layers replay on top of it. Keyframes
 * (`tectonicFrame`) make the history scrubbable per timescales.md §5.
 *
 * Provenance-independence contract: consumers see only the baked fields.
 * `bakeAuthors` plugs straight into `prepareSubstrate` and nothing above
 * the Substrate can tell this landscape from an authored one.
 */

export interface TectonicOpts {
  cols: number;
  rows: number;
  seed: number;
  /** Plate count (default 5). */
  plates?: number;
  /** Continental cap radius as a fraction of the map's short side (default
   *  0.55 — big enough that drainage basins grow real rivers; smaller caps
   *  make island worlds whose catchments never concentrate). */
  continentR?: number;
  /** Mantle plume count (default 2). */
  hotspots?: number;
}

export type TectonicEventKind = "orogeny" | "arc" | "rift" | "hotspot";

export interface TectonicEvent {
  epoch: number;
  cell: number;
  kind: TectonicEventKind;
}

export interface TectonicPlate {
  /** Drift velocity, tiles per epoch. */
  vx: number;
  vy: number;
  /** Fractional offset accumulators — a shift fires when they cross ±1. */
  ox: number;
  oy: number;
  /** Σ |integer shifts| over the whole history (diagnostics). */
  moved: number;
}

export interface TectonicWorld {
  cols: number;
  rows: number;
  seed: number;
  epoch: number;
  /** Owner plate per cell. */
  plate: Int16Array;
  /** Crust thickness (the master variable; elevation is isostasy on it). */
  thick: Float32Array;
  /** 1 = continental crust (buoyant, never subducts under ocean). */
  conti: Uint8Array;
  /** Deposit richness riding this crust column (moves with the plate). */
  ore: Float32Array;
  /** Rock above the deposit, thickness units; exposed once eroded to 0. */
  cover: Float32Array;
  plates: TectonicPlate[];
  hotspots: number[]; // fixed mantle-frame cells
  events: TectonicEvent[];
}

/** One keyframe of the watchable history (timescales.md §5). */
export interface TectonicFrame {
  epoch: number;
  height: Uint8Array; // baked 0..63
  plate: Int16Array;
  ore: Uint8Array; // baked EXPOSED ore 0..15
}

// --- tuning ------------------------------------------------------------
// Exported: sphere-tectonics.ts runs the SAME geology on curved lattices —
// one set of physical numbers, two drift kernels (torus translation here,
// Euler-pole rotation there).
export const OCEAN_T = 7; // fresh ocean-floor thickness
export const CONT_T = 30; // continental cap thickness
export const MAX_THICK = 70;
export const ELEV_BASE = 24; // thickness at sea level
export const ELEV_SCALE = 1.6; // height units per thickness unit
export const SEA_HEIGHT = 3; // baked height below this = submarine
export const SUBDUCT_UPLIFT = 0.3; // winner keeps this × the subducted slab
export const OROGENY_KEEP = 0.75; // winner keeps this × consumed continental crust
// Continental collision RESISTS: each orogeny event damps both plates'
// velocities, so colliding continents slow, suture, and stop — without
// this the fixed velocities grind the continents away cell by cell
// (observed: half the continental crust consumed over one history).
export const OROGENY_DAMP = 0.995;
export const TALUS = 8; // elevation diff below which slopes hold (mountains keep steep flanks)
export const ERODE_RATE = 0.025; // × excess slope, per epoch
export const HOTSPOT_BUILD = 0.3; // volcano growth per epoch over a plume
// Ore emplacement lotteries: probability per event, richness, burial depth.
export const ORE_ARC = { p: 0.18, amt: 6, cover: 3 };
export const ORE_SUTURE = { p: 0.5, amt: 10, cover: 8 };
export const ORE_RIFT = { p: 0.03, amt: 3, cover: 0 }; // surface evaporites
export const ORE_HOTSPOT = { p: 0.04, amt: 8, cover: 5 };

/** Deterministic hash in [0,1) — same construction as worldgen's. */
export function hash01(seed: number, cell: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ cell, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1597334677) >>> 0;
  h ^= h >>> 16;
  return h / 4294967296;
}

/** Torus distance² between two cells. */
function torusDist2(cols: number, rows: number, a: number, b: number): number {
  let dx = Math.abs((a % cols) - (b % cols));
  let dy = Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
  if (dx > cols / 2) dx = cols - dx;
  if (dy > rows / 2) dy = rows - dy;
  return dx * dx + dy * dy;
}

export function createTectonics(opts: TectonicOpts): TectonicWorld {
  const { cols, rows, seed } = opts;
  const nPlates = opts.plates ?? 5;
  const n = cols * rows;
  const minDim = Math.min(cols, rows);

  // Plate seeds: hash-picked, rejection-spaced so no plate is a sliver.
  const seedCells: number[] = [];
  const minSpace2 = Math.pow(minDim / 3, 2);
  let salt = 0;
  while (seedCells.length < nPlates && salt < 10_000) {
    const c = Math.floor(hash01(seed + 11, salt++) * n);
    if (seedCells.every(s => torusDist2(cols, rows, s, c) >= minSpace2)) seedCells.push(c);
  }
  while (seedCells.length < nPlates) seedCells.push(Math.floor(hash01(seed + 13, seedCells.length) * n));

  const plate = new Int16Array(n);
  const thick = new Float32Array(n);
  const conti = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < nPlates; p++) {
      const d = torusDist2(cols, rows, c, seedCells[p]);
      if (d < bestD) { bestD = d; best = p; }
    }
    plate[c] = best;
    // Irregular continental cap around the plate seed; ocean floor elsewhere.
    const capR = (opts.continentR ?? 0.55) * minDim * (0.7 + 0.6 * hash01(seed + 17, c));
    conti[c] = bestD <= capR * capR ? 1 : 0;
    thick[c] = conti[c] ? CONT_T : OCEAN_T;
  }

  // Drift speed scales with map size (calibrated on a 32-row world), so a
  // bigger map lives the same relative history — continents cross the same
  // FRACTION of the world per epoch, not the same tile count. Multi-tile
  // shifts per epoch (very large maps) coarsen collisions: intermediate
  // cells are jumped, which is acceptable for a coarse-simulate provider.
  const speedScale = minDim / 32;
  const plates: TectonicPlate[] = [];
  for (let p = 0; p < nPlates; p++) {
    const angle = hash01(seed + 19, p) * Math.PI * 2;
    const speed = (0.05 + 0.15 * hash01(seed + 23, p)) * speedScale;
    plates.push({ vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ox: 0, oy: 0, moved: 0 });
  }

  // Hotspot count scales with area (one plume per ~1200 tiles, min 2).
  const nHotspots = opts.hotspots ?? Math.max(2, Math.round(n / 1200));
  const hotspots: number[] = [];
  for (let h = 0; h < nHotspots; h++) hotspots.push(Math.floor(hash01(seed + 29, h) * n));

  return {
    cols, rows, seed, epoch: 0, plate, thick, conti,
    ore: new Float32Array(n), cover: new Float32Array(n),
    plates, hotspots, events: [],
  };
}

function emplace(w: TectonicWorld, cell: number, spec: { amt: number; cover: number }, kind: TectonicEventKind): void {
  if (w.ore[cell] <= 0) w.cover[cell] = spec.cover; // new lode at emplacement depth
  w.ore[cell] += spec.amt * (0.5 + hash01(w.seed + 31 + w.epoch, cell)); // joins the existing lode's depth
  w.events.push({ epoch: w.epoch, cell, kind });
}

/** Advance the geology one epoch: drift, collide, rift, hotspots, erode. */
export function tectonicEpoch(w: TectonicWorld): void {
  const { cols, rows } = w;
  const n = cols * rows;
  w.epoch++;

  // 1. Accumulate drift; a plate shifts by whole tiles when offsets cross 1.
  const dxs: number[] = [];
  const dys: number[] = [];
  let anyShift = false;
  for (const p of w.plates) {
    p.ox += p.vx;
    p.oy += p.vy;
    const dx = Math.trunc(p.ox);
    const dy = Math.trunc(p.oy);
    p.ox -= dx;
    p.oy -= dy;
    p.moved += Math.abs(dx) + Math.abs(dy);
    dxs.push(dx);
    dys.push(dy);
    if (dx !== 0 || dy !== 0) anyShift = true;
  }

  if (anyShift) {
    // 2. Every cell claims its destination; gather claims per destination.
    const claims: Array<number[] | undefined> = new Array(n);
    for (let c = 0; c < n; c++) {
      const p = w.plate[c];
      const x = (((c % cols) + dxs[p]) % cols + cols) % cols;
      const y = ((Math.floor(c / cols) + dys[p]) % rows + rows) % rows;
      const d = y * cols + x;
      (claims[d] ??= []).push(c);
    }

    // 3. Resolve claims in fixed cell order: continental beats oceanic,
    // thicker beats thinner, lower plate id breaks ties. Losers subduct
    // (uplift + arc ore) or collide (orogeny + suture ore).
    const nPlate = new Int16Array(n);
    const nThick = new Float32Array(n);
    const nConti = new Uint8Array(n);
    const nOre = new Float32Array(n);
    const nCover = new Float32Array(n);
    nPlate.fill(-1);
    for (let d = 0; d < n; d++) {
      const list = claims[d];
      if (!list) continue;
      let win = list[0];
      for (let i = 1; i < list.length; i++) {
        const c = list[i];
        if (
          w.conti[c] > w.conti[win] ||
          (w.conti[c] === w.conti[win] && (w.thick[c] > w.thick[win] ||
            (w.thick[c] === w.thick[win] && w.plate[c] < w.plate[win])))
        ) win = c;
      }
      nPlate[d] = w.plate[win];
      nThick[d] = w.thick[win];
      nConti[d] = w.conti[win];
      nOre[d] = w.ore[win];
      nCover[d] = w.cover[win];
      for (const c of list) {
        if (c === win) continue;
        if (w.conti[c] && nConti[d]) {
          nThick[d] = Math.min(MAX_THICK, nThick[d] + OROGENY_KEEP * w.thick[c]);
          w.events.push({ epoch: w.epoch, cell: d, kind: "orogeny" });
          const pw = w.plates[nPlate[d]];
          const pl = w.plates[w.plate[c]];
          pw.vx *= OROGENY_DAMP; pw.vy *= OROGENY_DAMP;
          pl.vx *= OROGENY_DAMP; pl.vy *= OROGENY_DAMP;
          if (hash01(w.seed + 37 + w.epoch, d) < ORE_SUTURE.p) {
            if (nOre[d] <= 0) nCover[d] = ORE_SUTURE.cover;
            nOre[d] += ORE_SUTURE.amt * (0.5 + hash01(w.seed + 41 + w.epoch, d));
          }
        } else {
          nThick[d] = Math.min(MAX_THICK, nThick[d] + SUBDUCT_UPLIFT * w.thick[c]);
          w.events.push({ epoch: w.epoch, cell: d, kind: "arc" });
          if (hash01(w.seed + 43 + w.epoch, d) < ORE_ARC.p) {
            if (nOre[d] <= 0) nCover[d] = ORE_ARC.cover;
            nOre[d] += ORE_ARC.amt * (0.5 + hash01(w.seed + 47 + w.epoch, d));
          }
        }
      }
    }

    // 3b. Vacated cells: fresh ocean floor welded to the old owner
    // (seafloor spreading behind a drifting plate), rare rift ore.
    for (let d = 0; d < n; d++) {
      if (nPlate[d] >= 0) continue;
      nPlate[d] = w.plate[d];
      nThick[d] = OCEAN_T;
      nConti[d] = 0;
      nOre[d] = 0;
      nCover[d] = 0;
      if (hash01(w.seed + 53 + w.epoch, d) < ORE_RIFT.p) {
        nCover[d] = ORE_RIFT.cover;
        nOre[d] = ORE_RIFT.amt * (0.5 + hash01(w.seed + 59 + w.epoch, d));
        w.events.push({ epoch: w.epoch, cell: d, kind: "rift" });
      }
    }

    w.plate = nPlate;
    w.thick = nThick;
    w.conti = nConti;
    w.ore = nOre;
    w.cover = nCover;
  }

  // 4. Hotspots build volcanoes through whichever crust is overhead.
  for (const h of w.hotspots) {
    w.thick[h] = Math.min(MAX_THICK, w.thick[h] + HOTSPOT_BUILD);
    if (hash01(w.seed + 61 + w.epoch, h) < ORE_HOTSPOT.p) emplace(w, h, ORE_HOTSPOT, "hotspot");
  }

  // 5. Erosion: subaerial cells shed excess slope to their lowest neighbour
  // (snapshot elevations → deltas → apply, so scan order cannot matter).
  // Shedding strips COVER at the source (exhumation) and adds it at the
  // sink (burial) — this is the mechanism that exposes ore.
  const elev = new Float32Array(n);
  for (let c = 0; c < n; c++) elev[c] = (w.thick[c] - ELEV_BASE) * ELEV_SCALE;
  const dThick = new Float32Array(n);
  const dCover = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    if (elev[c] <= SEA_HEIGHT) continue; // no subaerial relief to shed
    const x = c % cols;
    const y = Math.floor(c / cols);
    let low = c;
    const consider = (nc: number): void => { if (elev[nc] < elev[low]) low = nc; };
    consider(y * cols + ((x + 1) % cols));
    consider(y * cols + ((x - 1 + cols) % cols));
    consider(((y + 1) % rows) * cols + x);
    consider(((y - 1 + rows) % rows) * cols + x);
    // BASE LEVEL: the sea is where cutting stops. Relief is measured
    // against max(neighbour, sea level), or coastal cells would keep
    // shedding until they matched the OCEAN FLOOR and the continents
    // would dissolve (they did — this clamp is the fix).
    const diff = elev[c] - Math.max(elev[low], SEA_HEIGHT);
    if (diff <= TALUS) continue;
    const move = (ERODE_RATE * (diff - TALUS)) / ELEV_SCALE;
    dThick[c] -= move;
    dThick[low] += move;
    dCover[c] -= move;
    dCover[low] += move;
  }
  for (let c = 0; c < n; c++) {
    w.thick[c] += dThick[c];
    w.cover[c] = Math.max(0, w.cover[c] + dCover[c]);
  }
}

/** Raw (unfilled) elevation: isostasy + micro-relief, float. Micro-relief
 *  fades out near sea level — full-amplitude noise across the sea line
 *  bakes salt-and-pepper archipelago fringes instead of coastlines. */
function rawElev(w: TectonicWorld, cell: number): number {
  const base = (w.thick[cell] - ELEV_BASE) * ELEV_SCALE;
  const amp = Math.max(0, Math.min(1, (base - SEA_HEIGHT) / 5));
  return base + (hash01(w.seed + 67, cell) * 3 - 1.5) * amp;
}

const fillCache = new WeakMap<TectonicWorld, { epoch: number; filled: Float32Array }>();

/**
 * Depression-filled elevation surface (Planchon–Darboux with ε=0): every
 * land cell is raised to its spill level toward the sea, so the consumer's
 * flow field finds a drainage path everywhere instead of dying in the
 * micro-relief's pits. The fill runs on the INTEGER surface the consumer
 * will actually see — filling the float surface and rounding afterwards
 * re-creates pits at the rounding step (observed as scattered one-tile
 * "lakes" swallowing whole catchments). The resulting flats are exact
 * ties, which the engine's flat-routing resolves. Consumers are
 * non-wrapping grids, so the fill uses non-wrapping adjacency. All-land
 * worlds skip the fill (there is no sea to drain to).
 */
function filledElev(w: TectonicWorld): Float32Array {
  const cached = fillCache.get(w);
  if (cached && cached.epoch === w.epoch) return cached.filled;
  const { cols, rows } = w;
  const n = cols * rows;
  const raw = new Float32Array(n);
  let hasSea = false;
  for (let c = 0; c < n; c++) {
    raw[c] = Math.max(0, Math.min(63, Math.round(rawElev(w, c))));
    if (raw[c] < SEA_HEIGHT) hasSea = true;
  }
  // DESPECKLE the sea line: erosion deposits into single lowest-neighbour
  // cells, piling one-tile islets along the shelf (and leaving one-tile
  // coves), which bakes as salt-and-pepper coastline. Islets reach talus
  // height (~8 over sea), so the land window must span the whole shelf: an
  // islet up to SEA+7 with 3+ sea neighbours sinks awash; a cove with 3+
  // land neighbours silts up. Three fixed-order passes catch clusters;
  // deterministic.
  if (hasSea) {
    for (let pass = 0; pass < 3; pass++) {
      for (let c = 0; c < n; c++) {
        const h = raw[c];
        if (h > SEA_HEIGHT + 7 || h < SEA_HEIGHT - 2) continue;
        const x = c % cols;
        const y = Math.floor(c / cols);
        let seaNb = 0;
        let landNb = 0;
        if (x + 1 < cols) raw[c + 1] < SEA_HEIGHT ? seaNb++ : landNb++;
        if (x > 0) raw[c - 1] < SEA_HEIGHT ? seaNb++ : landNb++;
        if (y + 1 < rows) raw[c + cols] < SEA_HEIGHT ? seaNb++ : landNb++;
        if (y > 0) raw[c - cols] < SEA_HEIGHT ? seaNb++ : landNb++;
        if (h >= SEA_HEIGHT && seaNb >= 3) raw[c] = SEA_HEIGHT - 1;
        else if (h < SEA_HEIGHT && landNb >= 3) raw[c] = SEA_HEIGHT;
      }
    }
  }
  const filled = new Float32Array(n);
  if (!hasSea) {
    filled.set(raw);
  } else {
    for (let c = 0; c < n; c++) filled[c] = raw[c] < SEA_HEIGHT ? raw[c] : Infinity;
    // Alternating-direction sweeps to fixpoint: filled = max(raw, min(nb filled)).
    for (let sweep = 0; sweep < 200; sweep++) {
      let changed = false;
      const fwd = sweep % 2 === 0;
      for (let i = 0; i < n; i++) {
        const c = fwd ? i : n - 1 - i;
        if (raw[c] < SEA_HEIGHT) continue;
        const x = c % cols;
        const y = Math.floor(c / cols);
        let m = Infinity;
        if (x + 1 < cols && filled[c + 1] < m) m = filled[c + 1];
        if (x > 0 && filled[c - 1] < m) m = filled[c - 1];
        if (y + 1 < rows && filled[c + cols] < m) m = filled[c + cols];
        if (y > 0 && filled[c - cols] < m) m = filled[c - cols];
        const nf = Math.max(raw[c], m);
        if (nf < filled[c]) { filled[c] = nf; changed = true; }
      }
      if (!changed) break;
    }
    // Safety: a cell the sweeps never reached (cap hit on a huge map)
    // falls back to its raw height rather than baking as Infinity.
    for (let c = 0; c < n; c++) if (!Number.isFinite(filled[c])) filled[c] = raw[c];
  }
  fillCache.set(w, { epoch: w.epoch, filled });
  return filled;
}

/** Baked elevation of one cell: filled isostatic surface, 0..63 int. */
export function bakeHeight(w: TectonicWorld, cell: number): number {
  return Math.max(0, Math.min(63, Math.round(filledElev(w)[cell])));
}

/** Baked EXPOSED ore of one cell: buried lodes and undersea lodes are 0. */
export function bakeOre(w: TectonicWorld, cell: number): number {
  if (w.cover[cell] > 0 || bakeHeight(w, cell) < SEA_HEIGHT) return 0;
  return Math.max(0, Math.min(15, Math.round(w.ore[cell])));
}

/** Authors for `prepareSubstrate` — the whole provider contract. */
export function bakeAuthors(w: TectonicWorld): {
  height: (x: number, y: number) => number;
  ore: (x: number, y: number) => number;
} {
  return {
    height: (x, y) => bakeHeight(w, y * w.cols + x),
    ore: (x, y) => bakeOre(w, y * w.cols + x),
  };
}

/** One scrubbable keyframe of the history. */
export function tectonicFrame(w: TectonicWorld): TectonicFrame {
  const n = w.cols * w.rows;
  const height = new Uint8Array(n);
  const ore = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    height[c] = bakeHeight(w, c);
    ore[c] = bakeOre(w, c);
  }
  return { epoch: w.epoch, height, plate: w.plate.slice(), ore };
}

export interface RunTectonicOpts extends TectonicOpts {
  epochs?: number; // default 350
  keyframeEvery?: number; // default 25; 0 = final frame only
}

/** Run a whole history, collecting keyframes (final state always included). */
export function runTectonics(opts: RunTectonicOpts): { world: TectonicWorld; frames: TectonicFrame[] } {
  const world = createTectonics(opts);
  const epochs = opts.epochs ?? 350;
  const every = opts.keyframeEvery ?? 25;
  const frames: TectonicFrame[] = [];
  if (every > 0) frames.push(tectonicFrame(world));
  for (let e = 0; e < epochs; e++) {
    tectonicEpoch(world);
    if (every > 0 && world.epoch % every === 0) frames.push(tectonicFrame(world));
  }
  if (frames.length === 0 || frames[frames.length - 1].epoch !== world.epoch) frames.push(tectonicFrame(world));
  return { world, frames };
}
