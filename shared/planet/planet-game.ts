/**
 * The PLANET scope builder — the composition helper that turns a world
 * document's `game` settings (scope: "planet") into a living planet:
 *
 *   world JSON → cube-sphere lattice → sphere tectonics (a baked, causal
 *   terrain history) → settled substrate (rivers, fertility, wild crowds,
 *   founding candidates) → a PlanetSurface the quadtree renderer draws.
 *
 * Validation follows the module law: the manifest kernel gated the SHAPE
 * of `game`; this builder owns the deep validation of the planet-scoped
 * `world` object — unknown fields and out-of-range numbers are path-exact
 * refusals, never skips.
 *
 * The founding candidates ride along in the result: they are tomorrow's
 * `initial_focus` targets (focus a town = focus a site) and today's lab
 * readout. Deterministic end to end — same document, same planet.
 */
import type { GameSettings } from "../engine/manifest";
import { makeCubeSphereTopology, type GridTopology } from "../engine/cells/topology";
import type { CellGrid, FoundingSite } from "../engine/cells/index";
import { resolveSiteFocus, type SiteFocus } from "../engine/cells/site-focus";
import { runSphereTectonics, type SphereTectonicWorld, type TectonicFrame } from "../engine/geology/sphere-tectonics";
import { bakeCellAuthors } from "../engine/geology/sphere-tectonics";
import { SEA_HEIGHT } from "../engine/geology/tectonics";
import { prepareSubstrateOn } from "../engine/civ/tri";
import { substrateSurface, type PlanetSurface, type PlanetPalette, type RGB } from "./surface";
import { EARTHLIKE_BLUE, hexToLinear } from "./palettes";

export interface PlanetWorldSpec {
  topology: { kind: "cube-sphere"; faceN: number };
  geology: {
    seed: number;
    epochs: number;
    plates?: number;
    continentR?: number;
    hotspots?: number;
  };
  /** Mature the substrate after baking (rivers carve, fertility greens,
   *  wild crowds pool — what the civ layer founds on). Default true. */
  settle: boolean;
  /** Climate knob: multiplies the substrate's rain sources (default 1). */
  rain: number;
  /** Planet radius in render units (default 2000). */
  radius: number;
  /** Max mountain elevation as a fraction of the radius (default 0.005 —
   *  the renderer's honest silhouette default; NOT exaggerated. Worlds
   *  that want drama opt in explicitly). */
  relief: number;
  /** Sub-cell surface-detail amplitude (surface.ts `detail`; default 0.6). */
  detail: number;
  /** Terrain colour bands. Omitted = earthlike; solar-system planets get one
   *  derived from their physics (Mars red, Moon grey, ice white, …). */
  palette?: PlanetPalette;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, `must be a number (${min}..${max})`);
  if (v < min || v > max) fail(path, `out of range (${min}..${max})`);
  return v;
}

/** Deep gate for a planet-scoped `world` object. */
export function parsePlanetWorld(raw: unknown, path: string): PlanetWorldSpec {
  if (!isObj(raw)) fail(path, "expected an object (the planet definition)");
  for (const k of Object.keys(raw)) {
    if (!["topology", "geology", "settle", "rain", "radius", "relief", "detail", "palette"].includes(k)) {
      fail(`${path}.${k}`, "unknown field (allowed: topology, geology, settle, rain, radius, relief, detail, palette)");
    }
  }

  let faceN = 24;
  if ("topology" in raw) {
    const t = raw.topology;
    if (!isObj(t)) fail(`${path}.topology`, "expected an object");
    for (const k of Object.keys(t)) {
      if (!["kind", "faceN"].includes(k)) fail(`${path}.topology.${k}`, "unknown field (allowed: kind, faceN)");
    }
    if (t.kind !== "cube-sphere") {
      fail(`${path}.topology.kind`, `a planet is a curved lattice — expected "cube-sphere" (icosahedral hex will join it)`);
    }
    if ("faceN" in t) {
      faceN = num(t.faceN, `${path}.topology.faceN`, 2, 128);
      if (!Number.isInteger(faceN)) fail(`${path}.topology.faceN`, "must be an integer");
    }
  }

  let seed = 1;
  let epochs = 350;
  let plates: number | undefined;
  let continentR: number | undefined;
  let hotspots: number | undefined;
  if ("geology" in raw) {
    const g = raw.geology;
    if (!isObj(g)) fail(`${path}.geology`, "expected an object");
    for (const k of Object.keys(g)) {
      if (!["seed", "epochs", "plates", "continentR", "hotspots"].includes(k)) {
        fail(`${path}.geology.${k}`, "unknown field (allowed: seed, epochs, plates, continentR, hotspots)");
      }
    }
    if ("seed" in g) seed = num(g.seed, `${path}.geology.seed`, 0, Number.MAX_SAFE_INTEGER);
    if ("epochs" in g) epochs = num(g.epochs, `${path}.geology.epochs`, 0, 5000);
    if ("plates" in g) plates = num(g.plates, `${path}.geology.plates`, 2, 32);
    if ("continentR" in g) continentR = num(g.continentR, `${path}.geology.continentR`, 0.05, 1.5);
    if ("hotspots" in g) hotspots = num(g.hotspots, `${path}.geology.hotspots`, 0, 64);
  }

  let settle = true;
  if ("settle" in raw) {
    if (typeof raw.settle !== "boolean") fail(`${path}.settle`, "must be true or false");
    settle = raw.settle;
  }
  const rain = "rain" in raw ? num(raw.rain, `${path}.rain`, 0, 10) : 1;
  const radius = "radius" in raw ? num(raw.radius, `${path}.radius`, 1, 1e9) : 2000;
  const relief = "relief" in raw ? num(raw.relief, `${path}.relief`, 0.001, 0.2) : 0.005;
  const detail = "detail" in raw ? num(raw.detail, `${path}.detail`, 0, 5) : 0.6;
  const palette = "palette" in raw ? parsePalette(raw.palette, `${path}.palette`) : undefined;

  return {
    topology: { kind: "cube-sphere", faceN },
    geology: { seed, epochs, ...(plates !== undefined ? { plates } : {}), ...(continentR !== undefined ? { continentR } : {}), ...(hotspots !== undefined ? { hotspots } : {}) },
    settle, rain, radius, relief, detail, ...(palette ? { palette } : {}),
  };
}

/** A terrain palette in the spec: each of the 6 bands is a "#rrggbb" hex or an
 *  [r,g,b] linear tuple; omitted bands fall back to the earthlike scheme. */
function parsePalette(raw: unknown, path: string): PlanetPalette {
  if (!isObj(raw)) fail(path, "expected an object of colour bands");
  const bands = ["oceanFloor", "oceanSurface", "sand", "grass", "forest", "rock", "snow"] as const;
  for (const k of Object.keys(raw)) {
    if (!(bands as readonly string[]).includes(k)) fail(`${path}.${k}`, `unknown band (allowed: ${bands.join(", ")})`);
  }
  const band = (v: unknown, p: string): RGB => {
    if (typeof v === "string") {
      if (!/^#?[0-9a-fA-F]{6}$/.test(v)) fail(p, 'must be a "#rrggbb" hex string');
      return hexToLinear(v);
    }
    if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number")) {
      return [num(v[0], `${p}[0]`, 0, 1), num(v[1], `${p}[1]`, 0, 1), num(v[2], `${p}[2]`, 0, 1)];
    }
    fail(p, 'must be a "#rrggbb" hex or an [r,g,b] tuple (0..1)');
  };
  const out = { ...EARTHLIKE_BLUE };
  for (const k of bands) if (k in raw) (out as Record<string, RGB>)[k] = band((raw as Record<string, unknown>)[k], `${path}.${k}`);
  return out;
}

/** Founding scan used for the candidate readout (and, later, town-focus
 *  resolution) — the acceptance worlds' proportions. */
const PLANET_FOUNDING = { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 };

export interface BuiltPlanet {
  spec: PlanetWorldSpec;
  topo: GridTopology;
  /** The settled substrate — the same grid a civ layer would found on. */
  grid: CellGrid;
  /** Founding candidates on the settled substrate (empty when unsettled). */
  sites: FoundingSite[];
  geology: { world: SphereTectonicWorld; frames: TectonicFrame[] };
  surface: PlanetSurface;
}

/** Build the planet a `scope: "planet"` game plays in. */
export function buildPlanetWorld(game: GameSettings, label = "game"): BuiltPlanet {
  if (game.scope !== "planet") {
    fail(`${label}.scope`, `buildPlanetWorld builds "planet" games (got "${game.scope}")`);
  }
  const spec = parsePlanetWorld(game.world, `${label}.world`);

  const topo = makeCubeSphereTopology(spec.topology.faceN);
  const geology = runSphereTectonics({
    topo,
    seed: spec.geology.seed,
    epochs: spec.geology.epochs,
    plates: spec.geology.plates,
    continentR: spec.geology.continentR,
    hotspots: spec.geology.hotspots,
  });
  const authors = bakeCellAuthors(geology.world);

  const prep = prepareSubstrateOn({
    topology: { kind: "cube-sphere", faceN: spec.topology.faceN },
    height: authors.height,
    ore: authors.ore,
    founding: PLANET_FOUNDING,
    settle: spec.settle,
    rain: spec.rain,
  });

  const surface = substrateSurface({
    substrate: prep.grid,
    radius: spec.radius,
    maxElevation: spec.relief * spec.radius,
    seaHeight: SEA_HEIGHT,
    seed: spec.geology.seed,
    detail: spec.detail,
    palette: spec.palette,
  });

  return { spec, topo, grid: prep.grid, sites: spec.settle ? prep.sites : [], geology, surface };
}

// --- initial_focus -------------------------------------------------------------

export type PlanetFocus = SiteFocus;

/** Resolve a planet game's `initial_focus` against the built world —
 *  planet focus targets are the founding sites the settled substrate
 *  proposed (the generic site-focus contract, cells/site-focus.ts). */
export function resolvePlanetFocus(
  built: BuiltPlanet,
  focus: GameSettings["initialFocus"],
  label = "game",
): PlanetFocus | null {
  return resolveSiteFocus(built.grid, built.sites, focus, label);
}
