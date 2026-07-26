/**
 * rooms.ts — THE FLOOR PLAN of a town house, GENERATED FROM NEED (round
 * 5; house-generation-brainstorming.md). Pure and deterministic (same
 * house, same rooms, forever). The engine is room-native (one
 * BuildingSpec per room), so this module only DECIDES the split;
 * town-stage raises the rooms and door routing / visibility / the
 * cutaway all come along for free.
 *
 * The pipeline is graph-first — program → topology → embedding — not a
 * fixed template:
 *
 *   PROGRAM   how many rooms does this household NEED? The occupants'
 *             need-set (stations.ts's occupant program) sets the DEMAND;
 *             the back band's AREA is the GRANULARITY BUDGET (~one
 *             sleeping cell per BED_AREA m², hash-jittered); the chosen
 *             topology CAPACITY-CLAMPS the result (below). When the
 *             footprint tightens, clusters give up their dedicated cells
 *             in privacy-rank order (§9 slice 3): full form → wet merges
 *             into the living room (living + bedroom) → the STUDIO (the
 *             full merge — everything in one cell).
 *
 *   TOPOLOGY  how do you REACH a private room? — the master cultural
 *             variable (the brainstorm's circulation topology):
 *             HUB    the LIVING room is the circulation node; back rooms
 *                    door onto its partition. Door capacity is the
 *                    binding constraint (partition doors must clear the
 *                    goods chests' standing spots — DOOR_CLEAR below),
 *                    so a hub carries at most 2 bedrooms; with one, the
 *                    bath opens EN-SUITE through the bedroom; with two,
 *                    the middle bath is JACK-AND-JILL (a door from each
 *                    bedroom).
 *             SPINE  a HALL corridor behind the living room; every back
 *                    room doors onto the hall, free of the chest
 *                    constraint — the corridor is what historically
 *                    enabled reach-any-room-privately, and here it's
 *                    what lets a third bedroom exist. Needs back-band
 *                    depth for hall + a real room.
 *             The generator picks whichever SATISFIES the program (most
 *             wanted bedrooms), hash-coin variety on ties. Courtyard and
 *             richer cultural styles arrive with a per-town style vector
 *             later — new parameters, not new machinery.
 *
 *   EMBED     guillotine cuts of the footprint (cells ⊆ footprint by
 *             construction — subdivision, never packing), positions
 *             chosen by feasibility: minimum cell dims per function,
 *             door jambs, and DOOR_CLEAR for partition doors.
 *
 * `HouseRoom.depth` (door-graph hops from the living room) annotates the
 * PRIVACY GRADIENT every culture shares — publicness decays with depth.
 * The privacy need reads d(r), not room labels.
 *
 * Interior doors are 1.4 m (bath 1.2) — avatars auto-path through
 * doorways, so only the STREET door keeps the 2 m gaze affordance
 * (user decision, round 5).
 *
 * Room ids: the LIVING room KEEPS the house's historical building id
 * (`h_<index>`) — street door, goods boxes, table — so every errand
 * endpoint that used to mean "the house" still lands there. Back rooms
 * suffix it (_r1.._r3 bedrooms · _rb bath · _rh hall);
 * `houseIndexOfBuildingId` maps ANY of them back to the house.
 */

import type { TownHouse, TownWork } from "./plan";
import { ANNEX_ROOM_KIND, CLUSTERS, HOUSEHOLD, houseProgram, type BuildingProgram } from "./stations";
import { ladderBand, solveBand } from "./circulation";
import { DEFAULT_BODY_RADIUS_M, speciesBodyRadius } from "../../creatures/species";
// Type-only — construction.ts imports this module's VALUES (frame math),
// so the runtime dependency must stay one-directional.
import type { BuildingDelta } from "./construction";

// Local FNV/mulberry helpers, the kernel/town convention (plan.ts,
// residents.ts) — this layer stays import-free of app modules.
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

export interface RoomDoorway {
  edge: "north" | "south" | "east" | "west";
  /** Along the edge from its min corner (buildingStructures' convention). */
  offset: number;
  width: number;
}

export interface HouseRoom {
  /** Building id (living = `h_<index>`, back rooms `h_<index>_r*`,
   *  annexes `h_<index>_a<ord>` — construction.ts). */
  id: string;
  kind: "living" | "bedroom" | "bath" | "hall" | "store" | "kitchen" | "workshop";
  /** WORLD footprint rect (town center already applied). */
  rect: { x: number; y: number; w: number; h: number };
  /** Every doorway on this room's walls — a shared interior door appears
   *  on BOTH rooms it joins (embed.ts's convention). */
  doorways: RoomDoorway[];
  /** Door-graph hops from the living room (0 = living) — the privacy
   *  gradient: deeper is more private. */
  depth: number;
}

export interface HouseRoomPlan {
  /** rooms[0] is always the LIVING room (the street door's room). */
  rooms: HouseRoom[];
  partitioned: boolean;
  /** Bedroom ids in assignment order (see memberRoomOf). */
  bedrooms: string[];
  bathId: string | null;
}

/**
 * HOUSE_METRICS — every dimension the generator uses, in ONE place, with
 * the passability floors DERIVED from the base quantities instead of
 * hand-tuned. The engine blocks a body within `wallThickness/2 +
 * bodyRadius` of a wall's centerline (structuresWalkable), so:
 *
 *   passable width of an opening  = W − (wallThickness + 2·bodyRadius)
 *   walkable strip of a corridor  = W − (wallThickness + 2·bodyRadius)
 *
 * The body radius is THE CONSTRUCTING SPECIES' (speciesBodyRadius — a
 * species builds houses for its own adult size; the MODEL's visual
 * proportions never enter collision, human_cute is exactly as wide as a
 * capsule of 0.4). With the people default and 0.4 walls the keep-out is
 * 1.2 m: a 1.5 m hall left a 0.3 m strip and a 1.2 m door left NOTHING —
 * the round-5 narrow doors were impassable by arithmetic, which is why
 * creatures "refused" hallways. Change any base number below and the
 * floors re-derive; the generator's capacity rules (hub door counts,
 * spine feasibility) read the derived values, so plugged-in proportions
 * stay coherent. House
 * FOOTPRINT sizes live in dimensions.ts (TOWN_DIMS); furniture piece
 * sizes in furniture.ts (its FIT RULE makes any scale safe — pieces that
 * can't fit are omitted, never overlapped).
 */
export interface HouseMetrics {
  bodyRadius: number;
  wallThickness: number;
  streetDoorW: number;
  bathW: number;
  bedMinW: number;
  bedMinD: number;
  bedArea: number;
  partitionL: number;
  doorJamb: number;
  roomDoorW: number;
  bathDoorW: number;
  hallDoorW: number;
  hallW: number;
  doorClear: number;
}

const metricsCache = new Map<number, HouseMetrics>();

/** The metrics FOR A CONSTRUCTING SPECIES' body radius — a species builds
 *  for its own adult size, so every body-derived floor re-derives from the
 *  radius it designs for (a plan's `M`). Fixture geometry (cluster minimums,
 *  the chest inset) stays species-independent for now — a table is a table;
 *  only the PASSABILITY floors grow with the body. */
export function houseMetricsFor(bodyRadius: number): HouseMetrics {
  const hit = metricsCache.get(bodyRadius);
  if (hit) return hit;
  // ── base quantities (edit these) ──
  const wallThickness = 0.4; // town-stage's BuildingSpec walls
  const doorSlack = 0.6; // passable line a body needs through a doorway
  const laneSlack = 0.8; // walkable strip a corridor needs along its length
  const streetDoorW = Math.max(2.0, 2.0 + (bodyRadius - 0.4) * 2); // the gaze-steering affordance — keep generous
  // Cell floors come from the CLUSTER REGISTRY (stations.ts) — the wet
  // and sleep clusters own their geometry, this module only reads it.
  const bathW = CLUSTERS.wet!.minW!; // tub + privy + door lane
  const bedMinW = CLUSTERS.sleep!.minW!; // a real sleeping cell's minimum width
  const bedMinD = CLUSTERS.sleep!.minD!; // door swing lane + the 1.8 m double bed
  const bedArea = CLUSTERS.sleep!.cellArea!; // band m² that justify one sleeping cell
  const partitionL = 7.8; // frontage below this = studio
  const doorJamb = 0.5; // a door EDGE keeps this from its room's corners
  const chestSpotIn = 1.75; // goodBoxAt's corner inset (goods.ts)
  const chestSpotBerth = Math.max(0.5, bodyRadius + 0.1); // a body's berth around the standing spot
  // ── derived floors (recomputed from the bases) ──
  const keepOut = wallThickness + 2 * bodyRadius; // the wall's dead band
  const roomDoorW = keepOut + doorSlack; // 1.8 with the defaults
  const bathDoorW = keepOut + doorSlack;
  const hallDoorW = keepOut + doorSlack + 0.2; // the main artery breathes
  const hallW = keepOut + laneSlack; // 2.0 with the defaults
  const doorClear = chestSpotIn + chestSpotBerth + hallDoorW / 2 + 0.1;
  const m: HouseMetrics = {
    bodyRadius, wallThickness, streetDoorW, bathW, bedMinW, bedMinD,
    bedArea, partitionL, doorJamb, roomDoorW, bathDoorW, hallDoorW,
    hallW, doorClear,
  };
  metricsCache.set(bodyRadius, m);
  return m;
}

/** The PEOPLE-DEFAULT metrics (bodyRadius 0.4) — what every legacy house was
 *  built with. Kept for callers that reason about the default design; a
 *  species-aware path resolves through `metricsOf(house)` instead. */
export const HOUSE_METRICS = houseMetricsFor(DEFAULT_BODY_RADIUS_M);

/** THE house→metrics resolver: the metrics of the house's CONSTRUCTING
 *  species (TownHouse.species; absent = the people default). */
export function metricsOf(shape: { species?: string }): HouseMetrics {
  return houseMetricsFor(speciesBodyRadius(shape.species));
}

/** Frontage at/above this = the FULL form (bath cell + bedrooms). Below
 *  it the granularity gradient takes over (§9 slice 3): merged-wet
 *  two-cell where a lone partition door still clears the chests and the
 *  band holds a real sleep cell; the one-room studio otherwise. */
export const PARTITION_L = HOUSE_METRICS.partitionL;

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** The house index encoded in a room/house building id (`h_5`, `h_5_r1`),
 *  null for anything else (works `w_*`, market stalls, quest buildings). */
export function houseIndexOfBuildingId(id: string): number | null {
  if (!id.startsWith("h_")) return null;
  const n = Number(id.split("_")[1]);
  return Number.isFinite(n) ? n : null;
}

/** The fields a floor plan is a pure function of (color/floors don't
 *  shape rooms). `species` — the CONSTRUCTING species — shapes them too:
 *  its body radius sets every passability floor (houseMetricsFor). */
export type HouseShape = Pick<TownHouse, "index" | "dx" | "dy" | "w" | "h" | "door" | "species">;

/** The LIVING room's world rect — rooms[0] of the (memoized) plan. THE
 *  single source: goods.ts's box anchors and furniture's chest corners
 *  both read this, so the shopper's trip end, the drawn crate and the
 *  collision box can never drift apart — and a topology that resizes the
 *  living room (the spine steals depth for its hall) stays consistent
 *  everywhere for free. */
export function livingRect(
  center: { x: number; y: number },
  house: HouseShape,
): { x: number; y: number; w: number; h: number } {
  return houseRoomPlan(center, house).rooms[0]!.rect;
}

/** World point of a room doorway's center (u along the wall from its min
 *  corner — buildingStructures' convention). Exported for the goods-box
 *  resolver (placement.ts). */
export function doorwayWorldPoint(room: HouseRoom, d: RoomDoorway): { x: number; y: number } {
  const r = room.rect;
  return d.edge === "north" ? { x: r.x + d.offset, y: r.y }
    : d.edge === "south" ? { x: r.x + d.offset, y: r.y + r.h }
    : d.edge === "west" ? { x: r.x, y: r.y + d.offset }
    : { x: r.x + r.w, y: r.y + d.offset };
}

/** The corner of a room farthest from its nearest doorway — where the
 *  pantry fridge tucks so the oven keeps a wall and the shopper's stand
 *  spot in front stays reachable from the door. Index is goodBoxAt's
 *  (0 SW · 1 SE · 2 NE · 3 NW). The fit-aware room decision (kitchen vs
 *  living) lives in placement.ts's goodBoxPlacement (it needs the fit
 *  machinery to guarantee the oven never yields). */
export function kitchenDeepestCorner(room: HouseRoom): number {
  const r = room.rect;
  const corners = [
    { i: 0, x: r.x, y: r.y + r.h },
    { i: 1, x: r.x + r.w, y: r.y + r.h },
    { i: 2, x: r.x + r.w, y: r.y },
    { i: 3, x: r.x, y: r.y },
  ];
  const doors = room.doorways.map((d) => doorwayWorldPoint(room, d));
  let best = corners[0]!;
  let bestD = -Infinity;
  for (const c of corners) {
    const d = doors.length ? Math.min(...doors.map((p) => Math.hypot(c.x - p.x, c.y - p.y))) : 0;
    if (d > bestD + 1e-9) { bestD = d; best = c; }
  }
  return best.i;
}

/** Door-wall length (u axis) and depth (v axis) of a house. Exported for
 *  construction.ts (annex candidates reason in the same door-local frame). */
export function frameDims(house: Pick<TownHouse, "w" | "h" | "door">): { L: number; D: number } {
  const ns = house.door === "north" || house.door === "south";
  return { L: ns ? house.w : house.h, D: ns ? house.h : house.w };
}

/** Living-room depth along v: roomy enough for the table, never starving
 *  the back band below 3 m. */
function livingDepth(D: number): number {
  return clamp(0.52 * D, 4.2, D - 3.0);
}

/** Frame rect → world rect (frame axes are world-axis-aligned; only
 *  origin/orientation differ by door side). Exported for construction.ts. */
export function frameRect(
  house: Pick<TownHouse, "dx" | "dy" | "w" | "h" | "door">,
  x0: number,
  y0: number,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): { x: number; y: number; w: number; h: number } {
  const x1 = x0 + house.w;
  const y1 = y0 + house.h;
  switch (house.door) {
    case "north": return { x: x0 + u0, y: y0 + v0, w: u1 - u0, h: v1 - v0 };
    case "south": return { x: x0 + u0, y: y1 - v1, w: u1 - u0, h: v1 - v0 };
    case "west": return { x: x0 + v0, y: y0 + u0, w: v1 - v0, h: u1 - u0 };
    default: return { x: x1 - v1, y: y0 + u0, w: v1 - v0, h: u1 - u0 }; // east
  }
}

/** Frame point → world point. Exported for construction.ts. */
export function framePoint(
  house: Pick<TownHouse, "dx" | "dy" | "w" | "h" | "door">,
  x0: number,
  y0: number,
  u: number,
  v: number,
): { x: number; y: number } {
  const x1 = x0 + house.w;
  const y1 = y0 + house.h;
  switch (house.door) {
    case "north": return { x: x0 + u, y: y0 + v };
    case "south": return { x: x0 + u, y: y1 - v };
    case "west": return { x: x0 + v, y: y0 + u };
    default: return { x: x1 - v, y: y0 + u }; // east
  }
}

/** Which wall of `rect` the point sits on → a doorway record for that
 *  room (embed.ts's doorwayOnRoom, the proven multi-room convention).
 *  Null when the point is off every wall of this rect. Exported for
 *  construction.ts (annex doors follow the same convention). */
export function doorwayOnRect(
  rect: { x: number; y: number; w: number; h: number },
  at: { x: number; y: number },
  width: number,
): RoomDoorway | null {
  const EPS = 1e-3;
  const onX = at.x >= rect.x - EPS && at.x <= rect.x + rect.w + EPS;
  const onY = at.y >= rect.y - EPS && at.y <= rect.y + rect.h + EPS;
  if (Math.abs(at.y - rect.y) < EPS && onX) return { edge: "north", offset: at.x - rect.x, width };
  if (Math.abs(at.y - (rect.y + rect.h)) < EPS && onX) return { edge: "south", offset: at.x - rect.x, width };
  if (Math.abs(at.x - rect.x) < EPS && onY) return { edge: "west", offset: at.y - rect.y, width };
  if (Math.abs(at.x - (rect.x + rect.w)) < EPS && onY) return { edge: "east", offset: at.y - rect.y, width };
  return null;
}

/**
 * The floor plan of one house (module doc above: program → topology →
 * embed). Deterministic from the house record alone — variety comes from
 * a hash stream keyed on the house index, so goods.ts / furniture.ts /
 * residents.ts all reconstruct the identical plan with no shared state.
 * MEMOIZED (plans are pure and tiny; goods.ts reads livingRect through
 * this on its cycle math, so the lookup must be a map hit).
 *
 * CONSTRUCTION (v1): an optional BuildingDelta overlays the pure base —
 * annexes appended, demolished rooms merged away — via applyDelta below.
 * The delta's `rev` re-keys the memo, and the previous rev's entry is
 * EVICTED (one delta plan per building, however long the session). The
 * base plan itself never changes: goods.ts reads livingRect delta-blind,
 * and THE LIVING-ROOM INVARIANT (rooms[0] untouchable) is asserted after
 * every apply.
 */
const planCache = new Map<string, HouseRoomPlan>();
const deltaKeyOf = new Map<string, string>(); // baseKey → its one delta cache key
/** Does the delta change the ROOM PLAN? (Placed furniture doesn't.) */
const shapesRooms = (d: BuildingDelta | undefined): d is BuildingDelta =>
  !!d && (d.annexes.length > 0 || d.demolished.length > 0 || (d.interior?.length ?? 0) > 0);
/** Content hash of the ROOM-SHAPING delta fields — the memo re-key. By
 *  CONTENT, not rev: two stores with equal geometry share the entry, a
 *  furniture-only rev bump doesn't rebuild, and an undone annex falls
 *  back to the base plan's own cache line. */
const deltaShapeKey = (d: BuildingDelta): string =>
  `d${hashSeed(0, JSON.stringify({ a: d.annexes, m: d.demolished, i: d.interior ?? [] }))}`;
export function houseRoomPlan(
  center: { x: number; y: number },
  house: HouseShape,
  delta?: BuildingDelta,
): HouseRoomPlan {
  const baseKey = `${center.x},${center.y}|${house.index}|${house.dx},${house.dy},${house.w},${house.h},${house.door}|${house.species ?? ""}`;
  let base = planCache.get(baseKey);
  if (!base) {
    base = buildPlan(center, house);
    planCache.set(baseKey, base);
  }
  if (!shapesRooms(delta)) return base;
  const key = `${baseKey}|${deltaShapeKey(delta)}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const prev = deltaKeyOf.get(baseKey);
  if (prev && prev !== key) planCache.delete(prev);
  deltaKeyOf.set(baseKey, key);
  const plan = applyDelta(base, center, house, delta);
  planCache.set(key, plan);
  return plan;
}

function buildPlan(
  center: { x: number; y: number },
  house: HouseShape,
): HouseRoomPlan {
  // THE CONSTRUCTING SPECIES' metrics — every passability floor below
  // derives from the body this house is built for.
  const M = metricsOf(house);
  const { bedArea: BED_AREA, bathW: BATH_W, bedMinD: BED_MIN_D,
    roomDoorW: ROOM_DOOR_W, doorClear: DOOR_CLEAR, partitionL: PARTITION_L } = M;
  const x0 = center.x + house.dx;
  const y0 = center.y + house.dy;
  const { L, D } = frameDims(house);
  const along = house.door === "north" || house.door === "south" ? house.w : house.h;
  const streetDoor: RoomDoorway = { edge: house.door, offset: along / 2, width: M.streetDoorW };

  // ── GRANULARITY (§9 slice 3): below the full-form frontage the
  // clusters give up their dedicated cells in PRIVACY-RANK order — the
  // wet cell merges into the communal cell long before the household
  // gives up its bedroom (historically: the tin bath shared the hearth
  // room for generations after the sleeping loft appeared). The old
  // studio CLIFF at PARTITION_L is a gradient now:
  //   L ≥ PARTITION_L      living + bath + bedroom(s) — the ladder below
  //   L ≥ MERGE_L, D deep  living + bedroom; the wet stations STAND IN
  //                        THE LIVING ROOM (furniture's cell fallback
  //                        places a merged cluster's stations in the
  //                        communal cell)
  //   else                 the studio — the full merge
  if (L < PARTITION_L) {
    // A lone partition door must still clear both goods chests' standing
    // spots; the living room keeps its floor (4.2) and the sleep cell its
    // minimum depth. The living room takes everything the bedroom doesn't
    // need — its walls carry the merged wet stations, so the depth buys
    // the tub its stretch.
    const MERGE_L = 2 * DOOR_CLEAR;
    const vSplitM = Math.max(4.2, D - (BED_MIN_D + 0.3));
    if (L >= MERGE_L && D - vSplitM >= BED_MIN_D) {
      const living: HouseRoom = {
        id: `h_${house.index}`,
        kind: "living",
        rect: frameRect(house, x0, y0, 0, L, 0, vSplitM),
        doorways: [streetDoor],
        depth: 0,
      };
      const bed: HouseRoom = {
        id: `h_${house.index}_r1`,
        kind: "bedroom",
        rect: frameRect(house, x0, y0, 0, L, vSplitM, D),
        doorways: [],
        depth: 0,
      };
      const rooms = [living, bed];
      const at = framePoint(house, x0, y0, clamp(L / 2, DOOR_CLEAR, L - DOOR_CLEAR), vSplitM);
      for (const r of rooms) {
        const dw = doorwayOnRect(r.rect, at, ROOM_DOOR_W);
        if (dw) r.doorways.push(dw);
      }
      annotateDepths(rooms);
      return { rooms, partitioned: true, bedrooms: [bed.id], bathId: null };
    }
    return {
      rooms: [{
        id: `h_${house.index}`,
        kind: "living",
        rect: { x: x0, y: y0, w: house.w, h: house.h },
        doorways: [streetDoor],
        depth: 0,
      }],
      partitioned: false,
      bedrooms: [],
      bathId: null,
    };
  }

  const rng = mulberry32(hashSeed(house.index, "rooms"));
  // Fixed draws: n-jitter, side, topology, kitchen culture coin.
  const roll = [rng(), rng(), rng()] as const;
  const kitchenCoin = rng() < 0.5;

  const vSplitHub = livingDepth(D);

  // ── PROGRAM (§9 slice 2): the occupants' need-set sets the DEMAND
  // (HOUSEHOLD sleepers pairing perCell — the occupant program,
  // stations.ts); the back band's area is the GRANULARITY BUDGET (how
  // many dedicated cells the footprint affords, hash-jittered per
  // household); the topology ladder below is the CAPACITY. The realized
  // count is the least of the three. An inn multiplies the demand, a
  // smithy has none — same formula, different program.
  const program = houseProgram({ residents: HOUSEHOLD });
  const demand = program.sleepCells;
  const budget = (L - BATH_W) * (D - vSplitHub);
  const budgetCells = Math.round(budget / BED_AREA + (roll[0] - 0.5) * 0.6);
  const nWant = clamp(Math.min(demand, budgetCells), 1, 3);

  return bandPlan(`h_${house.index}`, house, M, x0, y0, L, D, streetDoor, roll, nWant, {
    want: program.kitchen,
    // THE CULTURE COIN (round 7): whether this household walls its
    // cooking off into a FRONT KITCHEN (bandPlan) or keeps the open
    // hearth hall — the first authored knob of the promised per-town
    // culture vector.
    frontCoin: kitchenCoin,
  });
}

/**
 * The FULL dwelling form: front (living) room + a solved back band of
 * cells (§9 slice 4). Shared by houses and by dwelling-programmed WORK
 * buildings (the inn multiplies `demand` past the house's 3 — the
 * solver's spine hall is how a row of cells gets doored).
 */
function bandPlan(
  idBase: string,
  shape: Pick<TownHouse, "dx" | "dy" | "w" | "h" | "door">,
  M: HouseMetrics,
  x0: number,
  y0: number,
  L: number,
  D: number,
  streetDoor: RoomDoorway,
  roll: readonly [number, number, number],
  demand: number,
  /** The program's KITCHEN demand (round 7): `want` asks the solver for
   *  a band kitchen cell at full sleep demand (granted only when it
   *  costs no bed — the spine hall is usually how one gets doored);
   *  `frontCoin` lets this household split a FRONT kitchen off the
   *  living room instead (the culture coin — buildPlan). */
  kit: { want: boolean; frontCoin: boolean } = { want: false, frontCoin: false },
): HouseRoomPlan {
  const { bathW: BATH_W, hallW: HALL_W, bedMinW: BED_MIN_W, bedMinD: BED_MIN_D,
    roomDoorW: ROOM_DOOR_W, bathDoorW: BATH_DOOR_W, hallDoorW: HALL_DOOR_W,
    doorJamb: DOOR_JAMB, doorClear: DOOR_CLEAR } = M;
  const vSplitHub = livingDepth(D);
  // ── CIRCULATION AS SEARCH (§9 slice 4): how each cell is REACHED is a
  // SOLUTION the solver finds (circulation.ts) — partition doors,
  // enfilade chains, Jack-and-Jill pairs and the spine hall are
  // candidates under one constraint set (the ladder's proven gates),
  // scored by realized demand, kitchen fit, circulation cost,
  // through-traffic and privacy fit. The round-5 ladder stays as the
  // FALLBACK (and as the benchmark the sweep test measures the solver
  // against).
  const bandInput = {
    L,
    D,
    vSplitHub,
    demand,
    metrics: {
      doorClear: DOOR_CLEAR,
      doorJamb: DOOR_JAMB,
      roomDoorW: ROOM_DOOR_W,
      bathDoorW: BATH_DOOR_W,
      hallDoorW: HALL_DOOR_W,
      hallW: HALL_W,
      bathW: BATH_W,
      bedMinW: BED_MIN_W,
      bedMinD: BED_MIN_D,
    },
    spineCoin: roll[2] < 0.35, // the hall EARNS its area, or variety
    kitchen: kit.want,
  };
  const hasKitchen = (b: { cells: { cluster: string }[] } | null): boolean =>
    !!b && b.cells.some((c) => c.cluster === "kitchen");
  const bedsOf = (b: { cells: { cluster: string }[] } | null): number =>
    b ? b.cells.filter((c) => c.cluster === "sleep").length : 0;
  let layout = solveBand(bandInput);

  // ── THE FRONT KITCHEN (round 7). A BAND kitchen cell barely exists in
  // hub houses — an edge cell's partition door can never clear the goods
  // chests (DOOR_CLEAR at both living ends), so the solver only realizes
  // one down a spine hall. But the SPACE for a kitchen is at the FRONT:
  // the living room runs the full frontage at 4.2+ deep. The culture
  // coin walls its high-u end (canonical — the variety mirror flips it
  // with the band) off as a galley kitchen, and the band re-solves with
  // its partition-door window pulled in to the SHRUNK living's chest
  // corners (doorClearHi — the corners move with livingRect, one
  // source). Taken only when it costs no sleep cell. Gates: the living
  // keeps both chest corners plus a door (2·DOOR_CLEAR), and the shared
  // wall's door needs a mid-wall berth clear of BOTH corner chests
  // (vSplit ≥ 4.4 — the boxes are unconditional, so the swing must miss
  // them by construction).
  const KIT_W = CLUSTERS.kitchen?.minW ?? BATH_W;
  let frontKit = false;
  if (kit.want && kit.frontCoin && !hasKitchen(layout)) {
    const vHub = bandInput.vSplitHub;
    if (L - KIT_W >= 2 * DOOR_CLEAR && vHub >= 4.4) {
      const f = solveBand({
        ...bandInput,
        kitchen: false,
        metrics: { ...bandInput.metrics, doorClearHi: L - KIT_W - DOOR_CLEAR },
      });
      // The REALIZED living depth carries the door berth (a spine steals
      // depth — its shallower living may lose the mid-wall window).
      if (f && f.vSplit >= 4.4 - 1e-9 && bedsOf(f) >= bedsOf(layout)) {
        layout = f;
        frontKit = true;
      }
    }
  }
  layout ??= ladderBand(bandInput);

  // The spine shrinks the living room to buy its hall (rooms behind get
  // ~3.4 m); a front kitchen shrinks it across; livingRect stays
  // truthful because it reads THIS plan.
  const vSplit = layout.vSplit;
  const backD = D - vSplit;
  /** The living room's high-u end and the band doors' clearance window
   *  (canonical) — a front kitchen pulls both in together, so partition
   *  doors keep clearing the chest corners that MOVED with the living. */
  const livU1 = frontKit ? L - KIT_W : L;
  const uClearHi = livU1 - DOOR_CLEAR;

  const bathAtLowU = roll[1] < 0.5;
  /** Mirror a frame u across the house when the bath sits high — spans
   *  and door points flip together (the living, a front kitchen and the
   *  band all mirror as one), so one canonical layout serves both
   *  sides. */
  const fu = (u: number): number => (bathAtLowU ? u : L - u);

  const living: HouseRoom = {
    id: idBase,
    kind: "living",
    rect: frameRect(shape, x0, y0, Math.min(fu(0), fu(livU1)), Math.max(fu(0), fu(livU1)), 0, vSplit),
    doorways: [streetDoor],
    depth: 0,
  };
  const rooms: HouseRoom[] = [living];
  const bedrooms: string[] = [];
  let bathId: string | null = null;

  /** Add a shared door at frame point (u, v) between every room whose
   *  wall it sits on — each adjacent room records its own doorway. */
  const sharedDoor = (u: number, v: number, width: number): void => {
    const at = framePoint(shape, x0, y0, u, v);
    for (const r of rooms) {
      const dw = doorwayOnRect(r.rect, at, width);
      if (dw) r.doorways.push(dw);
    }
  };
  const addRoom = (
    suffix: string,
    kind: HouseRoom["kind"],
    u0: number,
    u1: number,
    v0: number,
    v1: number,
  ): HouseRoom => {
    const room: HouseRoom = {
      id: `${idBase}${suffix}`,
      kind,
      rect: frameRect(shape, x0, y0, u0, u1, v0, v1),
      doorways: [],
      depth: 0,
    };
    rooms.push(room);
    if (kind === "bedroom") bedrooms.push(room.id);
    if (kind === "bath") bathId = room.id;
    return room;
  };

  const addRoomM = (
    suffix: string,
    kind: HouseRoom["kind"],
    u0: number,
    u1: number,
    v0: number,
    v1: number,
  ): HouseRoom => addRoom(suffix, kind, Math.min(fu(u0), fu(u1)), Math.max(fu(u0), fu(u1)), v0, v1);
  const sharedDoorM = (u: number, v: number, width: number): void => sharedDoor(fu(u), v, width);

  // ── EMIT the solved band — ONE realizer for every circulation shape
  // the search can produce. Door rules are the honed round-4/5 lessons,
  // applied uniformly: partition doors at the cell's center, chest-
  // clearance + jamb clamped; via (through-room) doors LOW on the shared
  // wall (their swing corridors cluster at the living end, so far walls
  // stay whole for beds — the J&J lesson); the living→hall door
  // OFF-CENTER (a centered swing lands where the table belongs).
  // ── THE FRONT KITCHEN's room and door (round 7; gates in the solve
  // above). Its door sits MID-WALL on the shared wall: the corner chests
  // are unconditional (goodsCorner — the corner IS the box), so the
  // swing corridor must miss both by construction (the vSplit ≥ 4.4
  // berth gate).
  if (frontKit) {
    addRoomM("_rk", "kitchen", livU1, L, 0, vSplit);
    sharedDoorM(livU1, clamp(vSplit / 2, 2.2, vSplit - 2.2), ROOM_DOOR_W);
  }

  /** A band cell's room suffix/kind/door width by cluster (the kitchen
   *  is `_rk` — one per plan, like the bath's `_rb`). */
  const cellRoom = (
    cluster: "wet" | "sleep" | "kitchen",
    nextBed: () => number,
  ): { suffix: string; kind: HouseRoom["kind"]; doorW: number } =>
    cluster === "wet"
      ? { suffix: "_rb", kind: "bath", doorW: BATH_DOOR_W }
      : cluster === "kitchen"
        ? { suffix: "_rk", kind: "kitchen", doorW: ROOM_DOOR_W }
        : { suffix: `_r${nextBed()}`, kind: "bedroom", doorW: ROOM_DOOR_W };

  if (layout.mode === "spine") {
    const hallV1 = vSplit + HALL_W;
    addRoom("_rh", "hall", 0, L, vSplit, hallV1);
    sharedDoorM(clamp(L * 0.32, DOOR_CLEAR, uClearHi), vSplit, HALL_DOOR_W);
    let bedI = 0;
    for (const c of layout.cells) {
      const r = cellRoom(c.cluster, () => ++bedI);
      addRoomM(r.suffix, r.kind, c.u0, c.u1, hallV1, D);
      // Its hall door — at the cell's center, jamb-clamped to its span.
      sharedDoorM(
        clamp((c.u0 + c.u1) / 2, c.u0 + DOOR_JAMB + r.doorW / 2, c.u1 - DOOR_JAMB - r.doorW / 2),
        hallV1,
        r.doorW,
      );
    }
  } else {
    let bedI = 0;
    layout.cells.forEach((c) => {
      const r = cellRoom(c.cluster, () => ++bedI);
      addRoomM(r.suffix, r.kind, c.u0, c.u1, vSplit, D);
    });
    layout.cells.forEach((c, i) => {
      const doorWBase = c.cluster === "wet" ? BATH_DOOR_W : ROOM_DOOR_W;
      if (c.access.kind === "partition") {
        sharedDoorM(
          clamp(
            (c.u0 + c.u1) / 2,
            Math.max(DOOR_CLEAR, c.u0 + DOOR_JAMB + doorWBase / 2),
            Math.min(uClearHi, c.u1 - DOOR_JAMB - doorWBase / 2),
          ),
          vSplit,
          doorWBase,
        );
      } else if (c.access.kind === "via") {
        const w = Math.min(doorWBase, backD - 1.2);
        for (const h of c.access.hosts) {
          sharedDoorM(h < i ? c.u0 : c.u1, vSplit + w / 2 + 0.6, w);
        }
      }
    });
  }

  annotateDepths(rooms);
  return { rooms, partitioned: true, bedrooms, bathId };
}

/** BFS over shared doors from the living room → HouseRoom.depth (the
 *  privacy gradient). Two rooms share a door when they record doorways
 *  at the same world point. */
function annotateDepths(rooms: HouseRoom[]): void {
  const doorPoint = (r: HouseRoom, d: RoomDoorway): string => {
    const at =
      d.edge === "north" ? { x: r.rect.x + d.offset, y: r.rect.y }
      : d.edge === "south" ? { x: r.rect.x + d.offset, y: r.rect.y + r.rect.h }
      : d.edge === "west" ? { x: r.rect.x, y: r.rect.y + d.offset }
      : { x: r.rect.x + r.rect.w, y: r.rect.y + d.offset };
    return `${at.x.toFixed(3)},${at.y.toFixed(3)}`;
  };
  const byPoint = new Map<string, HouseRoom[]>();
  for (const r of rooms) {
    for (const d of r.doorways) {
      const k = doorPoint(r, d);
      byPoint.set(k, [...(byPoint.get(k) ?? []), r]);
    }
  }
  for (const r of rooms) r.depth = Number.POSITIVE_INFINITY;
  rooms[0]!.depth = 0;
  const queue: HouseRoom[] = [rooms[0]!];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const linked of byPoint.values()) {
      if (!linked.includes(cur)) continue;
      for (const nxt of linked) {
        if (nxt.depth > cur.depth + 1) {
          nxt.depth = cur.depth + 1;
          queue.push(nxt);
        }
      }
    }
  }
  for (const r of rooms) if (!Number.isFinite(r.depth)) r.depth = 0; // unreachable = defensive
}

/**
 * APPLY A CONSTRUCTION DELTA to a base plan (construction v1). Pure:
 * same base + same delta ⇒ the identical plan, forever. Order of
 * operations is fixed — demolitions first (partitions come down), then
 * annexes in ordinal order (growth appends) — so a replayed delta can
 * never interleave differently.
 *
 * Demolition merges the room into its recorded host (the union was
 * validated RECTANGULAR at request time — construction.demolishRoom):
 * doors on surviving walls carry over (a door into the demolished room
 * becomes a door into the union); the partition door, now interior,
 * vanishes by construction (doorwayOnRect returns null off every wall).
 *
 * An annex is one new room flush past the footprint, its shared-wall
 * door cut at the RECORDED point — any room whose wall carries the point
 * records the doorway (bandPlan's sharedDoor convention), so the door
 * survives even when its original host merged into a union.
 *
 * An INTERIOR room (⑤b) carves a band OUT of its recorded host (after
 * annexes — an annex room may itself split): the host keeps the
 * rectangular remainder and every door that survives on its walls (the
 * cut was validated to strand none — interiorOptions); the new room takes
 * the band and the recorded partition door joins them. This is the ONE
 * path that may shrink rooms[0] — legal only for a NON-HOUSE root (a
 * shell subdividing from within); the living-room invariant then relaxes
 * to "same id, same street door, never grown".
 */
/** Host minus a flush guillotine cut → the rectangular remainder, null
 *  when the cut isn't a full-span band at one end (validated at request
 *  time — this is the defensive twin). */
function rectMinusRect(
  host: { x: number; y: number; w: number; h: number },
  cut: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } | null {
  const EPS = 1e-6;
  const sameX = Math.abs(cut.x - host.x) < EPS && Math.abs(cut.w - host.w) < EPS;
  const sameY = Math.abs(cut.y - host.y) < EPS && Math.abs(cut.h - host.h) < EPS;
  if (sameX && host.h - cut.h > EPS) {
    if (Math.abs(cut.y - host.y) < EPS) {
      return { x: host.x, y: cut.y + cut.h, w: host.w, h: host.h - cut.h };
    }
    if (Math.abs(cut.y + cut.h - (host.y + host.h)) < EPS) {
      return { x: host.x, y: host.y, w: host.w, h: host.h - cut.h };
    }
  }
  if (sameY && host.w - cut.w > EPS) {
    if (Math.abs(cut.x - host.x) < EPS) {
      return { x: cut.x + cut.w, y: host.y, w: host.w - cut.w, h: host.h };
    }
    if (Math.abs(cut.x + cut.w - (host.x + host.w)) < EPS) {
      return { x: host.x, y: host.y, w: host.w - cut.w, h: host.h };
    }
  }
  return null;
}

function applyDelta(
  base: HouseRoomPlan,
  center: { x: number; y: number },
  house: HouseShape,
  delta: BuildingDelta,
): HouseRoomPlan {
  const x0 = center.x + house.dx;
  const y0 = center.y + house.dy;
  // Deep-copy the base (the memoized base plan must never be mutated).
  const rooms: HouseRoom[] = base.rooms.map((r) => ({
    ...r,
    rect: { ...r.rect },
    doorways: r.doorways.map((d) => ({ ...d })),
  }));
  let bedrooms = [...base.bedrooms];
  let bathId = base.bathId;

  const doorWorldPoint = (r: HouseRoom, d: RoomDoorway): { x: number; y: number } =>
    d.edge === "north" ? { x: r.rect.x + d.offset, y: r.rect.y }
    : d.edge === "south" ? { x: r.rect.x + d.offset, y: r.rect.y + r.rect.h }
    : d.edge === "west" ? { x: r.rect.x, y: r.rect.y + d.offset }
    : { x: r.rect.x + r.rect.w, y: r.rect.y + d.offset };

  // ── demolitions: merge each room into its recorded host.
  for (const dem of delta.demolished) {
    const goneIdx = rooms.findIndex((r) => r.id === dem.roomId);
    const host = rooms.find((r) => r.id === dem.into);
    if (goneIdx <= 0 || !host) continue; // defensive — validated at request time
    const gone = rooms[goneIdx]!;
    const union = {
      x: Math.min(gone.rect.x, host.rect.x),
      y: Math.min(gone.rect.y, host.rect.y),
      w: Math.max(gone.rect.x + gone.rect.w, host.rect.x + host.rect.w) - Math.min(gone.rect.x, host.rect.x),
      h: Math.max(gone.rect.y + gone.rect.h, host.rect.y + host.rect.h) - Math.min(gone.rect.y, host.rect.y),
    };
    // Doors of BOTH rooms re-derived against the union — the partition
    // door lies strictly inside it and drops out; everything on a
    // surviving wall carries over.
    const carried: RoomDoorway[] = [];
    for (const src of [host, gone]) {
      for (const dw of src.doorways) {
        const ndw = doorwayOnRect(union, doorWorldPoint(src, dw), dw.width);
        if (ndw) carried.push(ndw);
      }
    }
    host.rect = union;
    host.doorways = carried;
    rooms.splice(goneIdx, 1);
    bedrooms = bedrooms.filter((id) => id !== gone.id);
    if (bathId === gone.id) bathId = null;
  }

  // ── annexes, in ordinal order (ids are `<base>_a<ord>` forever).
  const idBase = rooms[0]!.id;
  for (const a of [...delta.annexes].sort((p, q) => p.ord - q.ord)) {
    const room: HouseRoom = {
      id: `${idBase}_a${a.ord}`,
      kind: ANNEX_ROOM_KIND[a.cluster],
      rect: frameRect(house, x0, y0, a.u0, a.u1, a.v0, a.v1),
      doorways: [],
      depth: 0,
    };
    rooms.push(room);
    if (room.kind === "bedroom") bedrooms.push(room.id);
    if (room.kind === "bath" && !bathId) bathId = room.id;
    const at = framePoint(house, x0, y0, a.doorAt.u, a.doorAt.v);
    for (const r of rooms) {
      const dw = doorwayOnRect(r.rect, at, a.doorAt.width);
      if (dw) r.doorways.push(dw);
    }
  }

  // ── interior rooms (⑤b), in ordinal order — AFTER annexes, so an annex
  // room may host a cut. Each spec was validated at request time; a spec
  // whose host is gone or whose remainder wouldn't tile skips defensively
  // (never a half-applied room).
  for (const s of [...(delta.interior ?? [])].sort((p, q) => p.ord - q.ord)) {
    const host = rooms.find((r) => r.id === s.hostId);
    if (!host) continue;
    const cutRect = frameRect(house, x0, y0, s.u0, s.u1, s.v0, s.v1);
    const rem = rectMinusRect(host.rect, cutRect);
    if (!rem) continue;
    // The host keeps every door that survives on the remainder's walls;
    // one that falls on the CUT's outer boundary TRANSFERS whole to the
    // new room (re-creation hands the demolished room its old doors back
    // — the adjacent room still records its own half, so the shared door
    // re-pairs by world point). The cut was validated to strand none.
    const carried: RoomDoorway[] = [];
    const transferred: Array<{ at: { x: number; y: number }; width: number }> = [];
    for (const dw of host.doorways) {
      const at = doorWorldPoint(host, dw);
      const ndw = doorwayOnRect(rem, at, dw.width);
      if (ndw) carried.push(ndw);
      else transferred.push({ at, width: dw.width });
    }
    host.rect = rem;
    host.doorways = carried;
    const room: HouseRoom = {
      id: `${idBase}_i${s.ord}`,
      kind: s.kind,
      rect: cutRect,
      doorways: [],
      depth: 0,
    };
    for (const tr of transferred) {
      const ndw = doorwayOnRect(cutRect, tr.at, tr.width);
      if (ndw) room.doorways.push(ndw);
    }
    rooms.push(room);
    if (room.kind === "bedroom") bedrooms.push(room.id);
    if (room.kind === "bath" && !bathId) bathId = room.id;
    const at = framePoint(house, x0, y0, s.doorAt.u, s.doorAt.v);
    for (const r of rooms) {
      const dw = doorwayOnRect(r.rect, at, s.doorAt.width);
      if (dw) r.doorways.push(dw);
    }
  }

  annotateDepths(rooms);

  // THE LIVING-ROOM INVARIANT — rooms[0] byte-equal to the base. Goods
  // anchors, chest ids and errand endpoints all hang off it; a delta
  // that moved it is a programming error, not a content state. The ONE
  // legal exception: an interior spec naming rooms[0] (a shell's root
  // subdividing — non-house callers only, interiorOptions' keepRoot
  // gate) may SHRINK it; the id, a surviving doorway (the street door)
  // and containment in the base rect still hold.
  const rootSplit = (delta.interior ?? []).some((s) => s.hostId === base.rooms[0]!.id);
  const lb = base.rooms[0]!.rect;
  const la = rooms[0]!.rect;
  if (rooms[0]!.id !== base.rooms[0]!.id) {
    throw new Error(`applyDelta moved the living room of ${idBase}`);
  }
  if (rootSplit) {
    const inside =
      la.x >= lb.x - 1e-6 && la.y >= lb.y - 1e-6 &&
      la.x + la.w <= lb.x + lb.w + 1e-6 && la.y + la.h <= lb.y + lb.h + 1e-6;
    if (!inside || rooms[0]!.doorways.length === 0) {
      throw new Error(`applyDelta broke the root of ${idBase}`);
    }
  } else if (la.x !== lb.x || la.y !== lb.y || la.w !== lb.w || la.h !== lb.h) {
    throw new Error(`applyDelta moved the living room of ${idBase}`);
  }

  return { rooms, partitioned: rooms.length > 1, bedrooms, bathId };
}

/** The room a member calls their own: members pair off over the bedrooms
 *  in order (0,1 → the first — the double bed's; 2,3 → the second; 4 →
 *  the third), collapsing onto the last bedroom that exists — the living
 *  room only in a studio. Pets live in the living room. */
export function memberRoomOf(plan: HouseRoomPlan, member: number): HouseRoom {
  const want = Math.floor(Math.max(0, member) / 2);
  const id = plan.bedrooms[Math.min(want, plan.bedrooms.length - 1)];
  return plan.rooms.find((r) => r.id === id) ?? plan.rooms[0]!;
}

// ── NON-HOUSE BUILDINGS (§9 slice 5) ────────────────────────────────────
// A work building's interior is its PROGRAM (stations.ts WORK_PROGRAMS)
// run through the same generator a house uses — the dwelling is just one
// program. Room ids: the FRONT room keeps the work's historical building
// id (`w_<index>` — every consumer that meant "the building" still lands
// there); back rooms suffix it (_rs store · _r*/_rb/_rh dwelling cells).

/** The fields a work interior is a pure function of. `stations` is the
 *  building's extra-fixture override (workFurniture reads it; the room plan
 *  ignores it). */
export type WorkShape = Pick<TownWork, "dx" | "dy" | "w" | "h" | "door" | "species" | "stations" | "bare">;

const workPlanCache = new Map<string, HouseRoomPlan>();

/**
 * The floor plan of one WORK building — deterministic, memoized, same
 * contract as houseRoomPlan. The program picks the form:
 *   sleepCells  the dwelling band (the INN: sleep multiplied; the spine
 *               hall doors what a partition never could)
 *   store       front sales floor + a shallow stock band behind, when
 *               the footprint affords the store cluster's floors
 *   (neither)   one open hall (the market's stalls, the town hall's
 *               assembly floor — partitioning would wall off the point)
 */
export function buildingRoomPlan(
  center: { x: number; y: number },
  index: number,
  work: WorkShape,
  program: BuildingProgram,
  delta?: BuildingDelta,
): HouseRoomPlan {
  const baseKey = `${center.x},${center.y}|w${index}|${work.dx},${work.dy},${work.w},${work.h},${work.door}|${program.sleepCells ?? 0},${program.wet ? 1 : 0},${program.store ? 1 : 0},${program.kitchen ? 1 : 0}|${work.species ?? ""}`;
  let base = workPlanCache.get(baseKey);
  if (!base) {
    base = buildWorkPlan(center, index, work, program);
    workPlanCache.set(baseKey, base);
  }
  if (!shapesRooms(delta)) return base;
  const key = `${baseKey}|${deltaShapeKey(delta)}`;
  const hit = workPlanCache.get(key);
  if (hit) return hit;
  const prev = deltaKeyOf.get(baseKey);
  if (prev && prev !== key) workPlanCache.delete(prev);
  deltaKeyOf.set(baseKey, key);
  // A work's shape lacks `index` — applyDelta only reads the frame
  // fields, so grafting the index on keeps HouseShape satisfied.
  const plan = applyDelta(base, center, { ...work, index }, delta);
  workPlanCache.set(key, plan);
  return plan;
}

function buildWorkPlan(
  center: { x: number; y: number },
  index: number,
  work: WorkShape,
  program: BuildingProgram,
): HouseRoomPlan {
  const M = metricsOf(work);
  const { bedArea: BED_AREA, bathW: BATH_W, roomDoorW: ROOM_DOOR_W,
    partitionL: PARTITION_L } = M;
  const x0 = center.x + work.dx;
  const y0 = center.y + work.dy;
  const { L, D } = frameDims(work);
  const along = work.door === "north" || work.door === "south" ? work.w : work.h;
  const streetDoor: RoomDoorway = { edge: work.door, offset: along / 2, width: M.streetDoorW };
  const idBase = `w_${index}`;
  const open = (): HouseRoomPlan => ({
    rooms: [{
      id: idBase,
      kind: "living",
      rect: { x: x0, y: y0, w: work.w, h: work.h },
      doorways: [streetDoor],
      depth: 0,
    }],
    partitioned: false,
    bedrooms: [],
    bathId: null,
  });

  if (program.sleepCells) {
    // The dwelling band, demand from the program — the same granularity
    // budget (band area per sleep cellArea) clamps what the footprint
    // affords; no artificial cap (the solver's spine scales).
    if (L < PARTITION_L) return open();
    const rng = mulberry32(hashSeed(index, "workrooms"));
    const roll = [rng(), rng(), rng()] as const;
    const vSplitHub = livingDepth(D);
    const budgetCells = Math.round(((L - BATH_W) * (D - vSplitHub)) / BED_AREA + (roll[0] - 0.5) * 0.6);
    const demand = clamp(Math.min(program.sleepCells, budgetCells), 1, program.sleepCells);
    // No front-split coin for works (a shop front is the shop) — the
    // inn's kitchen exists where the band/spine affords it.
    return bandPlan(idBase, work, M, x0, y0, L, D, streetDoor, roll, demand, {
      want: !!program.kitchen,
      frontCoin: false,
    });
  }

  if (program.store) {
    // Front sales floor + a shallow stock band along the back wall — the
    // two-cell guillotine (slice 3's merged form, storefront edition).
    // The store cluster's floors gate the split; too small goes OPEN.
    const storeMinD = CLUSTERS.store!.minD!;
    const storeD = clamp(0.3 * D, storeMinD, 3.2);
    const FRONT_MIN_D = 4.2; // the sales floor keeps a real room
    const doorHalf = M.doorJamb + ROOM_DOOR_W / 2;
    if (D - storeD >= FRONT_MIN_D && L >= 2 * doorHalf + 0.2) {
      const vSplit = D - storeD;
      const front: HouseRoom = {
        id: idBase,
        kind: "living",
        rect: frameRect(work, x0, y0, 0, L, 0, vSplit),
        doorways: [streetDoor],
        depth: 0,
      };
      const store: HouseRoom = {
        id: `${idBase}_rs`,
        kind: "store",
        rect: frameRect(work, x0, y0, 0, L, vSplit, D),
        doorways: [],
        depth: 0,
      };
      const rooms = [front, store];
      // No goods chests in a work's front room — the partition door only
      // needs its jambs, so it centers plainly.
      const at = framePoint(work, x0, y0, clamp(L / 2, doorHalf, L - doorHalf), vSplit);
      for (const r of rooms) {
        const dw = doorwayOnRect(r.rect, at, ROOM_DOOR_W);
        if (dw) r.doorways.push(dw);
      }
      annotateDepths(rooms);
      return { rooms, partitioned: true, bedrooms: [], bathId: null };
    }
    return open();
  }

  return open();
}
