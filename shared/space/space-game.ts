/**
 * The GALAXY and SOLAR_SYSTEM scope builders — the top two rungs of the
 * scope ladder, over the migrated seagull-dream space chain (galaxy.ts:
 * on-demand hierarchical star cells; stellar.ts: real stellar physics;
 * solar.ts: the compact system model).
 *
 * Focus targets:
 *   galaxy       — STARS near home: `"home"`, `"star:<rank>"` (by distance
 *                  from the home star), or `{ type: "star" }` (the nearest);
 *   solar_system — PLANETS: `"planet:<index>"`, or `{ type: "planet",
 *                  kind?: "rocky" | "gas" | "ice" }` (first match, sunward
 *                  out).
 *
 * A focused star descends into its system (its systemSeed + stellar state
 * ARE the system); a focused rocky/ice planet descends into the planet
 * scope (its seed IS the geology seed). Validation follows the module law:
 * path-exact, reject-never-skip.
 */
import type { GameSettings } from "../engine/manifest";
import {
  generateUniverse, expandLeafCell, getOrMakeCell, CELL_SIZES,
  type Universe, type StarRecord, type GalaxyParams, DEFAULT_GALAXY_PARAMS,
} from "./galaxy";
import { sampleGalaxyParams } from "./galaxy-context";
import { generateSystem, type SolarSystemModel, type SystemPlanet, type PlanetKind } from "./solar";

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

// ── Galaxy ──────────────────────────────────────────────────────────────────

export interface GalaxyWorldSpec {
  seed: number;
}

export function parseGalaxyWorld(raw: unknown, path: string): GalaxyWorldSpec {
  if (!isObj(raw)) fail(path, "expected an object (the galaxy definition)");
  for (const k of Object.keys(raw)) {
    if (!["seed"].includes(k)) fail(`${path}.${k}`, "unknown field (allowed: seed)");
  }
  const seed = "seed" in raw ? num(raw.seed, `${path}.seed`, 0, Number.MAX_SAFE_INTEGER) : 1;
  return { seed };
}

export interface BuiltGalaxy {
  spec: GalaxyWorldSpec;
  params: GalaxyParams;
  universe: Universe;
  /** Focusable stars: home first, then its leaf-cell neighbourhood by
   *  distance from home — the rank behind "star:<n>". */
  stars: StarRecord[];
}

export function buildGalaxyWorld(game: GameSettings, label = "game"): BuiltGalaxy {
  if (game.scope !== "galaxy") {
    fail(`${label}.scope`, `buildGalaxyWorld builds "galaxy" games (got "${game.scope}")`);
  }
  const spec = parseGalaxyWorld(game.world, `${label}.world`);
  const params = spec.seed === 0 ? DEFAULT_GALAXY_PARAMS : sampleGalaxyParams(spec.seed);
  const universe = generateUniverse(spec.seed, params);

  // The focusable neighbourhood: every star in the home star's leaf cell
  // and the 26 surrounding leaves, ranked by distance from home.
  const home = universe.homeStar;
  const leaf = CELL_SIZES.length - 1;
  const size = CELL_SIZES[leaf];
  const hx = Math.floor(home.galacticPosition.x / size);
  const hy = Math.floor(home.galacticPosition.y / size);
  const hz = Math.floor(home.galacticPosition.z / size);
  const stars: StarRecord[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = getOrMakeCell(universe, leaf, hx + dx, hy + dy, hz + dz);
        for (const s of expandLeafCell(universe, cell)) stars.push(s);
      }
    }
  }
  stars.sort((a, b) =>
    a.galacticPosition.distanceToSquared(home.galacticPosition) -
    b.galacticPosition.distanceToSquared(home.galacticPosition));
  // Home is rank 0 by construction (distance 0); keep the list bounded.
  return { spec, params, universe, stars: stars.slice(0, 200) };
}

export interface GalaxyFocus {
  rank: number;
  star: StarRecord;
}

export function resolveGalaxyFocus(
  built: BuiltGalaxy,
  focus: GameSettings["initialFocus"],
  label = "game",
): GalaxyFocus | null {
  if (focus === null) return null;
  const at = `${label}.initial_focus`;
  if (typeof focus === "string") {
    if (focus === "home") return { rank: 0, star: built.universe.homeStar };
    const m = /^star:(\d+)$/.exec(focus);
    if (!m) fail(at, `unknown object ID "${focus}" (galaxy IDs: "home", "star:<rank>")`);
    const rank = Number(m[1]);
    if (rank >= built.stars.length) {
      fail(at, `"${focus}" — only ${built.stars.length} stars in the focusable neighbourhood`);
    }
    return { rank, star: built.stars[rank] };
  }
  for (const k of Object.keys(focus)) {
    if (!["type"].includes(k)) fail(`${at}.${k}`, "unknown parameter (allowed: type)");
  }
  if ("type" in focus && focus.type !== "star") {
    fail(`${at}.type`, `a galaxy focuses stars (expected "star")`);
  }
  return { rank: 0, star: built.stars[0] ?? built.universe.homeStar };
}

// ── Solar system ────────────────────────────────────────────────────────────

export interface SolarWorldSpec {
  seed: number;
  /** Pin the star (descending from a galaxy passes its record) — absent,
   *  the seed samples one. */
  star?: { massInit: number; age: number; feh: number };
}

export function parseSolarWorld(raw: unknown, path: string): SolarWorldSpec {
  if (!isObj(raw)) fail(path, "expected an object (the system definition)");
  for (const k of Object.keys(raw)) {
    if (!["seed", "star"].includes(k)) fail(`${path}.${k}`, "unknown field (allowed: seed, star)");
  }
  const seed = "seed" in raw ? num(raw.seed, `${path}.seed`, 0, Number.MAX_SAFE_INTEGER) : 1;
  let star: SolarWorldSpec["star"];
  if ("star" in raw) {
    const s = raw.star;
    if (!isObj(s)) fail(`${path}.star`, "expected an object");
    for (const k of Object.keys(s)) {
      if (!["massInit", "age", "feh"].includes(k)) {
        fail(`${path}.star.${k}`, "unknown field (allowed: massInit, age, feh)");
      }
    }
    star = {
      massInit: num(s.massInit, `${path}.star.massInit`, 0.05, 150),
      age: num(s.age, `${path}.star.age`, 0, 14),
      feh: "feh" in s ? num(s.feh, `${path}.star.feh`, -3, 1) : 0,
    };
  }
  return { seed, ...(star ? { star } : {}) };
}

export interface BuiltSolarSystem {
  spec: SolarWorldSpec;
  system: SolarSystemModel;
}

export function buildSolarWorld(game: GameSettings, label = "game"): BuiltSolarSystem {
  if (game.scope !== "solar_system") {
    fail(`${label}.scope`, `buildSolarWorld builds "solar_system" games (got "${game.scope}")`);
  }
  const spec = parseSolarWorld(game.world, `${label}.world`);
  return { spec, system: generateSystem(spec.seed, spec.star ? { star: spec.star } : {}) };
}

export interface SolarFocus {
  planet: SystemPlanet;
}

export function resolveSolarFocus(
  built: BuiltSolarSystem,
  focus: GameSettings["initialFocus"],
  label = "game",
): SolarFocus | null {
  if (focus === null) return null;
  const at = `${label}.initial_focus`;
  const planets = built.system.planets;
  if (typeof focus === "string") {
    const m = /^planet:(\d+)$/.exec(focus);
    if (!m) fail(at, `unknown object ID "${focus}" (system IDs: "planet:<index>")`);
    const i = Number(m[1]);
    if (i >= planets.length) fail(at, `"${focus}" — this system has ${planets.length} planets`);
    return { planet: planets[i] };
  }
  for (const k of Object.keys(focus)) {
    if (!["type", "kind"].includes(k)) fail(`${at}.${k}`, "unknown parameter (allowed: type, kind)");
  }
  if ("type" in focus && focus.type !== "planet") {
    fail(`${at}.type`, `a system focuses planets (expected "planet")`);
  }
  let kind: PlanetKind | undefined;
  if ("kind" in focus) {
    if (focus.kind !== "rocky" && focus.kind !== "gas" && focus.kind !== "ice") {
      fail(`${at}.kind`, `must be "rocky", "gas" or "ice"`);
    }
    kind = focus.kind;
  }
  for (const p of planets) {
    if (kind && p.kind !== kind) continue;
    return { planet: p };
  }
  fail(at, `no planet matches (this system has ${planets.length})`);
}
