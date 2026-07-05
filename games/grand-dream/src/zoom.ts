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
 *   Composition→ every HOUSE has a resident drawn from the site's
 *                syndrome distribution (`sampleVillager(site, houseIdx)`
 *                — same person at the same door every visit, zero
 *                storage). Only the nearest few exist as world-engine
 *                bodies at any moment (`WorldHost.addNpc`/`removeNpc`,
 *                nearest-first within the engine's concurrent cap).
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
  buildingStructures,
  certifyWorldSpec,
  WORLD_MAX_NPCS,
  type BuildingSpec,
  type NpcSpec,
  type StructureSpec,
  type WallSpec,
  type WorldSpec,
} from "@shared/world-engine/index";
import type { Histfig, HistfigSample } from "@popusim/controller/World";
import type { TriWorld } from "./tri";
import { ERRAND_WALK, HOUSEHOLD, createTownFood, houseDoorstep, type TownFood } from "./food";
import { buildTownRoads, type TownRoads } from "./town-roads";

export { HOUSEHOLD };

/** Meters per substrate tile — a tile is a square kilometer. */
export const WORLD_TILE = 1000;

/** Tile-center in world units (meters). */
export function worldPos(tileX: number, tileY: number): { x: number; y: number } {
  return { x: (tileX + 0.5) * WORLD_TILE, y: (tileY + 0.5) * WORLD_TILE };
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

/* --------------------------- the town plan --------------------------- */
// One town, laid out at real scale from its live settlement scalars.
// Deterministic and PREFIX-STABLE: lots form a fixed outward sequence,
// house k always occupies lot k — population growth appends houses at
// the edge and never reshuffles the town the player knows.

export interface TownHouse {
  /** Lot index — also the resident's `sampleVillager` index. */
  index: number;
  /** Footprint min-corner relative to the town center, meters. */
  dx: number;
  dy: number;
  w: number;
  h: number;
  /** Door on the street-facing (center-facing) edge. */
  door: "north" | "south" | "east" | "west";
  color: string;
}

export interface TownWork {
  type: "hall" | "farm" | "mine" | "smelter" | "market";
  dx: number;
  dy: number;
  w: number;
  h: number;
  door: "north" | "south" | "east" | "west";
  color: string;
}

export interface TownField {
  dx: number;
  dy: number;
  w: number;
  h: number;
}

export interface TownPlan {
  key: string;
  biome: "farmland" | "mining";
  groundColor: string;
  /** Edge of the built-up area, meters from center. */
  radius: number;
  houses: TownHouse[];
  works: TownWork[];
  /** Cultivated patches beyond the houses (farmland biome). */
  fields: TownField[];
}

const HOUSE_COLORS = ["#a8875f", "#9b7a52", "#b5936b", "#8f7350"];
const WORK_STYLE: Record<TownWork["type"], { color: string; w: number; h: number }> = {
  hall: { color: "#8a6d3b", w: 16, h: 12 },
  farm: { color: "#c9a94e", w: 13, h: 9 },
  mine: { color: "#70707a", w: 13, h: 9 },
  smelter: { color: "#a05038", w: 13, h: 9 },
  market: { color: "#c9803a", w: 16, h: 10 },
};

/** A town this big (houses) gets a MARKETPLACE on the plaza: the outskirt
 *  farms are far enough that farm-gate shopping stops being how a town of
 *  this size feeds itself. Below it, people buy at the farm door. */
export const MARKET_MIN_HOUSES = 24;

/** The fixed lot sequence: concentric rings around a central plaza, with
 *  two cross streets kept clear. Yields as many lots as asked for. */
function lotAt(k: number, rng: () => number): { x: number; y: number } {
  // Ring geometry is closed-form so lot k never depends on how many lots
  // exist: ring i starts at radius 28 + 15*i and holds floor(2πr/14) —
  // village-dense packing that keeps even a several-thousand-soul town
  // comfortably inside its square-kilometer tile.
  // Radial jitter is ±1.5 ON PURPOSE: with house depth ≤ 6.5 the worst
  // corner reaches ~7.05 m off the ring line, and the ring ROADS sit at
  // 7.5 — every street stays walkably clear of every house by
  // construction (town-roads.ts routes on those center lines).
  let i = 0;
  let base = 0;
  for (; ; i++) {
    const r = 28 + 15 * i;
    const cap = Math.floor((2 * Math.PI * r) / 14);
    if (k < base + cap) {
      const slot = k - base;
      // Angular jitter is ±1 m of ARC (divide by r) — a fixed-angle
      // jitter grows with radius and had outer-ring houses overlapping
      // each other (±0.025 rad is ±6 m of arc at ring 14).
      const a = (slot / cap) * Math.PI * 2 + (i % 2 ? Math.PI / cap : 0) + ((rng() - 0.5) * 2) / r;
      return { x: Math.cos(a) * (r + (rng() - 0.5) * 3), y: Math.sin(a) * (r + (rng() - 0.5) * 3) };
    }
    base += cap;
  }
}

/** The door edge for a lot: face the NEAREST road. Houses flanking a
 *  cross street front the street; everyone else fronts the ring road on
 *  their plaza side (the center-facing edge). Depends only on the lot's
 *  geometry, so it is as prefix-stable as the lot itself. */
function doorFor(x: number, y: number): TownHouse["door"] {
  const SPOKE_NEAR = 13; // within this of a cross street, front the street
  if (Math.abs(x) < SPOKE_NEAR && Math.abs(x) <= Math.abs(y)) return x > 0 ? "west" : "east";
  if (Math.abs(y) < SPOKE_NEAR && Math.abs(y) < Math.abs(x)) return y > 0 ? "north" : "south";
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? "west" : "east") : (y > 0 ? "north" : "south");
}

export function townPlan(tri: TriWorld, siteKey: string, seed: number): TownPlan {
  const city = tri.cities.find(c => c.key === siteKey);
  if (!city) throw new Error(`townPlan: unknown city "${siteKey}"`);
  const { dual } = tri;

  const ch = tri.charterOf(siteKey);
  const biome: TownPlan["biome"] = ch.ore_access > ch.farmland ? "mining" : "farmland";
  const fertMean = ch.farmland / 49;
  const groundColor = biome === "mining" ? "#8a8a90" : fertMean > 4 ? "#8fae62" : "#d6b87c";

  const pop = Math.max(0, dual.settlementScalar(siteKey, "population"));
  const houseCount = Math.max(6, Math.round(pop / HOUSEHOLD));

  // Houses on the lot sequence. Each lot's jitter rng is seeded by LOT
  // index, so house k is byte-identical whether the town has 50 houses
  // or 800 (prefix stability).
  const houses: TownHouse[] = [];
  let radius = 40;
  for (let k = 0; k < houseCount; k++) {
    const rng = mulberry32(hashSeed(seed, `${siteKey}:lot:${k}`));
    const lot = lotAt(k, rng);
    // Keep the two cross streets clear (roads run down them).
    if (Math.abs(lot.x) < 7 || Math.abs(lot.y) < 7) continue;
    const w = 6.5 + rng() * 2.5;
    const h = 5 + rng() * 1.5; // depth bounded so ring roads stay clear
    const door = doorFor(lot.x, lot.y);
    houses.push({
      index: k,
      dx: lot.x - w / 2,
      dy: lot.y - h / 2,
      w, h, door,
      color: HOUSE_COLORS[hashSeed(seed, `${siteKey}:c:${k}`) % HOUSE_COLORS.length],
    });
    const rr = Math.hypot(lot.x, lot.y) + 12;
    if (rr > radius) radius = rr;
  }

  // Civic + production on the outskirt ring, one building per counted
  // unit (capped — these are landmarks, not the industry ledger).
  const works: TownWork[] = [];
  const workCounts: Array<[TownWork["type"], number]> = [
    ["hall", 1],
    ["market", houses.length >= MARKET_MIN_HOUSES ? 1 : 0],
    ["farm", Math.min(6, Math.round(dual.settlementScalar(siteKey, "farms")))],
    ["mine", Math.min(6, Math.round(dual.settlementScalar(siteKey, "mines")))],
    ["smelter", Math.min(4, Math.round(dual.settlementScalar(siteKey, "smelters")))],
  ];
  let w = 0;
  const workRing = radius + 14;
  const totalWorks = workCounts.reduce((a, [, n]) => a + n, 0);
  for (const [type, n] of workCounts) {
    const style = WORK_STYLE[type];
    for (let k = 0; k < n; k++, w++) {
      if (type === "hall") {
        // The hall stands INSIDE the plaza (its far corner stays within
        // the plaza ring road at 22), door fronting the north street
        // mouth — plaza traffic circles it on the ring.
        works.push({ type, dx: -style.w / 2, dy: -5.5 - style.h, w: style.w, h: style.h, door: "north", color: style.color });
        continue;
      }
      if (type === "market") {
        // The market backs onto the hall across the plaza center, door
        // fronting the south street mouth.
        works.push({ type, dx: -style.w / 2, dy: 6.5, w: style.w, h: style.h, door: "south", color: style.color });
        continue;
      }
      // Keep workshops OFF the four road spokes (the spokes run out
      // through the work ring — a smelter astride the street would
      // block it): nudge any near-axis angle clear.
      let a = (w / Math.max(1, totalWorks)) * Math.PI * 2 + 0.7;
      const minAng = 14 / workRing;
      const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(a - q) < minAng) a = q + (a >= q ? minAng : -minAng);
      const x = Math.cos(a) * workRing;
      const y = Math.sin(a) * workRing;
      const door = Math.abs(x) > Math.abs(y) ? (x > 0 ? "west" : "east") : (y > 0 ? "north" : "south");
      works.push({ type, dx: x - style.w / 2, dy: y - style.h / 2, w: style.w, h: style.h, door, color: style.color });
    }
  }

  // Fields: cultivated patches past the buildings (farmland towns).
  const fields: TownField[] = [];
  if (biome === "farmland") {
    const patches = Math.min(14, 2 + Math.round(dual.settlementScalar(siteKey, "farms")) * 2);
    for (let k = 0; k < patches; k++) {
      const rng = mulberry32(hashSeed(seed, `${siteKey}:field:${k}`));
      const a = (k / patches) * Math.PI * 2 + rng() * 0.3;
      const r = workRing + 40 + rng() * 60;
      fields.push({ dx: Math.cos(a) * r - 23, dy: Math.sin(a) * r - 17, w: 46 + rng() * 20, h: 34 + rng() * 14 });
    }
  }

  return { key: siteKey, biome, groundColor, radius: workRing + 10, houses, works, fields };
}

/** The streaming NPC id for a resident — parse back with `villagerOf`. */
export function villagerNpcId(siteKey: string, index: number): string {
  return `villager_${siteKey}_${index}`;
}

/** Reverse of `villagerNpcId`: which sampled person an NPC id names. */
export function villagerOf(npcId: string): { siteKey: string; index: number } | null {
  const m = /^villager_(.+)_(\d+)$/.exec(npcId);
  return m ? { siteKey: m[1], index: parseInt(m[2], 10) } : null;
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
    type: "hall" | "farm" | "mine" | "smelter";
    color: string;
    dx: number;
    dy: number;
    w: number;
    h: number;
    door: { edge: "north" | "south" | "east" | "west"; offset: number; width: number };
  }>;
  villagers: CityVillager[];
}

const BUILDING_STYLE: Record<"hall" | "farm" | "mine" | "smelter", { color: string; w: number; h: number }> = {
  hall: { color: "#8a6d3b", w: 7, h: 6 },
  farm: { color: "#c9a94e", w: 6, h: 5 },
  mine: { color: "#70707a", w: 6, h: 5 },
  smelter: { color: "#a05038", w: 6, h: 5 },
};

export function cityContent(tri: TriWorld, siteKey: string, seed: number): CityContent {
  const city = tri.cities.find(c => c.key === siteKey);
  if (!city) throw new Error(`cityContent: unknown city "${siteKey}"`);
  const { dual } = tri;
  const rng = mulberry32(hashSeed(seed, siteKey));

  const ch = tri.charterOf(siteKey);
  const biome: CityContent["biome"] = ch.ore_access > ch.farmland ? "mining" : "farmland";
  const fertMean = ch.farmland / (PATCH_SIDE * PATCH_SIDE);
  const groundColor = biome === "mining" ? "#8a8a90" : fertMean > 4 ? "#8fae62" : "#d6b87c";

  const counts: Array<["hall" | "farm" | "mine" | "smelter", number]> = [
    ["hall", 1],
    ["farm", Math.round(dual.settlementScalar(siteKey, "farms"))],
    ["mine", Math.round(dual.settlementScalar(siteKey, "mines"))],
    ["smelter", Math.round(dual.settlementScalar(siteKey, "smelters"))],
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
  outer: for (const [type, n] of counts) {
    const style = BUILDING_STYLE[type];
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
          door: { edge, offset: along / 2 - 1, width: 2 },
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
//   the houses nearest the player: every update picks the K nearest
//   candidates inside PEOPLE_R (K = the live NPC budget) and diffs
//   against what's spawned — walk down a street and the people of THESE
//   houses are up and about, the previous street's have gone back
//   indoors. Recruited residents are excluded for the session.

/** Town DATA loads inside this (meters)... */
export const TOWN_LOAD_R = 1600;
/** ...and unloads past this (hysteresis). */
export const TOWN_UNLOAD_R = 2000;
/** Residents may embody within this range of the player (meters) —
 *  beyond the camera's street-level reach, so bodies appear off-screen. */
export const PEOPLE_R = 240;
/** A resident whose BODY is this close to the player never despawns
 *  (someone standing next to you cannot blink out): eviction happens
 *  beyond this, as the crowd turns over off to the sides. */
export const PEOPLE_EVICT_MIN = 60;
/** How far a resident strays from their doorstep — kept to their own
 *  yard and street; going further is what errands (roads) are for. */
const RESIDENT_WANDER_R = 10;
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
  /** The town's food-economy projection (street-level add-on to the
   *  aggregate consume behavior — see food.ts). */
  food: TownFood;
  /** The street network (rings + spokes) — errands ride it, the view
   *  draws it, houses face it. */
  roads: TownRoads;
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
  /** New streamed structure set for `WorldHost.setStructures` — walls +
   *  swinging doors of the buildings around the player. Undefined when
   *  the in-range building set did not change this update. */
  structures?: StructureSpec[];
}

export interface TownManager {
  /** Reconcile loaded towns + embodied residents against the player.
   *  `live` is the host's ACTUAL avatar positions — the source of truth:
   *  a body the host rejected or dropped is forgotten (and respawns if
   *  still ranked), and ranking uses where people ARE, not where their
   *  house is, so a wanderer beside the player never blinks out.
   *  `now` (seconds) drives the food-economy clock: unspawned residents
   *  rank/spawn at their shopping-cycle position, and embodied ones are
   *  sent on market trips when their cycle says the box ran dry. */
  update(p: { x: number; y: number }, live?: ReadonlyMap<string, { x: number; y: number }>, now?: number): ChunkUpdate;
  loaded(): LoadedTown[];
  /** Embodied residents currently on the host (budget sharing). */
  active(): number;
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
  /** Spawned resident id → doorstep position. */
  const bodies = new Map<string, { x: number; y: number }>();
  /** Spawned resident id → their house (for the live food cycle). */
  const bodyHouse = new Map<string, { town: LoadedTown; house: TownHouse }>();
  /** Last shopping cycle a trip errand was issued for, per body. */
  const tripSent = new Map<string, number>();
  /** Buildings currently lowered into REAL structures, by building id. */
  const solid = new Set<string>();

  /** Every building near p as a BuildingSpec at WORLD coordinates. */
  const buildingsNear = (p: { x: number; y: number }, range: number): Map<string, BuildingSpec> => {
    const out = new Map<string, BuildingSpec>();
    const consider = (townKey: string, center: { x: number; y: number }, id: string,
      b: { dx: number; dy: number; w: number; h: number; door: TownHouse["door"]; color: string }): void => {
      const cx = center.x + b.dx + b.w / 2;
      const cy = center.y + b.dy + b.h / 2;
      if (Math.hypot(cx - p.x, cy - p.y) > range) return;
      const along = b.door === "north" || b.door === "south" ? b.w : b.h;
      out.set(id, {
        id,
        footprint: { x: center.x + b.dx, y: center.y + b.dy, w: b.w, h: b.h },
        floors: 1,
        wallThickness: 0.4,
        doorways: [{ edge: b.door, offset: along / 2 - 1, width: 2 }],
        color: b.color,
      });
    };
    for (const town of towns.values()) {
      for (const h of town.plan.houses) consider(town.key, town.center, `h_${town.key}_${h.index}`, h);
      for (const [i, wk] of town.plan.works.entries()) consider(town.key, town.center, `w_${town.key}_${i}`, wk);
    }
    return out;
  };

  return {
    update(p, live, now = 0) {
      const spawn: ChunkUpdate["spawn"] = [];
      const despawn: string[] = [];
      const errands: ChunkUpdate["errands"] = [];

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
          }
        }
      }

      // Town data in/out (plans are cheap; hysteresis avoids flapping).
      for (const [key, town] of towns) {
        if (Math.hypot(town.center.x - p.x, town.center.y - p.y) > TOWN_UNLOAD_R) {
          towns.delete(key);
        }
      }
      for (const c of tri.cities) {
        if (towns.has(c.key)) continue;
        const center = worldPos(c.x, c.y);
        if (Math.hypot(center.x - p.x, center.y - p.y) < TOWN_LOAD_R) {
          const plan = townPlan(tri, c.key, seed);
          const roads = buildTownRoads(plan);
          const food = createTownFood(tri, { key: c.key, center, plan }, seed, roads);
          towns.set(c.key, { key: c.key, center, plan, food, roads });
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
      const candidates: Array<{
        id: string; town: LoadedTown; house: TownHouse; d: number;
        x: number; y: number; walkTo?: Array<{ x: number; y: number; dwell?: number }>;
        home: { x: number; y: number };
      }> = [];
      for (const town of towns.values()) {
        for (const house of town.plan.houses) {
          const id = villagerNpcId(town.key, house.index);
          if (excluded.has(id)) continue;
          const door = houseDoorstep(town.center, house);
          if (bodies.has(id)) {
            const at = bodyPos(id, door);
            const d = Math.hypot(at.x - p.x, at.y - p.y);
            if (d > PEOPLE_R) continue;
            candidates.push({ id, town, house, d, x: at.x, y: at.y, home: door });
            continue;
          }
          // Cheap prefilter: their day happens near the door–source
          // corridor. The ROAD route bows outward from the chord (ring
          // arcs), so allow a generous sagitta margin before skipping.
          const src = town.food.sourceOf(house);
          if (segDist(door, src) > PEOPLE_R + 120) continue;
          const est = town.food.errand(house, now);
          const d = Math.hypot(est.pos.x - p.x, est.pos.y - p.y);
          if (d > PEOPLE_R) continue;
          candidates.push({
            id, town, house, d, x: est.pos.x, y: est.pos.y,
            ...(est.walkTo ? { walkTo: est.walkTo } : {}), home: est.home,
          });
        }
      }
      candidates.sort((a, b) => a.d - b.d);
      const budget = Math.max(0, npcBudget());

      // LOCKED: spawned residents whose body is beside the player never
      // blink out — they hold their slot first (capped at the budget:
      // engine-cap pressure still wins). The rest of the budget fills
      // nearest-first; eviction happens only outside the lock radius.
      const desired = new Map<string, (typeof candidates)[number]>();
      for (const c of candidates) {
        if (desired.size >= budget) break;
        if (bodies.has(c.id) && c.d < PEOPLE_EVICT_MIN) desired.set(c.id, c);
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
        }
      }
      for (const [id, c] of desired) {
        if (bodies.has(id)) continue;
        const sample = tri.dual.sampleVillager(c.town.key, c.house.index);
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
              wanderRadius: RESIDENT_WANDER_R, home: c.home,
              // Bodies walk at the SAME pace the food cycle projects, so
              // an embodied trip and its clock stay in step.
              speed: ERRAND_WALK,
            },
            persona: { interestHints: sample.traitKeys.filter(t => t !== "human").slice(0, 3) },
          },
          ...(c.walkTo ? { walkTo: c.walkTo } : {}),
        });
        if (c.walkTo) {
          // Their current trip is already underway — don't re-issue it.
          tripSent.set(id, c.town.food.errand(c.house, now).cycle);
        }
      }

      // Live shopping trips: an embodied resident whose cycle entered
      // its trip window is sent out — once per cycle (the pantry model:
      // the box ran dry, they go fill it). The waypoints ride the ROADS,
      // so shoppers walk streets instead of grinding into house walls.
      for (const [id, bh] of bodyHouse) {
        if (despawn.includes(id)) continue;
        const est = bh.town.food.errand(bh.house, now);
        if (est.phase === "home" || !est.walkTo) continue;
        if (tripSent.get(id) === est.cycle) continue;
        tripSent.set(id, est.cycle);
        errands.push({ id, points: est.walkTo });
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
      let structures: StructureSpec[] | undefined;
      if (changed) {
        structures = [];
        for (const id of solid) {
          const b = keepable.get(id) ?? nearNow.get(id);
          if (b) structures.push(...buildingStructures(b));
        }
      }

      return { spawn, despawn, errands, ...(structures ? { structures } : {}) };
    },
    loaded() {
      return [...towns.values()];
    },
    active() {
      return bodies.size;
    },
    release(npcId) {
      excluded.add(npcId);
      bodies.delete(npcId);
      bodyHouse.delete(npcId);
      tripSent.delete(npcId);
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
