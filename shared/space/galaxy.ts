import * as THREE from "three";
import { sampleIMFMass, resolveStellarState, intrinsicFromLuminosity } from "./stellar";
import { sampleAgeAt, sampleMetallicityAt } from "./galaxy-context";

/** The handful of tunables this module read from seagull-dream's config —
 *  inlined at migration (shared/space is the game-agnostic home; the game
 *  keeps its own copy until its repoint turn). */
export const GALAXY = {
  /** Canonical home-system seed — the designated home star gets it. */
  homeSystemSeed: 1337,
  /** Per-cell brightness scale for non-leaf aggregates. */
  aggregateBrightness: 0.05,
  /** Per-star contribution to aggregate cluster brightness. */
  aggregateIntrinsicScale: 5e-10,
  /** Maximum pixel size for an aggregate cluster sprite. */
  aggregateMaxSize: 800,
  /** REAL scale: 1 scene metre == 1 real metre (a light-year in scene metres). */
  lyToSceneMeters: 9.4607304725808e15,
  /** Lift a star into a full solar system below this galactic distance (ly). */
  materializeLy: 0.5,
  /** Hysteresis — the active system stays loaded until this far (ly). */
  dematerializeLy: 0.8,
};

// Galaxy — a single procedurally-generated galaxy at galactic-scale
// (radius in tens of thousands of ly). Stars are not stored upfront; they're
// generated on demand from cell coordinates via a deterministic hash, so the
// registry can describe a galaxy with ~100 B stars without ever materializing
// most of them.
//
// Architecture:
//   - A continuous DENSITY FIELD `densityAt(x,y,z)` defines star density
//     anywhere in galactic coords (disc + bulge + spiral arms or clumps,
//     depending on type).
//   - A HIERARCHY of cubic cells at fixed sizes (`CELL_SIZES`) bins the
//     density. Each cell's aggregate brightness is sampled from the field
//     once and cached. Leaf cells (the smallest tier) generate individual
//     stars via a per-cell seeded RNG when expanded.
//   - Per-star PHYSICS sampling happens inside `expandLeafCell`: each star
//     draws (M_init, age, [Fe/H]) from the local IMF / SFR / metallicity
//     fields, then resolves current state. The star's `color` and
//     `intrinsic` (display brightness) come from physics, not a palette.
//   - Per frame the world iterates cells in concentric SHELLS around the
//     player, one shell per LOD tier. Far shells render coarser cells as
//     "smudged blob" aggregates; the innermost shell expands leaves into
//     individual stars. A FADE BAND between shells blends aggregate ↔
//     children for a smooth visual transition.

// ── Density field ───────────────────────────────────────────────────────────

export type GalaxyType = "spiral" | "elliptical" | "irregular";

/** An irregular-galaxy clump: a localized gaussian over-density representing
 *  a star-forming region. Used only when `type === "irregular"`. */
export interface Clump {
  position: THREE.Vector3;
  /** Characteristic radius (ly). */
  scale: number;
  /** Peak density boost (stars / ly³). */
  density: number;
}

export interface GalaxyParams {
  // ── Spatial ─────────────────────────────────────────────────────
  /** Galaxy bounding radius (ly). Beyond ~1.2× this the density is treated
   *  as zero so we don't waste cells on empty space. */
  radius: number;
  /** Number of spiral arms. 0 for non-spirals. */
  arms: number;
  /** Arm-spiral rate, radians per ly. Lower = looser spiral. */
  spin: number;
  /** Arm-density profile sharpness. Higher = thinner, more defined arms. */
  armSharpness: number;
  /** Arm-density boost factor. 0 = no arms (elliptical / irregular). */
  armStrength: number;
  /** Disc radial exponential scale (ly). */
  discScaleR: number;
  /** Disc vertical exponential scale (ly). Sets disc thickness. */
  discScaleZ: number;
  /** Disc central density (stars / ly³). */
  discDensity: number;
  /** Bulge spherical exponential scale (ly). */
  bulgeScale: number;
  /** Bulge central density (stars / ly³). */
  bulgeDensity: number;

  // ── Type + age ──────────────────────────────────────────────────
  type: GalaxyType;
  /** Galaxy age (Gyr). Used by SFR sampling — limits oldest possible star. */
  galaxyAgeGyr: number;

  // ── Star formation history ──────────────────────────────────────
  /** Time of peak star formation (Gyr after galaxy birth). */
  sfrPeakGyr: number;
  /** SFR e-folding time at galactic center (Gyr). */
  sfrTauInner: number;
  /** SFR e-folding time at edge (Gyr). Inside-out: outer τ > inner τ. */
  sfrTauOuter: number;
  /** Gaussian width of the bulge formation burst (Gyr). */
  bulgeBurstWidthGyr: number;
  /** Arm overdensity bias toward young stars. 0 = none; 1 = arms purely young. */
  armYouthBoost: number;

  // ── Metallicity field ───────────────────────────────────────────
  /** Central [Fe/H] today (dex). */
  fehCentral: number;
  /** Radial gradient (dex / ly). Negative for inside-out enrichment. */
  fehGradient: number;
  /** Vertical gradient (dex / ly). Negative; thick disc / halo metal-poor. */
  fehVerticalGradient: number;
  /** Intrinsic scatter (dex). */
  fehScatter: number;
  /** Age-metallicity slope (dex per Gyr of age). Older = more metal-poor. */
  ageMetallicityFactor: number;

  // ── Irregular-galaxy clump field ────────────────────────────────
  /** Optional clump perturbations on top of the disc/bulge density. */
  irregularClumps?: Clump[];
}

/** Default = MW-analog spiral. `sampleGalaxyParams(seed)` in galaxyContext.ts
 *  generates varied galaxies procedurally; this is what you get if you don't
 *  use the sampler. */
export const DEFAULT_GALAXY_PARAMS: GalaxyParams = {
  radius: 50000,
  arms: 4,
  spin: 0.0008,
  armSharpness: 3,
  armStrength: 1.5,
  discScaleR: 15000,
  discScaleZ: 200,
  discDensity: 0.04,
  bulgeScale: 3000,
  bulgeDensity: 0.2,

  type: "spiral",
  galaxyAgeGyr: 12,

  sfrPeakGyr: 3,
  sfrTauInner: 2,
  sfrTauOuter: 6,
  bulgeBurstWidthGyr: 1.0,
  armYouthBoost: 0.7,

  fehCentral: 0.3,
  fehGradient: -2e-5,      // ≈ -0.065 dex/kpc, close to MW
  fehVerticalGradient: -1e-3,
  fehScatter: 0.12,
  ageMetallicityFactor: 0.05,
};

/** Star density at a galactic position, in stars per ly³.
 *
 *  The same formula handles all three galaxy types — the values of
 *  `armStrength`, `discDensity`, and `irregularClumps` determine how each
 *  term contributes:
 *    - Spirals have armStrength > 0 (arms modulate the disc).
 *    - Ellipticals have discDensity = 0, armStrength = 0, inflated bulge.
 *    - Irregulars zero out arms, keep a soft disc, and add clump perturbations.
 */
export function densityAt(p: GalaxyParams, x: number, y: number, z: number): number {
  const r2 = x * x + z * z;
  const r = Math.sqrt(r2);
  const absY = Math.abs(y);
  const r3 = Math.sqrt(r2 + y * y);
  if (r3 > p.radius * 1.2) return 0;

  const bulge = p.bulgeDensity * Math.exp(-r3 / p.bulgeScale);
  const disc = p.discDensity
    * Math.exp(-r / p.discScaleR)
    * Math.exp(-absY / p.discScaleZ);

  // Spiral arm enhancement — only contributes when armStrength > 0.
  let armEnhancement = 0;
  if (p.armStrength > 0) {
    const theta = Math.atan2(z, x);
    const armPhase = p.arms * theta + r * p.spin;
    const armFactor = Math.max(0, Math.cos(armPhase));
    armEnhancement = Math.pow(armFactor, p.armSharpness) * p.armStrength;
  }

  // Irregular clump perturbations — sum of gaussian over-densities.
  let clumpContrib = 0;
  if (p.irregularClumps) {
    for (const c of p.irregularClumps) {
      const dx = x - c.position.x;
      const dy = y - c.position.y;
      const dz = z - c.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      clumpContrib += c.density * Math.exp(-d2 / (2 * c.scale * c.scale));
    }
  }

  return bulge + disc * (1 + armEnhancement) + clumpContrib;
}

// ── Records ─────────────────────────────────────────────────────────────────

export interface StarRecord {
  id: string;
  galacticPosition: THREE.Vector3;
  /** Display color, derived from current T_eff. */
  color: THREE.Color;
  /** Display brightness, log-compressed from luminosity. */
  intrinsic: number;
  /** Physical radius in R_sun. Cached from `resolveStellarState` so the
   *  warp impedance calculation can compute angular size without
   *  re-running the stellar physics every frame. */
  radius: number;
  /** Seed for full system materialization (planets, companions, etc.).
   *  Stable across runs given the same universe seed. */
  systemSeed: number;
  /** Initial mass at formation (M_sun). Stored so system materialization
   *  doesn't need to replay the IMF sample. */
  massInit: number;
  /** Current age (Gyr). */
  age: number;
  /** Metallicity ([Fe/H], dex). */
  feh: number;
}

export interface CellRecord {
  level: number;
  ix: number; iy: number; iz: number;
  /** Cell side length in ly at this level. */
  size: number;
  /** Cell center in galactic coords (ly). */
  center: THREE.Vector3;
  /** Aggregate intrinsic brightness — sum of expected star intrinsics
   *  inside the cell (density × volume × avg-per-star intrinsic). */
  intrinsic: number;
  /** Smudged-blob tint, derived from a position gradient. */
  color: THREE.Color;
  /** Generated stars at leaf level. Null until the cell is expanded. */
  stars: StarRecord[] | null;
}

// ── LOD tier sizes ──────────────────────────────────────────────────────────

export const CELL_SIZES = [5000, 500, 50, 5];
export const MAX_LEVEL = CELL_SIZES.length - 1;

/** Cells with aggregate intrinsic below this are skipped — empty cosmic
 *  void, no contribution to anything. */
const MIN_CELL_INTRINSIC = 0.05;

/** Average per-star intrinsic used to convert density × volume → aggregate
 *  blob brightness. Under physics-based sampling, individual stars span ~0.05
 *  to ~5, with most M dwarfs near the low end and a handful of bright stars
 *  near the high end. The arithmetic mean of the IMF-weighted display
 *  brightness comes out to roughly 0.5; we leave it at 0.65 since the
 *  blob renderer was calibrated against the old palette. Adjust if the
 *  background band looks under/over-saturated. */
const AVG_STAR_INTRINSIC = 0.65;

// ── Hash + RNG ──────────────────────────────────────────────────────────────

/** mulberry32 PRNG. Exported so galaxyContext / system can seed their own
 *  per-sample RNGs deterministically from the universe seed cascade. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of (universeSeed, level, ix, iy, iz) → 32-bit seed.
 *  Used to seed the per-cell RNG so each cell's star generation is stable
 *  across runs and across cache evictions. */
export function hashCell(seed: number, level: number, ix: number, iy: number, iz: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (level + 1), 0xb5297a4d);
  h = Math.imul(h ^ (ix + 0x40000000), 0x9e3779b1);
  h = Math.imul(h ^ (iy + 0x40000000), 0x85ebca6b);
  h = Math.imul(h ^ (iz + 0x40000000), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ── Color palettes ──────────────────────────────────────────────────────────
//
// The per-star color palette is gone — colors now come from physics
// (colorFromTeff in stellar.ts). The aggregate-blob tint stays because the
// L0-L3 smudges don't have individual stars to derive from, so we use the
// classic "inner red / outer blue" gradient.

const HOME_STAR_COLOR = new THREE.Color("#fff1c8");

const TINT_INNER = new THREE.Color("#ffb070");
const TINT_OUTER = new THREE.Color("#a0b8ff");

function fillCellTint(p: GalaxyParams, x: number, y: number, z: number, out: THREE.Color): void {
  const r = Math.sqrt(x * x + z * z);
  const t = Math.min(1, r / p.radius);
  out.copy(TINT_INNER).lerp(TINT_OUTER, t);
}

// ── Universe ────────────────────────────────────────────────────────────────

export interface Universe {
  seed: number;
  params: GalaxyParams;
  cells: Map<string, CellRecord>;
  topCells: CellRecord[];
  homeStar: StarRecord;
}

function cellKey(level: number, ix: number, iy: number, iz: number): string {
  return `${level}|${ix},${iy},${iz}`;
}

export function getOrMakeCell(
  universe: Universe,
  level: number,
  ix: number,
  iy: number,
  iz: number,
): CellRecord {
  const key = cellKey(level, ix, iy, iz);
  let cell = universe.cells.get(key);
  if (cell) return cell;
  const size = CELL_SIZES[level];
  // Hash-jitter the cell centroid by up to ±40% of cell size on each
  // axis. Without this, aggregate blobs render at perfectly-regular
  // positions and the sky shows a visible cubic grid of cells.
  const jitterHash = hashCell(universe.seed, level + 100, ix, iy, iz);
  const jx = (((jitterHash >>>  0) & 0xff) / 255 - 0.5) * 0.8;
  const jy = (((jitterHash >>>  8) & 0xff) / 255 - 0.5) * 0.8;
  const jz = (((jitterHash >>> 16) & 0xff) / 255 - 0.5) * 0.8;
  const cx = (ix + 0.5 + jx) * size;
  const cy = (iy + 0.5 + jy) * size;
  const cz = (iz + 0.5 + jz) * size;
  // Sample density at 8 sub-positions and average to smooth aliasing
  // across arm boundaries and disc edges.
  const half = size * 0.5;
  let dSum = 0;
  for (let dx = 0; dx < 2; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dz = 0; dz < 2; dz++) {
        const sx = cx + (dx === 0 ? -half * 0.5 : half * 0.5);
        const sy = cy + (dy === 0 ? -half * 0.5 : half * 0.5);
        const sz = cz + (dz === 0 ? -half * 0.5 : half * 0.5);
        dSum += densityAt(universe.params, sx, sy, sz);
      }
    }
  }
  const avgDensity = dSum / 8;
  const expectedStars = avgDensity * size * size * size;
  cell = {
    level, ix, iy, iz, size,
    center: new THREE.Vector3(cx, cy, cz),
    intrinsic: expectedStars * AVG_STAR_INTRINSIC,
    color: new THREE.Color(),
    stars: null,
  };
  fillCellTint(universe.params, cx, cy, cz, cell.color);
  universe.cells.set(key, cell);
  return cell;
}

/** Generate individual stars inside a leaf (L4) cell.
 *
 *  Each star gets its own seed (so the system builder can recover the
 *  same physics-roll later), then samples:
 *    1. Initial mass from Kroupa IMF.
 *    2. Age from local SFR field (bulge burst + disc delayed-τ + arms +
 *       clumps), inverse-CDF sampled over the galaxy's lifetime.
 *    3. [Fe/H] from local metallicity field, with age-metallicity bias
 *       and gaussian scatter.
 *  Then `resolveStellarState` computes current phase, L, R, T_eff, color.
 *  Color is set directly from T_eff; `intrinsic` is log-compressed from
 *  luminosity so the existing rendering pipeline's dynamic range still
 *  works (see intrinsicFromLuminosity in stellar.ts).
 *
 *  The star count is unchanged from the previous implementation — Poisson-
 *  ish around the cell's expected star count, with rejection sampling on
 *  position to bias toward high-density sub-regions inside the cell.
 */
export function expandLeafCell(universe: Universe, cell: CellRecord): StarRecord[] {
  if (cell.stars !== null) return cell.stars;
  if (cell.level !== MAX_LEVEL) {
    throw new Error(`expandLeafCell on non-leaf (level ${cell.level})`);
  }
  const p = universe.params;
  const seed = hashCell(universe.seed, cell.level, cell.ix, cell.iy, cell.iz);
  const rng = mulberry32(seed);
  const expected = cell.intrinsic / AVG_STAR_INTRINSIC;
  const noise = (rng() + rng() + rng() - 1.5) * Math.sqrt(Math.max(1, expected));
  const count = Math.max(0, Math.round(expected + noise));
  if (count === 0) {
    cell.stars = [];
    return cell.stars;
  }
  const peakDensity =
    Math.max(0.0001, densityAt(p, cell.center.x, cell.center.y, cell.center.z)) * 4;
  const stars: StarRecord[] = [];
  for (let i = 0; i < count; i++) {
    // Place position via rejection sampling against local density.
    let x = cell.center.x;
    let y = cell.center.y;
    let z = cell.center.z;
    for (let att = 0; att < 6; att++) {
      x = cell.center.x + (rng() - 0.5) * cell.size;
      y = cell.center.y + (rng() - 0.5) * cell.size;
      z = cell.center.z + (rng() - 0.5) * cell.size;
      const localD = densityAt(p, x, y, z);
      if (rng() * peakDensity < localD) break;
    }

    // Per-star physics sampling. The systemSeed is derived from the
    // cell seed; we use a fresh mulberry32 for the physics draws so
    // the same systemSeed reproduces the same (M_init, age, feh) when
    // the system builder later wants to materialize companions/planets.
    const systemSeed = ((seed ^ 0x9e3779b1) + i * 0x85ebca6b) >>> 0;
    const physRng = mulberry32(systemSeed);

    const massInit = sampleIMFMass(physRng);
    const age = sampleAgeAt(p, x, y, z, physRng);
    const feh = sampleMetallicityAt(p, x, y, z, age, physRng);

    const state = resolveStellarState(massInit, age, feh);

    stars.push({
      id: `s_${cell.ix}_${cell.iy}_${cell.iz}_${i}`,
      galacticPosition: new THREE.Vector3(x, y, z),
      color: state.color,
      intrinsic: intrinsicFromLuminosity(state.luminosity),
      radius: state.radius,
      systemSeed,
      massInit,
      age,
      feh,
    });
  }
  cell.stars = stars;
  return stars;
}

// ── Universe generation ─────────────────────────────────────────────────────

export function generateUniverse(
  seed: number,
  params: GalaxyParams = DEFAULT_GALAXY_PARAMS,
): Universe {
  const universe: Universe = {
    seed,
    params,
    cells: new Map(),
    topCells: [],
    homeStar: null as unknown as StarRecord,
  };
  const topSize = CELL_SIZES[0];
  const horizHalf = Math.ceil((params.radius * 1.2) / topSize);
  const vertHalf = Math.max(1, Math.ceil((params.discScaleZ * 6) / topSize));
  for (let ix = -horizHalf; ix <= horizHalf; ix++) {
    for (let iy = -vertHalf; iy <= vertHalf; iy++) {
      for (let iz = -horizHalf; iz <= horizHalf; iz++) {
        const cell = getOrMakeCell(universe, 0, ix, iy, iz);
        if (cell.intrinsic >= MIN_CELL_INTRINSIC) universe.topCells.push(cell);
      }
    }
  }
  injectHomeStar(universe);
  return universe;
}

/** Place a Sun-analog home star at a deterministic point on a spiral arm
 *  (or near the galactic center for non-spirals) and insert it into the
 *  appropriate L4 cell's star list. Fixed physical properties — solar
 *  mass, 4.6 Gyr age, solar metallicity — so the home system is consistent
 *  across seeds. */
function injectHomeStar(universe: Universe): void {
  const p = universe.params;
  let homePos: THREE.Vector3;
  if (p.type === "spiral" && p.armStrength > 0) {
    // On arm 0's peak-density curve at 35% radius.
    const homeR = p.radius * 0.35;
    const homeTheta = -homeR * p.spin / p.arms;
    homePos = new THREE.Vector3(
      homeR * Math.cos(homeTheta),
      0,
      homeR * Math.sin(homeTheta),
    );
  } else {
    // For elliptical / irregular, plant home star a little out from center.
    homePos = new THREE.Vector3(p.radius * 0.15, 0, 0);
  }
  const leafSize = CELL_SIZES[MAX_LEVEL];
  const ix = Math.floor(homePos.x / leafSize);
  const iy = Math.floor(homePos.y / leafSize);
  const iz = Math.floor(homePos.z / leafSize);
  const cell = getOrMakeCell(universe, MAX_LEVEL, ix, iy, iz);
  expandLeafCell(universe, cell);

  // Sun-analog physical properties — these drive system materialization.
  const massInit = 1.0;
  const age = 4.6;
  const feh = 0.0;
  // resolveStellarState would give us the actual color; we override with
  // HOME_STAR_COLOR for visual identifiability. We still want the
  // physical radius though so the warp impedance treats this star like
  // any other when seen from interstellar distances.
  const homeStarState = resolveStellarState(massInit, age, feh);
  const homeStar: StarRecord = {
    id: "home_star",
    galacticPosition: homePos,
    color: HOME_STAR_COLOR.clone(),
    intrinsic: 1.0,
    radius: homeStarState.radius,
    systemSeed: GALAXY.homeSystemSeed,
    massInit,
    age,
    feh,
  };
  cell.stars!.unshift(homeStar);
  universe.homeStar = homeStar;
}

// ── Brightness model ────────────────────────────────────────────────────────

function apparentAt(distLy: number, intrinsic: number): number {
  return intrinsic / (1 + distLy * distLy * 0.04);
}
function apparentToK(apparent: number): number {
  return Math.pow(Math.max(0, apparent), 0.7) * 2.5;
}
const STAR_VIS_K = 0.015;

// ── Projection ──────────────────────────────────────────────────────────────

const EXPAND_FACTOR = 4;
const FADE_FACTOR = 1.6;

export interface GalaxyProjection {
  count: number;
}

const _tmp = new THREE.Vector3();

export function projectGalaxy(
  universe: Universe,
  playerGalactic: THREE.Vector3,
  starfieldRadius: number,
  excludeStarId: string | null,
  outPositions: Float32Array,
  outColors: Float32Array,
  outSizes: Float32Array,
): number {
  let count = 0;
  for (let tier = 0; tier <= MAX_LEVEL; tier++) {
    const size = CELL_SIZES[tier];
    const innerExpand =
      tier === MAX_LEVEL ? 0 : CELL_SIZES[tier + 1] * EXPAND_FACTOR;
    const outerExpand =
      tier === 0 ? Infinity : size * EXPAND_FACTOR;
    const innerFadeEnd = innerExpand * FADE_FACTOR;
    const outerFadeEnd = outerExpand * FADE_FACTOR;

    if (tier === 0) {
      for (const cell of universe.topCells) {
        count = projectCell(
          universe, cell, playerGalactic, starfieldRadius, excludeStarId,
          innerExpand, innerFadeEnd, outerExpand, outerFadeEnd,
          outPositions, outColors, outSizes, count,
        );
      }
    } else {
      const reach = Math.ceil(outerFadeEnd / size) + 1;
      const px = playerGalactic.x, py = playerGalactic.y, pz = playerGalactic.z;
      const ixCenter = Math.floor(px / size);
      const iyCenter = Math.floor(py / size);
      const izCenter = Math.floor(pz / size);
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dz = -reach; dz <= reach; dz++) {
            const ix = ixCenter + dx;
            const iy = iyCenter + dy;
            const iz = izCenter + dz;
            const cx = (ix + 0.5) * size;
            const cy = (iy + 0.5) * size;
            const cz = (iz + 0.5) * size;
            const ddx = cx - px, ddy = cy - py, ddz = cz - pz;
            const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (dist2 > outerFadeEnd * outerFadeEnd) continue;
            const cell = getOrMakeCell(universe, tier, ix, iy, iz);
            if (cell.intrinsic < MIN_CELL_INTRINSIC) continue;
            count = projectCell(
              universe, cell, playerGalactic, starfieldRadius, excludeStarId,
              innerExpand, innerFadeEnd, outerExpand, outerFadeEnd,
              outPositions, outColors, outSizes, count,
            );
          }
        }
      }
    }
  }
  return count;
}

function projectCell(
  universe: Universe,
  cell: CellRecord,
  playerGalactic: THREE.Vector3,
  starfieldRadius: number,
  excludeStarId: string | null,
  innerExpand: number, innerFadeEnd: number,
  outerExpand: number, outerFadeEnd: number,
  outPositions: Float32Array, outColors: Float32Array, outSizes: Float32Array,
  count: number,
): number {
  _tmp.copy(cell.center).sub(playerGalactic);
  const cellDist = _tmp.length();

  let innerWeight = 1;
  if (cellDist < innerExpand) {
    innerWeight = 0;
  } else if (cellDist < innerFadeEnd) {
    innerWeight = (cellDist - innerExpand) / (innerFadeEnd - innerExpand);
  }
  let outerWeight = 1;
  if (cellDist >= outerFadeEnd) {
    outerWeight = 0;
  } else if (cellDist > outerExpand) {
    outerWeight = 1 - (cellDist - outerExpand) / (outerFadeEnd - outerExpand);
  }
  const weight = innerWeight * outerWeight;
  if (weight <= 0) return count;

  if (cell.level === MAX_LEVEL) {
    expandLeafCell(universe, cell);
    const stars = cell.stars!;
    for (const s of stars) {
      if (s.id === excludeStarId) continue;
      _tmp.copy(s.galacticPosition).sub(playerGalactic);
      const distLy = _tmp.length();
      if (distLy < 0.001) continue;
      const k = apparentToK(apparentAt(distLy, s.intrinsic)) * weight;
      if (k < STAR_VIS_K) continue;
      _tmp.divideScalar(distLy);
      const idx = count * 3;
      outPositions[idx + 0] = _tmp.x * starfieldRadius;
      outPositions[idx + 1] = _tmp.y * starfieldRadius;
      outPositions[idx + 2] = _tmp.z * starfieldRadius;
      outColors[idx + 0] = s.color.r * k;
      outColors[idx + 1] = s.color.g * k;
      outColors[idx + 2] = s.color.b * k;
      outSizes[count] = 3.0;
      count++;
    }
    return count;
  }

  if (cellDist < 0.001) return count;
  const k = cell.intrinsic * GALAXY.aggregateIntrinsicScale * weight * GALAXY.aggregateBrightness;
  if (k < 1e-5) return count;
  _tmp.divideScalar(cellDist);
  const idx = count * 3;
  outPositions[idx + 0] = _tmp.x * starfieldRadius;
  outPositions[idx + 1] = _tmp.y * starfieldRadius;
  outPositions[idx + 2] = _tmp.z * starfieldRadius;
  outColors[idx + 0] = cell.color.r * k;
  outColors[idx + 1] = cell.color.g * k;
  outColors[idx + 2] = cell.color.b * k;
  let pix = (cell.size / cellDist) * 2000;
  if (pix < 32) pix = 32;
  if (pix > GALAXY.aggregateMaxSize) pix = GALAXY.aggregateMaxSize;
  outSizes[count] = pix;
  return count + 1;
}

// ── Nearest-star query ──────────────────────────────────────────────────────

export interface NearestStarResult {
  star: StarRecord;
  distanceLy: number;
}

export function findNearestStar(
  universe: Universe,
  galacticPos: THREE.Vector3,
  withinLy = 6,
): NearestStarResult | null {
  const leafSize = CELL_SIZES[MAX_LEVEL];
  const reach = Math.ceil(withinLy / leafSize) + 1;
  const ixCenter = Math.floor(galacticPos.x / leafSize);
  const iyCenter = Math.floor(galacticPos.y / leafSize);
  const izCenter = Math.floor(galacticPos.z / leafSize);
  let bestStar: StarRecord | null = null;
  let bestDist = Infinity;
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const cell = getOrMakeCell(
          universe, MAX_LEVEL,
          ixCenter + dx, iyCenter + dy, izCenter + dz,
        );
        if (cell.intrinsic < MIN_CELL_INTRINSIC) continue;
        expandLeafCell(universe, cell);
        for (const s of cell.stars!) {
          const d = s.galacticPosition.distanceTo(galacticPos);
          if (d < bestDist) {
            bestDist = d;
            bestStar = s;
          }
        }
      }
    }
  }
  if (!bestStar) return null;
  return { star: bestStar, distanceLy: bestDist };
}

// ── Warp impedance from the registry ────────────────────────────────────────
//
// `largestAngularSizeFromRegistry` walks leaf cells around a galactic
// position and returns the maximum angular size (radians) of any star
// within the search radius. Used by warp impedance so interstellar
// flight slows down naturally in dense regions (galactic core, clusters)
// and speeds up in sparse halo/void regions — without needing to
// materialize any system.
//
// Search radius matters: a red supergiant (R ≈ 500 R_sun) ~30 ly away
// already contributes more than ANGULAR_FLOOR. We walk ±3 leaf cells
// (~15 ly radius); beyond that the largest plausible contribution drops
// below 1e-6 rad even for supergiants, and we'd be paying for nothing
// most of the time.

const R_SUN_LY = 6.957e8 / 9.4607304725808e15; // ~7.35e-8 ly per R_sun

export function largestAngularSizeFromRegistry(
  universe: Universe,
  galacticPos: THREE.Vector3,
  excludeStarId: string | null = null,
): number {
  const leafSize = CELL_SIZES[MAX_LEVEL];
  const REACH = 3; // ±3 leaf cells ≈ ±15 ly
  const ixCenter = Math.floor(galacticPos.x / leafSize);
  const iyCenter = Math.floor(galacticPos.y / leafSize);
  const izCenter = Math.floor(galacticPos.z / leafSize);
  let maxAngular = 0;
  for (let dx = -REACH; dx <= REACH; dx++) {
    for (let dy = -REACH; dy <= REACH; dy++) {
      for (let dz = -REACH; dz <= REACH; dz++) {
        const cell = getOrMakeCell(
          universe, MAX_LEVEL,
          ixCenter + dx, iyCenter + dy, izCenter + dz,
        );
        if (cell.intrinsic < MIN_CELL_INTRINSIC) continue;
        expandLeafCell(universe, cell);
        for (const s of cell.stars!) {
          if (excludeStarId !== null && s.id === excludeStarId) continue;
          const distLy = s.galacticPosition.distanceTo(galacticPos);
          const radiusLy = s.radius * R_SUN_LY;
          if (distLy <= radiusLy) return Math.PI; // inside the star
          const ratio = radiusLy / distLy;
          const angular = 2 * Math.asin(Math.min(1, ratio));
          if (angular > maxAngular) maxAngular = angular;
        }
      }
    }
  }
  return maxAngular;
}