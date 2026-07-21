// shared/planet/palettes.ts
//
// Rocky-world colour palettes — ported from seagull-dream's palettes.ts so a
// planet's terrain colour comes from its PHYSICS (temperature, composition,
// ocean, mass), not a single hard-coded earthlike scheme. `paletteFromFeatures`
// (planet-geography.ts) picks one; the terrain renderer (surface.ts) paints
// with it.
//
// Colours are stored as LINEAR-space RGB tuples (the renderer's colour-managed
// working space): seagull authored them as sRGB hex, so we convert sRGB→linear
// here to reproduce its exact look through the ACES/sRGB output pipeline.

import type { PlanetPalette, RGB } from "./surface.js";

/** sRGB hex → linear RGB tuple (matches THREE.Color(hex) under colour mgmt). */
export function hexToLinear(hex: string): RGB {
  const n = parseInt(hex.replace("#", ""), 16);
  const s = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const l = s.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return [l[0], l[1], l[2]];
}

const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const towardWhite = (c: RGB, t: number): RGB => [c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t];

/** Fill a full 6-band PlanetPalette from seagull's partial palettes (barren
 *  worlds omit oceanFloor/grass/forest/snow — derive them so basins/peaks
 *  still read without inventing vegetation on a dead world). */
function fill(p: { oceanFloor?: string; oceanSurface?: string; sand: string; grass?: string; forest?: string; rock: string; snow?: string }): PlanetPalette {
  const sand = hexToLinear(p.sand);
  const rock = hexToLinear(p.rock);
  const oceanFloor = p.oceanFloor ? hexToLinear(p.oceanFloor) : scale(sand, 0.3);
  return {
    oceanFloor,
    // Bright water surface for oceaned worlds; a dark basin tone (= floor) for
    // dry worlds so their basins don't read as blue water.
    oceanSurface: p.oceanSurface ? hexToLinear(p.oceanSurface) : oceanFloor,
    sand,
    grass: p.grass ? hexToLinear(p.grass) : sand,   // no vegetation → dusty land
    forest: p.forest ? hexToLinear(p.forest) : rock,
    rock,
    snow: p.snow ? hexToLinear(p.snow) : towardWhite(rock, 0.6),
  };
}

// Earthlike variants (oceans + grass).
export const EARTHLIKE_BLUE = fill({ oceanFloor: "#274764", oceanSurface: "#2c5b7e", sand: "#e6d49a", grass: "#4f8c3e", forest: "#2e5e2a", rock: "#7a7368", snow: "#f4f4f4" });
export const EARTHLIKE_RED_GRASS = fill({ oceanFloor: "#5e2828", oceanSurface: "#a04848", sand: "#f0c98c", grass: "#c4744a", forest: "#823925", rock: "#6b5e54", snow: "#e8ddd0" });
export const EARTHLIKE_VIOLET_GRASS = fill({ oceanFloor: "#2a2e58", oceanSurface: "#4e4eaa", sand: "#d4c8b0", grass: "#6a4a8c", forest: "#382460", rock: "#807078", snow: "#f0f0f8" });
export const EARTHLIKE_TEAL_OCEAN = fill({ oceanFloor: "#1a4a4e", oceanSurface: "#3da090", sand: "#f0e0a8", grass: "#c8d048", forest: "#6a8830", rock: "#807a6e", snow: "#f4f4f4" });

// Barren variants (no ocean, no vegetation).
export const BARREN_MARS = fill({ sand: "#c87858", rock: "#8a4a30", snow: "#f0d4b8" });
export const BARREN_YELLOW = fill({ sand: "#e8c878", rock: "#8a7038" });
export const BARREN_GRAY = fill({ sand: "#a8a4a0", rock: "#605c58", snow: "#dad6d0" });
export const BARREN_BROWN = fill({ sand: "#a08060", rock: "#604834", snow: "#d4b890" });
export const BARREN_DARK = fill({ sand: "#604c48", rock: "#302828" });
export const ICE_WORLD = fill({ sand: "#c8d8e8", rock: "#8898a8", snow: "#f4f8ff" });
export const MOON_PALETTE = fill({ sand: "#9a9590", rock: "#605c58" });

export const EARTHLIKE_VARIANTS: ReadonlyArray<PlanetPalette> = [
  EARTHLIKE_BLUE, EARTHLIKE_RED_GRASS, EARTHLIKE_VIOLET_GRASS, EARTHLIKE_TEAL_OCEAN,
];
export const BARREN_VARIANTS: ReadonlyArray<PlanetPalette> = [BARREN_MARS, BARREN_GRAY, BARREN_BROWN];

/** Named presets, so a planet doc can pin a palette by name if it wants. */
export const PLANET_PALETTES: Record<string, PlanetPalette> = {
  earthlike: EARTHLIKE_BLUE, earthlike_red: EARTHLIKE_RED_GRASS, earthlike_violet: EARTHLIKE_VIOLET_GRASS,
  earthlike_teal: EARTHLIKE_TEAL_OCEAN, mars: BARREN_MARS, yellow: BARREN_YELLOW, gray: BARREN_GRAY,
  brown: BARREN_BROWN, dark: BARREN_DARK, ice: ICE_WORLD, moon: MOON_PALETTE,
};
