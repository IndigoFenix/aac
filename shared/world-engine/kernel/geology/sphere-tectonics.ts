/**
 * Plate tectonics on a CURVED lattice — the Geology→Substrate provider for
 * spherical worlds (the same geology as tectonics.ts; a different drift
 * kernel, because a sphere has no translations).
 *
 * The flat stepper moves crust by integer raster shifts — an exact rigid
 * motion only a torus offers. Here plate motion is what it is on a real
 * planet: RIGID ROTATION about a per-plate Euler pole. The representation
 * follows from that:
 *
 *   - Crust lives in PLATE-FRAME rasters (mask + thick/conti/ore/cover on
 *     the same sphere lattice, frozen at the plate's birth orientation).
 *     A plate's accumulated angle is the ONLY thing that moves — origins
 *     never re-round, so rigidity has no accumulation drift.
 *   - Each epoch the world is GATHERED, not scattered: every world cell
 *     inverse-rotates into each plate's frame (topo.cellAt of the rotated
 *     direction) and samples its raster. Two plates landing on one world
 *     cell = a convergent boundary; no plate = seafloor spreading. Gather
 *     keeps plates contiguous — scatter would tear rounding gaps in them.
 *   - Boundary events reuse tectonics.ts's grammar and TUNING verbatim:
 *     ocean-under-anything subducts (uplift + arc ore), continent-on-
 *     continent collides (thickening + suture ore + velocity damping so
 *     sutured continents stop), vacated cells become fresh floor with
 *     rift-ore lotteries, fixed mantle-frame hotspots build volcano
 *     chains through whatever drifts overhead, and erosion sheds steep
 *     relief while exhuming buried lodes.
 *   - Everything is keyed hashes + fixed scan orders ⇒ same opts, same
 *     history, bit for bit. Keyframes make it scrubbable.
 *
 * Same provenance-independence contract: consumers see only the baked
 * fields (`bakeCellAuthors`); nothing above the Substrate can tell this
 * landscape from an authored one. Requires a topology with pos3 + cellAt
 * (cube-sphere today; the hex lattice will satisfy it too).
 */

import type { GridTopology } from "../cells/topology";
import {
  OCEAN_T, CONT_T, MAX_THICK, ELEV_BASE, ELEV_SCALE, SEA_HEIGHT,
  SUBDUCT_UPLIFT, OROGENY_KEEP, OROGENY_DAMP, TALUS, ERODE_RATE, HOTSPOT_BUILD,
  ORE_ARC, ORE_SUTURE, ORE_RIFT, ORE_HOTSPOT,
  type TectonicEvent, type TectonicEventKind, type TectonicFrame,
} from "./tectonics";

export type { TectonicEvent, TectonicEventKind, TectonicFrame } from "./tectonics";

/** Deterministic hash in [0, 1) — the flat stepper's construction with the
 *  sign fixed. tectonics.ts's hash01 coerces through SIGNED int32 on its
 *  last mix, so ~half its values are NEGATIVE — the flat module silently
 *  tolerates that (negative hotspot cells no-op on typed-array writes,
 *  lotteries with negative draws always pass) and its histories are pinned
 *  bit-identical by tests, so the quirk stays THERE. This module indexes
 *  rasters with its hashes and needs the honest range. */
function hash01(seed: number, cell: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ cell, 2654435761) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1597334677) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

type V3 = readonly [number, number, number];

export interface SphereTectonicOpts {
  /** A curved lattice exposing pos3 + cellAt (e.g. makeCubeSphereTopology). */
  topo: GridTopology;
  seed: number;
  /** Plate count (default 5). */
  plates?: number;
  /** Continental cap radius as a fraction of the antipodal distance
   *  (default 0.55 — matches the flat stepper's big-continent proportions). */
  continentR?: number;
  /** Mantle plume count (default one per ~1200 cells, min 2). */
  hotspots?: number;
}

export interface SpherePlate {
  /** Euler pole (unit axis, mantle frame). */
  axis: V3;
  /** Angular rate, radians per epoch — damped by orogeny like the flat
   *  stepper's velocities. */
  rate: number;
  /** Accumulated rotation since birth. The plate raster never moves;
   *  this angle is the plate's entire kinematic state. */
  angle: number;
  /** Σ rotation in cell-pitch units (diagnostics — the flat `moved`). */
  moved: number;
}

export interface SphereTectonicWorld {
  topo: GridTopology;
  seed: number;
  epoch: number;
  plates: SpherePlate[];
  hotspots: number[]; // fixed mantle-frame cells
  events: TectonicEvent[];
  /** One cell's angular size (radians) — sampled from the lattice. */
  pitch: number;
  // --- plate-frame rasters (index = plate-frame cell) ---
  mask: Uint8Array[];
  pThick: Float32Array[];
  pConti: Uint8Array[];
  pOre: Float32Array[];
  pCover: Float32Array[];
  // --- this epoch's gathered world state (index = world cell) ---
  plate: Int16Array;
  thick: Float32Array;
  conti: Uint8Array;
  ore: Float32Array;
  cover: Float32Array;
  /** World cell → the plate-frame cell its column was sampled from. */
  src: Int32Array;
}

/** Rotate `p` about unit `axis` by `angle` (Rodrigues, allocation-free). */
function rotate(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  angle: number, out: [number, number, number],
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = (ax * px + ay * py + az * pz) * (1 - c);
  out[0] = px * c + (ay * pz - az * py) * s + ax * d;
  out[1] = py * c + (az * px - ax * pz) * s + ay * d;
  out[2] = pz * c + (ax * py - ay * px) * s + az * d;
}

/** Median neighbour angle — the lattice's cell pitch in radians. */
function measurePitch(topo: GridTopology): number {
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  const samples: number[] = [];
  const step = Math.max(1, Math.floor(topo.n / 64));
  for (let i = 0; i < topo.n; i += step) {
    const k = topo.neighbours(i, nb);
    const p = topo.pos3!(i);
    for (let j = 0; j < k; j++) {
      const q = topo.pos3!(nb[j]);
      const dp = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
      samples.push(Math.acos(dp));
    }
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] || Math.PI / 64;
}

/** Base angular speed, radians/epoch — resolution-independent: plates cross
 *  the same FRACTION of the sphere per epoch at any lattice density
 *  (calibrated to the flat stepper's tiles-per-epoch on its 32-row world). */
const BASE_RATE = Math.PI / 64;

export function createSphereTectonics(opts: SphereTectonicOpts): SphereTectonicWorld {
  const { topo, seed } = opts;
  if (!topo.pos3 || !topo.cellAt) throw new Error("sphere-tectonics: topology must expose pos3 + cellAt (a curved lattice)");
  const n = topo.n;
  const nPlates = opts.plates ?? 5;
  const pitch = measurePitch(topo);
  const maxDist = Math.PI / pitch; // antipodal distance in cell units

  // Plate seeds: hash-picked, rejection-spaced so no plate is a sliver.
  const seedCells: number[] = [];
  const minSpace2 = Math.pow(maxDist / 3, 2);
  let salt = 0;
  while (seedCells.length < nPlates && salt < 10_000) {
    const c = Math.floor(hash01(seed + 11, salt++) * n);
    if (seedCells.every(s => topo.dist2(s, c) >= minSpace2)) seedCells.push(c);
  }
  while (seedCells.length < nPlates) seedCells.push(Math.floor(hash01(seed + 13, seedCells.length) * n));

  // Voronoi ownership + continental caps, exactly the flat recipe with
  // geodesic distance in place of torus distance.
  const plate = new Int16Array(n);
  const thick = new Float32Array(n);
  const conti = new Uint8Array(n);
  const mask: Uint8Array[] = [];
  const pThick: Float32Array[] = [];
  const pConti: Uint8Array[] = [];
  const pOre: Float32Array[] = [];
  const pCover: Float32Array[] = [];
  for (let p = 0; p < nPlates; p++) {
    mask.push(new Uint8Array(n));
    pThick.push(new Float32Array(n));
    pConti.push(new Uint8Array(n));
    pOre.push(new Float32Array(n));
    pCover.push(new Float32Array(n));
  }
  for (let c = 0; c < n; c++) {
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < nPlates; p++) {
      const d = topo.dist2(c, seedCells[p]);
      if (d < bestD) { bestD = d; best = p; }
    }
    const capR = (opts.continentR ?? 0.55) * (maxDist / 2) * (0.7 + 0.6 * hash01(seed + 17, c));
    const isCont = bestD <= capR * capR ? 1 : 0;
    plate[c] = best;
    conti[c] = isCont;
    thick[c] = isCont ? CONT_T : OCEAN_T;
    // Birth: plate frame == world frame (angle 0).
    mask[best][c] = 1;
    pThick[best][c] = thick[c];
    pConti[best][c] = isCont;
  }

  const plates: SpherePlate[] = [];
  for (let p = 0; p < nPlates; p++) {
    const z = 2 * hash01(seed + 19, p) - 1;
    const phi = hash01(seed + 21, p) * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    plates.push({
      axis: [r * Math.cos(phi), r * Math.sin(phi), z] as const,
      rate: (0.05 + 0.15 * hash01(seed + 23, p)) * BASE_RATE,
      angle: 0,
      moved: 0,
    });
  }

  const nHotspots = opts.hotspots ?? Math.max(2, Math.round(n / 1200));
  const hotspots: number[] = [];
  for (let h = 0; h < nHotspots; h++) hotspots.push(Math.floor(hash01(seed + 29, h) * n));

  const src = new Int32Array(n);
  for (let c = 0; c < n; c++) src[c] = c;

  return {
    topo, seed, epoch: 0, plates, hotspots, events: [], pitch,
    mask, pThick, pConti, pOre, pCover,
    plate, thick, conti, ore: new Float32Array(n), cover: new Float32Array(n), src,
  };
}

/** Advance the geology one epoch: rotate, gather (collide/rift), hotspots,
 *  erode — the flat stepper's step order, on the sphere. */
export function sphereTectonicEpoch(w: SphereTectonicWorld): void {
  const { topo } = w;
  const n = topo.n;
  const nPlates = w.plates.length;
  w.epoch++;

  // 1. Rotate: total angle only — origins are fixed, rigidity is free.
  for (const p of w.plates) {
    p.angle += p.rate;
    p.moved += p.rate / w.pitch;
  }

  // 2. GATHER the world from the plate frames; convergent cells resolve
  //    with the flat rules. All reads are pre-state (deltas buffered);
  //    a loser's source column is consumed AT MOST ONCE per epoch.
  const nPlate = new Int16Array(n);
  const nThick = new Float32Array(n);
  const nConti = new Uint8Array(n);
  const nOre = new Float32Array(n);
  const nCover = new Float32Array(n);
  const nSrc = new Int32Array(n);
  nPlate.fill(-1);

  const consumed: Set<number>[] = w.mask.map(() => new Set());
  // Buffered winner deltas, applied to plate rasters after the scan.
  const dThick: Map<number, number>[] = w.mask.map(() => new Map());
  const dOre: Map<number, number>[] = w.mask.map(() => new Map());
  const setCover: Map<number, number>[] = w.mask.map(() => new Map());
  const bump = (m: Map<number, number>, k: number, dv: number): void => {
    m.set(k, (m.get(k) ?? 0) + dv);
  };

  const out: [number, number, number] = [0, 0, 0];
  const candP: number[] = [];
  const candSrc: number[] = [];
  for (let c = 0; c < n; c++) {
    const pos = topo.pos3!(c);
    candP.length = 0;
    candSrc.length = 0;
    for (let p = 0; p < nPlates; p++) {
      const pl = w.plates[p];
      rotate(pos[0], pos[1], pos[2], pl.axis[0], pl.axis[1], pl.axis[2], -pl.angle, out);
      const s = topo.cellAt!(out);
      if (w.mask[p][s] && !consumed[p].has(s)) { candP.push(p); candSrc.push(s); }
    }

    if (candP.length === 0) {
      // 2b. Vacated: fresh ocean floor welded to the old owner (seafloor
      //     spreading behind a drifting plate), rare rift ore.
      const prev = w.plate[c];
      nPlate[c] = prev;
      nThick[c] = OCEAN_T;
      nConti[c] = 0;
      nOre[c] = 0;
      nCover[c] = 0;
      let ps = c;
      if (prev >= 0) {
        const pl = w.plates[prev];
        rotate(pos[0], pos[1], pos[2], pl.axis[0], pl.axis[1], pl.axis[2], -pl.angle, out);
        ps = topo.cellAt!(out);
      }
      nSrc[c] = ps;
      if (hash01(w.seed + 53 + w.epoch, c) < ORE_RIFT.p) {
        nCover[c] = ORE_RIFT.cover;
        nOre[c] = ORE_RIFT.amt * (0.5 + hash01(w.seed + 59 + w.epoch, c));
        w.events.push({ epoch: w.epoch, cell: c, kind: "rift" });
      }
      // Persist the new floor into the owner's raster (skip if a rounding
      // twin already holds that source — next epoch's gather re-covers it).
      if (prev >= 0 && !w.mask[prev][ps] && !consumed[prev].has(ps)) {
        w.mask[prev][ps] = 1;
        w.pThick[prev][ps] = OCEAN_T;
        w.pConti[prev][ps] = 0;
        w.pOre[prev][ps] = nOre[c];
        w.pCover[prev][ps] = nCover[c];
      }
      continue;
    }

    // Winner: continental beats oceanic, thicker beats thinner, lower
    // plate id breaks ties — the flat resolution, verbatim.
    let win = 0;
    for (let i = 1; i < candP.length; i++) {
      const p = candP[i], s = candSrc[i];
      const wp = candP[win], ws = candSrc[win];
      if (
        w.pConti[p][s] > w.pConti[wp][ws] ||
        (w.pConti[p][s] === w.pConti[wp][ws] && (w.pThick[p][s] > w.pThick[wp][ws] ||
          (w.pThick[p][s] === w.pThick[wp][ws] && p < wp)))
      ) win = i;
    }
    const wp = candP[win], ws = candSrc[win];
    nPlate[c] = wp;
    nThick[c] = w.pThick[wp][ws] + (dThick[wp].get(ws) ?? 0);
    nConti[c] = w.pConti[wp][ws];
    nOre[c] = w.pOre[wp][ws] + (dOre[wp].get(ws) ?? 0);
    nCover[c] = setCover[wp].get(ws) ?? w.pCover[wp][ws];
    nSrc[c] = ws;

    for (let i = 0; i < candP.length; i++) {
      if (i === win) continue;
      const lp = candP[i], ls = candSrc[i];
      consumed[lp].add(ls); // the slab is spent — never consumed twice
      if (w.pConti[lp][ls] && nConti[c]) {
        // Continent-on-continent: orogeny — thickening, damping, suture ore.
        const add = Math.min(MAX_THICK - nThick[c], OROGENY_KEEP * w.pThick[lp][ls]);
        if (add > 0) { bump(dThick[wp], ws, add); nThick[c] += add; }
        w.events.push({ epoch: w.epoch, cell: c, kind: "orogeny" });
        const a = w.plates[wp], b = w.plates[lp];
        a.rate *= OROGENY_DAMP;
        b.rate *= OROGENY_DAMP;
        if (hash01(w.seed + 37 + w.epoch, c) < ORE_SUTURE.p) {
          if (nOre[c] <= 0) { setCover[wp].set(ws, ORE_SUTURE.cover); nCover[c] = ORE_SUTURE.cover; }
          const amt = ORE_SUTURE.amt * (0.5 + hash01(w.seed + 41 + w.epoch, c));
          bump(dOre[wp], ws, amt);
          nOre[c] += amt;
        }
      } else {
        // Subduction: modest uplift + volcanic-arc ore on the winner.
        const add = Math.min(MAX_THICK - nThick[c], SUBDUCT_UPLIFT * w.pThick[lp][ls]);
        if (add > 0) { bump(dThick[wp], ws, add); nThick[c] += add; }
        w.events.push({ epoch: w.epoch, cell: c, kind: "arc" });
        if (hash01(w.seed + 43 + w.epoch, c) < ORE_ARC.p) {
          if (nOre[c] <= 0) { setCover[wp].set(ws, ORE_ARC.cover); nCover[c] = ORE_ARC.cover; }
          const amt = ORE_ARC.amt * (0.5 + hash01(w.seed + 47 + w.epoch, c));
          bump(dOre[wp], ws, amt);
          nOre[c] += amt;
        }
      }
    }
  }

  // Commit the scan: consumed slabs leave their plates; winner deltas land.
  for (let p = 0; p < nPlates; p++) {
    for (const s of consumed[p]) w.mask[p][s] = 0;
    for (const [s, dv] of dThick[p]) w.pThick[p][s] = Math.min(MAX_THICK, w.pThick[p][s] + dv);
    for (const [s, dv] of dOre[p]) w.pOre[p][s] += dv;
    for (const [s, v] of setCover[p]) w.pCover[p][s] = v;
  }
  w.plate = nPlate;
  w.thick = nThick;
  w.conti = nConti;
  w.ore = nOre;
  w.cover = nCover;
  w.src = nSrc;

  // 3. Hotspots build volcanoes through whichever crust is overhead.
  for (const h of w.hotspots) {
    const p = w.plate[h];
    if (p < 0) continue;
    const s = w.src[h];
    w.pThick[p][s] = Math.min(MAX_THICK, w.pThick[p][s] + HOTSPOT_BUILD);
    w.thick[h] = w.pThick[p][s];
    if (hash01(w.seed + 61 + w.epoch, h) < ORE_HOTSPOT.p) {
      if (w.pOre[p][s] <= 0) { w.pCover[p][s] = ORE_HOTSPOT.cover; w.cover[h] = ORE_HOTSPOT.cover; }
      const amt = ORE_HOTSPOT.amt * (0.5 + hash01(w.seed + 31 + w.epoch, h));
      w.pOre[p][s] += amt;
      w.ore[h] = w.pOre[p][s];
      w.events.push({ epoch: w.epoch, cell: h, kind: "hotspot" as TectonicEventKind });
    }
  }

  // 4. Erosion: subaerial cells shed excess slope to their lowest neighbour
  //    (snapshot elevations → deltas → apply, so scan order cannot matter).
  //    Shedding strips COVER at the source (exhumation) and buries it at the
  //    sink — the mechanism that exposes ore. Writes land on the world
  //    arrays AND the plate rasters through this epoch's gather mapping.
  const elev = new Float32Array(n);
  for (let c = 0; c < n; c++) elev[c] = (w.thick[c] - ELEV_BASE) * ELEV_SCALE;
  const eThick = new Float64Array(n);
  const eCover = new Float64Array(n);
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  for (let c = 0; c < n; c++) {
    if (elev[c] <= SEA_HEIGHT) continue; // no subaerial relief to shed
    const k = topo.neighbours(c, nb);
    let low = c;
    for (let j = 0; j < k; j++) if (elev[nb[j]] < elev[low]) low = nb[j];
    // BASE LEVEL: the sea is where cutting stops (the flat clamp, verbatim).
    const diff = elev[c] - Math.max(elev[low], SEA_HEIGHT);
    if (diff <= TALUS) continue;
    const move = (ERODE_RATE * (diff - TALUS)) / ELEV_SCALE;
    eThick[c] -= move;
    eThick[low] += move;
    eCover[c] -= move;
    eCover[low] += move;
  }
  for (let c = 0; c < n; c++) {
    if (eThick[c] === 0 && eCover[c] === 0) continue;
    w.thick[c] += eThick[c];
    w.cover[c] = Math.max(0, w.cover[c] + eCover[c]);
    const p = w.plate[c];
    if (p >= 0) {
      const s = w.src[c];
      w.pThick[p][s] = w.thick[c];
      w.pCover[p][s] = w.cover[c];
    }
  }
}

/** Raw (unfilled) elevation: isostasy + micro-relief that fades at the sea
 *  line — the flat formula on world cells. */
function rawElev(w: SphereTectonicWorld, cell: number): number {
  const base = (w.thick[cell] - ELEV_BASE) * ELEV_SCALE;
  const amp = Math.max(0, Math.min(1, (base - SEA_HEIGHT) / 5));
  return base + (hash01(w.seed + 67, cell) * 3 - 1.5) * amp;
}

const fillCache = new WeakMap<SphereTectonicWorld, { epoch: number; filled: Float32Array }>();

/** Depression-filled elevation (Planchon–Darboux, ε=0) on the closed
 *  lattice — the flat implementation with topology adjacency (a sphere has
 *  no map edge, so the non-wrapping caveat simply disappears). Includes the
 *  sea-line despeckle passes. All-land worlds skip the fill. */
function filledElev(w: SphereTectonicWorld): Float32Array {
  const cached = fillCache.get(w);
  if (cached && cached.epoch === w.epoch) return cached.filled;
  const { topo } = w;
  const n = topo.n;
  const raw = new Float32Array(n);
  let hasSea = false;
  for (let c = 0; c < n; c++) {
    raw[c] = Math.max(0, Math.min(63, Math.round(rawElev(w, c))));
    if (raw[c] < SEA_HEIGHT) hasSea = true;
  }
  const nb: number[] = new Array(topo.maxDegree).fill(0);
  if (hasSea) {
    // DESPECKLE the sea line (three fixed-order passes, the flat windows).
    for (let pass = 0; pass < 3; pass++) {
      for (let c = 0; c < n; c++) {
        const h = raw[c];
        if (h > SEA_HEIGHT + 7 || h < SEA_HEIGHT - 2) continue;
        const k = topo.neighbours(c, nb);
        let seaNb = 0;
        let landNb = 0;
        for (let j = 0; j < k; j++) raw[nb[j]] < SEA_HEIGHT ? seaNb++ : landNb++;
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
        const k = topo.neighbours(c, nb);
        let m = Infinity;
        for (let j = 0; j < k; j++) if (filled[nb[j]] < m) m = filled[nb[j]];
        const nf = Math.max(raw[c], m);
        if (nf < filled[c]) { filled[c] = nf; changed = true; }
      }
      if (!changed) break;
    }
    for (let c = 0; c < n; c++) if (!Number.isFinite(filled[c])) filled[c] = raw[c];
  }
  fillCache.set(w, { epoch: w.epoch, filled });
  return filled;
}

/** Baked elevation of one cell: filled isostatic surface, 0..63 int. */
export function bakeHeight(w: SphereTectonicWorld, cell: number): number {
  return Math.max(0, Math.min(63, Math.round(filledElev(w)[cell])));
}

/** Baked EXPOSED ore of one cell: buried lodes and undersea lodes are 0. */
export function bakeOre(w: SphereTectonicWorld, cell: number): number {
  if (w.cover[cell] > 0 || bakeHeight(w, cell) < SEA_HEIGHT) return 0;
  return Math.max(0, Math.min(15, Math.round(w.ore[cell])));
}

/** Cell-indexed authors — the provider contract for curved substrates
 *  (a curved grid has no (x, y); `prepareSubstrate`'s sphere-side twin
 *  reads by cell). */
export function bakeCellAuthors(w: SphereTectonicWorld): {
  height: (cell: number) => number;
  ore: (cell: number) => number;
} {
  return {
    height: cell => bakeHeight(w, cell),
    ore: cell => bakeOre(w, cell),
  };
}

/** One scrubbable keyframe — the flat TectonicFrame shape, world-indexed. */
export function sphereTectonicFrame(w: SphereTectonicWorld): TectonicFrame {
  const n = w.topo.n;
  const height = new Uint8Array(n);
  const ore = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    height[c] = bakeHeight(w, c);
    ore[c] = bakeOre(w, c);
  }
  return { epoch: w.epoch, height, plate: w.plate.slice(), ore };
}

export interface RunSphereTectonicOpts extends SphereTectonicOpts {
  epochs?: number; // default 350
  keyframeEvery?: number; // default 25; 0 = final frame only
}

/** Run a whole history, collecting keyframes (final state always included). */
export function runSphereTectonics(opts: RunSphereTectonicOpts): { world: SphereTectonicWorld; frames: TectonicFrame[] } {
  const world = createSphereTectonics(opts);
  const epochs = opts.epochs ?? 350;
  const every = opts.keyframeEvery ?? 25;
  const frames: TectonicFrame[] = [];
  if (every > 0) frames.push(sphereTectonicFrame(world));
  for (let e = 0; e < epochs; e++) {
    sphereTectonicEpoch(world);
    if (every > 0 && world.epoch % every === 0) frames.push(sphereTectonicFrame(world));
  }
  if (frames.length === 0 || frames[frames.length - 1].epoch !== world.epoch) frames.push(sphereTectonicFrame(world));
  return { world, frames };
}
