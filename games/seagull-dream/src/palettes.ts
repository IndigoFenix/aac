import * as THREE from "three";

// Visual palette for a rocky body. Drives both the terrain color ramp and
// the per-body sky color (read by createSky from ctx.dominant).
//
// Optional fields control terrain shape:
//   - oceanFloor / oceanSurface defined → planet has a water ocean shell;
//     undefined → barren, sub-sea-level terrain renders as exposed rock.
//   - grass / forest defined → vegetated mid-altitude band; undefined →
//     barren, mid-altitude blends from sand straight into rock.
//   - snow defined → high-altitude snow caps; undefined → just rock at the peaks.

export interface RockyPalette {
  oceanFloor?: THREE.Color;
  oceanSurface?: THREE.Color;
  sand: THREE.Color;
  grass?: THREE.Color;
  forest?: THREE.Color;
  rock: THREE.Color;
  snow?: THREE.Color;
  skyDay: THREE.Color;
  skyNight: THREE.Color;
}

const c = (hex: string) => new THREE.Color(hex);

// ── Earthlike palettes (have oceans + grass) ────────────────────────────────

export const EARTHLIKE_BLUE: RockyPalette = {
  oceanFloor: c("#274764"),
  oceanSurface: c("#2c5b7e"),
  sand: c("#e6d49a"),
  grass: c("#4f8c3e"),
  forest: c("#2e5e2a"),
  rock: c("#7a7368"),
  snow: c("#f4f4f4"),
  skyDay: c("#87ceeb"),
  skyNight: c("#070b1c"),
};

export const EARTHLIKE_RED_GRASS: RockyPalette = {
  oceanFloor: c("#5e2828"),
  oceanSurface: c("#a04848"),
  sand: c("#f0c98c"),
  grass: c("#c4744a"),
  forest: c("#823925"),
  rock: c("#6b5e54"),
  snow: c("#e8ddd0"),
  skyDay: c("#f1a874"),
  skyNight: c("#1a0a06"),
};

export const EARTHLIKE_VIOLET_GRASS: RockyPalette = {
  oceanFloor: c("#2a2e58"),
  oceanSurface: c("#4e4eaa"),
  sand: c("#d4c8b0"),
  grass: c("#6a4a8c"),
  forest: c("#382460"),
  rock: c("#807078"),
  snow: c("#f0f0f8"),
  skyDay: c("#c8a8e0"),
  skyNight: c("#0a0410"),
};

export const EARTHLIKE_TEAL_OCEAN: RockyPalette = {
  oceanFloor: c("#1a4a4e"),
  oceanSurface: c("#3da090"),
  sand: c("#f0e0a8"),
  grass: c("#c8d048"),
  forest: c("#6a8830"),
  rock: c("#807a6e"),
  snow: c("#f4f4f4"),
  skyDay: c("#a8e0d8"),
  skyNight: c("#031218"),
};

// ── Barren palettes (no ocean, no vegetation) ───────────────────────────────

export const BARREN_MARS: RockyPalette = {
  sand: c("#c87858"),
  rock: c("#8a4a30"),
  snow: c("#f0d4b8"),
  skyDay: c("#d4906a"),
  skyNight: c("#1c0a04"),
};

export const BARREN_YELLOW: RockyPalette = {
  sand: c("#e8c878"),
  rock: c("#8a7038"),
  skyDay: c("#e0b870"),
  skyNight: c("#180c04"),
};

export const BARREN_GRAY_PLANET: RockyPalette = {
  sand: c("#a8a4a0"),
  rock: c("#605c58"),
  snow: c("#dad6d0"),
  skyDay: c("#807c78"),
  skyNight: c("#0a0a0c"),
};

export const BARREN_BROWN: RockyPalette = {
  sand: c("#a08060"),
  rock: c("#604834"),
  snow: c("#d4b890"),
  skyDay: c("#b89878"),
  skyNight: c("#120804"),
};

export const BARREN_DARK: RockyPalette = {
  sand: c("#604c48"),
  rock: c("#302828"),
  skyDay: c("#4a3838"),
  skyNight: c("#040202"),
};

export const ICE_WORLD: RockyPalette = {
  sand: c("#c8d8e8"),
  rock: c("#8898a8"),
  snow: c("#f4f8ff"),
  skyDay: c("#b8d0e8"),
  skyNight: c("#08101c"),
};

// ── Moon palette ────────────────────────────────────────────────────────────
// Always used for moons regardless of parent. Slight contrast between
// sand (regolith highlights) and rock (mare lowlands), no atmosphere so
// the sky stays nearly black even at noon.

export const MOON_PALETTE: RockyPalette = {
  sand: c("#9a9590"),
  rock: c("#605c58"),
  skyDay: c("#0a0a0e"),
  skyNight: c("#000004"),
};

// ── Catalogs + picker ───────────────────────────────────────────────────────

const EARTHLIKE_VARIANTS: ReadonlyArray<RockyPalette> = [
  EARTHLIKE_BLUE,
  EARTHLIKE_RED_GRASS,
  EARTHLIKE_VIOLET_GRASS,
  EARTHLIKE_TEAL_OCEAN,
];

const BARREN_VARIANTS: ReadonlyArray<RockyPalette> = [
  BARREN_MARS,
  BARREN_YELLOW,
  BARREN_GRAY_PLANET,
  BARREN_BROWN,
  BARREN_DARK,
  ICE_WORLD,
];

function pick<T>(rng: () => number, arr: ReadonlyArray<T>): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Pick a random rocky-planet palette. Most planets are barren; a smaller
 * minority are earthlike (with ocean + vegetation).
 */
export function pickRandomRockyPalette(rng: () => number, earthlikeChance = 0.3): RockyPalette {
  return rng() < earthlikeChance ? pick(rng, EARTHLIKE_VARIANTS) : pick(rng, BARREN_VARIANTS);
}
