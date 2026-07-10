/**
 * Zoom-in play (unified-world-model §6 "Zoom in (sampling)" — build step 7).
 *
 * REAL-WORLD SCALE. World units are METERS (the engine's avatar is 0.4 m
 * radius walking 5 m/s), a substrate tile is a SQUARE KILOMETER of
 * geography, and a site is the size a site actually is: a town of three
 * thousand people is ~600 houses over half a kilometer, sitting inside
 * its tile with fields around it. The map (tens of km) is enormous
 * relative to the individual — that is the point; the lab's map view
 * remains the fast way across, and later milestones may compress or
 * hand the substrate to a planet-scale host (seagull-dream).
 *
 * Nothing at this scale can live in a spec or in memory all at once, so
 * everything local is DERIVED from seeded values and streamed by player
 * position:
 *
 *   Substrate  → always live: terrain renders through the camera window
 *                and collides through a MoveConstraint reading the grid.
 *   Settlement → `townPlan` lays out one town deterministically from its
 *                settlement scalars (houses ∝ population on ring lots —
 *                growth APPENDS outward, so house k is stable as the town
 *                grows; hall, workshops, fields). Town plans load within
 *                data radius; the view culls to the camera.
 *   Composition→ every HOUSE holds a HOUSEHOLD of `HOUSEHOLD` people
 *                drawn from the site's syndrome distribution — member m
 *                of house k is `sampleVillager(site, k*HOUSEHOLD + m)`
 *                (same family behind the same door every visit, zero
 *                storage; the addressable-person space ≈ the population,
 *                since houses = pop/HOUSEHOLD). Member 0 is the
 *                household's SHOPPER (walks the food cycle); the rest
 *                are homebodies about the room. Only the best-ranked few
 *                exist as world-engine bodies at any moment
 *                (`WorldHost.addNpc`/`removeNpc` within the budget).
 *
 * `generateScene` (bounded, certified) is kept as a COMPRESSED VIGNETTE
 * of a village core at `SCENE_TILE` scale — the §6 sampler and the seat
 * where goal-tree content projects; the seamless world does not use it.
 *
 * Party (§6 aggregation, the minimal arc): a villager the player engages
 * gets PINNED (histfig — Σ pops + histfigs stays constant); parking
 * remembers where; disbanding rebins everyone to their origin syndrome.
 */

import {
  certifyWorldSpec,
  WORLD_MAX_NPCS,
  type BuildingSpec,
  type NpcSpec,
  type WallSpec,
  type WorldSpec,
} from "@shared/world-engine/index";
import type { Histfig, HistfigSample } from "@popusim/controller/World";
import type { TriWorld } from "./tri";
import {
  ERRAND_WALK, HOUSEHOLD, doorTransit, goodBoxAt, houseDoorstep,
  pantryBoxAt, streetGoodsFor, type TownFood, type TownGoods,
} from "./food";
import { DEFAULT_ECONOMY } from "./economy-core";
import type { CompiledEconomy } from "./economy";
import {
  WORLD_TILE, worldPos,
  townBias as sharedTownBias, townPlan as sharedTownPlan,
  type TownBias, type TownHouse, type TownPlan,
} from "@shared/engine/town/plan";
import type { TownStreets } from "@shared/engine/town/streets";
import { houseFurniture } from "@shared/engine/town/furniture";
import type { ObjectSpec } from "@shared/world-engine/index";

export { HOUSEHOLD };

// The town-plan half of this module moved into the shared engine's town
// layer (shared/engine/town/plan.ts) in the engine carve; the geometry,
// types and constants re-export from here so every pre-carve import
// keeps working. What stays in this file is the world assembly and the
// STREAMING half — vignettes, the town manager, embodied villagers and
// parties — which reads named residents (popusim histfigs) and so
// belongs with the game until a demography module exists.
export {
  MARKET_MIN_HOUSES, WORLD_TILE, worldPos,
  type TownBias, type TownField, type TownHouse, type TownPlan, type TownWork,
} from "@shared/engine/town/plan";

/** The world's work registry (compiled economy, or the standard one). */
export function worksOf(tri: TriWorld): CompiledEconomy["works"] {
  return (tri.economy ?? DEFAULT_ECONOMY).works;
}

/** The typed growth bias for a town — THIS world's registry resolved. */
export function townBias(tri: TriWorld, siteKey: string): TownBias {
  return sharedTownBias(tri, tri.economy ?? DEFAULT_ECONOMY, siteKey);
}

/** THE BUILD-UP KNOB, resolved for a grand-dream town: how many storeys
 *  above the ground floor it will add under housing pressure —
 *  capability × cost. The factors that SHOULD feed it (technology,
 *  wealth, aesthetics, culture, building type) mostly don't exist as
 *  scalars yet, so v1 derives from the stable proxy the books already
 *  carry — the settlement's own scale — QUANTIZED so a drifting number
 *  never re-lays floors under the player's feet. When tech/wealth/
 *  values land as content, they plug in HERE, feeding this one number. */
export function buildUpOf(tri: TriWorld, siteKey: string): number {
  const pop = tri.dual.settlementScalar(siteKey, "population");
  return pop >= 4000 ? 2 : pop >= 2000 ? 1 : 0;
}

/** One town, laid out at real scale — THIS world's registry resolved. */
export function townPlan(tri: TriWorld, siteKey: string, seed: number): TownPlan {
  return sharedTownPlan(tri, tri.economy ?? DEFAULT_ECONOMY, siteKey, seed, buildUpOf(tri, siteKey));
}

/* ------------------------- deterministic rng ------------------------- */

function hashSeed(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The streaming NPC id for a resident — parse back with `villagerOf`.
 *  `index` is the SAMPLE index (see `memberIndex`), not the house. */
export function villagerNpcId(siteKey: string, index: number): string {
  return `villager_${siteKey}_${index}`;
}

/** Reverse of `villagerNpcId`: which sampled person an NPC id names. */
export function villagerOf(npcId: string): { siteKey: string; index: number } | null {
  const m = /^villager_(.+)_(\d+)$/.exec(npcId);
  return m ? { siteKey: m[1], index: parseInt(m[2], 10) } : null;
}

/** Sample index of member `m` of house `houseIdx`: a household is
 *  HOUSEHOLD consecutive sample indices, so every soul the population
 *  count implies is addressable (houses ≈ pop / HOUSEHOLD). Member 0 is
 *  the household's SHOPPER — the one who walks the food cycle. */
export function memberIndex(houseIdx: number, m: number): number {
  return houseIdx * HOUSEHOLD + m;
}

/** The house a sample index belongs to (inverse of `memberIndex`). */
export function houseIndexOf(sampleIndex: number): number {
  return Math.floor(sampleIndex / HOUSEHOLD);
}

/* ------------------ bounded vignette (the sampler) ------------------- */
// A COMPRESSED village-core scene: real towns don't fit a bounded spec
// (16-building cap), so the certified sampler renders the site's essence
// at SCENE_TILE scale. This is the §6 scene projection + the future
// goal-tree seat; the seamless world streams `townPlan` instead.

const SCENE_TILE = 8;
export const ZOOM_PATCH_R = 3;
const PATCH_SIDE = 2 * ZOOM_PATCH_R + 1;
const SCENE_SIZE = PATCH_SIDE * SCENE_TILE;
const CLIFF_RISE = 8;
const MAX_SCENE_BUILDINGS = 12;
const MAX_SCENE_VILLAGERS = 5;

export interface CityVillager {
  sample: HistfigSample;
  dx: number;
  dy: number;
  movement: "stationary" | "wander";
}

export interface CityContent {
  key: string;
  biome: "farmland" | "mining";
  groundColor: string;
  buildings: Array<{
    id: string;
    type: string;
    color: string;
    dx: number;
    dy: number;
    w: number;
    h: number;
    door: { edge: "north" | "south" | "east" | "west"; offset: number; width: number };
  }>;
  villagers: CityVillager[];
}

/** Vignette hall style — economy buildings carry their own (registry
 *  `vignette` + style color). */
const VIGNETTE_HALL = { color: "#8a6d3b", w: 7, h: 6 };

export function cityContent(tri: TriWorld, siteKey: string, seed: number): CityContent {
  const city = tri.cities.find(c => c.key === siteKey);
  if (!city) throw new Error(`cityContent: unknown city "${siteKey}"`);
  const { dual } = tri;
  const rng = mulberry32(hashSeed(seed, siteKey));

  const ch = tri.charterOf(siteKey);
  const biome: CityContent["biome"] = ch.ore_access > ch.farmland ? "mining" : "farmland";
  const fertMean = ch.farmland / (PATCH_SIDE * PATCH_SIDE);
  const groundColor = biome === "mining" ? "#8a8a90" : fertMean > 4 ? "#8fae62" : "#d6b87c";

  const counts: Array<[string, number, { color: string; w: number; h: number }]> = [
    ["hall", 1, VIGNETTE_HALL],
    ...worksOf(tri).map((def): [string, number, { color: string; w: number; h: number }] => [
      def.key,
      Math.round(dual.settlementScalar(siteKey, def.countScalar)),
      { color: def.style.color, ...def.vignette },
    ]),
  ];
  const slots: Array<{ x: number; y: number }> = [];
  const spin = rng() * Math.PI * 2;
  for (const [ring, n] of [[1.6, 6], [2.7, 10]] as Array<[number, number]>) {
    for (let k = 0; k < n; k++) {
      const a = spin + (k / n) * Math.PI * 2 + (ring > 2 ? Math.PI / n : 0);
      slots.push({ x: Math.cos(a) * ring * SCENE_TILE, y: Math.sin(a) * ring * SCENE_TILE });
    }
  }
  const half = SCENE_SIZE / 2;
  const buildings: CityContent["buildings"] = [];
  let slot = 0;
  outer: for (const [type, n, style] of counts) {
    for (let k = 0; k < n; k++) {
      if (buildings.length >= MAX_SCENE_BUILDINGS) break outer;
      let placed = false;
      while (slot < slots.length) {
        const s = slots[slot++];
        const fx = s.x - style.w / 2;
        const fy = s.y - style.h / 2;
        if (fx < 1 - half || fy < 1 - half || fx + style.w > half - 1 || fy + style.h > half - 1) continue;
        const edge = Math.abs(s.x) > Math.abs(s.y)
          ? (s.x > 0 ? "west" : "east")
          : (s.y > 0 ? "north" : "south");
        const along = edge === "north" || edge === "south" ? style.w : style.h;
        buildings.push({
          id: `${type}_${k}`, type, color: style.color,
          dx: fx, dy: fy, w: style.w, h: style.h,
          door: { edge, offset: along / 2, width: 2 }, // centred on the wall (see buildingsNear)
        });
        placed = true;
        break;
      }
      if (!placed) break outer;
    }
  }

  const pop = dual.settlementScalar(siteKey, "population");
  const want = Math.max(2, Math.min(MAX_SCENE_VILLAGERS, Math.round(Math.sqrt(Math.max(0, pop)) / 8)));
  const villagers: CityVillager[] = [];
  for (let i = 0; villagers.length < want && i < want * 2; i++) {
    const sample = dual.sampleVillager(siteKey, i);
    if (!sample) break;
    const a = rng() * Math.PI * 2;
    const r = (0.4 + rng() * 0.9) * SCENE_TILE;
    villagers.push({
      sample,
      dx: Math.cos(a) * r,
      dy: Math.sin(a) * r,
      movement: villagers.length === 0 ? "stationary" : "wander",
    });
  }

  return { key: siteKey, biome, groundColor, buildings, villagers };
}

export interface ZoomScene {
  spec: WorldSpec;
  villagers: HistfigSample[];
  siteKey: string;
  biome: "farmland" | "mining";
}

export interface ZoomOptions {
  seed?: number;
  title?: string;
  party?: Histfig[];
}

export function generateScene(tri: TriWorld, siteKey: string, opts: ZoomOptions = {}): ZoomScene {
  const city = tri.cities.find(c => c.key === siteKey);
  if (!city) throw new Error(`generateScene: unknown city "${siteKey}"`);
  const { grid, dual } = tri;
  const seed = opts.seed ?? 1;
  const rng = mulberry32(hashSeed(seed, `${siteKey}:scene`));
  const content = cityContent(tri, siteKey, seed);

  const hAt = (dx: number, dy: number): number => {
    const x = Math.max(0, Math.min(grid.cols - 1, city.x + dx));
    const y = Math.max(0, Math.min(grid.rows - 1, city.y + dy));
    return grid.fields.height[y * grid.cols + x];
  };
  const solidAt = (dx: number, dy: number): number => {
    const x = Math.max(0, Math.min(grid.cols - 1, city.x + dx));
    const y = Math.max(0, Math.min(grid.rows - 1, city.y + dy));
    return (grid.fields.solid ?? grid.fields.height)[y * grid.cols + x];
  };
  const cityH = hAt(0, 0);
  const steep = (dx: number, dy: number): boolean =>
    !(dx === 0 && dy === 0) && (hAt(dx, dy) - cityH >= CLIFF_RISE || (grid.fields.solid ? solidAt(dx, dy) >= 0.5 : false));

  const walls: WallSpec[] = [];
  for (let dy = -ZOOM_PATCH_R; dy <= ZOOM_PATCH_R; dy++) {
    let runStart: number | null = null;
    for (let dx = -ZOOM_PATCH_R; dx <= ZOOM_PATCH_R + 1; dx++) {
      const inRun = dx <= ZOOM_PATCH_R && steep(dx, dy);
      if (inRun && runStart === null) runStart = dx;
      if (!inRun && runStart !== null) {
        const yU = (dy + ZOOM_PATCH_R + 0.5) * SCENE_TILE;
        walls.push({
          kind: "wall",
          id: `cliff_${dy + ZOOM_PATCH_R}_${runStart + ZOOM_PATCH_R}`,
          a: { x: (runStart + ZOOM_PATCH_R) * SCENE_TILE, y: yU },
          b: { x: (dx + ZOOM_PATCH_R) * SCENE_TILE, y: yU },
          thickness: SCENE_TILE,
          color: "#6e6e75",
        });
        runStart = null;
      }
    }
  }

  const cx = SCENE_SIZE / 2;
  const buildings: BuildingSpec[] = content.buildings.map(b => ({
    id: b.id,
    footprint: { x: cx + b.dx, y: cx + b.dy, w: b.w, h: b.h },
    floors: 1,
    wallThickness: 0.4,
    doorways: [b.door],
    color: b.color,
  }));

  const party = opts.party ?? [];
  const budget = WORLD_MAX_NPCS - party.length;
  const kept = content.villagers.slice(0, Math.max(0, budget));
  const npcs: NpcSpec[] = kept.map(v => ({
    id: `villager_${v.sample.index}`,
    x: cx + v.dx,
    y: cx + v.dy,
    name: v.sample.name,
    behavior: { movement: v.movement, conversationRadius: 5 },
    persona: { interestHints: v.sample.traitKeys.filter(t => t !== "human").slice(0, 3) },
  }));
  for (const member of party) {
    npcs.push({
      id: `party_${member.id}`,
      x: cx + (rng() - 0.5) * SCENE_TILE,
      y: cx + SCENE_TILE * 1.5 + (rng() - 0.5) * 4,
      name: member.name,
      behavior: { movement: "approach_nearest", conversationRadius: 6 },
    });
  }

  const siteName = dual.sites().find(s => s.key === siteKey)?.name ?? siteKey;
  const raw: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: {
      title: opts.title ?? siteName,
      description: `A ${content.biome} settlement sampled from the living world (compressed vignette).`,
      locale: "en",
      theme: content.biome === "mining" ? "mountain mining town" : "river farming village",
    },
    manifold: { kind: "flat", width: SCENE_SIZE, height: SCENE_SIZE },
    terrain: { kind: "flat", groundColor: content.groundColor },
    spawns: [{ id: "plaza", x: cx, y: cx + SCENE_TILE * 0.75 }],
    objects: [],
    structures: walls,
    buildings,
    npcs,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };

  const cert = certifyWorldSpec(raw);
  if (!cert.ok) {
    throw new Error(`generateScene(${siteKey}): spec failed certification: ${JSON.stringify(cert.errors)}`);
  }
  return { spec: cert.spec, villagers: kept.map(v => v.sample), siteKey, biome: content.biome };
}

/* --------------------- the seamless world spec ----------------------- */

export interface SeamlessWorld {
  spec: WorldSpec;
  /** City key → spawn index, for `runWorldHost({spawnIndex})`. */
  spawnIndexOf: Map<string, number>;
}

export interface SeamlessOptions {
  seed?: number;
  atCity?: string;
  party?: Histfig[];
}

export function generateWorld(tri: TriWorld, opts: SeamlessOptions = {}): SeamlessWorld {
  const { grid } = tri;
  const rng = mulberry32(hashSeed(opts.seed ?? 1, "seamless-world"));
  const width = grid.cols * WORLD_TILE;
  const height = grid.rows * WORLD_TILE;

  const cities = tri.cities.slice(0, 16); // spawn cap; the lab never exceeds it
  const spawnIndexOf = new Map<string, number>();
  const spawns = cities.map((c, i) => {
    spawnIndexOf.set(c.key, i);
    const p = worldPos(c.x, c.y);
    return { id: c.key, x: p.x, y: p.y };
  });
  if (spawns.length === 0) spawns.push({ id: "wilds", x: width / 2, y: height / 2 });

  const at = cities.find(c => c.key === opts.atCity) ?? cities[0];
  const home = at ? worldPos(at.x, at.y) : { x: width / 2, y: height / 2 };
  const npcs: NpcSpec[] = (opts.party ?? []).map(member => ({
    id: `party_${member.id}`,
    x: home.x + (rng() - 0.5) * 4,
    y: home.y + 3 + (rng() - 0.5) * 2,
    name: member.name,
    behavior: { movement: "approach_nearest" as const, conversationRadius: 6 },
  }));

  const raw: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: {
      title: "The Wide World",
      description: "The whole substrate at real scale — towns, houses, and people stream in around you.",
      locale: "en",
      theme: "overland journey",
    },
    manifold: { kind: "flat", width, height },
    terrain: { kind: "flat" }, // drawn by the world view, not the spec
    spawns,
    objects: [],
    npcs,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  const cert = certifyWorldSpec(raw);
  if (!cert.ok) {
    throw new Error(`generateWorld: spec failed certification: ${JSON.stringify(cert.errors)}`);
  }
  return { spec: cert.spec, spawnIndexOf };
}

/* ------------------------- terrain collision ------------------------- */

const BLOCK_WATER = 2;
const BLOCK_RIVER = 45;

/** Terrain collision from the LIVE grid (tile granularity — a blocked
 *  tile is a kilometer of stone or deep water; fine collision later). */
export function terrainConstraint(grid: { cols: number; rows: number; fields: Record<string, ArrayLike<number>> }): {
  walkable(p: { x: number; y: number }, radius: number): boolean;
} {
  const blockedAt = (x: number, y: number): boolean => {
    const tx = Math.floor(x / WORLD_TILE);
    const ty = Math.floor(y / WORLD_TILE);
    if (tx < 0 || tx >= grid.cols || ty < 0 || ty >= grid.rows) return true;
    const i = ty * grid.cols + tx;
    if ((grid.fields.solid?.[i] ?? 0) >= 0.5) return true;
    if (grid.fields.water) return grid.fields.water[i] >= BLOCK_WATER;
    if (grid.fields.river) return grid.fields.river[i] > BLOCK_RIVER;
    return false;
  };
  return {
    walkable(p, radius) {
      if (blockedAt(p.x, p.y)) return false;
      return !blockedAt(p.x - radius, p.y) && !blockedAt(p.x + radius, p.y)
        && !blockedAt(p.x, p.y - radius) && !blockedAt(p.x, p.y + radius);
    },
  };
}

/** The city whose tile-center is nearest `p` (meters), with distance. */
export function nearestCity(tri: TriWorld, p: { x: number; y: number }): { key: string; distance: number } | null {
  let best: { key: string; distance: number } | null = null;
  for (const c of tri.cities) {
    const cp = worldPos(c.x, c.y);
    const d = Math.hypot(cp.x - p.x, cp.y - p.y);
    if (!best || d < best.distance) best = { key: c.key, distance: d };
  }
  return best;
}

/* ------------------------- town streaming ---------------------------- */
// Two independent streams, both position-seeded:
//   TOWN PLANS (cheap data: house/work/field rects) load within a data
//   radius and unload behind with hysteresis; the view culls to camera.
//   RESIDENTS (world-engine bodies, the expensive part) exist only for
//   the houses nearest the player: every update picks the K best-ranked
//   candidates inside PEOPLE_R (K = the live NPC budget) and diffs
//   against what's spawned. Ranking prefers STREET LIFE: someone out on
//   an errand is visible; someone home is behind a closed door the view
//   hides — so idle residents rank far behind walkers (and only embody
//   near the player at all), and the tiny engine budget buys people the
//   player can actually see. Recruited residents are excluded for the
//   session.

/** Town DATA loads inside this (meters)... */
export const TOWN_LOAD_R = 1600;
/** ...and unloads past this (hysteresis). */
export const TOWN_UNLOAD_R = 2000;
// The streaming NUMBERS are single-sourced in the shared engine since
// the 2D/3D parity carve (shared/engine/town/residents.ts — every view
// streams the same people to the same places): STREET_NPCS, PEOPLE_R,
// PEOPLE_EVICT_MIN, INDOOR_WANDER_R, IDLE_EMBODY_R, IDLE_RANK_PENALTY,
// BOX_FILL_DWELL. This manager still runs its own multi-town/histfig
// implementation of the rules; migrating it onto createResidentModel is
// the parity follow-up.
import {
  BOX_FILL_DWELL, IDLE_EMBODY_R, IDLE_RANK_PENALTY, INDOOR_WANDER_R,
  PEOPLE_EVICT_MIN, PEOPLE_R, STREET_NPCS,
} from "@shared/engine/town/residents";
export { IDLE_EMBODY_R, IDLE_RANK_PENALTY, PEOPLE_EVICT_MIN, PEOPLE_R, STREET_NPCS };
/** A watched pantry's flip detection rides render-call continuity: a
 *  house whose box was last displayed longer ago than this counts as
 *  freshly sighted (primed from the closed form, not deferred). */
const WATCH_STALE_SEC = 2.5;
/** Buildings become REAL engine structures (blocking walls, swinging
 *  doors) within this range of the player (meters)... */
export const STRUCT_LOAD_R = 100;
/** ...and revert to distant scenery past this (hysteresis). */
export const STRUCT_UNLOAD_R = 130;

export interface LoadedTown {
  key: string;
  /** Town center, meters. */
  center: { x: number; y: number };
  plan: TownPlan;
  /** ALL the town's street-goods projections, in slot order (the
   *  world's compiled economy registry, filtered to ledgers this
   *  settlement keeps) — food first, always. */
  goods: TownGoods[];
  /** goods[0] — the founding good (compat alias). */
  food: TownFood;
  /** The tools projection when the world trades them (compat alias). */
  wares: TownGoods | null;
  /** The street tree (streets.ts) — errands ride it, the view draws it,
   *  houses face it. Same object as `plan.streets`. */
  roads: TownStreets;
}

export interface ChunkUpdate {
  /** Residents to embody. A resident mid-shopping-trip spawns EN ROUTE
   *  with the rest of their trip as `walkTo` waypoints — people appear
   *  doing what the food economy says they're doing. */
  spawn: Array<{ npc: NpcSpec; walkTo?: Array<{ x: number; y: number; dwell?: number }> }>;
  despawn: string[];
  /** Shopping trips for residents ALREADY embodied — their pantry ran
   *  low this update; send them to their source and back. */
  errands: Array<{ id: string; points: Array<{ x: number; y: number; dwell?: number }> }>;
  /** New streamed BUILDING set for `WorldHost.setBuildings` — the
   *  volumes around the player (the host lowers them into walls +
   *  swinging doors, and the volumes carry roofs / see-inside fade /
   *  indoor cull in views that render them). Undefined when the
   *  in-range building set did not change this update. */
  buildings?: BuildingSpec[];
  /** FURNITURE arriving with its house (host.addObject) — solid,
   *  openable fixtures, abstracted away when the house unloads. */
  addObjects?: ObjectSpec[];
  /** Furniture leaving with its house (host.removeObject). */
  removeObjects?: string[];
}

export interface TownManager {
  /** Reconcile loaded towns + embodied residents against the player.
   *  `live` is the host's ACTUAL avatar positions — the source of truth:
   *  a body the host rejected or dropped is forgotten (and respawns if
   *  still ranked), and ranking uses where people ARE, not where their
   *  house is, so a wanderer beside the player never blinks out.
   *  `now` (seconds) drives the food-economy clock: unspawned residents
   *  rank/spawn at their shopping-cycle position, and embodied ones are
   *  sent on market trips when their cycle says the box ran dry.
   *  `visibleR` (meters) is how far the CAMERA can currently see: a
   *  mid-errand resident who would materialize inside it spawns at
   *  their trip's source BUILDING instead and walks out of its door —
   *  nobody pops into existence on open ground in front of the player.
   *  (Home-phase residents always spawn INSIDE their house; the view
   *  hides indoor villagers, so they exist only once they step out.) */
  update(p: { x: number; y: number }, live?: ReadonlyMap<string, { x: number; y: number }>, now?: number, visibleR?: number): ChunkUpdate;
  loaded(): LoadedTown[];
  /** Embodied residents currently on the host (budget sharing). */
  active(): number;
  /** The pantry box DISPLAY value for a house (rations, 0..boxCap) —
   *  the closed-form `town.food.pantry` wrapped in WITNESS rules:
   *   - while a real body is mid-trip the box stays empty until the
   *     shopper actually reaches the crate (`tripArrived`) — a body
   *     delayed by obstacles or door jams holds the refill back with it;
   *   - a refill never happens in front of the player: a WATCHED box
   *     (inside the camera's visible radius) waits for a real shopper,
   *     and catches up to the closed form only once the player looks
   *     away. A box seen for the first time reads the closed form
   *     directly (priming, not a jump).
   *  Call every rendered frame for on-screen boxes — the watched flip
   *  detection rides call continuity. */
  pantry(town: LoadedTown, house: TownHouse, t: number): number;
  /** The wares (tool chest) DISPLAY value — same witness rules on the
   *  tools projection; null in worlds without the commodity. */
  wares(town: LoadedTown, house: TownHouse, t: number): number | null;
  /** Any good's box DISPLAY value by index into `town.goods` — the
   *  renderer iterates every crate a house keeps. */
  goodBox(town: LoadedTown, goodIndex: number, house: TownHouse, t: number): number;
  /** Witness a shopper reaching their pantry box (the errand's final
   *  waypoint — main.ts wires the engine's onArrive here): the refill
   *  commits NOW, wherever the clock thinks the trip is. */
  tripArrived(npcId: string, now: number): void;
  /** Remove a resident for the session (recruited — they left the crowd). */
  release(npcId: string): void;
  /** Undo `release`: the person rejoined the crowd (a disbanded party
   *  member walked out of frame) — they may stream from their door again. */
  restore(npcId: string): void;
}

export function createTownManager(
  tri: TriWorld,
  seed: number,
  /** Live NPC budget for residents (engine cap minus party + travelers). */
  npcBudget: () => number,
): TownManager {
  const towns = new Map<string, LoadedTown>();
  const excluded = new Set<string>();

  /** Town-local house center in WORLD meters (the resident's indoor
   *  tether: idle residents shuffle INSIDE their home, so they never
   *  grind against a wall and — once the house is a real structure —
   *  they're hidden by the indoor cull until they step out to shop). */
  const houseCenter = (town: LoadedTown, h: TownHouse): { x: number; y: number } =>
    ({ x: town.center.x + h.dx + h.w / 2, y: town.center.y + h.dy + h.h / 2 });
  /** Wrap a shopping route (which starts/ends at the doorstep OUTSIDE
   *  the door) with door transits, so crossing the wall happens AT the
   *  doorway — the short-range "pathfinding" towns actually need.
   *  `exitFirst` prepends the inside→outside step for a body leaving
   *  home; the return steps (…→inside→the good's BOX) are always
   *  appended: the trip ends AT the crate, and reaching that final
   *  waypoint is what fills the box (tripArrived). */
  const throughDoor = (
    town: LoadedTown, h: TownHouse,
    walkTo: Array<{ x: number; y: number; dwell?: number }>, exitFirst: boolean,
    box?: { x: number; y: number },
  ): Array<{ x: number; y: number; dwell?: number }> => {
    const d = doorTransit(town.center, h);
    const pts: Array<{ x: number; y: number; dwell?: number }> =
      exitFirst ? [d.inside, d.outside, ...walkTo] : [...walkTo];
    pts.push(d.inside, { ...(box ?? pantryBoxAt(town.center, h)), dwell: BOX_FILL_DWELL });
    return pts;
  };

  /** One household ERRAND RUN: a good, the member ROLE that walks it,
   *  and where its box sits in the house. Role = the good's SLOT
   *  (registration order — role 0 the food shopper, role 1 the wares
   *  runner, and so on for every good the town trades), so an N-need
   *  household is N different people out on different clocks, not one
   *  runner in a hurry. */
  interface GoodRun {
    goods: TownGoods;
    role: number;
    box: (center: { x: number; y: number }, h: TownHouse) => { x: number; y: number };
  }
  const runCache = new WeakMap<LoadedTown, GoodRun[]>();
  const goodsRuns = (town: LoadedTown): GoodRun[] => {
    let runs = runCache.get(town);
    if (!runs) {
      runs = town.goods.map((g, i) => {
        const slot = g.good.slot ?? i;
        return { goods: g, role: slot, box: (center: { x: number; y: number }, h: TownHouse) => goodBoxAt(center, h, slot) };
      });
      runCache.set(town, runs);
    }
    return runs;
  };
  /** Witness-state key: one ledger entry per (household, good). */
  const boxKey = (hk: string, goods: TownGoods): string => `${hk}|${goods.good.key}`;

  /** Spawned resident id → doorstep position. */
  const bodies = new Map<string, { x: number; y: number }>();
  /** Spawned resident id → their house (for the live food cycle). */
  const bodyHouse = new Map<string, { town: LoadedTown; house: TownHouse }>();
  /** Last shopping cycle a trip errand was issued for, per body (each
   *  body runs at most one good, so the npc id suffices). */
  const tripSent = new Map<string, number>();
  /** Trip currently WALKED by a real body, per (household, good) box
   *  key — the runner is out and THAT box must not refill until they
   *  reach it (or vanish). */
  const tripWalking = new Map<string, { npcId: string; cycle: number }>();
  /** Witnessed/committed refill per (household, good) box key (which
   *  cycle's refill is showing and when the box actually filled). */
  const committed = new Map<string, { cycle: number; at: number }>();
  /** Last box display call per (household, good) — watched-flip
   *  continuity. */
  const lastShown = new Map<string, number>();
  /** Player position + camera reach at the last update — the "is the
   *  player looking at this box" test pantry() runs. */
  let lastP: { x: number; y: number } | null = null;
  let lastVisibleR: number | undefined;
  /** Growth-governor state: when each town last replanned (update-clock
   *  seconds) — a town replans at most once per cooldown window. */
  const REPLAN_COOLDOWN_S = 5;
  const replanAt = new Map<string, number>();
  /** Buildings currently lowered into REAL structures, by building id. */
  const solid = new Set<string>();
  /** Furniture per house building id (built lazily as houses stream). */
  const furnitureCatalog = new Map<string, ObjectSpec[]>();
  /** House ids whose furniture is currently in the world. */
  const furnished = new Set<string>();

  /** Is `pt` inside this house's four walls? */
  const inHouseRect = (pt: { x: number; y: number }, town: LoadedTown, h: TownHouse): boolean =>
    pt.x > town.center.x + h.dx && pt.x < town.center.x + h.dx + h.w &&
    pt.y > town.center.y + h.dy && pt.y < town.center.y + h.dy + h.h;

  /** The HOUSEHOLD key (member 0's npc id) — pantry witness state is
   *  keyed per household, stable across shopper handover. */
  const householdKey = (townKey: string, houseIdx: number): string =>
    villagerNpcId(townKey, memberIndex(houseIdx, 0));
  const householdKeyOf = (npcId: string): string | null => {
    const who = villagerOf(npcId);
    return who ? householdKey(who.siteKey, houseIndexOf(who.index)) : null;
  };
  /** Forget a body's in-flight trip (despawned / recruited / ghosted). */
  const dropTrip = (npcId: string): void => {
    for (const [k, v] of tripWalking) if (v.npcId === npcId) tripWalking.delete(k);
  };
  /** The household member who fills errand ROLE `role`: the (role+1)-th
   *  member not recruited away — recruit the shopper and a sibling takes
   *  over that run next cycle; a family down to one soul covers food and
   *  drops the wares run. Null when nobody's left for the role. */
  const roleMemberId = (townKey: string, houseIdx: number, role: number): string | null => {
    let seen = 0;
    for (let m = 0; m < HOUSEHOLD; m++) {
      const id = villagerNpcId(townKey, memberIndex(houseIdx, m));
      if (excluded.has(id)) continue;
      if (seen === role) return id;
      seen++;
    }
    return null;
  };
  /** The errand run THIS body walks for its house, if any. */
  const runFor = (town: LoadedTown, houseIdx: number, npcId: string): GoodRun | null => {
    for (const run of goodsRuns(town)) {
      if (roleMemberId(town.key, houseIdx, run.role) === npcId) return run;
    }
    return null;
  };
  /** Where member `m` of a household stands: a deterministic spot spread
   *  about the room (margin off the walls) — five people in a house are
   *  five bodies around the room, not a stack at its center. */
  const memberSpot = (town: LoadedTown, h: TownHouse, m: number): { x: number; y: number } => {
    const rng = mulberry32(hashSeed(seed, `${town.key}:member:${h.index}:${m}`));
    return {
      x: town.center.x + h.dx + 1.4 + rng() * Math.max(0.5, h.w - 2.8),
      y: town.center.y + h.dy + 1.4 + rng() * Math.max(0.5, h.h - 2.8),
    };
  };

  /** Every building near p as a BuildingSpec at WORLD coordinates. */
  const buildingsNear = (p: { x: number; y: number }, range: number): Map<string, BuildingSpec> => {
    const out = new Map<string, BuildingSpec>();
    const consider = (townKey: string, center: { x: number; y: number }, id: string,
      b: { dx: number; dy: number; w: number; h: number; door: TownHouse["door"]; color: string; floors?: number }): void => {
      const cx = center.x + b.dx + b.w / 2;
      const cy = center.y + b.dy + b.h / 2;
      if (Math.hypot(cx - p.x, cy - p.y) > range) return;
      const along = b.door === "north" || b.door === "south" ? b.w : b.h;
      out.set(id, {
        id,
        footprint: { x: center.x + b.dx, y: center.y + b.dy, w: b.w, h: b.h },
        // Storeys from the plan (the build-up knob raised them). Upper
        // floors are VISUAL for now — no stairs staged in homes; the
        // ground floor keeps every mechanic (boxes, members, errands).
        floors: b.floors ?? 1,
        stairs: false,
        wallThickness: 0.4,
        // The door gap is CENTERED on its wall (edgeStructures centers the
        // gap on `offset`) — the same wall midpoint houseDoorstep /
        // doorTransit aim at, so residents walk straight at their door
        // instead of at a point 1 m to its side (the old `along/2 - 1`
        // put the gap off-centre while the aim stayed centred).
        doorways: [{ edge: b.door, offset: along / 2, width: 2 }],
        color: b.color,
      });
    };
    for (const town of towns.values()) {
      for (const h of town.plan.houses) {
        const id = `h_${town.key}_${h.index}`;
        consider(town.key, town.center, id, h);
        if (out.has(id) && !furnitureCatalog.has(id)) {
          furnitureCatalog.set(id, houseFurniture(
            town.center, h,
            town.goods.map(g => ({ key: g.good.key, slot: g.good.slot })),
            `_${town.key}`,
          ).map(piece => ({
            id: piece.id,
            x: piece.x,
            y: piece.y,
            shape: "box" as const,
            radius: piece.radius,
            fixture: piece.kind,
            openable: piece.openable,
            facing: piece.facing,
            interactions: [],
            contains: [{ relation: piece.kind === "table" ? ("on" as const) : ("in" as const), capacity: 2 }],
          })));
        }
      }
      for (const [i, wk] of town.plan.works.entries()) consider(town.key, town.center, `w_${town.key}_${i}`, wk);
    }
    return out;
  };

  /** One good's box DISPLAY value under the witness rules (see the
   *  interface doc on `pantry`) — the machinery is good-agnostic; food
   *  and wares differ only in which projection and which crate. */
  const boxLevel = (town: LoadedTown, goods: TownGoods, house: TownHouse, t: number): number => {
    const { period, trip, offset } = goods.cycle(house);
    const raw = t + offset;
    const u = ((raw % period) + period) % period;
    const cyc = Math.floor(raw / period);
    const bk = boxKey(householdKey(town.key, house.index), goods);
    const shownAgo = t - (lastShown.get(bk) ?? -Infinity);
    lastShown.set(bk, t);
    // Refill committed for THIS cycle (witnessed arrival, or the
    // closed form caught up off-camera): decay from that moment at
    // the closed form's own rate (clamped — an early arrival still
    // brings home one boxful).
    const full = goods.fillOf(house) * goods.boxCap;
    const decayFrom = (at: number): number =>
      Math.max(0, Math.min(full, full * (1 - (t - at) / Math.max(1e-9, period - trip))));
    const com = committed.get(bk);
    if (com && com.cycle >= cyc) return decayFrom(com.at);
    if (u < trip) return 0; // out shopping per the clock — box ran dry
    if (tripWalking.has(bk)) return 0; // the real runner is still walking
    // Refill due, unwitnessed. Watched + continuously displayed: the
    // box never fills before the player's eyes — it waits for a real
    // shopper, or for the player to look away. Unwatched (or freshly
    // sighted): the off-screen truth catches up silently.
    const hc = houseCenter(town, house);
    const watched = lastP !== null && lastVisibleR !== undefined
      && Math.hypot(hc.x - lastP.x, hc.y - lastP.y) < lastVisibleR;
    if (watched && shownAgo < WATCH_STALE_SEC) return 0;
    committed.set(bk, { cycle: cyc, at: t - (u - trip) });
    return decayFrom(t - (u - trip));
  };

  return {
    update(p, live, now = 0, visibleR) {
      const spawn: ChunkUpdate["spawn"] = [];
      const despawn: string[] = [];
      const errands: ChunkUpdate["errands"] = [];
      lastP = { x: p.x, y: p.y };
      lastVisibleR = visibleR;

      // HOST TRUTH first: a body we think exists but the host doesn't
      // hold (addNpc was rejected in a budget race, or it was removed
      // elsewhere) is forgotten — it re-ranks and respawns below. This
      // is what stops "silent towns" from ledger drift.
      if (live) {
        for (const id of bodies.keys()) {
          if (!live.has(id)) {
            bodies.delete(id);
            bodyHouse.delete(id);
            tripSent.delete(id);
            dropTrip(id);
          }
        }
      }

      // Town data in/out (plans are cheap; hysteresis avoids flapping).
      for (const [key, town] of towns) {
        if (Math.hypot(town.center.x - p.x, town.center.y - p.y) > TOWN_UNLOAD_R) {
          towns.delete(key);
          replanAt.delete(key);
          // The town's witnessed-pantry ledger leaves with it.
          const prefix = `villager_${key}_`;
          for (const m of [committed, lastShown, tripWalking]) {
            for (const id of m.keys()) if (id.startsWith(prefix)) m.delete(id);
          }
        }
      }
      // Load the NEAREST missing town, ONE per update: a town plan is
      // EXPENSIVE at city scale (hundreds of ms of street growth) —
      // never stack two of them into a single frame.
      let toLoad: { key: string; center: { x: number; y: number } } | null = null;
      let toLoadD = TOWN_LOAD_R;
      for (const c of tri.cities) {
        if (towns.has(c.key)) continue;
        const center = worldPos(c.x, c.y);
        const d = Math.hypot(center.x - p.x, center.y - p.y);
        if (d < toLoadD) {
          toLoadD = d;
          toLoad = { key: c.key, center };
        }
      }
      if (toLoad) {
        const plan = townPlan(tri, toLoad.key, seed);
        const goods = streetGoodsFor(tri, { key: toLoad.key, center: toLoad.center, plan }, seed, plan.streets);
        towns.set(toLoad.key, {
          key: toLoad.key, center: toLoad.center, plan, goods,
          food: goods[0], wares: goods.find(g => g.good.key === "tools") ?? null,
          roads: plan.streets,
        });
      }

      // GROWTH while loaded: population moved → the plan re-derives.
      // Prefix stability means the rebuild only extends streets, appends
      // fringe lots, and maybe converts a lot into a stall — the town the
      // player is standing in doesn't reshuffle, it BUILDS (the view's
      // reveal trackers animate the difference as construction).
      // GOVERNED: a replan costs hundreds of ms, and the aggregate sim
      // moves the population a few souls every sim day — so replans fire
      // only when they'd CHANGE the town (a full town ignores demand it
      // can't house), only for meaningful moves (≥2% of the built lots),
      // at most one town per update and per cooldown window. This was
      // the city frame-rate crawl: full replans every sim day, rebuilding
      // a byte-identical overflowing town.
      let replanned = false;
      for (const [key, town] of towns) {
        if (replanned) break;
        const pop = Math.max(0, tri.dual.settlementScalar(key, "population"));
        const want = Math.max(6, Math.round(pop / HOUSEHOLD));
        if (want === town.plan.want) continue;
        // Overflowing town: demand above the built lots builds nothing,
        // however much it moves — skip until it drops below what stands.
        if (want > town.plan.built && town.plan.want > town.plan.built) continue;
        if (Math.abs(want - town.plan.want) < Math.max(2, Math.round(town.plan.built * 0.02))) continue;
        if (now - (replanAt.get(key) ?? -Infinity) < REPLAN_COOLDOWN_S) continue;
        replanAt.set(key, now);
        replanned = true;
        const plan = townPlan(tri, key, seed);
        const goods = streetGoodsFor(tri, { key, center: town.center, plan }, seed, plan.streets);
        const rebuilt: LoadedTown = {
          key, center: town.center, plan, goods,
          food: goods[0], wares: goods.find(g => g.good.key === "tools") ?? null,
          roads: plan.streets,
        };
        towns.set(key, rebuilt);
        // Re-point embodied residents at the new plan; a body whose lot
        // vanished (converted or abandoned) despawns via ranking below.
        for (const [id, bh] of bodyHouse) {
          if (bh.town.key !== key) continue;
          const house = plan.houses.find(h => h.index === bh.house.index);
          if (house) bodyHouse.set(id, { town: rebuilt, house });
          else {
            bodyHouse.delete(id);
            tripSent.delete(id);
            dropTrip(id);
          }
        }
      }

      // Candidates: a SPAWNED resident ranks by where their BODY is
      // (they wander); an unspawned one by their FOOD-CYCLE position —
      // home doorstep, or wherever along their shopping trip the clock
      // says they are, so the plaza has people in it before you arrive.
      const bodyPos = (id: string, fallback: { x: number; y: number }): { x: number; y: number } =>
        live?.get(id) ?? bodies.get(id) ?? fallback;
      /** Distance from p to the segment a–b (a shopper lives ON this
       *  segment — the player may stand near the path's middle while
       *  both ends are out of range). */
      const segDist = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
        return Math.hypot(a.x + abx * t - p.x, a.y + aby * t - p.y);
      };
      // RANK: raw distance for street life (someone out walking is
      // visible), distance + a heavy penalty for idle homebodies (the
      // view hides them behind their own door — the budget shouldn't
      // buy people nobody can see). The penalty is waived when the
      // player is inside that house: THEN the family being home is
      // exactly what's visible. Each house holds a HOUSEHOLD: the first
      // non-recruited members fill the ERRAND ROLES (member 0 the food
      // shopper, member 1 the wares runner where the town trades tools);
      // the other members are homebodies about the room.
      const candidates: Array<{
        id: string; town: LoadedTown; house: TownHouse; d: number; rank: number;
        x: number; y: number; walkTo?: Array<{ x: number; y: number; dwell?: number }>;
        home: { x: number; y: number }; indoor?: boolean; run?: GoodRun;
      }> = [];
      for (const town of towns.values()) {
        const runs = goodsRuns(town);
        for (const house of town.plan.houses) {
          const door = houseDoorstep(town.center, house);
          const playerInside = inHouseRect(p, town, house);
          const runnerOf = new Map<string, GoodRun>();
          for (const run of runs) {
            const id = roleMemberId(town.key, house.index, run.role);
            if (id) runnerOf.set(id, run);
          }
          const hk = householdKey(town.key, house.index);
          // Homebodies matter only up close (they're indoors, hidden
          // until the player steps in) — one cheap gate for the family.
          const hc = houseCenter(town, house);
          const homeNear = playerInside
            || Math.hypot(hc.x - p.x, hc.y - p.y) <= IDLE_EMBODY_R + 8;
          for (let m = 0; m < HOUSEHOLD; m++) {
            const id = villagerNpcId(town.key, memberIndex(house.index, m));
            if (excluded.has(id)) continue;
            const run = runnerOf.get(id);
            if (bodies.has(id)) {
              const at = bodyPos(id, door);
              const d = Math.hypot(at.x - p.x, at.y - p.y);
              if (d > PEOPLE_R) continue;
              const walking = run !== undefined
                && tripWalking.get(boxKey(hk, run.goods))?.npcId === id;
              const idle = !walking
                && (!run || run.goods.errand(house, now).phase === "home");
              const rank = idle && !playerInside ? d + IDLE_RANK_PENALTY : d;
              candidates.push({ id, town, house, d, rank, x: at.x, y: at.y, home: houseCenter(town, house) });
              continue;
            }
            if (!run) {
              // A homebody: indoors at their own spot in the room.
              if (!homeNear) continue;
              const spot = memberSpot(town, house, m);
              const d = Math.hypot(spot.x - p.x, spot.y - p.y);
              if (d > PEOPLE_R) continue;
              const rank = playerInside ? d : d + IDLE_RANK_PENALTY;
              candidates.push({
                id, town, house, d, rank, x: spot.x, y: spot.y, home: spot, indoor: true,
              });
              continue;
            }
            spawnRunner(id, town, house, door, playerInside, run);
          }
        }
      }
      /** An ERRAND RUNNER's streaming candidacy — where their good's
       *  cycle says they are, with the pop-in relocation rules. Split
       *  out so the member loop above stays readable. */
      function spawnRunner(
        id: string, town: LoadedTown, house: TownHouse,
        door: { x: number; y: number }, playerInside: boolean, run: GoodRun,
      ): void {
          // Cheap prefilter: their day happens near the door–source
          // corridor. The ROAD route bows outward from the chord, so
          // allow a generous sagitta margin before skipping.
          const src = run.goods.sourceOf(house);
          if (segDist(door, src) > PEOPLE_R + 120) return;
          const est = run.goods.errand(house, now);
          const d = Math.hypot(est.pos.x - p.x, est.pos.y - p.y);
          if (d > PEOPLE_R) return;
          if (est.phase === "home" && d > IDLE_EMBODY_R && !playerInside) return;
          const rank = est.phase === "home" && !playerInside ? d + IDLE_RANK_PENALTY : d;

          // WHERE the body materializes (the pop-in rule): people enter
          // the world through buildings, never onto open ground.
          //  - At home: spawn INSIDE the house (the view hides indoor
          //    villagers — they exist once they step out the door).
          //  - Mid-errand where the camera can see: spawn at the trip's
          //    SOURCE building and play the rest of the trip from there
          //    (they "were at the market" — a bounded, plausible slip
          //    of the clock instead of a body from thin air).
          //  - Mid-errand off-camera: spawn on-route as before (the
          //    plaza still has people in it before you arrive).
          let at = est.pos;
          let walkTo = est.walkTo;
          let indoor = false;
          if (est.phase === "home") {
            at = {
              x: town.center.x + house.dx + house.w / 2,
              y: town.center.y + house.dy + house.h / 2,
            };
            indoor = true;
          } else if (visibleR !== undefined && d < visibleR) {
            at = { x: est.source.x, y: est.source.y };
            if (est.phase === "to_source" && walkTo) {
              // Skip the outbound leg they no longer walk: resume from
              // the stall (its dwell point) onward.
              const dwellAt = walkTo.findIndex(pt => pt.dwell !== undefined);
              if (dwellAt > 0) walkTo = walkTo.slice(dwellAt);
            }
            if (est.source.work !== undefined) {
              const wk = town.plan.works[est.source.work];
              if (wk) {
                // Inside the source building, exiting through its door
                // (the transit sandwich) before the rest of the trip.
                at = { x: town.center.x + wk.dx + wk.w / 2, y: town.center.y + wk.dy + wk.h / 2 };
                const door = doorTransit(town.center, wk);
                walkTo = [door.inside, door.outside, ...(walkTo ?? [])];
              }
            }
          }
          // A mid-trip body ends its errand at the doorstep — send it on
          // through its own door so it settles indoors (and stops
          // grinding on the door frame trying to get back in).
          if (walkTo && !indoor) {
            walkTo = throughDoor(town, house, walkTo, false, run.box(town.center, house));
          }
          candidates.push({
            id, town, house, d, rank, x: at.x, y: at.y,
            ...(walkTo ? { walkTo } : {}), home: houseCenter(town, house), indoor, run,
          });
      }
      candidates.sort((a, b) => a.rank - b.rank);
      const budget = Math.max(0, npcBudget());

      // LOCKED: spawned residents whose body is beside the player never
      // blink out — they hold their slot first (capped at the budget:
      // engine-cap pressure still wins). A body idling INSIDE its own
      // house holds no lock (the view hides it — culling it is not a
      // blink-out) unless the player is in there looking at them. The
      // rest of the budget fills best-rank-first; eviction happens only
      // outside the lock radius.
      const desired = new Map<string, (typeof candidates)[number]>();
      for (const c of candidates) {
        if (desired.size >= budget) break;
        if (!bodies.has(c.id) || c.d >= PEOPLE_EVICT_MIN) continue;
        if (inHouseRect(c, c.town, c.house) && !inHouseRect(p, c.town, c.house)) continue;
        desired.set(c.id, c);
      }
      for (const c of candidates) {
        if (desired.size >= budget) break;
        if (!desired.has(c.id)) desired.set(c.id, c);
      }

      for (const id of bodies.keys()) {
        if (!desired.has(id)) {
          despawn.push(id);
          bodies.delete(id);
          bodyHouse.delete(id);
          tripSent.delete(id);
          dropTrip(id);
        }
      }
      for (const [id, c] of desired) {
        if (bodies.has(id)) continue;
        const sample = tri.dual.sampleVillager(c.town.key, villagerOf(id)!.index);
        if (!sample) continue;
        bodies.set(id, { x: c.x, y: c.y });
        bodyHouse.set(id, { town: c.town, house: c.house });
        // Spawn wherever the food cycle says they are — at their door,
        // or mid-trip with the rest of the trip as waypoints. The wander
        // tether anchors to their HOME either way, so a shopper drifts
        // back to their own street once the errand ends.
        spawn.push({
          npc: {
            id,
            x: c.x,
            y: c.y,
            name: sample.name,
            behavior: {
              movement: "wander", conversationRadius: 5,
              // Tethered to the house CENTER: idle bodies shuffle indoors
              // (small radius) rather than straying into their own walls,
              // and errands cross the door explicitly (throughDoor).
              wanderRadius: INDOOR_WANDER_R, home: c.home,
              // Bodies walk at the SAME pace the food cycle projects, so
              // an embodied trip and its clock stay in step.
              speed: ERRAND_WALK,
            },
            persona: { interestHints: sample.traitKeys.filter(t => t !== "human").slice(0, 3) },
          },
          ...(c.walkTo ? { walkTo: c.walkTo } : {}),
        });
        if (c.walkTo && c.run) {
          // Their current trip is already underway — don't re-issue it,
          // and hold that good's box refill for their actual arrival.
          const cyc = c.run.goods.errand(c.house, now).cycle;
          tripSent.set(id, cyc);
          tripWalking.set(boxKey(householdKey(c.town.key, c.house.index), c.run.goods), { npcId: id, cycle: cyc });
        }
      }

      // Live shopping trips: an embodied ERRAND RUNNER whose good's
      // cycle entered its trip window is sent out — once per cycle (the
      // box model: it ran dry, they go fill it). The waypoints ride the
      // ROADS, so runners walk streets instead of grinding into house
      // walls, and the trip is bracketed by door transits (out of home,
      // back in at the end) so the one obstacle in town — the doorway —
      // is crossed cleanly at both ends. Homebody members never shop.
      for (const [id, bh] of bodyHouse) {
        if (despawn.includes(id)) continue;
        const run = runFor(bh.town, bh.house.index, id);
        if (!run) continue;
        const est = run.goods.errand(bh.house, now);
        if (est.phase === "home" || !est.walkTo) continue;
        if (tripSent.get(id) === est.cycle) continue;
        tripSent.set(id, est.cycle);
        tripWalking.set(boxKey(householdKey(bh.town.key, bh.house.index), run.goods), { npcId: id, cycle: est.cycle });
        errands.push({ id, points: throughDoor(bh.town, bh.house, est.walkTo, true, run.box(bh.town.center, bh.house)) });
      }

      // Structures: the buildings around the player become REAL walls
      // and swinging doors (the same engine machinery bounded scenes
      // used — this is an overhead view of the same engine). Hysteresis:
      // keep what's loaded until it drifts past the unload radius.
      const nearNow = buildingsNear(p, STRUCT_LOAD_R);
      const keepable = buildingsNear(p, STRUCT_UNLOAD_R);
      let changed = false;
      for (const id of solid) {
        if (!keepable.has(id)) {
          solid.delete(id);
          changed = true;
        }
      }
      for (const id of nearNow.keys()) {
        if (!solid.has(id)) {
          solid.add(id);
          changed = true;
        }
      }
      let buildings: BuildingSpec[] | undefined;
      const addObjects: ObjectSpec[] = [];
      const removeObjects: string[] = [];
      if (changed) {
        buildings = [];
        for (const id of solid) {
          const b = keepable.get(id) ?? nearNow.get(id);
          if (b) buildings.push(b);
        }
        // FURNITURE follows its house (same rule the symbol game's town
        // stage runs — the shared furniture model is the parity source).
        for (const id of [...furnished]) {
          if (solid.has(id)) continue;
          for (const o of furnitureCatalog.get(id) ?? []) removeObjects.push(o.id);
          furnished.delete(id);
        }
        for (const id of solid) {
          if (furnished.has(id) || !furnitureCatalog.has(id)) continue;
          addObjects.push(...furnitureCatalog.get(id)!);
          furnished.add(id);
        }
      }

      return {
        spawn, despawn, errands,
        ...(buildings ? { buildings } : {}),
        ...(addObjects.length ? { addObjects } : {}),
        ...(removeObjects.length ? { removeObjects } : {}),
      };
    },
    loaded() {
      return [...towns.values()];
    },
    active() {
      return bodies.size;
    },
    pantry(town, house, t) {
      return boxLevel(town, town.food, house, t);
    },
    wares(town, house, t) {
      return town.wares ? boxLevel(town, town.wares, house, t) : null;
    },
    goodBox(town, goodIndex, house, t) {
      return boxLevel(town, town.goods[goodIndex], house, t);
    },
    tripArrived(npcId, now) {
      const hk = householdKeyOf(npcId);
      if (!hk) return;
      // Which good's box this arrival fills: the run the body is
      // assigned, else whichever walked trip names it (a body released
      // between issue and arrival).
      const bh = bodyHouse.get(npcId);
      const run = bh ? runFor(bh.town, bh.house.index, npcId) : null;
      let bk = run ? boxKey(hk, run.goods) : null;
      if (bk === null) {
        for (const [k, v] of tripWalking) if (v.npcId === npcId) { bk = k; break; }
      }
      if (bk === null) return;
      const e = tripWalking.get(bk);
      if (e && e.npcId !== npcId) return; // a stale arrival — not this box's trip
      tripWalking.delete(bk);
      const cur = run && bh ? run.goods.errand(bh.house, now).cycle : 0;
      committed.set(bk, { cycle: e?.cycle ?? cur, at: now });
    },
    release(npcId) {
      excluded.add(npcId);
      bodies.delete(npcId);
      bodyHouse.delete(npcId);
      tripSent.delete(npcId);
      dropTrip(npcId);
    },
    restore(npcId) {
      excluded.delete(npcId);
    },
  };
}

/* ------------------------------ party -------------------------------- */

export interface Party {
  members: Histfig[];
  parkedAt: string | null;
}

export function createParty(): Party {
  return { members: [], parkedAt: null };
}

/** Pin a sampled villager into the party (they leave the aggregate:
 *  totalPop −1, histfigs +1 — the conservation checks know). */
export function recruitVillager(tri: TriWorld, party: Party, siteKey: string, index: number): Histfig | null {
  const fig = tri.dual.pinHistfig(siteKey, index, "party");
  if (fig) party.members.push(fig);
  return fig;
}

export function parkParty(party: Party, siteKey: string): void {
  party.parkedAt = party.members.length ? siteKey : null;
}

/** Release everyone back into the distribution (threshold-0.5 rebin). */
export function disbandParty(tri: TriWorld, party: Party): number {
  let released = 0;
  for (const m of party.members) {
    if (tri.dual.releaseHistfig(m.id)) released++;
  }
  party.members = [];
  party.parkedAt = null;
  return released;
}
