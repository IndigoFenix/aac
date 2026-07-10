/**
 * PlanetSurface — the height/color seam between a world and its planet
 * renderer. The renderer (chunk.ts + lod.ts) samples ONLY this interface,
 * so the same quadtree mesh draws:
 *
 *   - a SUBSTRATE-BACKED world (`substrateSurface`): the shared engine's
 *     cube-sphere cell grid — tectonic height, fertility greens, seas
 *     where the geology put them. This is the seam where the civilization
 *     stack becomes VISIBLE terrain: fields are read by direction through
 *     the lattice (topo.cellAt + pos3), so the render mesh owes nothing to
 *     the grid's resolution or parameterization.
 *   - a pure-noise world: seagull-dream's continent/detail FBM, for bodies
 *     with no simulation underneath (that game's celestial-body keeps its
 *     own richer physics-driven version until its migration turn).
 *
 * Cell fields are piecewise-constant; raw nearest-cell sampling would bake
 * terraced "pixel" continents. `substrateSurface` therefore interpolates —
 * inverse-distance weighting over the cell and its lattice neighbours
 * (C0-smooth, seam-free because everything is direction-based) — and
 * layers sub-cell detail noise on top, faded out near the shoreline so the
 * coast stays where the substrate drew it (the flat stepper's micro-relief
 * rule, at planet scale).
 */
import type { GridTopology } from "../engine/cells/topology";
import { makePlanetNoise } from "./noise";

export type Vec3 = readonly [number, number, number];
export type RGB = readonly [number, number, number];

export interface PlanetSurface {
  /** Planet base radius (sea level), in render units. */
  radius: number;
  /** Elevation above (+) / below (−) the sea-level sphere at a unit direction. */
  heightAt(dir: Vec3): number;
  /** Vertex color for an elevation at a direction (dir enables field-driven
   *  tinting — fertility greens, ore dust). Writes into `out`. */
  colorAt(h: number, dir: Vec3, out: [number, number, number]): void;
}

/** What the substrate surface reads — a CellGrid satisfies it structurally
 *  (type-only coupling to the engine: the renderer knows the lattice seam,
 *  not the engine). */
export interface SubstrateLike {
  topo: GridTopology;
  fields: Record<string, ArrayLike<number>>;
}

export interface PlanetPalette {
  /** Deep-water / basin floor colour (dark). */
  oceanFloor: RGB;
  /** Water SURFACE colour (the bright blue seen from orbit). On a dry world
   *  this is a dark basin tone so basins don't read as water. */
  oceanSurface: RGB;
  sand: RGB;
  /** Fully-fertile lowland color; barren land falls back to sand→rock. */
  grass: RGB;
  forest: RGB;
  rock: RGB;
  snow: RGB;
}

export const EARTHLIKE_PALETTE: PlanetPalette = {
  oceanFloor: [0.024, 0.065, 0.13],
  oceanSurface: [0.026, 0.106, 0.207],
  sand: [0.78, 0.70, 0.52],
  grass: [0.28, 0.52, 0.25],
  forest: [0.13, 0.33, 0.16],
  rock: [0.45, 0.41, 0.38],
  snow: [0.93, 0.94, 0.96],
};

export interface SubstrateSurfaceOpts {
  /** The cube-sphere cell grid (topo must expose pos3 + cellAt). */
  substrate: SubstrateLike;
  /** Planet base radius in render units. */
  radius: number;
  /** Elevation of a max-height (63) cell above sea level
   *  (default 0.5% of the radius — seagull's silhouette clamp). */
  maxElevation?: number;
  /** The substrate's sea line in height units (geology's SEA_HEIGHT). */
  seaHeight?: number;
  /** Top of the substrate height range (default 63). */
  maxHeightUnits?: number;
  /** Detail-noise seed (default 1). */
  seed?: number;
  /** Sub-cell detail amplitude as a fraction of one height-unit's elevation
   *  (default 0.6; 0 disables). */
  detail?: number;
  /** Field names (defaults: height / fertility). */
  heightField?: string;
  fertilityField?: string;
  /** Fertility value that reads as fully lush (default 6). */
  fertilityFull?: number;
  palette?: PlanetPalette;
}

const lerp3 = (a: RGB, b: RGB, t: number, out: [number, number, number]): void => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
};

/** Median neighbour angle of the lattice — one cell's angular pitch. */
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

export function substrateSurface(opts: SubstrateSurfaceOpts): PlanetSurface {
  const { substrate, radius } = opts;
  const { topo } = substrate;
  if (!topo.pos3 || !topo.cellAt) throw new Error("substrateSurface: topology must expose pos3 + cellAt (a curved lattice)");
  const heightArr = substrate.fields[opts.heightField ?? "height"];
  if (!heightArr) throw new Error("substrateSurface: substrate has no height field");
  const fertArr = substrate.fields[opts.fertilityField ?? "fertility"];

  const sea = opts.seaHeight ?? 3;
  const maxUnits = opts.maxHeightUnits ?? 63;
  const maxElevation = opts.maxElevation ?? radius * 0.005;
  const maxDepth = maxElevation * 1.3; // seagull's basin ratio
  const unitElev = maxElevation / Math.max(1, maxUnits - sea); // one height unit, in render units
  const detailAmp = (opts.detail ?? 0.6) * unitElev;
  const palette = opts.palette ?? EARTHLIKE_PALETTE;
  const fertilityFull = opts.fertilityFull ?? 6;

  const pitch = measurePitch(topo);
  // Detail wavelength ≈ a third of a cell — relief WITHIN cells, never
  // competing with the substrate's own shapes.
  const detailFreq = 3 / pitch;
  const noise = makePlanetNoise(opts.seed ?? 1);

  /** Kernel-interpolated field value at a unit direction. The stencil is
   *  the containing cell's radius-2 disk; each cell's weight kernel
   *  (Wendland-style (1 − (a/R)²)²) reaches EXACTLY zero at that cell's
   *  cutoff radius, so cells enter and leave the stencil at weight 0 —
   *  the sampled field is continuous across cell boundaries and face
   *  seams. (A naive inverse-distance stencil swap here produced
   *  full-cliff pops at cell edges, ~22× amplified in the deep-sea
   *  scaling.)
   *
   *  Two fidelity rules, both probed on the tectonic world:
   *  - The cutoff is TIGHT (1.2 × the cell's spacing): at a cell's center
   *    its own value carries ~73% of the weight, so a shore cell the
   *    substrate calls land RENDERS as land even with the sea on every
   *    side — LAND NEVER SINKS (a 1.6 × cutoff redrew 17% of coastal
   *    cells across the sea line). The converse is looser by design: a
   *    sea cell at the foot of a great cliff wall can shelf up to a
   *    narrow beach (bounded by the neighbour weight × the wall height)
   *    — the one smoothing artifact this kernel accepts, since interior
   *    ocean is untouched and cities live on land.
   *  - The cutoff is PER-CELL (that cell's own mean neighbour angle, not
   *    the global median): cube-sphere spacing varies ~1.3× across a
   *    face, and a global radius oversmooths wherever cells sit closer
   *    than the median (still 9% redrawn). Weights depend only on
   *    (direction, cell) — never on which cell contains the sample — so
   *    per-cell radii cost nothing in continuity. */
  const localR = new Float64Array(topo.n);
  {
    const nbs: number[] = new Array(topo.maxDegree).fill(0);
    for (let i = 0; i < topo.n; i++) {
      const k = topo.neighbours(i, nbs);
      const p = topo.pos3!(i);
      let sum = 0;
      for (let j = 0; j < k; j++) {
        const q = topo.pos3!(nbs[j]);
        const dp = Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
        sum += Math.acos(dp);
      }
      localR[i] = 1.2 * (k > 0 ? sum / k : pitch);
    }
  }
  const sampleField = (arr: ArrayLike<number>, x: number, y: number, z: number): number => {
    const c0 = topo.cellAt!([x, y, z]);
    let wsum = 0;
    let vsum = 0;
    topo.disk(c0, 2, cell => {
      const p = topo.pos3!(cell);
      const dp = Math.max(-1, Math.min(1, x * p[0] + y * p[1] + z * p[2]));
      const a = Math.acos(dp);
      const R = localR[cell];
      if (a >= R) return;
      const t = 1 - (a / R) * (a / R);
      const w = t * t;
      wsum += w;
      vsum += w * arr[cell];
    });
    return wsum > 0 ? vsum / wsum : arr[c0];
  };

  /** Height units → render elevation: linear above the sea line up to
   *  maxElevation, linear below it down to −maxDepth. */
  const unitsToElev = (units: number): number => {
    if (units >= sea) return (units - sea) * unitElev;
    return ((units - sea) / sea) * maxDepth;
  };

  const heightAt = (dir: Vec3): number => {
    const base = unitsToElev(sampleField(heightArr, dir[0], dir[1], dir[2]));
    if (detailAmp <= 0) return base;
    // Shoreline fade (the flat stepper's micro-relief rule): full detail
    // one unit above the sea, none at or below it — coasts stay where the
    // substrate drew them instead of dissolving into speckle.
    const fade = Math.max(0, Math.min(1, base / unitElev));
    if (fade === 0) return base;
    const d = noise.detail(dir[0] * detailFreq, dir[1] * detailFreq, dir[2] * detailFreq);
    return base + d * detailAmp * fade;
  };

  const shoreShallow = unitElev * 0.5;
  const treeLine = maxElevation * 0.5;
  const snowLine = maxElevation * 0.75;
  const mix: [number, number, number] = [0, 0, 0];

  const colorAt = (_h: number, dir: Vec3, out: [number, number, number]): void => {
    // Color bands select on the SMOOTH base field, not the detailed height
    // the geometry uses — the sub-cell detail noise crosses the narrow
    // shore/vegetation thresholds at every vertex otherwise, and the whole
    // planet reads as sand-colored speckle from orbit.
    const h = unitsToElev(sampleField(heightArr, dir[0], dir[1], dir[2]));
    if (h <= 0) {
      // Bright water at the surface/shore, darkening to the deep-floor colour —
      // so oceans read as blue water from orbit, not a near-black seabed.
      const t = Math.max(0, Math.min(1, 1 + h / maxDepth)); // 1 at surface, 0 deep
      lerp3(palette.oceanFloor, palette.oceanSurface, t, out);
      return;
    }
    if (h < shoreShallow) {
      out[0] = palette.sand[0]; out[1] = palette.sand[1]; out[2] = palette.sand[2];
      return;
    }
    // Lushness comes from the SUBSTRATE: the fertility the rivers laid down
    // decides how green the lowlands read.
    const fert = fertArr
      ? Math.max(0, Math.min(1, sampleField(fertArr, dir[0], dir[1], dir[2]) / fertilityFull))
      : 0;
    if (h < treeLine) {
      lerp3(palette.grass, palette.forest, (h - shoreShallow) / (treeLine - shoreShallow), mix);
      lerp3(palette.sand, mix as unknown as RGB, fert, out); // barren land stays dusty
      return;
    }
    if (h < snowLine) {
      lerp3(palette.grass, palette.forest, 1, mix);
      lerp3(palette.sand, mix as unknown as RGB, fert, mix);
      lerp3(mix as unknown as RGB, palette.rock, (h - treeLine) / (snowLine - treeLine), out);
      return;
    }
    lerp3(palette.rock, palette.snow, Math.min(1, (h - snowLine) / Math.max(1e-9, maxElevation - snowLine)), out);
  };

  return { radius, heightAt, colorAt };
}

export interface NoiseSurfaceOpts {
  radius: number;
  seed: number;
  maxElevation?: number;
  /** Continent threshold offset (negative = wetter world; default -0.15). */
  continentOffset?: number;
  detailWeight?: number;
  palette?: PlanetPalette;
}

/** A pure-noise planet — seagull-dream's height model behind the same seam
 *  (for bodies with no simulation underneath). */
export function noiseSurface(opts: NoiseSurfaceOpts): PlanetSurface {
  const { radius } = opts;
  const maxElevation = opts.maxElevation ?? radius * 0.005;
  const maxDepth = maxElevation * 1.3;
  const continentFreq = 1.5;
  const detailFreq = 40;
  const detailWeight = opts.detailWeight ?? 0.2;
  const continentOffset = opts.continentOffset ?? -0.15;
  const palette = opts.palette ?? EARTHLIKE_PALETTE;
  const noise = makePlanetNoise(opts.seed);

  const heightAt = (dir: Vec3): number => {
    const c = noise.continent(dir[0] * continentFreq, dir[1] * continentFreq, dir[2] * continentFreq);
    const continent = c + continentOffset;
    if (continent < 0) return Math.max(continent * maxDepth * 1.5, -maxDepth);
    const d = noise.detail(dir[0] * detailFreq, dir[1] * detailFreq, dir[2] * detailFreq);
    return continent * maxElevation + d * detailWeight * maxElevation;
  };

  const shoreShallow = maxElevation * 0.02;
  const treeLine = maxElevation * 0.5;
  const snowLine = maxElevation * 0.75;

  const colorAt = (h: number, _dir: Vec3, out: [number, number, number]): void => {
    if (h <= 0) lerp3(palette.oceanFloor, palette.oceanSurface, Math.max(0, Math.min(1, 1 + h / maxDepth)), out);
    else if (h < shoreShallow) { out[0] = palette.sand[0]; out[1] = palette.sand[1]; out[2] = palette.sand[2]; }
    else if (h < treeLine) lerp3(palette.grass, palette.forest, (h - shoreShallow) / (treeLine - shoreShallow), out);
    else if (h < snowLine) lerp3(palette.forest, palette.rock, (h - treeLine) / (snowLine - treeLine), out);
    else lerp3(palette.rock, palette.snow, Math.min(1, (h - snowLine) / Math.max(1e-9, maxElevation - snowLine)), out);
  };

  return { radius, heightAt, colorAt };
}
