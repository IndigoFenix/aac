/**
 * planet-scope.ts — THE BOOT OF A PLANET WORLD, AS ONE ENGINE DEFINITION.
 *
 * ⚖️ THE USER'S LAW (2026-09-10): *"Why can't text mode boot a planet world
 * with cities streamed as partners? Text mode isn't supposed to be different
 * from visual mode except for the visual rendering."*
 *
 * Founding a homestead on a real planet used to be an APPLICATION procedure:
 * `games/world-lab/src/main.ts` picked the forest cell, deposited the kit,
 * measured the charter, sampled climate/biome/ecology, founded the cities,
 * laid the roads and projected the trade partners into town coordinates — all
 * in the browser, all beside a THREE scene. Headless mode therefore could not
 * boot that world at all: `text-quest.ts` carried four HAND-WRITTEN CONSTANTS
 * pretending to be a planet cell, and they described a temperate wood that
 * does not exist anywhere on the world the browser actually bakes.
 *
 * So the whole boot lives here, once, DOM-free and THREE-free, and both
 * clients call it: the browser for what it draws, text mode for what it says.
 * Nothing in this file renders; nothing in it is new. Every step is the app's
 * own line, moved (the line references are to `main.ts` as of this round).
 *
 * THE THREE PRODUCERS OF ONE RECORD (`SiteEnvironment`):
 *   ① `measuredEnvironment` — read off a baked substrate (this file: the
 *      planet arm; S3b's region arm shares it through `SurfaceMetric`);
 *   ② `declaredEnvironment` — read off a town DOCUMENT that carries the
 *      record as fields (the declared-cell document, S2);
 *   ③ the region producer (S3b).
 * One shape, so a host wires its seats once: `climate` twice (the books and
 * the live farm), `biome`/`eco` through the wilderness mix, `partners`
 * through `deps.tradePartners`.
 *
 * Pure + deterministic: same document ⇒ same record, every process.
 */
import type { GameSettings } from "../../kernel/manifest.js";
import type { CellGrid } from "../../kernel/cells/grid.js";
import type { ClimateSample } from "../../products.js";
import type { WorldScaleSpec } from "../../scale.js";
import { resolveWorldScale } from "../../scale.js";
import type { PartnerGeography } from "../../kernel/town/barter.js";
import {
  generateUniverse, GALAXY, DEFAULT_GALAXY_PARAMS,
} from "../../space/galaxy.js";
import {
  buildHomeBlueprint, materializeSystem, resolveSystem, type ResolvedBody,
} from "../../space/physics/index.js";
import { buildPlanetGeography } from "../../space/planet-geography.js";
import { parseSolarWorld } from "../../space/space-game.js";
import type { BuiltPlanet } from "../../planet/planet-game.js";
import {
  planetCities, citiesOn, charterBoxAt, charterReachCells, type PlanetCity,
} from "../../planet/cities.js";
import { planetStates, statesOn, statePairs, type PlanetStates } from "../../planet/states.js";
import { planetRoutes, routesOn, type PlanetRoute } from "../../planet/routes.js";
import { climateSampleAt, ecoAbundanceAt } from "../../planet/ecology.js";
import { SEA_HEIGHT } from "../../kernel/geology/tectonics.js";
import {
  sphereMetric, sphereGeometry, tangentFrameAt,
  type SurfaceMetric, type SettledWorld, type Vec3,
} from "../../planet/surface-metric.js";
import { buildRegionWorld, type BuiltRegion } from "../../kernel/civ/region-game.js";
import { wildMixForBiome, type WildMixEntry } from "../quest/wilderness.js";
import {
  createFoundedSite, foundSite, siteTownConfig,
  type FoundedSite, type SerializedFoundedSite,
} from "./founding.js";
import type { TownPlayConfig } from "./town-play.js";
import { buildTownScopeFromConfig, type BuiltTownScope } from "./town-play-game.js";

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

// ⚖️ `SurfaceMetric` (+ `sphereMetric`/`tangentFrameAt`/`sphereGeometry`) MOVED
// to `planet/surface-metric.ts` (planet-boot round S3b) — the seam a flat
// region's `planeMetric` sits beside. Re-exported here so every existing
// import (`main.ts`, both jest/vitest suites) keeps resolving unchanged.
export { sphereMetric, tangentFrameAt, sphereGeometry };
export type { SurfaceMetric };

// ── THE RECORD ───────────────────────────────────────────────────────────────

/**
 * WHAT THE GROUND UNDER A SETTLEMENT SAYS — one record, three producers.
 *
 * This is exactly what a host needs to boot a settlement that stands
 * SOMEWHERE: what grows (`climate`), what kind of country it is (`biome`,
 * `eco`), what the land is worth (`charter`), and who else is out there
 * (`partners`). `ground` is the one optional half, because only a client with
 * a real terrain surface under it can answer it.
 */
export interface SiteEnvironment {
  /** The founding cell's climate sample (products.ts) — the books AND the
   *  live farm read this one expression. */
  climate: ClimateSample;
  /** `fields.biome` index: 0 barren, then DEFAULT_BIOSPHERE order (1 forest,
   *  2 steppe/meadow, 3 grazer range). NEVER `plan.biome` (a land-use label). */
  biome: number;
  /** Per-species abundance at the cell, 0..1 (`ecoAbundanceAt`). `{}` when
   *  the substrate carries no per-species ecology. */
  eco: Record<string, number>;
  /** The charter box the settlement measures — its endowment. */
  charter: { farmland: number; ore_access: number; timberland: number };
  /** The nearest cities as BOOT-SUPPLIED trade partners, in the settlement's
   *  own sim coordinates, nearest first. `distanceM` is the INCIDENT ROAD's
   *  length where the net joins the two, else the great-circle chord — trade
   *  prices the road, not the line of sight. */
  partners: Array<{ key: string; at: { x: number; y: number }; geo: PartnerGeography; distanceM: number }>;
  /** The terrain samplers, when the producer has a surface (the browser's
   *  anchored layer). Omitted headless — the ground seam is flat there. */
  ground?: { groundAt(x: number, y: number): number; waterAt(x: number, y: number): boolean };
}

/** The whole boot of a planet world, as one value. */
export interface PlanetScope {
  built: BuiltPlanet;
  body: { id: string; radiusM: number; dir: [number, number, number]; surfaceR: number };
  /** The per-body geology seed the substrate was baked from. */
  geologySeed: number;
  /** THE PARITY PIN: FNV-1a over the substrate's own fields. Two producers
   *  that agree on this agree about the planet. */
  checksum: string;
  site: FoundedSite;
  /** The LATTICE cell the site stands on (12755 on the frontier planet). The
   *  app's synthetic beacon key (`FOUNDED_CELL_BASE + seed`) stays app-side —
   *  a synthetic id is not a field index (see `measuredEnvironment`). */
  cell: number;
  env: SiteEnvironment;
  cities: PlanetCity[];
  states: PlanetStates;
  pairs: Array<[number, number]>;
  routes: PlanetRoute[];
  /** The scatter mix the countryside wakes up with — `wildMixForBiome` on the
   *  MEASURED cell, the browser's exact call. */
  wildMix: WildMixEntry[];
  townConfig: TownPlayConfig;
  /** The town scope a host plays — the same `{spec, play, focus}` shape
   *  `buildTownScope` returns, so text mode's steps run unchanged. */
  scope: BuiltTownScope;
}

// ── The parity checksum ──────────────────────────────────────────────────────

/** The substrate fields the checksum covers — the ground a settlement reads. */
const CHECKSUM_FIELDS = ["height", "biome", "fertility", "ore", "rain", "tempC", "plant"] as const;

/**
 * FNV-1a over the settled substrate's own fields — the number that says two
 * producers baked THE SAME PLANET.
 *
 * Values are taken at 1e-6 and fed low half then high half, so an integer
 * field and a float field hash the same way and a bake that moves a
 * temperature by a millionth of a degree shows up. A field the substrate does
 * not carry contributes nothing (an unclimated grid is a different world, and
 * its other fields already say so).
 */
export function planetChecksum(grid: CellGrid): string {
  let h = 0x811c9dc5 >>> 0;
  for (const name of CHECKSUM_FIELDS) {
    const arr = grid.fields[name];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.round(arr[i]! * 1e6) | 0;
      h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
      h = Math.imul(h ^ ((v >>> 16) & 0xffff), 0x01000193) >>> 0;
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── The environment, measured ────────────────────────────────────────────────

/** ⚖️ WHAT A DISTANT CITY'S GROUND SAYS IT CAN SELL — the founding scan's own
 *  verdict, forwarded verbatim (main.ts `cityPartnerGeography`). Nothing is
 *  computed here; "geography chooses" simply reaches the scarcity proxy the
 *  barter clerk quotes from. */
export function partnerGeographyOf(city: PlanetCity): PartnerGeography {
  return { node: city.node?.type ?? null, farmland: city.charter?.farmland, ore: city.charter?.ore_access };
}

/** The routes incident to each endpoint cell — built once per measurement so
 *  the partner scan is a lookup, not a scan per row. */
function routesByCell(routes: readonly PlanetRoute[]): Map<number, PlanetRoute[]> {
  const out = new Map<number, PlanetRoute[]>();
  const push = (cell: number, r: PlanetRoute): void => {
    const list = out.get(cell);
    if (list) list.push(r); else out.set(cell, [r]);
  };
  for (const r of routes) { push(r.a, r); push(r.b, r); }
  return out;
}

/** How many partner rows a settlement boots with (`nearbyCityPartners` maxN). */
const PARTNER_ROWS = 3;

/**
 * ⚖️ THE PARTNER SCAN — ONE BODY, TWO CALLERS (planet-boot round, D-A3).
 *
 * `measuredEnvironment` below calls it for a MEASURED settlement; the browser
 * calls it directly (`main.ts nearbyCityPartners`) because its situation is
 * the one this signature is shaped for:
 *
 *   • it enumerates `flight.cities()`, whose rows include the FOUNDED BEACON
 *     at a SYNTHETIC cell (`FOUNDED_CELL_BASE + seed`) that no lattice `pos3`
 *     can answer — so a row's POSITION is read off the row (`PlanetCity.dir`),
 *     never looked up by cell. For a planet city that dir IS `pos3(cell)`
 *     (`planetCities` sets it from exactly that), so nothing moves; for the
 *     beacon it is the only address there is; and for S3b's plane it will be
 *     whatever `citiesOn` wrote from its own metric.
 *   • `self` is likewise a POSITION, not a cell — a wilderness mount knows
 *     where it stands but not which lattice cell that is.
 *   • `excludeCell` is the identity question ("which city am I?") and stays a
 *     CELL KEY: it is what drops our own row, and — the D-A2 rule — it is what
 *     the incident-road list belongs to. A caller with no city passes null and
 *     an empty `incident`, and every row prices at the chord (C-5).
 *
 * Deliberately NOT taken: a `SurfaceMetric`'s `posOf`. Only `distM`/`offsetM`
 * are read, so the parameter says so and a caller with no lattice (the app)
 * hands over `sphereGeometry(radiusM)`.
 */
export function partnerRows(
  cities: readonly PlanetCity[],
  metric: Pick<SurfaceMetric, "distM" | "offsetM">,
  self: Vec3,
  simCenter: { x: number; y: number },
  excludeCell: number | null,
  incident: readonly PlanetRoute[],
  maxN: number = PARTNER_ROWS,
): SiteEnvironment["partners"] {
  const rows: Array<{ key: string; d: number; at: { x: number; y: number }; geo: PartnerGeography; distanceM: number }> = [];
  for (const c of cities) {
    if (c.cell === excludeCell) continue;
    const other = c.dir;
    const off = metric.offsetM(self, other);
    if (!off) continue; // same place (the co-located capital) or antipodal
    const d = metric.distM(self, other);
    const road = incident.find((r) => (r.a === excludeCell ? r.b : r.a) === c.cell);
    rows.push({
      key: `city:${c.cell}`,
      d,
      at: { x: simCenter.x + off.x, y: simCenter.y + off.y },
      geo: partnerGeographyOf(c),
      distanceM: road?.lengthM ?? d,
    });
  }
  rows.sort((a, b) => a.d - b.d);
  return rows.slice(0, maxN).map(({ key, at, geo, distanceM }) => ({ key, at, geo, distanceM }));
}

/**
 * ① THE MEASURED PRODUCER — the record read straight off a baked substrate.
 *
 * ⚠️ `cell` IS A LATTICE CELL, never a founded site's registered id. A site
 * founded in the wilderness carries a SYNTHETIC cell (`FOUNDED_CELL_BASE +
 * seed`, deliberately disjoint from the lattice) and indexing a grid field
 * with it is out of bounds by construction — which is why the app's three
 * samplers all read through the site's DIRECTION. Here the direction has
 * already been resolved to its lattice cell by the caller, and `excludeCell`
 * (which may well BE the synthetic id) is only ever compared, never indexed.
 *
 * `buildings` is the settlement's structure count: the charter re-measures as
 * the site grows (`charterReachCells`), so nothing about the charter is stored
 * — it is derived from (cell, buildings) and reproduces exactly on restore.
 */
export function measuredEnvironment(
  world: { grid: CellGrid; cities: readonly PlanetCity[]; routes: readonly PlanetRoute[] },
  metric: SurfaceMetric,
  cell: number,
  buildings: number,
  simCenter: { x: number; y: number },
  excludeCell: number | null,
): SiteEnvironment {
  const { grid, cities, routes } = world;
  const charter = charterBoxAt(grid, cell, charterReachCells(buildings));
  const climate = climateSampleAt(grid, cell);
  const biome = grid.fields.biome?.[cell] ?? 0;
  const eco = ecoAbundanceAt(grid, cell) ?? {};

  // THE PARTNER ROWS — `partnerRows` above (one body, two callers). The
  // incident-road list is looked up by `excludeCell`, NOT by `cell`: it asks
  // which CITY we are, and a founded site's registered cell is synthetic and
  // never a route endpoint, so the premise prices chords even though its
  // lattice cell may carry a whole junction's worth of interstates (D-A2/C-5).
  const partners = partnerRows(
    cities, metric, metric.posOf(cell), simCenter, excludeCell,
    excludeCell === null ? [] : routesByCell(routes).get(excludeCell) ?? [],
  );
  return { climate, biome, eco, charter, partners };
}

/**
 * ② THE DECLARED PRODUCER — the same record, read off a town DOCUMENT that
 * carries it as fields (the declared-cell document, S2's generator).
 *
 * Null unless ALL FIVE are present: a half-declared cell is a document that
 * says one thing about its ground and leaves the rest to a default, which is
 * the sampled-constants defect in a new costume. Absent ⇒ the caller keeps
 * whatever arm it had.
 */
export function declaredEnvironment(config: TownPlayConfig): SiteEnvironment | null {
  // `biome`/`eco`/`partners` join `TownPlayConfig` in S2 (the town document's
  // declared fields); read structurally so this file lands first.
  const c = config as TownPlayConfig & {
    biome?: number;
    eco?: Record<string, number>;
    partners?: SiteEnvironment["partners"];
  };
  if (!c.climate || c.biome === undefined || !c.eco || !c.charter || !c.partners) return null;
  return {
    climate: c.climate,
    biome: c.biome,
    eco: c.eco,
    charter: { farmland: c.charter.farmland, ore_access: c.charter.ore_access, timberland: c.charter.timberland ?? 0 },
    partners: c.partners,
  };
}

// ── The boot ─────────────────────────────────────────────────────────────────

/** THE FOUNDING PREMISE'S SETTLEMENT KEY — the app's own (`main.ts
 *  PREMISE_KEY`), so a save written by either client restores in the other. */
export const PREMISE_KEY = "frontier";

export interface PlanetScopeOpts {
  /** RESTORE a founded site instead of founding a fresh one: the same bake,
   *  the same measurements, the saved record in place of `foundSite`. */
  restore?: { site: SerializedFoundedSite; cell: number; dir: [number, number, number] };
  /** Cube-sphere face resolution. Default 48 — what the browser's space boot
   *  passes (`createSpaceFlight(scene, seed, 48, bake)`), and therefore what
   *  the planet IS. */
  faceN?: number;
}

/** What a premise declares — the three fields the solar document carries. */
export interface PlanetPremise {
  /** The SITE's seed: the town seed, the scatter seed. (The planet's own
   *  identity is the home system, not this — see `buildPlanetScope`.) */
  seed: number;
  stock: Record<string, number>;
  startPop: number;
}

/** The civ layer over a baked substrate, memoised per `built` object. The
 *  browser already holds `body.geography` from its worker; deriving cities
 *  and roads twice off one substrate is ~2 s of identical work. */
interface CivLayer {
  cities: PlanetCity[]; states: PlanetStates; pairs: Array<[number, number]>; routes: PlanetRoute[];
}
const CIV_MEMO = new WeakMap<BuiltPlanet, { scaleKey: string; civ: CivLayer }>();

function civOf(built: BuiltPlanet, scale: WorldScaleSpec | null): CivLayer {
  // The scale is part of the answer (it clips every road at the town extent),
  // so it is part of the key — a memo that ignored it would hand the second
  // caller the first caller's roads.
  const scaleKey = JSON.stringify(scale ?? null);
  const hit = CIV_MEMO.get(built);
  if (hit && hit.scaleKey === scaleKey) return hit.civ;
  // BARE, like every other producer (space-fly.ts :168, trade-roads.ts :443,
  // planet/refine.ts): a real-sized world founds a city at every site that can
  // feed itself, and an opts bag here would be a fourth opinion about that.
  const cities = planetCities(built);
  const states = planetStates(built, cities);
  const pairs = statePairs(states);
  // THE PORT LAW READS THE WORLD'S OWN EXTENT — `trade-roads.ts:457-460`
  // verbatim: omitting the scale ports the roads at the real 450 m while the
  // town plans to the derived figure, and the interstates cross the new
  // buildings the moment they exist.
  const routes = planetRoutes(built, cities, {
    ...(pairs.length ? { pairs } : {}),
    ...(scale ? { scale: resolveWorldScale(scale) } : {}),
  });
  const civ: CivLayer = { cities, states, pairs, routes };
  CIV_MEMO.set(built, { scaleKey, civ });
  return civ;
}

/**
 * THE BOOT, GIVEN A SUBSTRATE — everything after the bake.
 *
 * Split out so the BROWSER can call it on the `BuiltPlanet` its geology worker
 * already produced (S3) while headless mode bakes its own
 * (`buildPlanetScope`). One definition either way: the two differ only in
 * where the substrate came from, which is precisely the "except for the visual
 * rendering" the law allows.
 */
export function planetScopeOn(
  built: BuiltPlanet,
  body: { id: string; radiusM: number },
  premise: PlanetPremise,
  scale: WorldScaleSpec | null,
  opts: PlanetScopeOpts = {},
): PlanetScope {
  const pos3 = built.topo.pos3;
  const cellAt = built.topo.cellAt;
  if (!pos3 || !cellAt) {
    throw new Error("planetScopeOn: the topology has no pos3/cellAt — a planet boot lives on a curved lattice");
  }
  const metric = sphereMetric(built.topo, body.radiusM);

  // ① THE SITE. Restored, or founded on the forest cell.
  let site: FoundedSite;
  let dir: [number, number, number];
  if (opts.restore) {
    // `restS: 0` — the rest interval is the SAVE DOOR's business (world-lab
    // spends it once, on `savedAt`); a re-derivation of the scope must not
    // age the records a second time.
    site = createFoundedSite(opts.restore.site, { restS: 0 });
    dir = [...opts.restore.dir] as [number, number, number];
  } else {
    // FOREST-FIRST (the homestead ① ruling): the homestead stands where the
    // timber is. Founding cells are pre-scored (`findFoundingSites`); biome 1
    // = tree (ecology.ts: species index + 1); dry land only.
    const biomeField = built.grid.fields.biome;
    const dry = (built.sites ?? []).filter((s) => built.surface.heightAt(pos3(s.cell)) >= 0);
    const site0 = dry.find((s) => biomeField?.[s.cell] === 1) ?? dry[0];
    if (!site0) throw new Error(`planetScopeOn: body ${body.id} has no dry founding site`);
    const d = pos3(site0.cell);
    dir = [d[0], d[1], d[2]];
    // The kit rides `foundSite` now (`FoundSiteOpts.stock`) — founders carry
    // what the spec says and nothing else.
    site = foundSite({ seed: premise.seed, at: { x: 0, y: 0 }, key: PREMISE_KEY, stock: premise.stock });
  }
  // THE ADDRESS IS THE DIRECTION. A founded site's registered cell is
  // synthetic; its LATTICE cell is what the fields are indexed by.
  const cell = cellAt(dir);
  const surfaceR = body.radiusM + Math.max(0, built.surface.heightAt(dir));

  // ② THE CIV LAYER (memoised per substrate).
  const { cities, states, pairs, routes } = civOf(built, scale);

  // ③ THE ENVIRONMENT. The premise's own beacon is not in `cities` (it is the
  // app's synthetic row), so nothing is excluded by cell here — the capital
  // that shares this cell drops out through the metric's null offset, exactly
  // as `nearbyCityPartners`' `ang < 1e-9` drops it in the browser.
  const env = measuredEnvironment(
    { grid: built.grid, cities, routes }, metric, cell, site.buildings, { x: 0, y: 0 }, null,
  );

  // ④ WHAT THE COUNTRYSIDE IS MADE OF — the browser's exact call.
  const wildMix = wildMixForBiome(env.biome, site.seed, env.climate, env.eco);

  // ⑤ THE TOWN. `siteTownConfig` is the documented founding seam; the CLIMATE
  // seat it has none of is filled here, which is the city loader's own line
  // (`city-towns.ts:241-244`) — a founded config carries no climate, so the
  // loader fills it from the cell. One line, replicated once.
  const townConfig = siteTownConfig(site, {
    ...(scale ? { scale: resolveWorldScale(scale) } : {}),
    // A RESTORED premise re-registers with the founding population in the app
    // (every restored site registers at 0 first) — the engine's restore arm
    // simply omits it, and the host says what it wants.
    ...(opts.restore ? {} : { startPop: premise.startPop }),
    charter: env.charter,
  });
  townConfig.climate = env.climate;

  const { spec, play } = buildTownScopeFromConfig(townConfig, scale, "planet");

  return {
    built,
    body: { id: body.id, radiusM: body.radiusM, dir, surfaceR },
    geologySeed: built.spec.geology.seed,
    checksum: planetChecksum(built.grid),
    site,
    cell,
    env,
    cities,
    states,
    pairs,
    routes,
    wildMix,
    townConfig,
    scope: { spec, play, focus: null },
  };
}

/** The baked substrate, memoised per process. Deterministic in its key, so the
 *  memo is invisible — it exists only because ONE bake is 24–29 s and a jest
 *  worker must not pay it per suite. */
const BAKE_MEMO = new Map<string, { built: BuiltPlanet; body: { id: string; radiusM: number } }>();

/**
 * ⚖️ THE PLANET'S IDENTITY IS THE HOME SYSTEM, NOT THE DOCUMENT SEED (R-2).
 *
 * `generateUniverse(seed)` moves the home star's GALACTIC POSITION; its
 * `systemSeed` is the constant `GALAXY.homeSystemSeed`, so the system, the
 * home body and its geology seed are the same planet at every document seed.
 * What the document's seed IS, is the CAMP's: the site seed, the town seed,
 * the scatter seed (`main.ts premiseSeedPending.seed = galaxySeed`).
 */
function bakeHomePlanet(
  seed: number, faceN: number, compression: number, scale: WorldScaleSpec | null,
): { built: BuiltPlanet; body: { id: string; radiusM: number } } {
  const key = JSON.stringify([seed, faceN, compression, scale]);
  const hit = BAKE_MEMO.get(key);
  if (hit) return hit;
  const universe = generateUniverse(seed, DEFAULT_GALAXY_PARAMS);
  const star = universe.homeStar;
  const blueprint = star.systemSeed === GALAXY.homeSystemSeed
    ? buildHomeBlueprint(star, DEFAULT_GALAXY_PARAMS)
    : materializeSystem(star, DEFAULT_GALAXY_PARAMS);
  const resolved = resolveSystem(blueprint, DEFAULT_GALAXY_PARAMS.galaxyAgeGyr);
  // THE HOME WORLD: `pickHomePlanet`'s rule without building a single mesh —
  // the most habitable body with a real surface. (`createCelestialBody`'s
  // `walkable` says `type === "rocky" && maxReliefKm > 0`; a luminous root has
  // no parent, and every relief-bearing body in the home system is rocky, so
  // this reads the same list without the body factory.)
  let home: ResolvedBody | null = null;
  for (const rb of resolved) {
    if (rb.body.parentId === null || rb.features.terrain.maxReliefKm <= 0) continue;
    if (!home || rb.features.life.habitability > home.features.life.habitability) home = rb;
  }
  if (!home) throw new Error("buildPlanetScope: the home system has no walkable body");
  const geo = buildPlanetGeography(home, star.systemSeed, { faceN, compression, scale });
  const out = { built: geo.built, body: { id: home.body.id, radiusM: geo.radiusM } };
  BAKE_MEMO.set(key, out);
  return out;
}

/**
 * BOOT A PLANET WORLD FROM ITS DOCUMENT — the whole thing, headless.
 *
 * `game` is a `scope: "solar_system"` document declaring a `premise`. The
 * substrate is baked (or served from the process memo) and handed to
 * `planetScopeOn`, which is the half the browser calls on its own.
 */
export function buildPlanetScope(
  game: GameSettings, opts: PlanetScopeOpts = {}, label = "game",
): PlanetScope {
  if (game.scope !== "solar_system") {
    fail(`${label}.scope`, `buildPlanetScope boots "solar_system" games (got "${game.scope}")`);
  }
  const spec = parseSolarWorld(game.world, `${label}.world`);
  if (spec.premise !== "founding") {
    fail(
      `${label}.world.premise`,
      spec.premise === undefined
        ? 'required — buildPlanetScope boots a founding premise (expected "founding")'
        : `buildPlanetScope boots a founding premise (expected "founding", got "${spec.premise}")`,
    );
  }
  // PLANET COMPRESSION: the browser's own gate (`spaceScaleOpts` — only a
  // non-unity dial is forwarded), so an undeclared world bakes at real scale.
  const resolvedScale = game.scale ? resolveWorldScale(game.scale) : null;
  const compression = resolvedScale && resolvedScale.planetCompression > 1 ? resolvedScale.planetCompression : 1;
  const faceN = opts.faceN ?? 48;
  const { built, body } = bakeHomePlanet(spec.seed, faceN, compression, game.scale);
  return planetScopeOn(
    built, body,
    { seed: spec.seed, stock: spec.premise_stock ?? {}, startPop: spec.premise_population ?? 0 },
    game.scale, opts,
  );
}

// ── THE REGION ARM (planet-boot round S3b) ──────────────────────────────────

/**
 * ⚖️ THE THIRD PRODUCER: a baked FLAT region boots the same founding camp
 * headless — real cells, sites, cities, routes and partners, no planet. The
 * user: *"it's not that important, but it is a feature we'll want in the
 * spec. Could also help with faster testing since we don't have to build the
 * whole planet every time."*
 *
 * Deliberately a SIBLING of `PlanetScope`, not the same interface with a
 * nullable `built` — `PlanetScope.built: BuiltPlanet` is read unguarded by
 * every existing consumer (`server/tests/world-engine/planet-scope.test.ts`
 * — `SCOPE.built.spec…`), so widening it to admit `null` would need every
 * one of those call sites narrowed first, which is not this stage's file to
 * edit. `env`/`scope` are the two fields a HOST actually reads
 * (`headless/text-quest.ts`), and both interfaces shape them identically.
 */
export interface RegionScope {
  region: BuiltRegion;
  /** The plane's own geometry — `region.metric`, held here too so a caller
   *  need not reach through `region` for it. */
  metric: SurfaceMetric;
  site: FoundedSite;
  /** The LATTICE cell the site stands on (a REAL cell on a flat region —
   *  never synthetic, unlike a planet's founded beacon). */
  cell: number;
  env: SiteEnvironment;
  cities: PlanetCity[];
  states: PlanetStates;
  pairs: Array<[number, number]>;
  routes: PlanetRoute[];
  wildMix: WildMixEntry[];
  townConfig: TownPlayConfig;
  scope: BuiltTownScope;
}

/**
 * BOOT A REGION WORLD FROM ITS DOCUMENT — the flat sibling of
 * `buildPlanetScope`. `game` is a `scope: "region"` document declaring a
 * `premise`; `buildRegionWorld` (kernel/civ/region-game.ts) owns the deep
 * validation of `game.world` (including the `PREMISE_FIELDS` it now
 * carries), so the premise gate below reads its already-parsed spec rather
 * than re-parsing.
 *
 * Shares `measuredEnvironment`/`partnerRows`/`wildMixForBiome`/
 * `siteTownConfig`/`buildTownScopeFromConfig` with the planet arm verbatim —
 * only the SUBSTRATE and its GEOMETRY differ (`region.grid`/`region.metric`
 * vs a baked `BuiltPlanet`/`sphereMetric`). `env.ground` is OMITTED: the
 * region boots FLAT, same as the planet arm's headless measured record.
 */
export function buildRegionScope(game: GameSettings, label = "game"): RegionScope {
  const region = buildRegionWorld(game, label);
  const spec = region.spec;
  if (spec.premise !== "founding") {
    fail(
      `${label}.world.premise`,
      spec.premise === undefined
        ? 'required — buildRegionScope boots a founding premise (expected "founding")'
        : `buildRegionScope boots a founding premise (expected "founding", got "${spec.premise}")`,
    );
  }
  const { grid, metric } = region;

  // ① THE SITE — forest-first, BY FIELDS: a flat region has no
  //   `surface.heightAt` sampler (the sphere arm's form is untouched;
  //   `heightField[cell] >= SEA_HEIGHT` is the same "is this dry land" test
  //   the substrate's own settle pass used to accept the site).
  const heightField = grid.fields.height;
  const biomeField = grid.fields.biome;
  const dry = (region.sites ?? []).filter((s) => (heightField?.[s.cell] ?? 0) >= SEA_HEIGHT);
  const site0 = dry.find((s) => biomeField?.[s.cell] === 1) ?? dry[0];
  if (!site0) throw new Error(`buildRegionScope: the region has no dry founding site`);
  const cell = site0.cell;
  // The region's premise has NO seed field of its own (unlike a solar
  // document's `spec.seed`) — the terrain's own geology seed doubles as the
  // camp's seed, exactly as a planet's document seed doubles as its camp's.
  const seed = spec.geology.seed;
  const site = foundSite({ seed, at: { x: 0, y: 0 }, key: PREMISE_KEY, stock: spec.premise_stock ?? {} });

  // ② THE CIV LAYER — `citiesOn`/`statesOn`/`routesOn`, the SAME functions
  //   the sphere arm's `civOf` calls, fed this region's `SettledWorld`.
  const world: SettledWorld = { grid, sites: region.sites, seedBase: seed, metric };
  const cities = citiesOn(world);
  const states = statesOn(world, cities);
  const pairs = statePairs(states);
  const routes = routesOn(world, cities, {
    ...(pairs.length ? { pairs } : {}),
    ...(game.scale ? { scale: resolveWorldScale(game.scale) } : {}),
  });

  // ③ THE ENVIRONMENT — the SAME `measuredEnvironment`/`partnerRows` the
  //   sphere arm shares; nothing here is excluded by cell (a founded region
  //   site sits at a REAL lattice cell, so an eventual village at the same
  //   cell would legitimately be "us" — none exists on the founding day).
  const env = measuredEnvironment({ grid, cities, routes }, metric, cell, site.buildings, { x: 0, y: 0 }, null);

  // ④ THE COUNTRYSIDE — the browser's exact call, unchanged.
  const wildMix = wildMixForBiome(env.biome, site.seed, env.climate, env.eco);

  // ⑤ THE TOWN — `siteTownConfig` + the climate seat it has none of, exactly
  //   as the sphere arm fills it (city-towns.ts:241-244, C-7).
  const townConfig = siteTownConfig(site, {
    ...(game.scale ? { scale: resolveWorldScale(game.scale) } : {}),
    startPop: spec.premise_population ?? 0,
    charter: env.charter,
  });
  townConfig.climate = env.climate;

  const { spec: townSpec, play } = buildTownScopeFromConfig(townConfig, game.scale, "region");

  return {
    region,
    metric,
    site,
    cell,
    env,
    cities,
    states,
    pairs,
    routes,
    wildMix,
    townConfig,
    scope: { spec: townSpec, play, focus: null },
  };
}
