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
import type { GridTopology } from "../kernel/cells/topology";
import { makePlanetNoise } from "./noise";

export type Vec3 = readonly [number, number, number];
export type RGB = readonly [number, number, number];

/** How much of each detailed ground material a vertex is: [sand, grass, rock].
 *
 *  Weights, not an enum — the colour ramps blend, so the detail must blend with
 *  them or the texture edge and the colour edge land in different places. They
 *  need not sum to 1: everything the detail pass has no material for (open
 *  water, seabed, snow cap) is simply LOW on all three, which reads as the
 *  untextured colour it already was. */
export type MaterialWeights = [sand: number, grass: number, rock: number];

/** Per-material SHAPE parameter, 0..1, index-aligned with MaterialWeights — how
 *  each material looks where it is, as opposed to how much of it there is.
 *
 *  Only the sand slot is live: 0 = fine sorted sand (wind ripples), 1 = coarse
 *  grit (pebbles, no ripples). The grass and rock slots exist so the seam is
 *  already the right shape when they grow one, and are zero until then. */
export type MaterialRegime = [sandGrain: number, grassShape: number, rockShape: number];

export interface PlanetSurface {
  /** Planet base radius (sea level), in render units. */
  radius: number;
  /** Elevation above (+) / below (−) the sea-level sphere at a unit direction.
   *  This is the CARVED ground — what the mesh, the walk chart and collision
   *  all read. */
  heightAt(dir: Vec3): number;
  /** Elevation off the MACRO height field — the drainage/climate potential,
   *  before its rivers cut valleys into it. Only refinement needs this: a
   *  child tier's `height` must be seeded from macro, never from the carved
   *  ground, or valleys compound per tier. Equals `heightAt` where nothing
   *  carves (noise surfaces, authored labs). */
  macroHeightAt?(dir: Vec3): number;
  /** 0..1 river wetness at a direction — a watercourse running at whatever
   *  altitude its bed sits, NOT the sea (that's a height test in chunk.ts).
   *  Absent on surfaces with no river field. */
  wetAt?(dir: Vec3): number;
  /** Unit planet-local direction the current runs at a direction, written into
   *  `out`; (0,0,0) where the water is still or dry. Tangent to the surface. */
  flowAt?(dir: Vec3, out: [number, number, number]): void;
  /** RIVER RECOLOR (planet/rivers.ts attachRiverRelief installs this): blends
   *  water colour into a vertex colour where `dir` lies within a channel of
   *  the extracted river polylines. Painted into the TERRAIN mesh's own
   *  colours, so it tracks the ground at every LOD by construction — the fix
   *  for draped water burying/floating as the quadtree re-chords valleys.
   *  `minHalfWidthM` is the mesh builder's vertex spacing: thin channels
   *  widen to it (capped) so rivers survive coarse chunks. Absent = none. */
  riverTintAt?(dir: Vec3, minHalfWidthM: number, rgb: [number, number, number]): void;
  /** RIVER WATER + PAINT in one lookup (planet/rivers.ts attachRiverRelief
   *  installs this): does riverTintAt's recolor AND returns the depth of
   *  standing water above the carved ground at `dir` (0 = dry), filling
   *  `outFlow` with the unit DOWNSTREAM direction when wet. The mesh builder
   *  clamps wet vertices up to the water surface and feeds the flow to the
   *  water shader's clamped current path — the actual water layer, at the
   *  channel's TRUE width only (the LOD glyph applies to paint, never to
   *  water: glyphed water was the region-sized animated "sea" bug). */
  riverSampleAt?(dir: Vec3, vertSpanM: number, rgb: [number, number, number], outFlow: [number, number, number]): number;
  /** ROAD RECOLOR (planet/route-paint.ts): blends packed-dirt colour into a
   *  vertex colour where `dir` lies on a painted lane — true width, faded by
   *  coverage below the mesh's resolution, same law as the river paint. The
   *  index starts empty; the host merges route sets as they appear. */
  roadTintAt?(dir: Vec3, vertSpanM: number, rgb: [number, number, number]): void;
  /** Vertex color for an elevation at a direction (dir enables field-driven
   *  tinting — fertility greens, ore dust). Writes into `out`. */
  colorAt(h: number, dir: Vec3, out: [number, number, number]): void;
  /** Ground-material mix at a direction, for the detail-texture pass
   *  (terrain-shading.ts). Writes into `out`.
   *
   *  OPTIONAL, and absence is a real answer, not a stub: a surface that doesn't
   *  implement it gets all-zero weights, i.e. flat vertex colour — exactly how
   *  every surface looked before detail existed. So a foreign PlanetSurface
   *  keeps working untouched rather than breaking on a new required method.
   *
   *  MUST track colorAt's own branches. These weights say "draw grass here" and
   *  colorAt says "be green here"; if they disagree the texture visibly runs
   *  past the colour it belongs to. */
  materialAt?(h: number, dir: Vec3, out: MaterialWeights): void;
  /** Per-material shape at a direction — see MaterialRegime. Writes into `out`.
   *
   *  OPTIONAL like materialAt, and absence means the same thing: all-zero, i.e.
   *  every material reads as its 0 end (sand as fine sand everywhere). That is a
   *  plausible world, not a broken one. */
  regimeAt?(h: number, dir: Vec3, out: MaterialRegime): void;
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
  /** Ice-cap field (climate.ts's `ice`, 0..1): where it samples high the
   *  vertex paints snow-white, land or sea (sea ice). Absent field = no
   *  extra work — the sampler is the per-vertex hot path. */
  iceField?: string;
  /** Biome field (ecology.ts's `biome`, species idx + 1; 0 = barren) +
   *  its colour lookup (`biomePalette`, index-aligned; null = keep the
   *  fertility tint). Present ⇒ vegetated land reads as its DOMINANT PLANT
   *  (forest deep green, steppe meadow) instead of the elevation ramp. One
   *  gated sampleField, like ice. */
  biomeField?: string;
  biomeColors?: Array<RGB | null>;
  /** Fertility value that reads as fully lush (default 6). */
  fertilityFull?: number;
  /** Valley-cut field (worldgen.carveValleys' `valley`, in HEIGHT UNITS): how
   *  deep the rivers cut here. Where they cut, they cut down to BEDROCK, so
   *  this is what puts rock — and its strata — in a river valley instead of
   *  only on mountain tops. Absent field = no extra work, like ice and biome.
   *
   *  It is deliberately the CUT and not the river: rivers don't make strata,
   *  they expose them. */
  valleyField?: string;
  /** Cut depth (height units) that reads as fully bare rock. Default 2 =
   *  carveValleys' own default `maxDepth`, i.e. a full-depth trunk valley
   *  exposes bedrock. Raise it with that option or valleys stay green. */
  valleyRockFull?: number;
  /** Local relief (mean |Δheight| to neighbouring cells, in HEIGHT UNITS) that
   *  reads as fully-sorted fine sand / as raw grit. Sand's grain regime lerps
   *  between them — see `regimeAt`.
   *
   *  Defaults measured on the tectonic substrate rather than guessed: land
   *  relief there runs p10 0.25 / p50 5 / p90 20.75 / max 63, so 2..18 spreads
   *  the regime across the real distribution. A plausible-looking 1..6 puts 90%
   *  of all land at fully coarse and the fine end never renders. */
  grainReliefLo?: number;
  grainReliefHi?: number;
  palette?: PlanetPalette;
  /** Flow-accumulation field the rivers live in (default 'river'). */
  riverField?: string;
  /** Accumulation OVER which a cell carries visible water (default 16 —
   *  travel.ts's "genuine watercourse", the same line carveValleys starts
   *  cutting a bed at, so water appears exactly where there's a bed for it). */
  riverWetOver?: number;
}

/** The river tint, as a smoothstep over wetness with these knees and ceiling.
 *
 *  The problem it threads: the substrate's `fertile-rich` rule keys straight off
 *  river flow, so the wettest cells are ALSO the most fertile. A tint that rose
 *  with wetness from zero turned equatorial floodplain the sea's own colour
 *  (green 0.14 vs blue 0.21). But a tint too timid to overcome that is why
 *  rivers were invisible on the rendered planet — a channel came out faintly
 *  bluish green, indistinguishable from forest.
 *
 *  The lever is that `wetAt` is SMOOTHED 0/1 channel-ness: a genuine channel
 *  cell samples high (~0.7–0.86), the fertile HALO one cell off samples low
 *  (~0.2–0.35), and dry-but-fertile land samples 0. So a smoothstep with its low
 *  knee ABOVE the halo band tints only the water itself and leaves the
 *  floodplain green.
 *
 *  NOW A BACKING, NOT THE WATER. The draped ribbon (world-lab/river-ribbons.ts)
 *  draws the actual river line, so this tint's job shrank to a faint DAMP hint
 *  under it — a channel cell reads slightly bluer than dry land, no more. The
 *  ceiling is low and the low knee is high on purpose: a strong, wide tint was
 *  what flooded whole regions blue (with trees and towns stranded in the
 *  "water") before the ribbon existed. Keep it subtle; the ribbon is the
 *  watercourse. */
const WET_CHANNEL_LO = 0.50;
const WET_CHANNEL_HI = 0.80;
const WET_TINT_MAX = 0.35;

/** Cubic smoothstep, clamped. */
const smooth01 = (lo: number, hi: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

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
  // THE RENDER/WALK DATUM is `ground` — macro height minus the valleys its
  // rivers cut (kernel/cells/worldgen.carveValleys). Everything that touches
  // the world's surface (mesh conform, walk chart, collision, camera, road
  // and building placement) reaches height through THIS array, so this is the
  // one line that decides which layer the world is made of. Callers that need
  // the MACRO field — the drainage/climate potential — must ask for it by
  // name; planet/refine.ts does, and must, or each region tier would carve a
  // valley into the last tier's valley. Substrates that carve nothing (the
  // authored labs) have no `ground` var and fall back to `height`, which is
  // what this always read.
  const heightKey = opts.heightField ?? (substrate.fields["ground"] ? "ground" : "height");
  const heightArr = substrate.fields[heightKey];
  if (!heightArr) throw new Error(`substrateSurface: substrate has no '${heightKey}' field`);
  const fertArr = substrate.fields[opts.fertilityField ?? "fertility"];
  const iceArr = opts.iceField ? substrate.fields[opts.iceField] : undefined;
  const biomeArr = opts.biomeField ? substrate.fields[opts.biomeField] : undefined;
  const valleyArr = opts.valleyField ? substrate.fields[opts.valleyField] : undefined;
  const valleyRockFull = Math.max(1e-9, opts.valleyRockFull ?? 2);
  const biomeColors = opts.biomeColors;

  const sea = opts.seaHeight ?? 3;
  const maxUnits = opts.maxHeightUnits ?? 63;
  const maxElevation = opts.maxElevation ?? radius * 0.005;
  const maxDepth = maxElevation * 1.3; // seagull's basin ratio
  const unitElev = maxElevation / Math.max(1, maxUnits - sea); // one height unit, in render units
  const detailAmp = (opts.detail ?? 0.6) * unitElev;
  const palette = opts.palette ?? EARTHLIKE_PALETTE;
  const fertilityFull = opts.fertilityFull ?? 6;

  const grainLo = opts.grainReliefLo ?? 2;
  const grainHi = opts.grainReliefHi ?? 18;

  const pitch = measurePitch(topo);
  // Detail wavelength ≈ a third of a cell — relief WITHIN cells, never
  // competing with the substrate's own shapes.
  const detailFreq = 3 / pitch;
  const noise = makePlanetNoise(opts.seed ?? 1);

  // ── METRIC RELIEF BANDS ─────────────────────────────────────────────────
  // Every other wavelength here scales with the CELL pitch — on a real-radius
  // planet the substrate's shapes span ~200 km and the angular detail ~70 km,
  // so the ground on foot reads dead flat, while a small moon packs the same
  // relative relief into km-scale drama. These bands are FIXED wavelengths in
  // metres — the hills a walker actually sees — each active only where it is
  // finer than what the angular detail already draws (λ < cellArc/3), so toy
  // worlds and small moons render bit-identically to before.
  // One raw simplex octave per band (noise.octave): heightAt is the chunk
  // builder's per-vertex hot path — a full FBM per band would jank flight.
  const cellArcM = pitch * radius;
  const detailParam = opts.detail ?? 0.6;
  const bands = [
    { lambdaM: 24_000, coef: 0.05 },
    { lambdaM: 6_000, coef: 0.02 },
    { lambdaM: 1_500, coef: 0.008 },
  ]
    .filter(b => b.lambdaM < cellArcM / 3)
    .map(b => ({ freq: radius / b.lambdaM, amp: b.coef * maxElevation * detailParam }));
  const bandMax = bands.reduce((s, b) => s + b.amp, 0);
  // The shore fade must cover the WORST detail sum, not one height unit —
  // otherwise a band digs coastal land below the sea line the color bands
  // sit on (sunken grass pits). Coastal plains render flat — honestly.
  const fadeBandElev = Math.max(unitElev, 1.25 * (bandMax + detailAmp));

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

  // ── SEDIMENT REGIME ───────────────────────────────────────────────────────
  // How rugged the neighbourhood is, per cell (mean |Δheight| to neighbours, in
  // height units). Sand's grain regime is read off this, because sediment
  // calibre IS a relief story: coarse grit sits where rock is close and the
  // transport is short (cliff feet, rugged coasts), and fine sorted sand
  // accumulates on flat ground far from any source.
  //
  // HONEST LIMIT: this is REGIONAL, at the substrate's cell pitch — ~200 km on
  // an Earth-radius world. It says "this region is mountainous, so its beaches
  // are cobbly", never "this beach is cobbly". That is the right shape of
  // answer for the signal available, but it is a proxy standing in for sediment
  // physics the sim does not run yet. When it does, THIS is the line to
  // replace, and the shading downstream shouldn't need to change.
  //
  // Precomputed once (O(n · degree)) rather than sampled per vertex: regimeAt
  // runs on the same hot path as heightAt/colorAt, where a fresh neighbour walk
  // per vertex was already measured as the biggest source of chunk-build jank.
  const reliefArr = new Float64Array(topo.n);
  {
    const nbs: number[] = new Array(topo.maxDegree).fill(0);
    for (let i = 0; i < topo.n; i++) {
      const k = topo.neighbours(i, nbs);
      let sum = 0;
      for (let j = 0; j < k; j++) sum += Math.abs(heightArr[i] - heightArr[nbs[j]]);
      reliefArr[i] = k > 0 ? sum / k : 0;
    }
  }
  // ── RIVERS: wetness + the direction the water actually goes ──────────────
  // Both precomputed per cell, for the same reason reliefArr is: these are read
  // on the per-vertex chunk hot path, and a neighbour walk per vertex was
  // already measured as the biggest cause of chunk-build jank.
  //
  // `wetArr` marks cells carrying a real watercourse. It is NOT the sea: ocean
  // is a height test (chunk.ts clamps those vertices up to sea level), while a
  // river sits at whatever altitude its bed does. The two share only the water
  // SHADING path.
  //
  // `flowArr` is the unit planet-local direction toward each wet cell's
  // steepest-descent neighbour — which is not an approximation of where the
  // water goes, it is BY CONSTRUCTION the same edge grid.ts's computeFlow
  // routed the catchment down (kernel/cells/grid.ts). Read off the MACRO height
  // for that reason: the carved `ground` is a valley the river already cut, and
  // draining over it would be answering a different question than the one the
  // river field answered. Zero on dry cells and on sinks (a lake has no
  // downstream), which the shader reads as "no current".
  const riverArr = substrate.fields[opts.riverField ?? "river"];
  // The macro field by name, not the `macroArr` binding below — that one is
  // declared with the samplers, long after this precompute runs.
  const macroForFlow = substrate.fields["height"] ?? heightArr;
  const RIVER_WET_OVER = opts.riverWetOver ?? 16; // travel.ts's "genuine watercourse"
  const wetArr = riverArr ? new Float32Array(topo.n) : null;
  const flowArr = riverArr ? new Float32Array(topo.n * 3) : null;
  if (riverArr && wetArr && flowArr) {
    const nbs: number[] = new Array(topo.maxDegree).fill(0);
    for (let i = 0; i < topo.n; i++) {
      if (riverArr[i] <= RIVER_WET_OVER) continue;
      wetArr[i] = 1;
      const k = topo.neighbours(i, nbs);
      let low = -1;
      let lowH = macroForFlow[i];
      for (let j = 0; j < k; j++) {
        if (macroForFlow[nbs[j]] < lowH) { lowH = macroForFlow[nbs[j]]; low = nbs[j]; }
      }
      if (low < 0) continue; // a sink — still water, no current
      const a = topo.pos3!(i);
      const b = topo.pos3!(low);
      // Tangential component of the step to the downstream cell: the chord
      // b − a minus its radial part, so the current runs ALONG the surface.
      let fx = b[0] - a[0], fy = b[1] - a[1], fz = b[2] - a[2];
      const radial = fx * a[0] + fy * a[1] + fz * a[2];
      fx -= a[0] * radial; fy -= a[1] * radial; fz -= a[2] * radial;
      const m = Math.hypot(fx, fy, fz);
      if (m < 1e-9) continue;
      flowArr[i * 3 + 0] = fx / m;
      flowArr[i * 3 + 1] = fy / m;
      flowArr[i * 3 + 2] = fz / m;
    }
  }

  // Sub-cell grain variation. Regional relief alone changes only every ~200 km,
  // so a walker would never see the regime change at all; this is a STAND-IN
  // for the local processes (wind sorting, stream flow) that the sim doesn't
  // model. It is deliberately BOUNDED so it can only ever nudge the physical
  // signal, never overturn it — a rugged region stays coarser than a flat one,
  // which is what keeps the regime testable against the geology.
  const GRAIN_LOCAL_LAMBDA_M = 300;
  const GRAIN_LOCAL_SPREAD = 0.3;
  // Gated like the relief bands: a wavelength coarser than the cells would
  // compete with the regional signal instead of detailing it.
  const grainNoiseFreq = GRAIN_LOCAL_LAMBDA_M < cellArcM / 3 ? radius / GRAIN_LOCAL_LAMBDA_M : 0;

  // ── Sampling hot path ─────────────────────────────────────────────────
  // This closure runs PER TERRAIN VERTEX (twice: geometry + color bands).
  // The naive form — a fresh disk() BFS with a Set per call plus acos per
  // stencil cell — measured ~65 µs/sample, ~10× seagull's noise sampler and
  // the single biggest cause of flight chunk-build jank. So the stencil is
  // PRECOMPUTED (one flat cell array per center cell — identical membership
  // to disk(c0, 2), same kernel), cell centers live in flat arrays, and the
  // tiny angles use the chord approximation a ≈ √(2(1−cosθ)) (< 0.01% off
  // at cell pitch) instead of acos. Same field, ~10× cheaper.
  const cposX = new Float64Array(topo.n);
  const cposY = new Float64Array(topo.n);
  const cposZ = new Float64Array(topo.n);
  for (let i = 0; i < topo.n; i++) {
    const p = topo.pos3!(i);
    cposX[i] = p[0]; cposY[i] = p[1]; cposZ[i] = p[2];
  }
  const stencilStart = new Int32Array(topo.n + 1);
  let stencilCells: Int32Array;
  {
    // MEMBERSHIP MUST BE METRIC-COMPLETE, not hop-complete. The kernel is
    // continuous ONLY if every cell whose cutoff radius reaches the sample is
    // IN the stencil of whichever cell contains it — a contributing cell that
    // is 2 hops from one side of a border but 3 hops from the other POPS in
    // and out as `cellAt` flips, a cliff-line discontinuity (the deep-sea
    // scaling amplifies it ~22×). Hop distance ≠ metric distance exactly at
    // cube-sphere face edges/corners, where the seams drew themselves as long
    // straight cliffs. So: gather a wider disk(3) net, then keep the cells
    // that could actually reach a sample inside this cell — center distance
    // under (that cell's own cutoff + this cell's containment radius).
    const lists: number[] = [];
    for (let i = 0; i < topo.n; i++) {
      stencilStart[i] = lists.length;
      const contain = localR[i] / 1.2; // ≈ this cell's mean neighbour angle
      topo.disk(i, 3, cell => {
        const dp = cposX[i] * cposX[cell] + cposY[i] * cposY[cell] + cposZ[i] * cposZ[cell];
        const a = Math.sqrt(Math.max(0, 2 * (1 - dp)));
        if (a < localR[cell] + contain) lists.push(cell);
      });
    }
    stencilStart[topo.n] = lists.length;
    stencilCells = Int32Array.from(lists);
  }
  const sampleField = (arr: ArrayLike<number>, x: number, y: number, z: number): number => {
    const c0 = topo.cellAt!([x, y, z]);
    let wsum = 0;
    let vsum = 0;
    const end = stencilStart[c0 + 1];
    for (let s = stencilStart[c0]; s < end; s++) {
      const cell = stencilCells[s];
      const dp = x * cposX[cell] + y * cposY[cell] + z * cposZ[cell];
      // Chord ≈ angle for the small stencil angles (exact enough vs acos).
      const a = Math.sqrt(Math.max(0, 2 * (1 - dp)));
      const R = localR[cell];
      if (a >= R) continue;
      const t = 1 - (a / R) * (a / R);
      const w = t * t;
      wsum += w;
      vsum += w * arr[cell];
    }
    return wsum > 0 ? vsum / wsum : arr[c0];
  };

  // One-entry memo: the chunk builder samples heightAt(dir) then
  // colorAt(h, dir) with the SAME direction — share the smooth base field
  // between them instead of re-walking the stencil.
  let memoX = NaN;
  let memoY = NaN;
  let memoZ = NaN;
  let memoBase = 0;
  const smoothHeightUnits = (x: number, y: number, z: number): number => {
    if (x === memoX && y === memoY && z === memoZ) return memoBase;
    memoX = x; memoY = y; memoZ = z;
    memoBase = sampleField(heightArr, x, y, z);
    return memoBase;
  };

  /** Height units → render elevation: linear above the sea line up to
   *  maxElevation, linear below it down to −maxDepth. */
  const unitsToElev = (units: number): number => {
    if (units >= sea) return (units - sea) * unitElev;
    return ((units - sea) / sea) * maxDepth;
  };

  /** Height units → detailed render elevation. Split from `heightAt` so the
   *  macro sampler below can share the detail/band envelope instead of
   *  duplicating it — the two differ ONLY in which base field they read. */
  const detailedElev = (units: number, dir: Vec3): number => {
    const base = unitsToElev(units);
    if (detailAmp <= 0) return base;
    // Shoreline fade (the flat stepper's micro-relief rule): full detail
    // above the fade band, none at or below the sea — coasts stay where the
    // substrate drew them instead of dissolving into speckle. The band is
    // sized so |detail| < base everywhere: land NEVER sinks.
    const fade = Math.max(0, Math.min(1, base / fadeBandElev));
    if (fade === 0) return base;
    let d = noise.detail(dir[0] * detailFreq, dir[1] * detailFreq, dir[2] * detailFreq) * detailAmp;
    if (bands.length) {
      // Relief envelope: plains roll gently (35%), highlands crag in full,
      // summits taper so the silhouette stays the physics' maxElevation.
      const m = base / maxElevation;
      const env = (0.35 + 0.65 * Math.min(1, m / 0.3))
        * Math.max(0, Math.min(1, (1.05 - m) / 0.25));
      if (env > 0) {
        for (const b of bands) {
          d += noise.octave(dir[0] * b.freq, dir[1] * b.freq, dir[2] * b.freq) * b.amp * env;
        }
      }
    }
    return base + d * fade;
  };

  const heightAt = (dir: Vec3): number => detailedElev(smoothHeightUnits(dir[0], dir[1], dir[2]), dir);

  // THE MACRO SAMPLER: the same surface read off the uncarved drainage
  // potential. planet/refine.ts samples the parent surface and feeds the
  // result in as the CHILD's `height` — its drainage potential — so it must
  // never see `ground`: the child would solve its rivers over terrain the
  // parent's rivers had already cut, and every tier would carve a valley
  // into the last tier's valley. Valleys are derived FROM rivers, so they
  // can never be an input to the thing that computes rivers — at any tier.
  // Identical to `heightAt` on substrates that carve nothing.
  const macroArr = substrate.fields["height"];
  const macroHeightAt = !macroArr || macroArr === heightArr
    ? heightAt
    : (dir: Vec3): number => detailedElev(sampleField(macroArr, dir[0], dir[1], dir[2]), dir);

  /** 0..1 river wetness. SMOOTH (the same stencil the height uses), so a bank
   *  fades rather than staircasing along cell edges. Ocean is not included —
   *  that stays a height test in chunk.ts. */
  const wetAt = wetArr
    ? (dir: Vec3): number => sampleField(wetArr, dir[0], dir[1], dir[2])
    : undefined;

  /** Unit planet-local direction the current runs, or (0,0,0) for still water.
   *  NEAREST, not smoothed: averaging unit vectors across a cell boundary
   *  shortens them toward zero exactly where two tributaries meet — a
   *  confluence would read as slack water, which is the one place a current is
   *  most obviously wrong. Cell-pitch steps in direction are hidden by the
   *  wetness fade and the wave field's own irregularity. */
  const flowAt = flowArr
    ? (dir: Vec3, out: [number, number, number]): void => {
        const c = topo.cellAt!(dir) * 3;
        out[0] = flowArr[c]; out[1] = flowArr[c + 1]; out[2] = flowArr[c + 2];
      }
    : undefined;

  const shoreShallow = unitElev * 0.5;
  const treeLine = maxElevation * 0.5;
  const snowLine = maxElevation * 0.75;
  const mix: [number, number, number] = [0, 0, 0];
  const _veg: [number, number, number] = [0, 0, 0];
  /** Fallback vegetation colour: the old elevation grass→forest ramp, for
   *  worlds with no biome field. */
  const defaultVeg = (h: number): RGB => {
    const t = Math.max(0, Math.min(1, (h - shoreShallow) / (treeLine - shoreShallow)));
    lerp3(palette.grass, palette.forest, t, _veg);
    return _veg as unknown as RGB;
  };

  const colorAt = (_h: number, dir: Vec3, out: [number, number, number]): void => {
    // Color bands select on the SMOOTH base field, not the detailed height
    // the geometry uses — the sub-cell detail noise crosses the narrow
    // shore/vegetation thresholds at every vertex otherwise, and the whole
    // planet reads as sand-colored speckle from orbit. (Memoized: heightAt
    // just sampled this direction.)
    const h = unitsToElev(smoothHeightUnits(dir[0], dir[1], dir[2]));
    // ICE CAPS (climate.ts): the interpolated 0/1 field crosses ~0.5 at
    // the cap edge; a narrow blend band keeps the margin from aliasing.
    // One extra field sample, only on worlds that carry the field.
    if (iceArr) {
      const ice = sampleField(iceArr, dir[0], dir[1], dir[2]);
      if (ice >= 0.65) {
        out[0] = palette.snow[0]; out[1] = palette.snow[1]; out[2] = palette.snow[2];
        return;
      }
      if (ice > 0.35) {
        wetBase(h, dir, out);
        lerp3(out as unknown as RGB, palette.snow, (ice - 0.35) / 0.3, out);
        return;
      }
    }
    wetBase(h, dir, out);
  };

  /** The land/ocean colour, then RIVERS blended over it by wetness.
   *
   *  A blend rather than a replace, against the SMOOTH wetness: the bank fades
   *  into the water over a cell instead of stopping at a polygon edge, which is
   *  the same reason the ice margin blends. Only above the sea — the ocean is
   *  already water and `h <= 0` owns it.
   *
   *  Colour is where river water gets its strength, deliberately: the seizure
   *  rule in terrain-shading.ts says that when water needs to read stronger you
   *  reach for COLOUR and CONTRAST, which don't flicker, never for gloss. */
  const wetBase = (h: number, dir: Vec3, out: [number, number, number]): void => {
    baseColor(h, dir, out);
    if (!wetAt || h <= 0) return;
    const t = smooth01(WET_CHANNEL_LO, WET_CHANNEL_HI, wetAt(dir));
    if (t <= 0) return;
    lerp3(out as unknown as RGB, palette.oceanSurface, t * WET_TINT_MAX, out);
  };

  /** How much BEDROCK is showing — the river cut, minus whatever grew over it.
   *
   *  Two facts, and the second is what keeps this from fighting the rest of the
   *  world. Rivers cut down to rock, so the cut depth says where rock is
   *  reachable. But the ecology makes river cells the FERTILE ones (its
   *  `fertile-rich` rule keys straight off river flow), so cut and green land
   *  coincide by construction — and without the `1 - fert` term the valleys
   *  that rivers make lush would render as bare stone. Vegetation covers
   *  bedrock; a barren cut shows it. Fertile floodplain green, canyon rock, and
   *  the two stop competing for the same ground. */
  const exposureAt = (dir: Vec3, fert: number): number => {
    if (!valleyArr) return 0;
    const cut = sampleField(valleyArr, dir[0], dir[1], dir[2]);
    if (cut <= 0) return 0;
    return Math.max(0, Math.min(1, cut / valleyRockFull)) * (1 - fert);
  };

  const baseColor = (h: number, dir: Vec3, out: [number, number, number]): void => {
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
    // The vegetation colour is the DOMINANT PLANT where ecology named one
    // (forest vs steppe read distinct), else the elevation grass→forest ramp.
    let veg: RGB = defaultVeg(h);
    if (biomeArr && biomeColors) {
      const b = Math.round(sampleField(biomeArr, dir[0], dir[1], dir[2]));
      const col = b > 0 && b < biomeColors.length ? biomeColors[b] : null;
      if (col) veg = col;
    }
    if (h >= snowLine) {
      lerp3(palette.rock, palette.snow, Math.min(1, (h - snowLine) / Math.max(1e-9, maxElevation - snowLine)), out);
      return;
    }
    if (h < treeLine) {
      lerp3(palette.sand, veg, fert, out); // barren land stays dusty
    } else {
      lerp3(palette.sand, veg, fert, mix);
      lerp3(mix as unknown as RGB, palette.rock, (h - treeLine) / (snowLine - treeLine), out);
    }
    // BEDROCK THE RIVERS CUT DOWN TO — what puts rock, and its strata, in a
    // valley rather than only on mountain tops. Applied below the snow line
    // only: a buried cap shows nothing.
    const ex = exposureAt(dir, fert);
    if (ex > 0) lerp3(out as unknown as RGB, palette.rock, ex, out);
  };

  /** The same branches as baseColor/colorAt, answering "which material" instead
   *  of "which colour". It is deliberately a PARALLEL walk of the same bands
   *  rather than a by-product of the colour: the colour is a blended RGB by the
   *  time it exists, and recovering weights from it would mean matching against
   *  a palette that callers can replace and biomes already override.
   *
   *  Reads the SMOOTH base height for the same reason colorAt does — sub-cell
   *  detail noise crosses these thresholds at every vertex, which would speckle
   *  the material mix as badly as it once speckled the colour. Cheap: heightAt
   *  and colorAt already sampled this direction, so the memo answers. */
  const materialAt = (_h: number, dir: Vec3, out: MaterialWeights): void => {
    const h = unitsToElev(smoothHeightUnits(dir[0], dir[1], dir[2]));
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (h <= 0) return; // water surface / seabed — the water pass owns these
    if (h < shoreShallow) { out[0] = 1; return; }

    const fert = fertArr
      ? Math.max(0, Math.min(1, sampleField(fertArr, dir[0], dir[1], dir[2]) / fertilityFull))
      : 0;
    // Barren lowland is dusty ground, not meadow — the colour ramp lerps sand→veg
    // by fertility, so the materials split the same way.
    let sand = 1 - fert;
    let grass = fert;
    let rock = 0;
    if (h >= treeLine) {
      const t = h < snowLine
        ? (h - treeLine) / (snowLine - treeLine)
        : 1;
      sand *= 1 - t;
      grass *= 1 - t;
      rock = t;
    }
    if (h >= snowLine) {
      // Above the snow line the colour ramp walks rock→snow; snow has no detail
      // material of its own, so rock simply fades out under it.
      const s = Math.min(1, (h - snowLine) / Math.max(1e-9, maxElevation - snowLine));
      rock *= 1 - s;
    } else {
      // Bedrock the rivers cut down to — baseColor lerps toward palette.rock by
      // exactly this, below the snow line and by the same exposure, so the
      // strata land on ground that is actually painted as rock.
      const ex = exposureAt(dir, fert);
      if (ex > 0) {
        sand *= 1 - ex;
        grass *= 1 - ex;
        rock = rock * (1 - ex) + ex;
      }
    }
    if (iceArr) {
      // Mirrors colorAt's cap blend: full cap paints snow and hides the ground.
      const ice = sampleField(iceArr, dir[0], dir[1], dir[2]);
      if (ice >= 0.65) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
      if (ice > 0.35) {
        const k = 1 - (ice - 0.35) / 0.3;
        sand *= k; grass *= k; rock *= k;
      }
    }
    out[0] = sand; out[1] = grass; out[2] = rock;
  };

  /** Sand's grain regime from local relief — see the SEDIMENT REGIME note.
   *  Unlike materialAt this reads a field the colour ramp knows nothing about,
   *  so it has no colorAt branch to track. */
  const regimeAt = (_h: number, dir: Vec3, out: MaterialRegime): void => {
    const r = sampleField(reliefArr, dir[0], dir[1], dir[2]);
    let grain = (r - grainLo) / Math.max(1e-9, grainHi - grainLo);
    if (grainNoiseFreq > 0) {
      grain += noise.octave(dir[0] * grainNoiseFreq, dir[1] * grainNoiseFreq, dir[2] * grainNoiseFreq)
        * GRAIN_LOCAL_SPREAD * 0.5;
    }
    out[0] = Math.max(0, Math.min(1, grain));
    out[1] = 0; // grass has no regime yet
    out[2] = 0; // nor rock
  };

  return { radius, heightAt, macroHeightAt, wetAt, flowAt, colorAt, materialAt, regimeAt };
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

  /** Parallel to colorAt's bands — see the note on substrateSurface's version.
   *  This world has no fertility field, so its lowlands are meadow outright
   *  where the ramp is already grass→forest. */
  const materialAt = (h: number, _dir: Vec3, out: MaterialWeights): void => {
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (h <= 0) return;
    if (h < shoreShallow) { out[0] = 1; return; }
    if (h < treeLine) { out[1] = 1; return; }
    if (h < snowLine) {
      const t = (h - treeLine) / (snowLine - treeLine);
      out[1] = 1 - t;
      out[2] = t;
      return;
    }
    const s = Math.min(1, (h - snowLine) / Math.max(1e-9, maxElevation - snowLine));
    out[2] = 1 - s;
  };

  return { radius, heightAt, colorAt, materialAt };
}
