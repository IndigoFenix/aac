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
import { ERRAND_WALK, HOUSEHOLD, createTownFood, doorTransit, houseDoorstep, type TownFood } from "./food";
import { foundNeighborhoodMarkets } from "./districts";
import { growStreets, type TownStreets, type Vec2 } from "./streets";

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
  /** Door on the street-facing edge (houses front their street). */
  door: "north" | "south" | "east" | "west";
  color: string;
  /** Arterial subtree the house's street descends from (districts.ts). */
  arm?: number;
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
  /** Lots the population asked for (houses may be fewer if the town is
   *  full) — the cheap growth check TownManager compares against. */
  want: number;
  houses: TownHouse[];
  works: TownWork[];
  /** Cultivated patches beyond the houses (farmland biome). */
  fields: TownField[];
  /** The organic street tree the whole plan hangs off (streets.ts). */
  streets: TownStreets;
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

/** Door edge facing from a footprint center toward a target point. */
function doorToward(cx: number, cy: number, tx: number, ty: number): TownHouse["door"] {
  const dx = tx - cx;
  const dy = ty - cy;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "east" : "west") : (dy > 0 ? "south" : "north");
}

/* ---------------- typed growth bias (city-development §2b) ------------ */
// A town turns toward what feeds it: its arterials aim at its trade
// partners and its resource sides, and its works cap the tips that point
// the right way (farm gates toward the fertile tiles, the pithead toward
// the ore). Bearings are QUANTIZED (16 compass buckets) and memoized per
// session, so slow substrate drift (mining depletion, greening) doesn't
// re-lay a town under the player's feet — a re-boot long after the
// mountain emptied MAY re-lay it, which is development, not noise.

const BEARING_QUANT = Math.PI / 8;
const quantB = (a: number): number => Math.round(a / BEARING_QUANT) * BEARING_QUANT;

export interface TownBias {
  /** Arterial bearings, most important first (roads, then resources). */
  bearings: number[];
  /** Direction of the fertile side (radians), if the surroundings lean. */
  fertile: number | null;
  /** Direction of the ore side, likewise. */
  ore: number | null;
}

/** Weighted mean direction of a substrate field around the town's tile —
 *  null when the surroundings are symmetric (no side to lean toward). */
function fieldBearing(
  grid: { cols: number; rows: number; fields: Record<string, ArrayLike<number>> } | undefined,
  cx: number, cy: number, field: string, radius = 4,
): number | null {
  const vals = grid?.fields?.[field];
  if (!vals) return null;
  let vx = 0, vy = 0, sum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= grid!.rows) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = cx + dx;
      if (x < 0 || x >= grid!.cols) continue;
      const v = vals[y * grid!.cols + x];
      if (!(v > 0)) continue;
      const inv = 1 / Math.hypot(dx, dy);
      vx += v * dx * inv;
      vy += v * dy * inv;
      sum += v;
    }
  }
  if (sum <= 0) return null;
  if (Math.hypot(vx, vy) / sum < 0.15) return null; // symmetric — no lean
  return quantB(Math.atan2(vy, vx));
}

const biasMemo = new WeakMap<TriWorld, Map<string, TownBias>>();

/** The typed growth bias for a town (session-memoized — see above). */
export function townBias(tri: TriWorld, siteKey: string): TownBias {
  let memo = biasMemo.get(tri);
  if (!memo) {
    memo = new Map();
    biasMemo.set(tri, memo);
  }
  const hit = memo.get(siteKey);
  if (hit) return hit;

  const city = tri.cities.find(c => c.key === siteKey);
  const grid = tri.grid as unknown as Parameters<typeof fieldBearing>[0];
  const fertile = city ? fieldBearing(grid, city.x, city.y, "fertility") : null;
  const ore = city ? fieldBearing(grid, city.x, city.y, "ore") : null;

  // Roads out of town head where the road GOES: bearings toward up to
  // two route-connected neighbor cities (the high street is the highway).
  const bearings: number[] = [];
  if (city) {
    const routes = (tri.dual as { routes?: () => Array<{ site_a: { key: string } | null; site_b: { key: string } | null }> }).routes?.() ?? [];
    for (const r of routes) {
      if (bearings.length >= 2) break;
      const otherKey = r.site_a?.key === siteKey ? r.site_b?.key
        : r.site_b?.key === siteKey ? r.site_a?.key : null;
      if (!otherKey) continue;
      const other = tri.cities.find(c => c.key === otherKey);
      if (!other || (other.x === city.x && other.y === city.y)) continue;
      bearings.push(quantB(Math.atan2(other.y - city.y, other.x - city.x)));
    }
  }
  if (fertile !== null) bearings.push(fertile);
  if (ore !== null) bearings.push(ore);

  const bias: TownBias = { bearings, fertile, ore };
  memo.set(siteKey, bias);
  return bias;
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

  // The street tree grows first (streets.ts); houses fill its frontage
  // slots in CONSTRUCTION ORDER. Each lot's jitter rng is seeded by LOT
  // index and the street event stream is fixed by (seed, site, bias), so
  // house k is byte-identical whether the town has 50 houses or 800
  // (prefix stability) — growth extends streets and appends lots at the
  // fringe. The TYPED BIAS aims the arterials: out along the trade
  // roads, toward the fertile side, toward the ore.
  const bias = townBias(tri, siteKey);
  const net = growStreets(seed, siteKey, houseCount, { bearings: bias.bearings });
  const houses: TownHouse[] = [];
  let radius = 40;
  const count = Math.min(houseCount, net.slots.length);
  for (let k = 0; k < count; k++) {
    const slot = net.slots[k];
    const rng = mulberry32(hashSeed(seed, `${siteKey}:lot:${k}`));
    // Face the frontage anchor (the slot's own street), from the
    // UNJITTERED slot so the door edge never flips with the wobble.
    const door = doorToward(slot.x, slot.y, slot.ax, slot.ay);
    const depth = 5 + rng() * 1.5; // toward the street — keeps it clear
    const width = 6.5 + rng() * 2.5;
    const sideways = door === "east" || door === "west";
    const w = sideways ? depth : width;
    const h = sideways ? width : depth;
    const cx = slot.x + (rng() - 0.5) * 2;
    const cy = slot.y + (rng() - 0.5) * 2;
    houses.push({
      index: k,
      dx: cx - w / 2,
      dy: cy - h / 2,
      w, h, door,
      color: HOUSE_COLORS[hashSeed(seed, `${siteKey}:c:${k}`) % HOUSE_COLORS.length],
      arm: slot.arm,
    });
    const rr = Math.hypot(cx, cy) + 12;
    if (rr > radius) radius = rr;
  }

  // STEP 1 of the city fractal (city-development.md §7): neighborhood
  // market stalls founded by unserved demand, each a CONVERTED house lot
  // (same footprint and door, so it stays on its street frontage).
  // The founding anchor is the town's central source — the plaza market
  // when the town rates one, else the hall (both at fixed plaza spots,
  // so founding stays prefix-stable as the town grows).
  const hasPlazaMarket = houses.length >= MARKET_MIN_HOUSES;
  const mkStyle = WORK_STYLE.market;
  const anchor = hasPlazaMarket
    ? { x: 0, y: 6.5 + mkStyle.h + 1.5 } // plaza market doorstep (south)
    : { x: 0, y: -5.5 - WORK_STYLE.hall.h - 1.5 }; // hall doorstep (north)
  const stalls = foundNeighborhoodMarkets(houses, anchor, net);
  const stallIdx = new Set(stalls.map(s => s.index));
  const homes = stallIdx.size ? houses.filter(h => !stallIdx.has(h.index)) : houses;

  // Civic buildings hold the plaza; production works cap the street TIPS
  // (the town's edge, where the lanes peter out into fields and pits) —
  // one building per counted unit (capped: landmarks, not the ledger).
  const works: TownWork[] = [];
  works.push({
    // The hall stands INSIDE the plaza, door fronting north.
    type: "hall", dx: -WORK_STYLE.hall.w / 2, dy: -5.5 - WORK_STYLE.hall.h,
    w: WORK_STYLE.hall.w, h: WORK_STYLE.hall.h, door: "north", color: WORK_STYLE.hall.color,
  });
  if (hasPlazaMarket) {
    // The market backs onto the hall across the plaza center.
    works.push({
      type: "market", dx: -mkStyle.w / 2, dy: 6.5,
      w: mkStyle.w, h: mkStyle.h, door: "south", color: mkStyle.color,
    });
  }

  // Street tips — where the works go. Each type prefers the tips that
  // POINT THE RIGHT WAY (typed placement, city-development §2b): farm
  // gates toward the fertile side, mine/smelter toward the ore side,
  // outskirts-ness as the tiebreak (and the whole rule when the
  // surroundings are symmetric).
  const tips: Array<{ p: Vec2; dir: { x: number; y: number } }> = [];
  let maxTipR = 1;
  for (const s of net.streets) {
    if (s.ring || s.pts.length < 3) continue;
    const p = s.pts[s.pts.length - 1];
    const q = s.pts[s.pts.length - 2];
    const len = Math.hypot(p.x - q.x, p.y - q.y) || 1;
    tips.push({ p, dir: { x: (p.x - q.x) / len, y: (p.y - q.y) / len } });
    maxTipR = Math.max(maxTipR, Math.hypot(p.x, p.y));
  }
  const usedTips = new Set<number>();
  const bestTip = (toward: number | null): number => {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < tips.length; i++) {
      if (usedTips.has(i)) continue;
      const t = tips[i];
      const r = Math.hypot(t.p.x, t.p.y);
      const align = toward === null ? 0 : Math.cos(Math.atan2(t.p.y, t.p.x) - toward);
      const score = align * 0.75 + (r / maxTipR) * 0.45;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  };
  const workCounts: Array<[TownWork["type"], number]> = [
    ["farm", Math.min(6, Math.round(dual.settlementScalar(siteKey, "farms")))],
    ["mine", Math.min(6, Math.round(dual.settlementScalar(siteKey, "mines")))],
    ["smelter", Math.min(4, Math.round(dual.settlementScalar(siteKey, "smelters")))],
  ];
  const farmSpots: Array<{ x: number; y: number }> = [];
  for (const [type, n] of workCounts) {
    const style = WORK_STYLE[type];
    const toward = type === "farm" ? bias.fertile : bias.ore;
    for (let k = 0; k < n; k++) {
      let placed = false;
      for (;;) {
        const i = bestTip(toward);
        if (i < 0) break;
        usedTips.add(i);
        const t = tips[i];
        const x = t.p.x + t.dir.x * 13;
        const y = t.p.y + t.dir.y * 13;
        if (works.some(wk => Math.hypot(wk.dx + wk.w / 2 - x, wk.dy + wk.h / 2 - y) < 22)) continue;
        const door = doorToward(x, y, t.p.x, t.p.y); // door faces back up the street
        works.push({ type, dx: x - style.w / 2, dy: y - style.h / 2, w: style.w, h: style.h, door, color: style.color });
        if (type === "farm") farmSpots.push({ x, y });
        const rr = Math.hypot(x, y) + 14;
        if (rr > radius) radius = rr;
        placed = true;
        break;
      }
      if (!placed) {
        // Tips ran out (tiny towns): fall back to the town edge, still
        // leaning the typed way when there is one.
        const a = toward ?? (works.length / 6) * Math.PI * 2 + 0.7;
        const spread = toward === null ? 0 : (k - (n - 1) / 2) * 0.5;
        const x = Math.cos(a + spread) * (radius + 14);
        const y = Math.sin(a + spread) * (radius + 14);
        const door = doorToward(x, y, 0, 0);
        works.push({ type, dx: x - style.w / 2, dy: y - style.h / 2, w: style.w, h: style.h, door, color: style.color });
        if (type === "farm") farmSpots.push({ x, y });
      }
    }
  }
  // The founded stalls, in founding order (after the plaza market, so
  // `works.find(type === "market")` stays the plaza one).
  for (const s of stalls) {
    works.push({ type: "market", dx: s.dx, dy: s.dy, w: s.w, h: s.h, door: s.door, color: mkStyle.color });
  }

  // Fields: cultivated patches past the farm gates (farmland towns) —
  // the countryside starts where the lanes end.
  const fields: TownField[] = [];
  if (biome === "farmland") {
    const anchors = farmSpots.length
      ? farmSpots
      : tips.slice(0, 2).map(t => ({ x: t.p.x, y: t.p.y }));
    if (anchors.length === 0) anchors.push({ x: radius, y: 0 });
    const patches = Math.min(14, 2 + Math.round(dual.settlementScalar(siteKey, "farms")) * 2);
    for (let k = 0; k < patches; k++) {
      const rng = mulberry32(hashSeed(seed, `${siteKey}:field:${k}`));
      const at = anchors[k % anchors.length];
      const rr = Math.hypot(at.x, at.y) || 1;
      const ux = at.x / rr;
      const uy = at.y / rr;
      const out = 30 + rng() * 60;
      const side = (rng() - 0.5) * 90;
      fields.push({
        dx: at.x + ux * out - uy * side - 23,
        dy: at.y + uy * out + ux * side - 17,
        w: 46 + rng() * 20,
        h: 34 + rng() * 14,
      });
    }
  }

  return {
    key: siteKey, biome, groundColor, radius: radius + 10,
    want: houseCount, houses: homes, works, fields, streets: net,
  };
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
/** Wander tether radius for a resident, anchored at their house CENTER:
 *  a shuffle inside their own four walls, not a stroll — they leave the
 *  house only on an errand (which crosses the door explicitly), never by
 *  steering into a wall, and while home they sit under the indoor cull. */
const INDOOR_WANDER_R = 2.5;
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
   *  home; the return step (…→inside) is always appended so the shopper
   *  ends up back indoors. */
  const throughDoor = (
    town: LoadedTown, h: TownHouse,
    walkTo: Array<{ x: number; y: number; dwell?: number }>, exitFirst: boolean,
  ): Array<{ x: number; y: number; dwell?: number }> => {
    const d = doorTransit(town.center, h);
    const pts = exitFirst ? [d.inside, d.outside, ...walkTo] : [...walkTo];
    pts.push(d.inside);
    return pts;
  };

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
      for (const h of town.plan.houses) consider(town.key, town.center, `h_${town.key}_${h.index}`, h);
      for (const [i, wk] of town.plan.works.entries()) consider(town.key, town.center, `w_${town.key}_${i}`, wk);
    }
    return out;
  };

  return {
    update(p, live, now = 0, visibleR) {
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
          const food = createTownFood(tri, { key: c.key, center, plan }, seed, plan.streets);
          towns.set(c.key, { key: c.key, center, plan, food, roads: plan.streets });
        }
      }

      // GROWTH while loaded: population moved → the plan re-derives.
      // Prefix stability means the rebuild only extends streets, appends
      // fringe lots, and maybe converts a lot into a stall — the town the
      // player is standing in doesn't reshuffle, it BUILDS (the view's
      // reveal trackers animate the difference as construction).
      for (const [key, town] of towns) {
        const pop = Math.max(0, tri.dual.settlementScalar(key, "population"));
        const want = Math.max(6, Math.round(pop / HOUSEHOLD));
        if (want === town.plan.want) continue;
        const plan = townPlan(tri, key, seed);
        const food = createTownFood(tri, { key, center: town.center, plan }, seed, plan.streets);
        const rebuilt: LoadedTown = { key, center: town.center, plan, food, roads: plan.streets };
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
      const candidates: Array<{
        id: string; town: LoadedTown; house: TownHouse; d: number;
        x: number; y: number; walkTo?: Array<{ x: number; y: number; dwell?: number }>;
        home: { x: number; y: number }; indoor?: boolean;
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
            candidates.push({ id, town, house, d, x: at.x, y: at.y, home: houseCenter(town, house) });
            continue;
          }
          // Cheap prefilter: their day happens near the door–source
          // corridor. The ROAD route bows outward from the chord, so
          // allow a generous sagitta margin before skipping.
          const src = town.food.sourceOf(house);
          if (segDist(door, src) > PEOPLE_R + 120) continue;
          const est = town.food.errand(house, now);
          const d = Math.hypot(est.pos.x - p.x, est.pos.y - p.y);
          if (d > PEOPLE_R) continue;

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
          if (walkTo && !indoor) walkTo = throughDoor(town, house, walkTo, false);
          candidates.push({
            id, town, house, d, x: at.x, y: at.y,
            ...(walkTo ? { walkTo } : {}), home: houseCenter(town, house), indoor,
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
        if (c.walkTo) {
          // Their current trip is already underway — don't re-issue it.
          tripSent.set(id, c.town.food.errand(c.house, now).cycle);
        }
      }

      // Live shopping trips: an embodied resident whose cycle entered
      // its trip window is sent out — once per cycle (the pantry model:
      // the box ran dry, they go fill it). The waypoints ride the ROADS,
      // so shoppers walk streets instead of grinding into house walls,
      // and the trip is bracketed by door transits (out of home, back
      // in at the end) so the one obstacle in town — the doorway — is
      // crossed cleanly at both ends.
      for (const [id, bh] of bodyHouse) {
        if (despawn.includes(id)) continue;
        const est = bh.town.food.errand(bh.house, now);
        if (est.phase === "home" || !est.walkTo) continue;
        if (tripSent.get(id) === est.cycle) continue;
        tripSent.set(id, est.cycle);
        errands.push({ id, points: throughDoor(bh.town, bh.house, est.walkTo, true) });
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
