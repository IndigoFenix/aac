/**
 * plan.ts — ONE TOWN, laid out at real scale from its live settlement
 * scalars (grand-dream zoom.ts's town-plan half until the engine carve;
 * that file re-exports this and keeps the streaming/NPC machinery).
 * Deterministic and PREFIX-STABLE: lots form a fixed outward sequence,
 * house k always occupies lot k — population growth appends houses at
 * the edge and never reshuffles the town the player knows.
 *
 * Everything reads through the TownHost seam (host.ts) plus an explicit
 * compiled-economy registry: which registry (and any fallback) is the
 * game's concern, never this module's.
 */

import type { CompiledEconomy } from "../modules/economy/economy";
import type { TownHost } from "./host";
import { HOUSEHOLD } from "./goods";
import { TOWN_DIMS } from "./dimensions";
import { foundNeighborhoodMarkets } from "./districts";
import { growStreets, type TownStreets, type Vec2 } from "./streets";

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
  /** Storeys (≥1). Rises under housing pressure when the town's
   *  BUILD-UP knob allows it — center first (see townPlan). */
  floors: number;
  /** Arterial subtree the house's street descends from (districts.ts). */
  arm?: number;
}

export interface TownWork {
  /** Work type — a registered building key (the world's compiled
   *  economy registry), or the STRUCTURAL "hall" / "market" every town
   *  can grow. An open string: content defines the vocabulary. */
  type: string;
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
  /** Household capacity PROVIDED: lots actually placed (homes +
   *  converted stalls) plus upper storeys the build-up knob added.
   *  `built < want` means the town is full — extra demand builds
   *  nothing, and the growth governor skips replans that couldn't
   *  change the town. */
  built: number;
  houses: TownHouse[];
  works: TownWork[];
  /** Cultivated patches beyond the houses (farmland biome). */
  fields: TownField[];
  /** The organic street tree the whole plan hangs off (streets.ts). */
  streets: TownStreets;
}

const HOUSE_COLORS = ["#a8875f", "#9b7a52", "#b5936b", "#8f7350"];
/** STRUCTURAL works only — every economy building's style lives in its
 *  registry def (economy.ts BuildingDef.style). Footprints from the
 *  realistic-scale knob set (dimensions.ts). */
const WORK_STYLE: Record<"hall" | "market", { color: string; w: number; h: number }> = {
  hall: { color: "#8a6d3b", w: TOWN_DIMS.hallW, h: TOWN_DIMS.hallH },
  market: { color: "#c9803a", w: TOWN_DIMS.marketW, h: TOWN_DIMS.marketH },
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
  /** Direction of the wooded side (the `plant` field) — sawmills lean
   *  this way. NOT an arterial bearing: adding it would re-lay every
   *  existing street tree; only work placement reads it. */
  timber: number | null;
  /** Bearing per substrate FIELD (whatever the world's work registry
   *  leans toward) — fertile/ore/timber above are the named aliases. */
  toward: Record<string, number | null>;
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

const biasMemo = new WeakMap<TownHost, Map<string, TownBias>>();

/** The typed growth bias for a town (session-memoized — see above). */
export function townBias(tri: TownHost, eco: CompiledEconomy, siteKey: string): TownBias {
  let memo = biasMemo.get(tri);
  if (!memo) {
    memo = new Map();
    biasMemo.set(tri, memo);
  }
  const hit = memo.get(siteKey);
  if (hit) return hit;

  const city = tri.cities.find(c => c.key === siteKey);
  const grid = tri.grid as Parameters<typeof fieldBearing>[0];
  // One bearing per field the registry's works lean toward (plus the
  // classics, which the named aliases and tests read).
  const toward: Record<string, number | null> = {};
  const fields = new Set<string>(["fertility", "ore", "plant"]);
  for (const def of eco.works) if (def.leansToward) fields.add(def.leansToward);
  for (const f of fields) toward[f] = city ? fieldBearing(grid, city.x, city.y, f) : null;
  const fertile = toward.fertility;
  const ore = toward.ore;
  const timber = toward.plant;

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

  const bias: TownBias = { bearings, fertile, ore, timber, toward };
  memo.set(siteKey, bias);
  return bias;
}

/**
 * `buildUp` — THE BUILD-UP KNOB: how many storeys above the ground floor
 * this town is willing AND able to add when housing pressure demands it
 * (0 = it only ever spreads; 2 = burgher town). Capability × cost is the
 * HOST's judgment — technology, wealth, aesthetics, culture and building
 * type all feed this one number where they exist (grand-dream derives it
 * from the settlement's books, quantized so a drifting scalar never
 * re-lays floors under the player's feet). The engine only DISTRIBUTES:
 * overflow households become upper storeys center-out — land nearest the
 * plaza rises first, the historical gradient — deterministically and
 * monotonically (more pressure ⇒ floors only rise; positions never move).
 */
export function townPlan(
  tri: TownHost, eco: CompiledEconomy, siteKey: string, seed: number, buildUp = 0,
  // House-wall palette. Default = the realistic muted browns (grand-dream's
  // look). A game may pass DISTINCT, nameable colors (the symbol-game town does,
  // so residents can point you to "the blue house").
  housePalette: readonly string[] = HOUSE_COLORS,
): TownPlan {
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
  const bias = townBias(tri, eco, siteKey);
  const net = growStreets(seed, siteKey, houseCount, { bearings: bias.bearings });
  const houses: TownHouse[] = [];
  let radius = TOWN_DIMS.plazaR + 15;
  const count = Math.min(houseCount, net.slots.length);
  for (let k = 0; k < count; k++) {
    const slot = net.slots[k];
    const rng = mulberry32(hashSeed(seed, `${siteKey}:lot:${k}`));
    // Face the frontage anchor (the slot's own street), from the
    // UNJITTERED slot so the door edge never flips with the wobble.
    const door = doorToward(slot.x, slot.y, slot.ax, slot.ay);
    const depth = TOWN_DIMS.houseDepthMin + rng() * TOWN_DIMS.houseDepthJit; // toward the street
    const width = TOWN_DIMS.houseWidthMin + rng() * TOWN_DIMS.houseWidthJit;
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
      color: housePalette[hashSeed(seed, `${siteKey}:c:${k}`) % housePalette.length]!,
      floors: 1,
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
  const clear = TOWN_DIMS.plazaClear;
  const anchor = hasPlazaMarket
    ? { x: 0, y: clear + mkStyle.h + 1.5 } // plaza market doorstep (south)
    : { x: 0, y: -clear - WORK_STYLE.hall.h - 1.5 }; // hall doorstep (north)
  const stalls = foundNeighborhoodMarkets(houses, anchor, net);
  const stallIdx = new Set(stalls.map(s => s.index));
  const homes = stallIdx.size ? houses.filter(h => !stallIdx.has(h.index)) : houses;

  // BUILD UP: households the streets couldn't lot become UPPER STOREYS,
  // center-out (land nearest the plaza rises first), up to the knob's
  // level and the engine's storey cap. Monotone in pressure and in the
  // knob: growth only ever raises floors, never moves a house.
  let extraFloors = 0;
  if (buildUp > 0) {
    let overflow = houseCount - count;
    const maxFloors = Math.min(1 + Math.max(0, Math.floor(buildUp)), TOWN_DIMS.maxHouseFloors);
    if (overflow > 0 && maxFloors > 1) {
      const ranked = [...homes].sort((a, b) => {
        const ra = Math.hypot(a.dx + a.w / 2, a.dy + a.h / 2);
        const rb = Math.hypot(b.dx + b.w / 2, b.dy + b.h / 2);
        return ra - rb || a.index - b.index;
      });
      for (let level = 2; level <= maxFloors && overflow > 0; level++) {
        for (const home of ranked) {
          if (overflow <= 0) break;
          if (home.floors !== level - 1) continue;
          home.floors = level;
          extraFloors++;
          overflow--;
        }
      }
    }
  }

  // Civic buildings hold the plaza; production works cap the street TIPS
  // (the town's edge, where the lanes peter out into fields and pits) —
  // one building per counted unit (capped: landmarks, not the ledger).
  const works: TownWork[] = [];
  works.push({
    // The hall stands INSIDE the plaza, door fronting north.
    type: "hall", dx: -WORK_STYLE.hall.w / 2, dy: -clear - WORK_STYLE.hall.h,
    w: WORK_STYLE.hall.w, h: WORK_STYLE.hall.h, door: "north", color: WORK_STYLE.hall.color,
  });
  if (hasPlazaMarket) {
    // The market backs onto the hall across the plaza center.
    works.push({
      type: "market", dx: -mkStyle.w / 2, dy: clear,
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
  // Production works come from the WORK REGISTRY (the world's compiled
  // economy): each def carries its count scalar, map cap, footprint and
  // the substrate field it leans toward (null = an outskirt tip
  // whichever way it points — the forge's fire risk lives at the
  // town's edge). settlementScalar reads 0 for vars a world doesn't
  // declare, so a base world simply places none of a goods2 building.
  const workCounts: Array<[string, number, number | null, { color: string; w: number; h: number }]> =
    eco.works.map(def => [
      def.key,
      Math.min(def.mapCap, Math.round(dual.settlementScalar(siteKey, def.countScalar))),
      def.leansToward ? bias.toward[def.leansToward] ?? null : null,
      def.style,
    ]);
  const farmSpots: Array<{ x: number; y: number }> = [];
  for (const [type, n, toward, style] of workCounts) {
    for (let k = 0; k < n; k++) {
      let placed = false;
      for (;;) {
        const i = bestTip(toward);
        if (i < 0) break;
        usedTips.add(i);
        const t = tips[i];
        const x = t.p.x + t.dir.x * TOWN_DIMS.workTipOut;
        const y = t.p.y + t.dir.y * TOWN_DIMS.workTipOut;
        if (works.some(wk => Math.hypot(wk.dx + wk.w / 2 - x, wk.dy + wk.h / 2 - y) < TOWN_DIMS.workMinSpacing)) continue;
        const door = doorToward(x, y, t.p.x, t.p.y); // door faces back up the street
        works.push({ type, dx: x - style.w / 2, dy: y - style.h / 2, w: style.w, h: style.h, door, color: style.color });
        if (type === "farm") farmSpots.push({ x, y });
        const rr = Math.hypot(x, y) + 18;
        if (rr > radius) radius = rr;
        placed = true;
        break;
      }
      if (!placed) {
        // Tips ran out (tiny towns): fall back to the town edge, still
        // leaning the typed way when there is one.
        const a = toward ?? (works.length / 6) * Math.PI * 2 + 0.7;
        const spread = toward === null ? 0 : (k - (n - 1) / 2) * 0.5;
        const x = Math.cos(a + spread) * (radius + TOWN_DIMS.workTipOut);
        const y = Math.sin(a + spread) * (radius + TOWN_DIMS.workTipOut);
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
      const out = TOWN_DIMS.fieldOutMin + rng() * TOWN_DIMS.fieldOutJit;
      const side = (rng() - 0.5) * TOWN_DIMS.fieldSideSpread;
      const w = TOWN_DIMS.fieldWMin + rng() * TOWN_DIMS.fieldWJit;
      const h = TOWN_DIMS.fieldHMin + rng() * TOWN_DIMS.fieldHJit;
      fields.push({
        dx: at.x + ux * out - uy * side - w / 2,
        dy: at.y + uy * out + ux * side - h / 2,
        w,
        h,
      });
    }
  }

  return {
    key: siteKey, biome, groundColor, radius: radius + 10,
    // `built` = household capacity PROVIDED: placed lots plus the upper
    // storeys — the growth governor's "can a replan change anything".
    want: houseCount, built: count + extraFloors, houses: homes, works, fields, streets: net,
  };
}
