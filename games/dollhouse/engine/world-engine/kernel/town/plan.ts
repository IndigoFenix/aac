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
import type { BuildingProgram, StationKind } from "./stations";
import { quantB } from "./approach";
import { HOUSEHOLD, houseDoorstep, workDoorstep } from "./goods";
import { TOWN_DIMS } from "./dimensions";
import { foundServicePoints, NEIGH_CONVENIENT, NEIGH_FOUND_MASS, WELL_FOUND_MASS } from "./districts";
import type { ServicePoint } from "./construction";
import {
  growStreets, networkJunctions, roadDistance, stubSeedsOf,
  type GrowSeed, type TownStreets, type Vec2,
} from "./streets";
import {
  farmAreaPerPersonM2, producerSurplusFrac, REAL_SCALE, serviceRadiusM, tierExtentM,
  type SettlementTier, type WorldScale,
} from "../../scale";

/** Meters per substrate tile — a tile is a square kilometer. */
export const WORLD_TILE = 1000;

/** FOUNDING AGE (city-founding): a town this many days old or younger has
 *  NO pre-built history — the plan lays no base houses or civic works even
 *  with a real population; settlers raise everything through founded
 *  deltas. Day one IS the founding ("age 0" in the design doc). */
export const FOUNDING_AGE_DAYS = 1;

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
  /** The street frontage slot this house occupies (streets.ts). Equal to
   *  `index` until founded buildings claim slots of their own (①b) —
   *  then base houses skip the claimed ones. */
  slot?: number;
  /** THE CONSTRUCTING SPECIES (creature registry id) — whose adult body this
   *  house is BUILT FOR. Rooms, doors, halls and furniture lanes all derive
   *  their passability floors from its `speciesBodyRadius` (rooms.ts
   *  houseMetricsFor, placement.ts service flood). Absent = the people
   *  default. Movers of this size or smaller navigate by construction; a
   *  larger visitor plans at its own girth and fits only where it fits. */
  species?: string;
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
  /** Interior program OVERRIDE (①b: a founded building carries its
   *  StructureSpec's program, so the stage never falls through
   *  workProgram()'s generic default). Absent = workProgram(type). */
  program?: BuildingProgram;
  /** EXTRA stations this building furnishes beyond its program's base work
   *  set (a founded building carries its StructureSpec's `stations` — a
   *  weaver's loom, a dyer's vat). Consumed by workFurniture; absent = just
   *  the base work stations. Mirrors `program` — the interior-override seam. */
  stations?: readonly StationKind[];
  /** Roster staff override (①b: per-spec jobs replaces the flat
   *  STAFF_PER_WORK). Absent = the roster default. */
  jobs?: number;
  /** The FoundedBuilding ordinal this row materializes (①b) — links the
   *  row to its construction-progress delta. Absent = a base work. */
  foundedOrd?: number;
  /** An EMPTY SHELL (pipeline ⑤b — a building born without a role): no
   *  registry stations furnish it; only its construction delta's placed
   *  pieces stand inside. Rooms arrive by interior subdivision. */
  bare?: boolean;
  /** VACATED live (④ move-in): this founded house-role row converted to a
   *  real plan.houses household mid-session. The row STAYS (works indices
   *  are load-bearing — jobs, attendance, the stage's registration maps)
   *  but stages nothing and counts for nothing; a REBUILD never creates a
   *  vacated row (applyFoundedBuildings materializes the house directly). */
  vacated?: boolean;
  /** The constructing species (see TownHouse.species). */
  species?: string;
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
  /** Edge of the built-up area, meters from center — an OUTPUT of what
   *  actually grew (growth-phase-B §1.5), never a promise: street growth
   *  holds `builtMargin` back from the declared extent, so this can never
   *  exceed `TOWN_DIMS.townRMax`. */
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
  /**
   * POPULATION FOLLOWS CAPACITY (food-scale-round.md, Stage α) — the souls this
   * site can actually seat: `built × HOUSEHOLD`. The aggregate sim ASSIGNS a
   * population (`dual.settlementScalar`) and nothing used to reconcile it with
   * the lots the street tree found, so a 71 m Earthlike town carried a want of
   * 195 houses against 0-1 placed ones and still raised 11 workplaces
   * (`earthlike-city-regression.md`). This is the honest local number.
   */
  popCap: number;
  /**
   * The assigned population this site could NOT seat (`max(0, pop − popCap)`).
   * A site too small for its population gets a SMALLER POPULATION, and the
   * region is meant to answer with MORE SITES — that answer is Stage β
   * (`planet/refine.ts` founding pressure) and does not exist yet, so today
   * this is a published truth rather than a consumed one. Never zero-filled:
   * a plan that reports 0 spill really did seat everybody.
   */
  popSpill: number;
  houses: TownHouse[];
  works: TownWork[];
  /** The town's CONSTRUCTING SPECIES — stamped on every house/work row (and
   *  the default for its residents' bodies). Absent = the people default. */
  species?: string;
  /** THE PLAZA — town-local, an OUTPUT of the network (growth-phase-B
   *  §1.6, re-derived in phase C §1.3): the junction CLOSEST to the founding
   *  generation's frontage, widened into a clearing the civic buildings front
   *  and the town well stands on. There is no hub input any more; closeness
   *  peaks near the middle on any roughly-convex network, so the plaza lands
   *  near the middle BECAUSE the walking does. Absent only on a hand-built
   *  plan — read it through `townPlaza`, which falls back to the frame
   *  origin. */
  plaza?: Vec2;
  /** Cultivated patches beyond the houses (farmland biome). */
  fields: TownField[];
  /** NEIGHBORHOOD WELLS (needs-aware construction): town-local verge
   *  points founded by the thirst-cycle service pass, beyond the plaza
   *  well the host always digs. Only a scale-aware plan lays any —
   *  absent/empty = the clock-blind legacy town (one well on the square). */
  wells?: Vec2[];
  /** THE FOUNDED SERVICE POINTS this plan stands on (growth phase C §3.2),
   *  in founding order: the recorded history first, verbatim, then whatever
   *  the demand pass still had to append. The host writes the appended ones
   *  back into the overlay (`TownDeltas.addService`), which is what makes a
   *  town's civic set HISTORY rather than a re-derivation — see the
   *  `ServicePoint` doc for the loops regression this closes. Absent on a
   *  clock-blind plan (it founds no wells and records no stalls). */
  services?: ServicePoint[];
  /** FRONTAGE SLOTS THE CIVIC BUILDINGS TOOK (the hall and the plaza
   *  market are ordinary lots since growth-phase-B §1.6, and each covers a
   *  few of its neighbours). Base houses already skip them; this publishes
   *  them so a FOUNDING enumeration can skip them too — `foundingOptions`
   *  only knows the footprint rects otherwise, which lets a small
   *  structure squeeze onto a lot the plan has already spent. */
  civicSlots?: number[];
  /** The organic street tree the whole plan hangs off (streets.ts). */
  streets: TownStreets;
}

/** THE PLAZA, town-local — the widened junction the town's well stands on
 *  and the civic buildings front. An OUTPUT of the network (see
 *  `TownPlan.plaza`); the frame origin is the fallback for a hand-built
 *  plan that never grew one (any point does — it is a frame, not a hub). */
export function townPlaza(plan: Pick<TownPlan, "plaza">): Vec2 {
  return plan.plaza ?? { x: 0, y: 0 };
}

/** THE FOUNDING GENERATION whose trips fixed the town's centre. The civic
 *  ranking reads the FIRST lots, never today's population, which is what
 *  keeps the plaza put as the town grows — prefix stability at the civic
 *  rung, the same discipline the slot sequence itself keeps. */
const CIVIC_SETTLE_SLOTS = 48;

/** How far a civic building's street-facing edge stands off its own
 *  centerline — a hair inside the house frontage line, so the hall reads
 *  as fronting the square rather than standing in the road. */
const CIVIC_FRONT = 6;

/** Extra frontage the tree is grown for, because the hall and the market
 *  now take lots of their own (a 20 m footprint covers two or three). */
const CIVIC_SLOT_RESERVE = 12;

/** THE GOLDEN ANGLE (2π / φ²) — the low-discrepancy step the works' fallback
 *  ring advances by. Its whole point is that it NEVER repeats: the arm it
 *  replaced advanced by 2π/6 and so stacked work N on work N+6 exactly. */
const GOLDEN_ANGLE = 2.399963229728653;
/** Candidate positions the fallback ring tries before it gives up and stands
 *  the building on the last one anyway (a placed building the player can see
 *  overlapping beats a building the economy counts and the map lacks). */
const RING_TRIES = 24;
/** Angle candidates per ring before the arm steps outward — a whole turn's
 *  worth at the golden angle, after which this circle is genuinely full. */
const RING_TURN = 8;

/**
 * THE PLAZA: the junction CLOSEST to the founding generation — argmin over
 * junctions of Σ `roadDistance` to the first `CIVIC_SETTLE_SLOTS` frontage
 * anchors. Falls back to the frame origin for a tree with no junction at all
 * (a one-street hamlet).
 *
 * CLOSENESS, not traffic (growth phase B residual B-3). Traffic counts trips
 * per STREET ID, and on a SPAN baseline — which is now the normal shape, since
 * the town grows around the road that passes through it — every junction is a
 * child of that one baseline, so every junction ties at the same count and the
 * ranking's tie-break (street id, then arc) silently decides: the plaza lands
 * at whichever end the port happens to be, and the civic core sits on the edge
 * of town. Closeness has a real gradient along the baseline and puts the
 * square where the walking actually converges. MEASURED: offset from the
 * built-mass median fell from 388 m to ~136 m at a port, and the answer is
 * byte-stable across 4.5x growth (the prefix is prefix-stable by construction,
 * so a town that doubles does not move the square its people know).
 *
 * `rankJunctions`-by-traffic stays in streets.ts for consumers with a real
 * economy behind them, where trips per street mean what they say.
 *
 * DETERMINISM: `networkJunctions` is already ordered by street then arc, and
 * this takes STRICT improvements only (travel.ts's heap discipline), so ties
 * resolve to the earliest street, then the earliest arc.
 */
function plazaOf(net: TownStreets): Vec2 {
  const junctions = networkJunctions(net);
  if (junctions.length === 0) return { x: 0, y: 0 };
  const n = Math.min(net.slots.length, CIVIC_SETTLE_SLOTS);
  let best = junctions[0];
  let bestSum = Infinity;
  for (const j of junctions) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const s = net.slots[k];
      sum += roadDistance(net, { x: s.ax, y: s.ay }, { x: j.x, y: j.y });
    }
    if (sum < bestSum) {
      bestSum = sum;
      best = j;
    }
  }
  return { x: best.x, y: best.y };
}

/** A founded well's spot for its chosen lot: street furniture on the
 *  verge past the lot's far corner — clear of the doorway and the
 *  neighbor's frontage. The ONE shape for plan-time wells, the rebuild's
 *  founded-household pass, and the host's live dig. */
export function wellVergePoint(h: TownHouse): Vec2 {
  const d = houseDoorstep({ x: 0, y: 0 }, h);
  return h.door === "north" || h.door === "south"
    ? { x: h.dx + h.w + 1.6, y: d.y }
    : { x: d.x, y: h.dy + h.h + 1.6 };
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

/** Do two footprints (one padded) overlap? */
function rectsClash(a: { dx: number; dy: number; w: number; h: number }, r: Rect, pad: number): boolean {
  return (
    a.dx < r.x + r.w + pad && a.dx + a.w > r.x - pad &&
    a.dy < r.y + r.h + pad && a.dy + a.h > r.y - pad
  );
}

interface Rect { x: number; y: number; w: number; h: number }

/**
 * A CIVIC BUILDING IS JUST A BUILDING (growth-unification §3): the hall
 * and the market take STREET FRONTAGE SLOTS like every other structure,
 * on the lot nearest the plaza junction that their footprint fits. They
 * front their own street, their door faces it, and the lots the footprint
 * covers are claimed so no house is laid inside them.
 *
 * Returns the row plus the slots it consumed; null when nothing fits.
 */
function placeCivic(
  net: TownStreets, at: Vec2, style: { color: string; w: number; h: number }, type: string,
  claimed: ReadonlySet<number>, standing: ReadonlyArray<TownWork>, bound: number,
): { work: TownWork; slots: number[] } | null {
  const order = net.slots
    .map((s, k) => ({ k, s, d: Math.hypot(s.x - at.x, s.y - at.y) }))
    .filter(e => !claimed.has(e.k))
    .sort((a, b) => a.d - b.d || a.k - b.k);
  for (const { k, s } of order) {
    const door = doorToward(s.x, s.y, s.ax, s.ay);
    const sideways = door === "east" || door === "west";
    const w = sideways ? style.h : style.w;
    const h = sideways ? style.w : style.h;
    // Set back off the centerline like a house, not centred on the lot —
    // a 15 m-deep hall on a 10.5 m setback would stand in the road.
    const off = Math.hypot(s.x - s.ax, s.y - s.ay) || 1;
    const nx = (s.x - s.ax) / off;
    const ny = (s.y - s.ay) / off;
    const reach = CIVIC_FRONT + (sideways ? w : h) / 2;
    const cx = s.ax + nx * reach;
    const cy = s.ay + ny * reach;
    const rect: Rect = { x: cx - w / 2, y: cy - h / 2, w, h };
    // Inside the declared extent, clear of what already stands.
    if (Math.hypot(cx, cy) + Math.hypot(w, h) / 2 > bound) continue;
    if (standing.some(o => rectsClash(o, rect, 1))) continue;
    // Every lot the footprint covers becomes part of the civic ground.
    const slots: number[] = [];
    for (let j = 0; j < net.slots.length; j++) {
      const o = net.slots[j];
      if (Math.abs(o.x - cx) < w / 2 + 8 && Math.abs(o.y - cy) < h / 2 + 8) slots.push(j);
    }
    if (!slots.includes(k)) slots.push(k);
    return {
      work: { type, dx: rect.x, dy: rect.y, w, h, door, color: style.color },
      slots,
    };
  }
  return null;
}

/* ---------------- typed growth bias (city-development §2b) ------------ */
// A town turns toward what feeds it: its arterials aim at its trade
// partners and its resource sides, and its works cap the tips that point
// the right way (farm gates toward the fertile tiles, the pithead toward
// the ore). Bearings are QUANTIZED (16 compass buckets) and memoized per
// session, so slow substrate drift (mining depletion, greening) doesn't
// re-lay a town under the player's feet — a re-boot long after the
// mountain emptied MAY re-lay it, which is development, not noise.

// quantB lives in approach.ts now — one quantization law for bearings
// derived here and for the true approach bearings hosts hand in.

export interface TownBias {
  /** WHAT THE TOWN GROWS AROUND (phase B §2.1) — the growth seeds, in the
   *  order the street layer reads them: the host's ROAD SEEDS first (a
   *  through-road span and its spurs, real geometry) then the substrate's
   *  leanings as bare stubs. A host with no seed geometry contributes only
   *  stubs, which is exactly what `bearings` used to say. */
  seeds: GrowSeed[];
  /** LEGACY VIEW of the same answer: the bare bearings among `seeds`, plus
   *  the road bearings a seedless host handed in. Kept while the fixtures
   *  still speak it (phase B stage 3 sweeps it). */
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

/** How many incident roads a town seeds arterials for — `approachBearings`'
 *  own cap (approach.ts, default 6). Beyond it a hub is pathological, and
 *  growStreets' compass dedup collapses roads sharing a bucket anyway. */
const ROAD_BEARING_CAP = 6;

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

  // Roads out of town head where the road GOES. A host that knows its
  // incident road POLYLINES hands their true approach bearings through
  // the seam (host.roadBearings — where each route actually crosses the
  // town edge, kernel/town/approach.ts; a least-cost road curves around
  // hills, so this rarely matches the straight line to the neighbor).
  // That answer is trusted whole, empty included (a verified roadless
  // town). Without it, fall back to straight-line bearings toward the
  // route-connected neighbor cities (the high street is the highway).
  //
  // PORTS ARE PLURAL (phase B §1.7 — defect B-1): the old cap of TWO threw
  // away phase A's plural ports before they ever reached growStreets, so a
  // five-road crossroads still grew two road-aimed arterials. The cap is
  // now the approach cap: one seed per incident road.
  const bearings: number[] = [];
  const road = tri.roadBearings?.(siteKey) ?? null;
  if (road) {
    for (const b of road) {
      if (bearings.length >= ROAD_BEARING_CAP) break;
      bearings.push(quantB(b));
    }
  } else if (city) {
    const routes = (tri.dual as { routes?: () => Array<{ site_a: { key: string } | null; site_b: { key: string } | null }> }).routes?.() ?? [];
    for (const r of routes) {
      if (bearings.length >= ROAD_BEARING_CAP) break;
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

  // THE SEAM (§2.1): a host that knows its incident road POLYLINES hands
  // the ROADS THEMSELVES, not a bearing apiece — the town's baseline then
  // IS the through road rather than a guess aimed along it. Trusted whole;
  // an empty answer (the overlap rule left every route unclipped, so there
  // is no port-to-port span) falls back to the stub compile, which is what
  // this function has always produced.
  const roadSeeds = tri.roadSeeds?.(siteKey) ?? null;
  // The substrate's leanings ride along as bare stubs either way: "there is
  // good land that way" is a direction and nothing more.
  const leanings: number[] = [];
  if (fertile !== null) leanings.push(fertile);
  if (ore !== null) leanings.push(ore);
  const seeds: GrowSeed[] = roadSeeds?.length
    ? [...roadSeeds, ...stubSeedsOf(leanings)]
    : stubSeedsOf(bearings);

  const bias: TownBias = { seeds, bearings, fertile, ore, timber, toward };
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
  foundedSlots: readonly number[] = [],
  species?: string,
  ageDays?: number,
  scale?: WorldScale,
  services: readonly ServicePoint[] = [],
  obstacles: readonly Rect[] = [],
): TownPlan {
  // The generator IS the implementation; the sync path just drains it, so
  // the two can never drift (staged output is byte-identical by construction).
  const gen = townPlanSteps(
    tri, eco, siteKey, seed, buildUp, housePalette, foundedSlots, species, ageDays,
    scale, services, obstacles,
  );
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * The plan laid in RESUMABLE STEPS: yields a progress note at each natural
 * boundary (streets grown, every house batch, works) so a live host can
 * spread the ~synchronous lump across frames (the approach-load story) —
 * this was the single biggest founding hitch on the flight loop.
 */
export function* townPlanSteps(
  tri: TownHost, eco: CompiledEconomy, siteKey: string, seed: number, buildUp = 0,
  housePalette: readonly string[] = HOUSE_COLORS,
  /** Street slots FOUNDED BUILDINGS claimed (①b construction deltas) — the
   *  street tree grows to cover them and base houses skip them. Empty =
   *  legacy behavior, byte-identical. */
  foundedSlots: readonly number[] = [],
  /** THE CONSTRUCTING SPECIES (creature registry id) — this town is built by
   *  and for these bodies: every house/work row is stamped with it, and the
   *  room/furniture generators size doors, halls and lanes to its
   *  `speciesBodyRadius`. Absent = the people default (byte-identical
   *  legacy output). */
  species?: string,
  /** THE TOWN'S AGE in days (city-founding): ≤ FOUNDING_AGE_DAYS lays no
   *  base houses/works regardless of population — settlers build everything
   *  through founded deltas. Absent = established (byte-identical legacy
   *  output; far-LOD hosts never pass it). */
  ageDays?: number,
  /** SPACE-TIME COMPRESSION (scale.ts): sizes the town's SERVICE DISTRICTS —
   *  market stalls found on the hunger-cycle walk radius, wells on the
   *  thirst-cycle one (needs-aware construction: faster-draining needs ⇒
   *  smaller districts). Absent = the clock-blind legacy literals,
   *  byte-identical output, no neighborhood wells. */
  scale?: WorldScale,
  /** 🔴 THE TOWN'S FOUNDED SERVICE POINTS (growth phase C §3.2, the
   *  `ServicePoint` doc): stalls and wells this town ALREADY founded, as
   *  history. They stand verbatim and anchor the demand pass, which then
   *  only appends. Empty = re-derive, byte-identical legacy output. */
  services: readonly ServicePoint[] = [],
  /** STANDING GROUND the tree must bend around (growth-unification §3
   *  "Streets respect buildings"; the annexed homesteads of phase C §3.3 are
   *  the something that finally needed it). Read off the overlay with
   *  `construction.ts groundObstacles`, and the FOUNDING ENUMERATION must be
   *  handed the identical list or the two lattices disagree. Empty = the
   *  unfed `GrowOpts.obstacles` seat, byte-identical legacy growth. */
  obstacles: readonly Rect[] = [],
): Generator<string, TownPlan> {
  const city = tri.cities.find(c => c.key === siteKey);
  if (!city) throw new Error(`townPlan: unknown city "${siteKey}"`);
  const { dual } = tri;

  const ch = tri.charterOf(siteKey);
  const biome: TownPlan["biome"] = ch.ore_access > ch.farmland ? "mining" : "farmland";
  const fertMean = ch.farmland / 49;
  const groundColor = biome === "mining" ? "#8a8a90" : fertMean > 4 ? "#8fae62" : "#d6b87c";

  const pop = Math.max(0, dual.settlementScalar(siteKey, "population"));
  // ZERO-BUILDING GROWTH (①b): a founded site's town (startPop 0) lays NO
  // base houses — it grows building-by-building through founded deltas.
  // FOUNDING AGE (city-founding): a town aged ≤ FOUNDING_AGE_DAYS has no
  // pre-built history either, whatever its population — its people arrived
  // with the wagon and every building they'll ever have goes up through the
  // same founded deltas. Any older real population keeps the historical
  // 6-house floor.
  const founding = (ageDays ?? Number.POSITIVE_INFINITY) <= FOUNDING_AGE_DAYS;
  const houseCount = pop <= 0 || founding ? 0 : Math.max(6, Math.round(pop / HOUSEHOLD));

  // The street tree grows first (streets.ts); houses fill its frontage
  // slots in CONSTRUCTION ORDER. Each lot's jitter rng is seeded by LOT
  // index and the street event stream is fixed by (seed, site, bias), so
  // house k is byte-identical whether the town has 50 houses or 800
  // (prefix stability) — growth extends streets and appends lots at the
  // fringe. The TYPED BIAS aims the arterials: out along the trade
  // roads, toward the fertile side, toward the ore.
  const bias = townBias(tri, eco, siteKey);
  // The tree must cover the base lots AND every founded-claimed slot —
  // growth is prefix-stable, so extra slots never move existing houses.
  const claimed = new Set(foundedSlots);
  let slotNeed = houseCount + claimed.size;
  for (const s of claimed) slotNeed = Math.max(slotNeed, s + 1);
  // The civic buildings take frontage of their own (below), so the tree is
  // asked for a few lots more than the households need. Growth is
  // prefix-stable, so over-asking never moves a lot.
  /** THE DERIVED EXTENT (growth phase C §1.2) — the declared town size
   *  capped by what this world can hold (`scale.ts townExtentM`: a town may
   *  not build so far out that it swallows the road to its neighbour). ONE
   *  derivation, read identically by the street gate below, the planet's
   *  route ports and the road-seed seam, so the tree, the buildings and the
   *  roads all stop at the same circle. A plan with no declared scale gets
   *  the real-scale answer, which IS `dimensions.townRMax`.
   *
   *  Street growth holds its built margin back from this, so `radius` below
   *  is an OUTPUT that fits inside.
   *
   *  ⚖️ THE TIER SEAT (food-scale-round ④⑵): the clip is read through
   *  `tierExtentM`, so a hamlet, a village and a market town can declare
   *  different BODIES on one world instead of all declaring 450 m and being
   *  told apart only by the clip. Nothing hands this generator a tier yet —
   *  `planet/refine.ts`/`planet/border.ts` own the tier ladder and are
   *  SEQUENCED-AFTER — so it reads `"town"`, which IS `townExtentM` and is
   *  byte-identical to what shipped. */
  const tier: SettlementTier = "town";
  const extentM = tierExtentM(tier, scale ?? REAL_SCALE);
  const net = growStreets(
    seed, siteKey, slotNeed + CIVIC_SLOT_RESERVE,
    { seeds: bias.seeds, extentM, ...(obstacles.length ? { obstacles } : {}) },
  );

  // THE CENTRE IS AN OUTPUT (growth-phase-B §1.6, phase C §1.3): the plaza is
  // whichever junction the founding generation's walks are SHORTEST to, and
  // the hall and market are ordinary buildings on the frontage nearest it.
  // There is no plaza berth and no PLAZA_WELL — closeness peaks near the
  // middle on a roughly-convex network, so the civic core lands near the
  // middle BECAUSE the walking does.
  const plaza = plazaOf(net);
  const mkStyle = WORK_STYLE.market;
  // Read the WANT, not the placed count: the market's lot has to be
  // reserved before the households fill the frontage.
  const hasPlazaMarket = houseCount >= MARKET_MIN_HOUSES;
  const civic: TownWork[] = [];
  const civicSlots: number[] = [];
  if (houseCount > 0) {
    const civicBound = extentM - TOWN_DIMS.workPad;
    const market = hasPlazaMarket
      ? placeCivic(net, plaza, mkStyle, "market", claimed, [], civicBound)
      : null;
    for (const s of market?.slots ?? []) { claimed.add(s); civicSlots.push(s); }
    const hall = placeCivic(
      net, plaza, WORK_STYLE.hall, "hall", claimed, market ? [market.work] : [], civicBound,
    );
    for (const s of hall?.slots ?? []) { claimed.add(s); civicSlots.push(s); }
    // Hall first: `works.find(type === "market")` must stay the plaza one.
    if (hall) civic.push(hall.work);
    if (market) civic.push(market.work);
  }

  // ⚖️ THE CIVIC CORE MAY NOT EAT THE LAST LOT (earthlike-city-regression Q2,
  // the second-order defect). `works` below drops the civic rows when no house
  // stood, but the frontage they claimed above was never released — so on a
  // 2-4 slot street tree the hall and the market consumed every lot and then
  // did not exist, leaving a town of nothing. A reservation that leaves the
  // households nowhere to stand is not a reservation, it is the town's death:
  // RELEASE it and let the houses have the frontage. `claimed` also carries
  // the FOUNDED slots, which are history and are never released.
  //
  // Exactly equivalent to "release when `count === 0`", checked before the
  // fact: the loop below lots every unclaimed slot until the want is met, so
  // zero houses ⇔ zero unclaimed slots.
  if (houseCount > 0 && civicSlots.length > 0 && net.slots.length - claimed.size <= 0) {
    for (const s of civicSlots) claimed.delete(s);
    civicSlots.length = 0;
    civic.length = 0;
  }

  yield "framing houses";
  const houses: TownHouse[] = [];
  let radius = TOWN_DIMS.plazaR + 15;
  for (let k = 0; k < net.slots.length && houses.length < houseCount; k++) {
    // Founded buildings hold their frontage — base houses skip those lots.
    if (claimed.has(k)) continue;
    // A metropolis lays hundreds of lots — breathe between batches (60 lots
    // ≈ 11 ms warm on the timing probe; 150 blew the frame budget).
    if (k > 0 && k % 60 === 0) yield "framing houses";
    const slot = net.slots[k];
    // Jitter/color seeded by SLOT (position identity, not house ordinal):
    // legacy towns (no founded slots) keep slot === index byte-identical,
    // and a founded claim never re-rolls the houses beyond it.
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
      index: houses.length,
      dx: cx - w / 2,
      dy: cy - h / 2,
      w, h, door,
      color: housePalette[hashSeed(seed, `${siteKey}:c:${k}`) % housePalette.length]!,
      floors: 1,
      arm: slot.arm,
      slot: k,
    });
    const rr = Math.hypot(cx, cy) + TOWN_DIMS.housePad;
    if (rr > radius) radius = rr;
  }
  const count = houses.length;

  // STEP 1 of the city fractal (city-development.md §7): neighborhood
  // market stalls founded by unserved demand, each a CONVERTED house lot
  // (same footprint and door, so it stays on its street frontage).
  // The founding anchor is the town's central source — the plaza market's
  // doorstep when the town rates one, else the hall's. Both sit on lots the
  // prefix-stable slot sequence chose, so founding stays prefix-stable too.
  const central = civic.find(w => w.type === "market") ?? civic[0];
  const anchor = central ? workDoorstep({ x: 0, y: 0 }, central) : plaza;
  // 🔴 SLOTS ARE HISTORY (growth phase C §3.2). The RECORDED service points
  // stand first and unconditionally — a stall that opened does not un-open
  // because a loop cut later made somebody else's walk shorter (§2's measured
  // regression: the argmin legitimately moves once a link shortens a walk
  // between two lots the town already had). They then join the ANCHOR SET, so
  // the demand pass below only ever APPENDS what history still leaves
  // unserved: self-limitation intact, prefix stability restored by record
  // rather than by luck.
  const bySlot = new Map(houses.filter(h => h.slot !== undefined).map(h => [h.slot!, h] as const));
  const historyStalls: TownHouse[] = [];
  const historyWells: TownHouse[] = [];
  for (const s of services) {
    const h = bySlot.get(s.slot);
    if (!h) continue; // a slot beyond today's lots: the town shrank in a replay
    (s.kind === "stall" ? historyStalls : historyWells).push(h);
  }
  const historyStallIdx = new Set(historyStalls.map(h => h.index));
  // NEEDS-AWARE DISTRICT SIZING: with a declared scale the convenience
  // radius derives from the served need's fill cycle (the intercity
  // "day's walk apart" law one rung down) — the street clock shrinks it,
  // realism grows it past the whole town (one central market, the
  // historical village). Without a scale: the clock-blind legacy literal.
  const newStalls = foundServicePoints(
    historyStallIdx.size ? houses.filter(h => !historyStallIdx.has(h.index)) : houses,
    [anchor, ...historyStalls.map(h => houseDoorstep({ x: 0, y: 0 }, h))],
    net,
    {
      convenientM: scale ? serviceRadiusM(scale, "hunger") : NEIGH_CONVENIENT,
      foundMass: NEIGH_FOUND_MASS,
    },
  );
  const stalls = [...historyStalls, ...newStalls];
  const stallIdx = new Set(stalls.map(s => s.index));
  const homes = stallIdx.size ? houses.filter(h => !stallIdx.has(h.index)) : houses;

  // WELLS on the thirst radius — same pass, civic founding bar, anchored
  // at THE PLAZA: the widened junction gets the town well, founded like
  // every other service point instead of decreed at a fixed berth. The
  // chosen lot STAYS a home: its well is street furniture on the verge
  // past the lot's far corner (clear of the doorway and the neighbor's).
  const wells: Vec2[] = [];
  const wellLots: TownHouse[] = [];
  if (scale) {
    // History first here too, and the recorded wells anchor the pass.
    for (const h of historyWells) { wellLots.push(h); wells.push(wellVergePoint(h)); }
    const more = foundServicePoints(homes, [plaza, ...wells], net, {
      convenientM: serviceRadiusM(scale, "thirst"),
      foundMass: WELL_FOUND_MASS,
    });
    for (const h of more) { wellLots.push(h); wells.push(wellVergePoint(h)); }
  }
  // What this plan STANDS ON, in founding order — history verbatim, then the
  // appended answers. The host writes the new ones back into the overlay.
  // A lot with no `slot` has no positional identity to record (a hand-built
  // plan) — it stands, but it cannot become history.
  const servicePoints: ServicePoint[] = [
    ...stalls.map(h => ({ kind: "stall" as const, slot: h.slot })),
    ...wellLots.map(h => ({ kind: "well" as const, slot: h.slot })),
  ].filter((s): s is ServicePoint => s.slot !== undefined);

  // BUILD UP: households the streets couldn't lot become UPPER STOREYS,
  // the most ACCESSIBLE land first — shortest street walk to the plaza,
  // which is the historical gradient re-read off the network instead of
  // off a hard-coded origin. Monotone in pressure and in the knob: growth
  // only ever raises floors, never moves a house.
  let extraFloors = 0;
  if (buildUp > 0) {
    let overflow = houseCount - count;
    const maxFloors = Math.min(1 + Math.max(0, Math.floor(buildUp)), TOWN_DIMS.maxHouseFloors);
    if (overflow > 0 && maxFloors > 1) {
      const reach = new Map<number, number>();
      for (const h of homes) reach.set(h.index, roadDistance(net, houseDoorstep({ x: 0, y: 0 }, h), plaza));
      const ranked = [...homes].sort((a, b) => {
        const ra = reach.get(a.index) ?? Infinity;
        const rb = reach.get(b.index) ?? Infinity;
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

  // ⚖️ POPULATION FOLLOWS CAPACITY (food-scale-round, Stage α). The aggregate
  // sim ASSIGNS a population and the street tree finds however many lots the
  // ground allows; until now nothing reconciled the two, so a plan could carry
  // a want of 195 against 1 placed house and still raise a full economy's
  // worth of workplaces around 5 residents. `built` is the household capacity
  // this site really provides (lots placed + build-up storeys), so `popCap` is
  // what it can seat and `popSpill` is the demand it turned away. Stage β
  // (planet/refine.ts) is what will FOUND ANOTHER SITE with the spill; this
  // stage only stops the plan lying to itself.
  const popCap = (count + extraFloors) * HOUSEHOLD;
  const popSpill = Math.max(0, pop - popCap);
  // The share of its own assigned population this site actually holds — the
  // factor everything sized off the population must be read through. At or
  // above capacity it is 1 and every count is byte-identical to what shipped
  // (REAL scale seats 195 lots against a want of 195).
  const seatedFrac = count > 0 ? (pop > 0 ? Math.min(1, popCap / pop) : 1) : 0;

  yield "raising works";
  // The civic rows lead (hall, then plaza market — see above); production
  // works cap the street TIPS (the town's edge, where the lanes peter out
  // into fields and pits) — one building per counted unit (capped:
  // landmarks, not the ledger).
  const works: TownWork[] = count > 0 ? [...civic] : [];

  // Street tips — where the works go. Each type prefers the tips that
  // POINT THE RIGHT WAY (typed placement, city-development §2b): farm
  // gates toward the fertile side, mine/smelter toward the ore side,
  // OUTSKIRTS-NESS as the tiebreak — measured from the PLAZA, the town's
  // own centre of gravity, not from the frame origin.
  const tips: Array<{ p: Vec2; dir: { x: number; y: number } }> = [];
  let maxTipR = 1;
  for (const s of net.streets) {
    if (s.baseline || s.pts.length < 3) continue;
    const p = s.pts[s.pts.length - 1];
    const q = s.pts[s.pts.length - 2];
    const len = Math.hypot(p.x - q.x, p.y - q.y) || 1;
    tips.push({ p, dir: { x: (p.x - q.x) / len, y: (p.y - q.y) / len } });
    maxTipR = Math.max(maxTipR, Math.hypot(p.x - plaza.x, p.y - plaza.y));
  }
  const usedTips = new Set<number>();
  const bestTip = (toward: number | null): number => {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < tips.length; i++) {
      if (usedTips.has(i)) continue;
      const t = tips[i];
      const r = Math.hypot(t.p.x - plaza.x, t.p.y - plaza.y);
      const align = toward === null
        ? 0
        : Math.cos(Math.atan2(t.p.y - plaza.y, t.p.x - plaza.x) - toward);
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
  //
  // ⚖️ GATED AND SCALED BY WHAT ACTUALLY STOOD (earthlike-city-regression Q2 /
  // food-scale-round ④⑴). This loop was the ONE list with no `count > 0` guard
  // — the civic list above and the field block below both have it — so a town
  // that housed nobody still raised 11 workplaces around empty ground. And the
  // count itself is now read through `seatedFrac`: a site seating a fifth of
  // its assigned population employs a fifth of its assigned economy. A town at
  // or above capacity scales by exactly 1, so nothing shipped moves.
  const workCounts: Array<[string, number, number | null, { color: string; w: number; h: number }]> =
    count <= 0 ? [] : eco.works.map(def => [
      def.key,
      Math.min(def.mapCap, Math.round(dual.settlementScalar(siteKey, def.countScalar) * seatedFrac)),
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
        const rr = Math.hypot(x, y) + TOWN_DIMS.workPad;
        if (rr > radius) radius = rr;
        placed = true;
        break;
      }
      if (!placed) {
        // Tips ran out (tiny towns): fall back to the town edge, still
        // leaning the typed way when there is one. DEFECT B-2: this arm
        // used to place without widening `radius` (contrast the tip arm
        // above), so the plan under-reported its own built area. It now
        // widens like every other placement AND is clamped inside the
        // declared extent, which is what makes `radius ≤ extentM` true.
        //
        // ⚖️ DEFECT S3 (earthlike-city-regression Q3): the angle generator used
        // to be `(works.length / 6) × 2π`, which advances by exactly 60° and
        // WRAPS EVERY SIX placements, while `out` saturates at the same clamp
        // for all of them — so work N and work N+6 landed on the identical
        // point to the metre (measured: 5 exact overlaps, purple weavers and
        // tailors standing inside green farms). `spread` could not save it:
        // it is 0 whenever `toward === null`, which is always true for a
        // town-play host (`fieldBearing` returns null). TWO fixes, both
        // needed: the GOLDEN ANGLE never repeats, and — unlike the arm this
        // was copied from, which at least tests `workMinSpacing` — the ring
        // now REJECTS a footprint that clashes, against the houses too.
        const base = toward ?? 0.7;
        const spread = toward === null ? 0 : (k - (n - 1) / 2) * 0.5;
        const cap = extentM - TOWN_DIMS.workPad;
        const ring = Math.min(radius + TOWN_DIMS.workTipOut, cap);
        let x = plaza.x + Math.cos(base + spread) * ring;
        let y = plaza.y + Math.sin(base + spread) * ring;
        for (let attempt = 0; attempt < RING_TRIES; attempt++) {
          // Angle first, then step the ring outward when a whole turn of
          // angles is spoken for — concentric rings sized by footprint, and
          // never past the declared extent.
          const a = base + spread + attempt * GOLDEN_ANGLE;
          const out = Math.min(
            ring + Math.floor(attempt / RING_TURN) * TOWN_DIMS.workMinSpacing,
            cap,
          );
          const cx = plaza.x + Math.cos(a) * out;
          const cy = plaza.y + Math.sin(a) * out;
          x = cx;
          y = cy;
          const rect: Rect = { x: cx - style.w / 2, y: cy - style.h / 2, w: style.w, h: style.h };
          if (works.some(wk => rectsClash(wk, rect, 1))) continue;
          if (houses.some(hs => rectsClash(hs, rect, 1))) continue;
          break;
        }
        const door = doorToward(x, y, plaza.x, plaza.y);
        works.push({ type, dx: x - style.w / 2, dy: y - style.h / 2, w: style.w, h: style.h, door, color: style.color });
        if (type === "farm") farmSpots.push({ x, y });
        const rr = Math.hypot(x, y) + TOWN_DIMS.workPad;
        if (rr > radius) radius = rr;
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
  //
  // ⚖️ S2 — THE AREA SEAM (economy-arc-opening.md, SUPPLY & DEMAND ROUND).
  // Patches used to count `dual.settlementScalar(siteKey, "farms")` — the
  // BUILT farm count, an economy scalar with no relation to how much land a
  // population of this size honestly needs to eat. Now they SUM to that
  // need directly: `pop × farmAreaPerPersonM2(tier) ÷ dial`, `pop` the same
  // read `houseCount` above already uses (so the picture never disagrees
  // with itself: houses and fields both track the town's one population).
  //
  // THE SHIPPED TIER is "ancient" (12 acres/person): town-play has no
  // mechanization anywhere in it — hand-farmed grain, an ox-and-plough
  // granary economy, no tractors — so the pre-industrial anchor is the
  // honest one; "modern" (0.5 acres/person) would understate a hand-farmed
  // village by 24×. THE DIAL, NOW WIRED (S3): `scale.resourceCompression`,
  // absent `scale` ⇒ 1 — the SAME default S2 shipped, so a caller that
  // still passes no scale (worldgen, far-LOD twins, this file's own
  // fixtures) is byte-identical.
  //
  // ⚖️ FIELDS ARE THE HINTERLAND, NOT THE HOUSING (earthlike-city-regression Q1
  // / food-scale-round ④⑷). The gate used to be `count` — the houses the street
  // tree found room for — so on a cramped world whether a town had any
  // countryside at all was a coin flip on lot luck: 3 of 6 measured seeds grew
  // a fully-populated economy with ZERO fields. Land is farmed because a
  // HOUSEHOLD eats, so the gate is the WANT: a town that means to house 195
  // families has their fields whether or not the street tree found their lots.
  //
  // ⚖️ THE WANT, NOT THE POPULATION, and the difference is the FOUNDING LAW: a
  // town aged ≤ FOUNDING_AGE_DAYS sets `houseCount = 0` however many souls
  // arrived, because everything it will ever have goes up through founded
  // deltas — *"no phantom founding farm; food must be built, not assumed"*
  // (`server/tests/world-engine/town-founding-age.test.ts`). Gating on `pop`
  // would hand the wagon a cultivated hinterland on day 0.
  const fields: TownField[] = [];
  if (biome === "farmland" && houseCount > 0) {
    const anchors = farmSpots.length
      ? farmSpots
      : tips.slice(0, 2).map(t => ({ x: t.p.x, y: t.p.y }));
    if (anchors.length === 0) anchors.push({ x: plaza.x + radius, y: plaza.y });
    // ⚖️ σ — AND THE FIELDS ARE SIZED FOR SURPLUS (S&D σ close). The farm's
    // own declared margin, read OFF THE COMPILED PRODUCER ROW (never a
    // literal here): the map and the books must be sized from ONE number, and
    // that number lives spec-side on the producer (`BuildingDef.surplusFrac`,
    // scale.ts `producerSurplusFrac`). A document whose farm declares
    // nothing inherits the STAPLE anchor — this is the staple's own field
    // block, so `"staple"` is the class it falls back to, not the generic
    // craft default.
    const farmRow = eco.works.find((w) => w.key === "farm");
    const surplusFrac = producerSurplusFrac(farmRow?.surplusFrac, "staple");
    const totalFieldAreaM2 =
      pop * farmAreaPerPersonM2("ancient", scale?.resourceCompression ?? 1) * (1 + surplusFrac);
    // Patch COUNT is a rendering-resolution knob (TOWN_DIMS.fieldPatchCap,
    // explicitly-declared content) — patch SIZE carries the honest total
    // past it, which is what makes a big town's fields visibly DOMINATE it
    // (the von Thünen picture, the user's law) instead of multiplying into
    // thousands of unrenderable smallholdings.
    const refPatchAreaM2 =
      (TOWN_DIMS.fieldWMin + TOWN_DIMS.fieldWJit / 2) * (TOWN_DIMS.fieldHMin + TOWN_DIMS.fieldHJit / 2);
    const patches = Math.max(
      2,
      Math.min(TOWN_DIMS.fieldPatchCap, Math.round(totalFieldAreaM2 / refPatchAreaM2)),
    );
    const areaScale = Math.sqrt(totalFieldAreaM2 / (patches * refPatchAreaM2));
    for (let k = 0; k < patches; k++) {
      const rng = mulberry32(hashSeed(seed, `${siteKey}:field:${k}`));
      const at = anchors[k % anchors.length];
      // Fields fan OUTWARD from the town's own centre (the plaza), which
      // is where "past the farm gate" points once the origin stops being
      // the middle of anything. `out`/`side` scale with the patch too — a
      // field big enough to dwarf the town needs to stand back from it, not
      // just grow from a point still pinned at the old smallholding's edge.
      const rr = Math.hypot(at.x - plaza.x, at.y - plaza.y) || 1;
      const ux = (at.x - plaza.x) / rr;
      const uy = (at.y - plaza.y) / rr;
      const out = (TOWN_DIMS.fieldOutMin + rng() * TOWN_DIMS.fieldOutJit) * areaScale;
      const side = (rng() - 0.5) * TOWN_DIMS.fieldSideSpread * areaScale;
      const w = (TOWN_DIMS.fieldWMin + rng() * TOWN_DIMS.fieldWJit) * areaScale;
      const h = (TOWN_DIMS.fieldHMin + rng() * TOWN_DIMS.fieldHJit) * areaScale;
      fields.push({
        dx: at.x + ux * out - uy * side - w / 2,
        dy: at.y + uy * out + ux * side - h / 2,
        w,
        h,
      });
    }
  }

  // The constructing species rides on every row (rooms/furniture/placement
  // read it off the house they're given — no side channel). Stamped only
  // when authored, so a legacy plan stays byte-identical.
  if (species) {
    for (const h of homes) h.species = species;
    for (const w of works) w.species = species;
  }
  return {
    key: siteKey, biome, groundColor,
    // EXTENT IS AN OUTPUT (§1.5): the radius is what actually got built,
    // and street growth already held `builtMargin` back from the declared
    // extent, so it fits inside by construction (the old plan reported
    // 495 against a 450 port extent).
    radius: Math.min(radius + TOWN_DIMS.planPad, extentM),
    // `built` = household capacity PROVIDED: placed lots plus the upper
    // storeys — the growth governor's "can a replan change anything".
    want: houseCount, built: count + extraFloors, popCap, popSpill,
    houses: homes, works, plaza, fields, streets: net,
    ...(civicSlots.length ? { civicSlots: civicSlots.slice().sort((a, b) => a - b) } : {}),
    ...(scale ? { wells } : {}),
    ...(servicePoints.length ? { services: servicePoints } : {}),
    ...(species ? { species } : {}),
  };
}
