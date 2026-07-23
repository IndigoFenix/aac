/**
 * construction.ts — THE CONSTRUCTION OVERLAY (construction v1): the ONLY
 * mutable geometry state a town carries. The whole town is a pure
 * function of (seed, config, clock); every deliberate change — an annex
 * raised behind a house, a partition taken down, a chair a resident
 * placed — is a discrete DELTA held here and consumed by the pure
 * generators as INPUT (rooms.ts applyDelta, furniture.ts seeding).
 * Delete the delta and the base town returns; serialize it and the
 * mutated town replays byte-identically (seed + clock + mutations).
 *
 * Scope-agnostic by design: deltas are keyed by BUILDING KEY (`h_<i>`,
 * `w_<i>`), and every rule below reasons in a building's door-local
 * frame + a caller-supplied neighbor set — the same machinery grows a
 * cottage bedroom, a shop's stock room, and (later) a city block.
 *
 * THE LIVING-ROOM INVARIANT (load-bearing): rooms[0] — the street door's
 * room, the goods corners, the errand endpoints — is untouchable. An
 * annex never overlaps it, a demolition may never name it, and rooms.ts
 * asserts its rect against the base plan after every applyDelta. This is
 * what keeps goods.ts (the shopping clock, the chest ids, reanchor)
 * entirely DELTA-BLIND.
 *
 * Feasibility lives INSIDE the candidate test (annexOptions), never as
 * post-hoc repair: a candidate that reaches the caller is buildable.
 */

import {
  frameDims,
  frameRect,
  houseRoomPlan,
  metricsOf,
  type HouseRoom,
  type HouseRoomPlan,
  type HouseShape,
  type RoomDoorway,
} from "./rooms";
import { CLUSTERS, type AnnexCluster, type StationKind } from "./stations";
import { growStreets, type TownStreets } from "./streets";
import type { TownPlan } from "./plan";
// Type-only by design (zoning.ts imports THIS module at runtime — the one
// direction; the charter rows just live in the same serialized store).
import type { SlotZoning, ZoneCharter } from "./zoning";
// Type-only likewise (population.ts is the ④ runtime; the cohort rows just
// live in the same serialized store).
import type { CohortRow } from "./population";
// Runtime import (one direction — transfer.ts never imports construction):
// the standing-route ledger SERIALIZES WITH THE DELTAS so reload keeps
// trade routes exactly as it keeps founded buildings (P0, nations arc).
import {
  createTransferLedger,
  type SerializedTransferLedger,
  type TransferLedger,
} from "./transfer.js";
// Kernel-root import (the scale.ts precedent): AUTHORED law rows persist
// beside the construction they govern; the absolute ring never does (it
// re-derives from game.culture every boot).
import type { Law } from "../laws.js";

export type { AnnexCluster };

/** Which footprint edge the annex grows from, in the door-local frame:
 *  `rear` past the far wall (v > D), `side0`/`side1` past the flanks. */
export type AnnexSide = "rear" | "side0" | "side1";

/** One annex, fully determined: its frame rect (flush against the BASE
 *  footprint), its cluster, and its door — stored exactly so that
 *  re-materialization is exact on every replay. */
export interface AnnexSpec {
  /** Ordinal — annex k of this building, forever (ids `_a<ord>`). */
  ord: number;
  side: AnnexSide;
  cluster: AnnexCluster;
  /** Frame rect (door-local u/v — rear: v0 === D; side: u1 === 0 or
   *  u0 === L of the base footprint). */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** The existing room the shared-wall door cuts into. */
  doorInto: string;
  /** The door's center on the shared wall (frame) + its width. */
  doorAt: { u: number; v: number; width: number };
}

/** A candidate annex — an AnnexSpec minus the ordinal (assigned when the
 *  request is accepted). */
export type AnnexCandidate = Omit<AnnexSpec, "ord">;

/** A player/creature-placed furniture piece (world meters, like
 *  FurniturePiece — the generator fits its stations AROUND these). */
export interface PlacedPiece {
  id: string;
  kind: StationKind;
  x: number;
  y: number;
  radius: number;
  facing: number;
  openable: boolean;
  roomId: string;
}

/** A demolished BASE room and the door-adjacent room that absorbs its
 *  floor (the partition between them comes down — rect union, validated
 *  rectangular at request time). Annex rooms demolish by removing their
 *  AnnexSpec instead (the footprint shrinks back). */
export interface DemolishedRoom {
  roomId: string;
  into: string;
}

/** One building's construction overlay. Plain JSON — serializable. */
export interface BuildingDelta {
  /** Monotone per-building revision — the memo caches' re-key. */
  rev: number;
  /** Append-only (like floors: growth only adds; removal is `demolished`
   *  for base rooms, spec removal for annexes). */
  annexes: AnnexSpec[];
  demolished: DemolishedRoom[];
  placed: PlacedPiece[];
  /** Generated piece ids removed/stowed — furnishPlan never emits them
   *  (their space genuinely frees; an anchored piece follows its anchor). */
  removedPieces: string[];
  /** The auto-expansion accumulator (construction v1 §5). */
  prosperity?: number;
}

/**
 * A FOUNDED BUILDING (city-expansion ①b) — the annex pattern ONE LEVEL UP:
 * founding a whole building is an "annex" of the street/block frame. The
 * delta stores everything EXACTLY (lot rect flush to a street frontage,
 * door onto the street ≙ `doorInto`, the slot claimed), so re-materialization
 * is exact on every replay — the pure generators (plan.ts / town-stage.ts)
 * consume these rows as input. Feasibility lived INSIDE the enumeration
 * (`foundingOptions`, the annexOptions law): a row that got committed was
 * buildable when it was ordered.
 */
export interface FoundedBuilding {
  /** Founding ordinal — building k founded at this town, forever. */
  ord: number;
  /** StructureSpec type (the catalog key; also the TownWork.type). */
  type: string;
  /** The street frontage slot claimed (streets.ts prefix-stable sequence). */
  slot: number;
  /** Lot rect, TOWN-LOCAL (relative the town center), stored exactly. */
  dx: number;
  dy: number;
  w: number;
  h: number;
  /** Door on the street-facing edge (faces the slot's frontage anchor). */
  door: "north" | "south" | "east" | "west";
  /** Town street-day construction started (fractional days). */
  startedDay: number;
  /** Street-days of visible construction. */
  buildDays: number;
  /** Construction FINISHED — written once by the host when the clock passed
   *  (a serialized fact, so a rebooted session never re-scaffolds it). */
  completed?: boolean;
  /** A HOUSEHOLD MOVED IN (④ move-in, house-role specs only) — written once
   *  by `admitHousehold` when the immigration rule admits one (a serialized
   *  fact, the `completed` pattern): the building materializes as a REAL
   *  house (plan.houses row + residents) instead of an empty work row, on
   *  this session and every rebuild. */
  household?: boolean;
}

/** A founding candidate — a FoundedBuilding minus the ordinal/clock fields
 *  (assigned when the order is accepted). */
export type FoundingCandidate = Omit<FoundedBuilding, "ord" | "startedDay" | "buildDays" | "completed">;

export interface SerializedTownDeltas {
  version: number;
  buildings: Record<string, BuildingDelta>;
  /** Founded whole buildings, in founding order (①b). Absent = none. */
  founded?: FoundedBuilding[];
  /** The town's builder's-yard STOCK (material glyph → count) build costs
   *  draw from. Absent = empty. (A wilderness FoundedSite keeps its own
   *  stock until its town builds; siteTownConfig copies it in here.) */
  stock?: Record<string, number>;
  /** ZONE CHARTERS (③), in charter (ord) order. Absent = none. */
  zones?: ZoneCharter[];
  /** Town-scope prosperity banked toward zone-steered FOUNDING (③).
   *  Absent = 0. */
  civicProsperity?: number;
  /** PER-DISTRICT COHORT POOLS (④), in district order. Absent = none —
   *  the tier is dormant below the tracked cap. */
  cohorts?: CohortRow[];
  /** THE TRANSFER/BARTER LEDGER (② / ⑤) — standing trade routes and
   *  in-flight hauls survive reload beside the geometry they feed.
   *  Absent = empty ledger. */
  transfers?: SerializedTransferLedger;
  /** ABSTRACT-PARTNER SHELVES (⑤ stub partners): partner key → the
   *  synthetic stack `town:<key>` endpoints alias when the partner isn't a
   *  real sim. Serialized so a standing barter route resumes against the
   *  same boundary mint. Absent = none. */
  partnerStock?: Record<string, Record<string, number>>;
  /** AUTHORED LAWS (nations P2, kernel/laws.ts): player/NPC-issued
   *  prohibitions scoped to this settlement — "no fight in town" outlives
   *  the session. NEVER holds the world spec's absolute ring (that
   *  re-derives from game.culture). Absent = none. */
  laws?: Law[];
}

/** The per-town overlay store. `version` is the global monotone the
 *  stage's dirty check watches; each building's `rev` re-keys its memo. */
export interface TownDeltas {
  get(key: string): BuildingDelta | undefined;
  /** Mutate (creating an empty delta on first touch) — bumps the
   *  building's rev and the store's version. */
  mutate(key: string, f: (d: BuildingDelta) => void): void;
  keys(): string[];
  version: number;
  /** FOUNDED whole buildings, in founding order (①b). Read-only view. */
  founded(): readonly FoundedBuilding[];
  /** Commit a validated founding candidate (from foundingOptions) — assigns
   *  its ordinal, stamps the clock, bumps the version. */
  foundBuilding(c: FoundingCandidate, startedDay: number, buildDays: number): FoundedBuilding;
  /** Mark founded building `ord` construction-COMPLETE (idempotent). Bumps
   *  the version so the stage re-stages doors + furniture the same frame. */
  completeFounding(ord: number): void;
  /** Mark founded house `ord` HOUSEHOLDED (④ move-in, idempotent). Bumps
   *  the version so the stage reconciles the work-row→house conversion. */
  admitHousehold(ord: number): void;
  /** The town's material STOCK (glyph → count) — the ONE mutable stack map
   *  build costs draw from (aliasable as a crate's contents, the FoundedSite
   *  pattern). Mutate it in place; it serializes with the deltas. */
  readonly stock: Record<string, number>;
  /** ZONE CHARTERS (③) in charter (ord) order — the LATEST charter covering
   *  a point WINS where discs overlap (zoning.ts zoneAt). Read-only view. */
  zones(): readonly ZoneCharter[];
  /** Charter a zone (category null = clear the ground back to unzoned) —
   *  assigns its ordinal, bumps the version (the ground overlay re-tints). */
  addZone(c: Omit<ZoneCharter, "ord">): ZoneCharter;
  /** The town-scope prosperity accumulator (③ zone-steered founding —
   *  the civic twin of each house delta's `prosperity`). Mutate in place;
   *  it serializes with the deltas. */
  readonly civic: { prosperity: number };
  /** PER-DISTRICT COHORT POOLS (④, population.ts) — the LIVE rows the
   *  cohort machinery mutates in place (the `stock` pattern); they
   *  serialize with the deltas. Empty below the tracked cap. */
  readonly cohorts: CohortRow[];
  /** THE TRANSFER/BARTER LEDGER (②/⑤) — the live ledger the session
   *  executes against (quest-host aliases it as `session.transfers`); it
   *  serializes with the deltas so standing routes survive reload. */
  readonly transfers: TransferLedger;
  /** ABSTRACT-PARTNER SHELVES (⑤) — partner key → synthetic stack, mutated
   *  in place (the `stock` pattern); serializes with the deltas. */
  readonly partnerStock: Record<string, Record<string, number>>;
  /** AUTHORED LAWS (nations P2) — the live rows the session's law book
   *  aliases (the cohorts pattern: append via kernel/laws.ts addLaw);
   *  serializes with the deltas. */
  readonly laws: Law[];
  toJSON(): SerializedTownDeltas;
}

export function emptyDelta(): BuildingDelta {
  return { rev: 0, annexes: [], demolished: [], placed: [], removedPieces: [] };
}

/** True when a delta changes nothing (a fresh or fully-undone one). */
export function deltaIsEmpty(d: BuildingDelta | undefined): boolean {
  return (
    !d ||
    (d.annexes.length === 0 &&
      d.demolished.length === 0 &&
      d.placed.length === 0 &&
      d.removedPieces.length === 0)
  );
}

export function createTownDeltas(json?: SerializedTownDeltas): TownDeltas {
  const buildings = new Map<string, BuildingDelta>();
  if (json) {
    for (const [k, d] of Object.entries(json.buildings)) {
      // Deep-clone on load — the store owns its state (no aliasing the
      // caller's JSON).
      buildings.set(k, JSON.parse(JSON.stringify(d)) as BuildingDelta);
    }
  }
  const founded: FoundedBuilding[] = (json?.founded ?? []).map(
    (b) => JSON.parse(JSON.stringify(b)) as FoundedBuilding,
  );
  const stock: Record<string, number> = { ...(json?.stock ?? {}) };
  const zones: ZoneCharter[] = (json?.zones ?? []).map((z) => ({ ...z }));
  const civic = { prosperity: json?.civicProsperity ?? 0 };
  const cohorts: CohortRow[] = (json?.cohorts ?? []).map(
    (r) => JSON.parse(JSON.stringify(r)) as CohortRow,
  );
  const transfers = createTransferLedger(json?.transfers);
  const partnerStock: Record<string, Record<string, number>> = JSON.parse(
    JSON.stringify(json?.partnerStock ?? {}),
  ) as Record<string, Record<string, number>>;
  const laws: Law[] = (json?.laws ?? []).map((l) => JSON.parse(JSON.stringify(l)) as Law);
  const store: TownDeltas = {
    version: json?.version ?? 0,
    get: (key) => buildings.get(key),
    mutate: (key, f) => {
      const d = buildings.get(key) ?? emptyDelta();
      f(d);
      d.rev++;
      buildings.set(key, d);
      store.version++;
    },
    keys: () => [...buildings.keys()],
    founded: () => founded,
    foundBuilding: (c, startedDay, buildDays) => {
      const ord = founded.reduce((m, b) => Math.max(m, b.ord + 1), 0);
      const b: FoundedBuilding = { ord, ...c, startedDay, buildDays };
      founded.push(b);
      store.version++;
      return b;
    },
    completeFounding: (ord) => {
      const b = founded.find((f) => f.ord === ord);
      if (!b || b.completed) return;
      b.completed = true;
      store.version++;
    },
    admitHousehold: (ord) => {
      const b = founded.find((f) => f.ord === ord);
      if (!b || b.household) return;
      b.household = true;
      store.version++;
    },
    stock,
    zones: () => zones,
    addZone: (c) => {
      const ord = zones.reduce((m, z) => Math.max(m, z.ord + 1), 0);
      const z: ZoneCharter = { ord, ...c };
      zones.push(z);
      store.version++;
      return z;
    },
    civic,
    cohorts,
    transfers,
    partnerStock,
    laws,
    toJSON: () => ({
      version: store.version,
      buildings: Object.fromEntries(
        [...buildings.entries()].map(([k, d]) => [k, JSON.parse(JSON.stringify(d)) as BuildingDelta]),
      ),
      founded: founded.map((b) => JSON.parse(JSON.stringify(b)) as FoundedBuilding),
      stock: { ...stock },
      zones: zones.map((z) => ({ ...z })),
      civicProsperity: civic.prosperity,
      cohorts: cohorts.map((r) => JSON.parse(JSON.stringify(r)) as CohortRow),
      transfers: transfers.toJSON(),
      partnerStock: JSON.parse(JSON.stringify(partnerStock)) as Record<string, Record<string, number>>,
      laws: laws.map((l) => JSON.parse(JSON.stringify(l)) as Law),
    }),
  };
  return store;
}

/** Is founded building `b` construction-complete at town street-day `day`?
 *  The serialized `completed` fact wins (a reboot resets the clock); until
 *  it's written, the clock decides — so visuals never wait on the host. */
export function foundedBuildingDone(b: FoundedBuilding, day: number): boolean {
  return b.completed === true || day >= b.startedDay + b.buildDays;
}

// ── ANNEX FEASIBILITY ───────────────────────────────────────────────────

/** Total building depth (base + rear annexes) never exceeds this —
 *  the lot's back garden keeps real ground (TOWN_DIMS: 15 m lot pitch,
 *  10.5 m setback, 30 m street gap ⇒ ~4 m of rear room on the deepest
 *  base footprint). */
export const ANNEX_DEPTH_CAP = 14;
/** Total frontage (base + side annexes) cap — side gaps are the tight
 *  ones (15 m pitch vs 13 m max frontage). */
export const ANNEX_FRONTAGE_CAP = 16;
/** Clearance an annex keeps from every neighbor footprint. */
export const ANNEX_CLEARANCE = 1.0;
/** Annexes per building — a cottage is not a palace. */
export const MAX_ANNEXES = 3;
/** Materials a PLAYER-ORDERED annex spends from the builder's stock
 *  (city-founding ③ structure board) — about one room of the house's own
 *  6-wood build cost. Auto-expansion keeps paying in banked prosperity. */
export const ANNEX_COSTS: Readonly<Record<string, number>> = { wood: 2 };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Frame rect of the annex → world rect (frameRect handles coordinates
 *  outside the base 0..L/0..D — the annex lives past the footprint). */
export function annexWorldRect(
  center: { x: number; y: number },
  house: HouseShape,
  a: Pick<AnnexSpec, "u0" | "u1" | "v0" | "v1">,
): Rect {
  return frameRect(house, center.x + house.dx, center.y + house.dy, a.u0, a.u1, a.v0, a.v1);
}

const rectGap = (a: Rect, b: Rect): number => {
  const gx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
  const gy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.max(gx, gy); // axis-aligned: separation on the wider axis
};

/** A room's rect in the house's door-local frame. */
function frameOfRect(
  center: { x: number; y: number },
  house: HouseShape,
  r: Rect,
): { u0: number; u1: number; v0: number; v1: number } {
  const x0 = center.x + house.dx;
  const y0 = center.y + house.dy;
  const x1 = x0 + house.w;
  const y1 = y0 + house.h;
  const pt = (x: number, y: number): { u: number; v: number } => {
    switch (house.door) {
      case "south": return { u: x - x0, v: y1 - y };
      case "north": return { u: x - x0, v: y - y0 };
      case "west": return { u: y - y0, v: x - x0 };
      default: return { u: y - y0, v: x1 - x }; // east
    }
  };
  const a = pt(r.x, r.y);
  const b = pt(r.x + r.w, r.y + r.h);
  return {
    u0: Math.min(a.u, b.u),
    u1: Math.max(a.u, b.u),
    v0: Math.min(a.v, b.v),
    v1: Math.max(a.v, b.v),
  };
}

/** The cluster's geometry floors (CLUSTERS is the one rulebook; a
 *  cluster without authored floors gets a modest room). */
function clusterFloors(cluster: AnnexCluster): { minW: number; minD: number } {
  const c = CLUSTERS[cluster];
  return { minW: c?.minW ?? 2.8, minD: c?.minD ?? 2.8 };
}

/**
 * Feasible annex candidates for one building, best-first (rear before
 * side — the back garden is the natural growth ground). Every candidate
 * that comes back is BUILDABLE: inside the depth/frontage caps, clear of
 * every neighbor, clear of every existing annex, and its shared-wall
 * door has a legal berth into an existing room. Empty ⇒ the lot is out
 * of ground (the refusal reason is the caller's to phrase).
 *
 * `neighbors` — world rects of everything this building must keep
 * ANNEX_CLEARANCE from (adjacent lots' houses/works, the caller slices).
 * Scope-agnostic: a work building passes its own shape + neighbor set.
 */
export function annexOptions(
  center: { x: number; y: number },
  house: HouseShape,
  plan: HouseRoomPlan,
  neighbors: ReadonlyArray<Rect>,
  delta: BuildingDelta | undefined,
  want: AnnexCluster,
): AnnexCandidate[] {
  if ((delta?.annexes.length ?? 0) >= MAX_ANNEXES) return [];
  const { L, D } = frameDims(house);
  const { minW, minD } = clusterFloors(want);
  const M = metricsOf(house); // the constructing species' floors
  const doorW = want === "wet" ? M.bathDoorW : M.roomDoorW;
  const jamb = M.doorJamb;
  const existing = (delta?.annexes ?? []).map((a) => ({
    rect: a,
    world: annexWorldRect(center, house, a),
  }));
  // Rooms still standing (demolished base rooms can't host a door).
  const gone = new Set((delta?.demolished ?? []).map((d) => d.roomId));
  const rooms = plan.rooms.filter((r) => !gone.has(r.id));
  const out: AnnexCandidate[] = [];

  const tryCandidate = (side: AnnexSide, u0: number, u1: number, v0: number, v1: number): void => {
    if (u1 - u0 < minW - 1e-9 || v1 - v0 < (side === "rear" ? minD : minW) - 1e-9) return;
    // Caps — the lot keeps its garden and its side gaps.
    if (side === "rear" && v1 > ANNEX_DEPTH_CAP) return;
    if (side !== "rear" && L + (u1 - u0) > ANNEX_FRONTAGE_CAP) return;
    const world = annexWorldRect(center, house, { u0, u1, v0, v1 });
    for (const n of neighbors) {
      if (rectGap(world, n) < ANNEX_CLEARANCE - 1e-9) return;
    }
    for (const e of existing) {
      if (rectGap(world, e.world) > -1e-9) continue; // separated — fine
      return; // overlaps an existing annex
    }
    // The shared wall: which standing room's edge runs along it, with
    // enough overlap for a legal door? Best host = widest overlap.
    let best: { room: HouseRoom; lo: number; hi: number } | null = null;
    for (const r of rooms) {
      const f = frameOfRect(center, house, r.rect);
      let lo: number;
      let hi: number;
      if (side === "rear") {
        if (Math.abs(f.v1 - v0) > 1e-6) continue; // room's far wall ≠ annex's near wall
        lo = Math.max(f.u0, u0);
        hi = Math.min(f.u1, u1);
      } else {
        const wallU = side === "side0" ? u1 : u0; // annex touches the footprint flank
        if (Math.abs((side === "side0" ? f.u0 : f.u1) - wallU) > 1e-6) continue;
        lo = Math.max(f.v0, v0);
        hi = Math.min(f.v1, v1);
      }
      if (hi - lo < doorW + 2 * jamb) continue;
      if (!best || hi - lo > best.hi - best.lo) best = { room: r, lo, hi };
    }
    if (!best) return;
    const mid = (best.lo + best.hi) / 2;
    const doorAt =
      side === "rear"
        ? { u: mid, v: v0, width: doorW }
        : { u: side === "side0" ? u1 : u0, v: mid, width: doorW };
    // The door must keep a jamb's berth from every EXISTING doorway on
    // that wall of the host (a second swing on the same stretch).
    for (const d of best.room.doorways) {
      const at = doorwayFramePoint(center, house, best.room, d);
      const onSameWall =
        side === "rear" ? Math.abs(at.v - doorAt.v) < 1e-6 : Math.abs(at.u - doorAt.u) < 1e-6;
      if (!onSameWall) continue;
      const along = side === "rear" ? Math.abs(at.u - doorAt.u) : Math.abs(at.v - doorAt.v);
      if (along < (d.width + doorW) / 2 + jamb) return;
    }
    out.push({ side, cluster: want, u0, u1, v0, v1, doorInto: best.room.id, doorAt });
  };

  // REAR candidates — the back garden first. Width: a real room, biased
  // generous (half the frontage), placed at either corner and centered.
  const rearD = Math.max(minD, 3.0);
  if (D + rearD <= ANNEX_DEPTH_CAP) {
    const w = Math.min(L, Math.max(minW + 0.8, L * 0.5));
    tryCandidate("rear", 0, w, D, D + rearD);
    tryCandidate("rear", L - w, L, D, D + rearD);
    tryCandidate("rear", (L - w) / 2, (L + w) / 2, D, D + rearD);
  }
  // SIDE candidates — alongside the LIVING room (they door into it, the
  // natural depth-1 room), when the flank keeps its clearance.
  const sideW = Math.max(minW, 2.8) + 0.4;
  const lf = frameOfRect(center, house, plan.rooms[0]!.rect);
  const v0 = Math.max(lf.v0 + 0.4, 0.4);
  const v1 = Math.min(lf.v1 - 0.4, D - 0.4);
  if (v1 - v0 >= Math.max(minD, minW)) {
    if (L + sideW <= ANNEX_FRONTAGE_CAP) {
      tryCandidate("side0", -sideW, 0, v0, v1);
      tryCandidate("side1", L, L + sideW, v0, v1);
    }
  }
  return out;
}

/** A doorway's center point in the house frame (mirror of rooms.ts's
 *  world-point convention). */
function doorwayFramePoint(
  center: { x: number; y: number },
  house: HouseShape,
  room: HouseRoom,
  d: RoomDoorway,
): { u: number; v: number } {
  const r = room.rect;
  const at =
    d.edge === "north" ? { x: r.x + d.offset, y: r.y }
    : d.edge === "south" ? { x: r.x + d.offset, y: r.y + r.h }
    : d.edge === "west" ? { x: r.x, y: r.y + d.offset }
    : { x: r.x + r.w, y: r.y + d.offset };
  const f = frameOfRect(center, house, { x: at.x, y: at.y, w: 0, h: 0 });
  return { u: f.u0, v: f.v0 };
}

// ── THE MUTATION WRITES ─────────────────────────────────────────────────

export type ConstructionResult =
  | { ok: true }
  | { ok: false; reason: "living" | "disconnects" | "not-rect" | "no-room" | "cap" };

/** Accept a candidate from annexOptions — assigns its ordinal and bumps
 *  the revision. The candidate was validated by construction; this only
 *  re-checks the cap (the delta may have grown since the options call). */
export function requestAnnex(
  deltas: TownDeltas,
  buildingKey: string,
  c: AnnexCandidate,
): ConstructionResult {
  const d = deltas.get(buildingKey);
  if ((d?.annexes.length ?? 0) >= MAX_ANNEXES) return { ok: false, reason: "cap" };
  const ord = (d?.annexes ?? []).reduce((m, a) => Math.max(m, a.ord + 1), 0);
  deltas.mutate(buildingKey, (bd) => {
    bd.annexes.push({ ord, ...c });
  });
  return { ok: true };
}

/** Pure feasibility of demolishRoom — the same rules, NO mutation (the
 *  structure board pre-filters with this so it never shows a dead button).
 *  `into` = the base-room merge host; null = an annex spec removal. */
export function demolishCheck(
  deltas: TownDeltas,
  buildingKey: string,
  plan: HouseRoomPlan,
  roomId: string,
): { ok: true; into: string | null } | Exclude<ConstructionResult, { ok: true }> {
  const room = plan.rooms.find((r) => r.id === roomId);
  if (!room) return { ok: false, reason: "no-room" };
  if (room === plan.rooms[0]) return { ok: false, reason: "living" };

  const d = deltas.get(buildingKey);
  const annexMatch = /_a(\d+)$/.exec(roomId);

  if (annexMatch && d?.annexes.some((a) => `_a${a.ord}` === `_a${annexMatch[1]}`)) {
    // Annex: spec removal. Its door leaves with it (applyDelta cuts annex
    // doors from the spec, never from the base plan).
    return { ok: true, into: null };
  }
  // Base room: find the merge host among door-adjacent rooms — union
  // must tile a rectangle (same span on the shared axis). NEVER the
  // living room: growing rooms[0] would break the living-rect
  // invariant every goods anchor hangs off.
  const host = plan.rooms.find((r) => {
    if (r === room || r === plan.rooms[0]) return false;
    if (!shareDoor(room, r)) return false;
    return rectUnionIsRect(room.rect, r.rect);
  });
  if (!host) return { ok: false, reason: "not-rect" };
  // Connectivity: every surviving room must still reach the living room
  // over the door graph with `room` merged into `host`.
  if (!staysConnected(plan, roomId, host.id)) return { ok: false, reason: "disconnects" };
  return { ok: true, into: host.id };
}

/**
 * Demolish one room of the (delta-applied) plan.
 *  - The living room refuses ("living").
 *  - An ANNEX room removes its spec — the footprint shrinks back.
 *  - A BASE room merges into a door-adjacent neighbor whose union stays
 *    a rectangle (the partition comes down); anything else refuses.
 * Placed pieces in the room return as `stowed` stacks (kind → count) for
 * the caller to bank into storage; generated pieces re-derive with the
 * new plan (the household honestly rearranges).
 */
export function demolishRoom(
  deltas: TownDeltas,
  buildingKey: string,
  plan: HouseRoomPlan,
  roomId: string,
): { ok: true; stowed: Partial<Record<StationKind, number>> } | Exclude<ConstructionResult, { ok: true }> {
  const check = demolishCheck(deltas, buildingKey, plan, roomId);
  if (!check.ok) return check;
  const annexMatch = /_a(\d+)$/.exec(roomId);
  const into = check.into;

  const stowed: Partial<Record<StationKind, number>> = {};
  deltas.mutate(buildingKey, (bd) => {
    if (annexMatch && bd.annexes.some((a) => String(a.ord) === annexMatch[1])) {
      bd.annexes = bd.annexes.filter((a) => String(a.ord) !== annexMatch[1]);
    } else if (into) {
      bd.demolished.push({ roomId, into });
    }
    const stay: PlacedPiece[] = [];
    for (const p of bd.placed) {
      if (p.roomId === roomId) stowed[p.kind] = (stowed[p.kind] ?? 0) + 1;
      else stay.push(p);
    }
    bd.placed = stay;
  });
  return { ok: true, stowed };
}

/** Record a validated placement (the caller ran placementFeasible). */
export function placeFurniture(deltas: TownDeltas, buildingKey: string, piece: PlacedPiece): void {
  deltas.mutate(buildingKey, (d) => {
    d.placed.push(piece);
  });
}

/** Un-place a placed piece — back to a stack in the caller's hands. */
export function removePlacedPiece(
  deltas: TownDeltas,
  buildingKey: string,
  pieceId: string,
): StationKind | null {
  let kind: StationKind | null = null;
  deltas.mutate(buildingKey, (d) => {
    const p = d.placed.find((q) => q.id === pieceId);
    if (p) {
      kind = p.kind;
      d.placed = d.placed.filter((q) => q.id !== pieceId);
    }
  });
  return kind;
}

/** Stow a GENERATED piece (its id never re-emits; its space frees, and
 *  an anchored piece follows its anchor out). */
export function stowGeneratedPiece(deltas: TownDeltas, buildingKey: string, pieceId: string): void {
  deltas.mutate(buildingKey, (d) => {
    if (!d.removedPieces.includes(pieceId)) d.removedPieces.push(pieceId);
  });
}

/** The next placed-piece id for a building (`furn<scope>_<i>_p<serial>`
 *  is the caller's format; this just yields a stable serial). */
export function nextPlacedSerial(delta: BuildingDelta | undefined): number {
  return (delta?.placed ?? []).reduce((m, p) => {
    const s = /_p(\d+)$/.exec(p.id);
    return s ? Math.max(m, Number(s[1]) + 1) : m;
  }, 0);
}

// ── FOUNDING WORKSHOPS (optional rooms, seeded) ─────────────────────────

// Local FNV/mulberry helpers, the kernel/town convention (plan.ts,
// rooms.ts) — this layer stays import-free of app modules.
function hashSeed(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Roughly one house in this many founds with a carpenter's workshop. */
export const WORKSHOP_SEED_RATE = 8;

/**
 * Seed the OPTIONAL ROOMS a town founds with (construction v1): a
 * deterministic minority of houses raise a WORKSHOP annex — the
 * carpenter's bench is where furniture is made, and not every house has
 * one. Runs ONCE on a fresh overlay (a restored session's deltas already
 * carry theirs); every draw is seeded, so the same town founds the same
 * carpenters forever. At least one workshop is guaranteed whenever any
 * lot has the ground for it — a town needs SOMEWHERE furniture comes
 * from. Returns the seeded house indices.
 */
export function seedFoundingWorkshops(
  center: { x: number; y: number },
  plan: Pick<TownPlan, "houses" | "works">,
  deltas: TownDeltas,
  seed: number,
): number[] {
  const rects: Rect[] = [
    ...plan.houses.map((h) => ({ x: center.x + h.dx, y: center.y + h.dy, w: h.w, h: h.h })),
    ...plan.works.map((w) => ({ x: center.x + w.dx, y: center.y + w.dy, w: w.w, h: w.h })),
  ];
  const seeded: number[] = [];
  const trySeed = (h: (typeof plan.houses)[number], hi: number): boolean => {
    const key = `h_${h.index}`;
    const neighbors = rects.filter((_, i) => i !== hi);
    const opts = annexOptions(
      center, h, houseRoomPlan(center, h, deltas.get(key)), neighbors, deltas.get(key), "workshop",
    );
    if (!opts.length) return false;
    if (!requestAnnex(deltas, key, opts[0]!).ok) return false;
    seeded.push(h.index);
    return true;
  };
  plan.houses.forEach((h, hi) => {
    if (hashSeed(seed, `carpenter_${h.index}`) % WORKSHOP_SEED_RATE !== 0) return;
    trySeed(h, hi);
  });
  if (!seeded.length) {
    for (let hi = 0; hi < plan.houses.length; hi++) {
      if (trySeed(plan.houses[hi]!, hi)) break;
    }
  }
  return seeded;
}

// ── FOUNDING A WHOLE BUILDING (city-expansion ①b) ───────────────────────
// The annexOptions law one level up: candidates are STREET FRONTAGE SLOTS
// (streets.ts's prefix-stable lot sequence — the same slots houses fill),
// enumerated best-first (center-out, the sequence's own order) with
// feasibility INSIDE the enumeration: clearance from every existing
// footprint, streets kept walkable, the manifold bound respected. A
// candidate that reaches the caller is buildable; empty ⇒ the caller
// phrases the refusal.

/** Clearance a founded lot keeps from every existing footprint. */
export const FOUNDING_CLEARANCE = 1.0;
/** Free slots grown beyond the claimed set when enumerating (the street
 *  tree extends prefix-stably, so looking ahead never moves a lot). */
export const FOUNDING_LOOKAHEAD = 10;
/** Corridor half-width a founded lot keeps clear around street centerlines. */
const STREET_KEEPOUT = 2.6;

export interface FoundingOptionsInput {
  /** The town's seed + settlement key (street-tree identity). */
  seed: number;
  key: string;
  /** Arterial bearings the town's tree was grown with (TownStreets.bearings)
   *  — regrowing with the same triple (seed, key, bearings) is PREFIX-
   *  CONSISTENT with the plan's own tree. */
  bearings?: readonly number[];
  /** The structure's lot request: frontage (along street) × depth. */
  footprint: { w: number; d: number };
  /** StructureSpec type the candidates carry. */
  type: string;
  /** TOWN-LOCAL rects the lot must keep FOUNDING_CLEARANCE from (existing
   *  houses, works, founded lots — the caller slices). */
  occupied: ReadonlyArray<Rect>;
  /** Street slots already claimed (base house lots + founded buildings). */
  claimedSlots: ReadonlySet<number>;
  /** Half-side bound (town-local): the lot must fit inside ±bound. Absent =
   *  unbounded (the replay town's manifold grows to cover founded lots). */
  bound?: number;
  /** Candidates returned, best-first (default 3). */
  max?: number;
  /** POINT-STEERED ordering (city-founding: "build + house + here"): rank
   *  feasible lots by distance to this TOWN-LOCAL point instead of the
   *  sequence's own center-out order. Point-steered, not point-exact — the
   *  lot still comes from the street tree's slot lattice, so frontage,
   *  door and walkability guarantees hold. Zoning precedence is untouched
   *  (match still outranks open). Absent = byte-identical legacy order. */
  near?: { x: number; y: number };
  /** ZONING (③, zoning.ts slotZoningFn): classify a lot's CENTER —
   *  "match" (inside a zone that admits this structure), "open" (unzoned
   *  ground — always admitted), "blocked" (zoned for another category:
   *  infeasible, kept out of the enumeration — the annexOptions law).
   *  Candidates come back MATCH-FIRST (zoned ground that WANTS the
   *  structure outranks open ground), each group in street-slot order.
   *  Absent = everything "open" (byte-identical to before). */
  zoning?: (x: number, y: number) => SlotZoning;
}

/** Segment–rect overlap (rect expanded by `pad`). */
function segCrossesRect(
  ax: number, ay: number, bx: number, by: number, r: Rect, pad: number,
): boolean {
  const x0 = r.x - pad;
  const y0 = r.y - pad;
  const x1 = r.x + r.w + pad;
  const y1 = r.y + r.h + pad;
  // Trivial accept: an endpoint inside.
  const inside = (x: number, y: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inside(ax, ay) || inside(bx, by)) return true;
  // Liang-Barsky style clip.
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay)
  );
}

/**
 * Feasible lots for founding one structure, best-first. Deterministic and
 * RNG-free given its input (multiplayer law: claims and placements are pure
 * functions of the mutation record) — the street tree it enumerates is
 * `growStreets(seed, key, …, bearings)`, prefix-consistent with the plan's.
 */
export function foundingOptions(input: FoundingOptionsInput): FoundingCandidate[] {
  const max = input.max ?? 3;
  let maxClaimed = -1;
  for (const s of input.claimedSlots) maxClaimed = Math.max(maxClaimed, s);
  const minSlots = Math.max(maxClaimed + 1, input.claimedSlots.size) + FOUNDING_LOOKAHEAD;
  const net: TownStreets = growStreets(input.seed, input.key, minSlots, {
    bearings: [...(input.bearings ?? [])],
  });
  // With zoning, feasible lots split MATCH (in a zone that wants this
  // structure) / OPEN (unzoned); matches lead the result. Without zoning
  // everything is "open" and the loop early-outs exactly as before.
  const matches: FoundingCandidate[] = [];
  const opens: FoundingCandidate[] = [];
  for (let k = 0; k < net.slots.length; k++) {
    if (matches.length >= max) break;
    if (!input.zoning && opens.length >= max) break;
    if (input.claimedSlots.has(k)) continue;
    const slot = net.slots[k]!;
    // Face the frontage anchor — the house rule (plan.ts doorToward).
    const ddx = slot.ax - slot.x;
    const ddy = slot.ay - slot.y;
    const door: FoundingCandidate["door"] =
      Math.abs(ddx) > Math.abs(ddy) ? (ddx > 0 ? "east" : "west") : ddy > 0 ? "south" : "north";
    const sideways = door === "east" || door === "west";
    const w = sideways ? input.footprint.d : input.footprint.w;
    const h = sideways ? input.footprint.w : input.footprint.d;
    const rect: Rect = { x: slot.x - w / 2, y: slot.y - h / 2, w, h };
    // Manifold bound — the lot must stand on real ground.
    if (input.bound !== undefined) {
      if (
        rect.x < -input.bound || rect.y < -input.bound ||
        rect.x + rect.w > input.bound || rect.y + rect.h > input.bound
      ) continue;
    }
    // Clearance from every existing footprint (the annexOptions law).
    let bad = false;
    for (const n of input.occupied) {
      if (rectGap(rect, n) < FOUNDING_CLEARANCE - 1e-9) {
        bad = true;
        break;
      }
    }
    if (bad) continue;
    // Streets stay walkable: no FOREIGN lane centerline may cross the lot
    // (the ring, cross-lanes, a parallel street behind). The slot's OWN
    // street is exempt — its frontage offset is the slot generator's
    // guarantee, exactly the one every house relies on (an axis-aligned
    // lot on a diagonal lane grazes its own centerline the same way the
    // base houses do).
    for (const s of net.streets) {
      if (s.id === slot.street) continue;
      for (let i = 1; i < s.pts.length && !bad; i++) {
        if (segCrossesRect(s.pts[i - 1]!.x, s.pts[i - 1]!.y, s.pts[i]!.x, s.pts[i]!.y, rect, STREET_KEEPOUT)) {
          bad = true;
        }
      }
      if (bad) break;
    }
    if (bad) continue;
    // ZONING (③): the charter over the lot's center rules — blocked ground
    // never reaches the caller (the refusal reason is the caller's to
    // phrase); zoned-and-admitted ground is PREFERRED over open ground.
    const grade: SlotZoning = input.zoning
      ? input.zoning(rect.x + rect.w / 2, rect.y + rect.h / 2)
      : "open";
    if (grade === "blocked") continue;
    const c: FoundingCandidate = {
      type: input.type, slot: k, dx: rect.x, dy: rect.y, w: rect.w, h: rect.h, door,
    };
    (grade === "match" ? matches : opens).push(c);
  }
  if (input.near) {
    const n = input.near;
    const d2 = (c: FoundingCandidate): number =>
      (c.dx + c.w / 2 - n.x) ** 2 + (c.dy + c.h / 2 - n.y) ** 2;
    const steer = (a: FoundingCandidate, b: FoundingCandidate): number =>
      d2(a) - d2(b) || a.slot - b.slot;
    matches.sort(steer);
    opens.sort(steer);
  }
  return [...matches, ...opens].slice(0, max);
}

// ── AUTOMATIC EXPANSION (construction v1 §5) ────────────────────────────

/** One named prosperity input — plain numbers so the adapter seam stays
 *  open (a REAL economy later replaces the proxy signals without touching
 *  this function; the same shape later grows city buildings). */
export interface ConstructionSignal {
  key: string;
  value: number;
}

export interface ConstructionOrder {
  buildingKey: string;
  action: { kind: "annex"; cluster: AnnexCluster; candidate: AnnexCandidate };
}

/** Prosperity a household must bank before it builds (with the daily cap
 *  this is ~a week of full signals — tune in playtests). */
export const PROSPERITY_THRESHOLD = 6;
/** Prosperity accrual cap per credited day (hysteresis: no single lucky
 *  day builds an annex). */
export const PROSPERITY_DAILY_CAP = 1.5;

/** The next annex CLUSTER a house wants, from its realized plan — unmet
 *  program first (a third sleep cell), then the differentiations in
 *  historical order (kitchen → store → workshop). Null = content. */
export function nextAnnexWant(plan: HouseRoomPlan): AnnexCluster | null {
  if (plan.bedrooms.length < 3) return "sleep";
  if (!plan.rooms.some((r) => r.kind === "kitchen")) return "kitchen";
  if (!plan.rooms.some((r) => r.kind === "store")) return "store";
  if (!plan.rooms.some((r) => r.kind === "workshop")) return "workshop";
  return null;
}

/**
 * ONE construction tick (call once per credited town day): accrue each
 * household's prosperity from the caller's signals, and let AT MOST ONE
 * house per town spend a full threshold on its best annex candidate —
 * center-out on ties, exactly the build-up knob's distribution
 * philosophy. Deterministic given (plan, deltas, signals); `day` is
 * carried into the order log only. Mutates `deltas` (prosperity accrual
 * + the accepted annex) and returns the orders raised.
 */
export function constructionStep(
  center: { x: number; y: number },
  plan: Pick<TownPlan, "houses" | "works">,
  deltas: TownDeltas,
  signalsOf: (houseIndex: number) => ConstructionSignal[],
  day: number,
): ConstructionOrder[] {
  void day;
  const rects: Rect[] = [
    ...plan.houses.map((h) => ({ x: center.x + h.dx, y: center.y + h.dy, w: h.w, h: h.h })),
    ...plan.works.map((w) => ({ x: center.x + w.dx, y: center.y + w.dy, w: w.w, h: w.h })),
  ];
  // Accrue prosperity for every house (cheap — a few adds per house).
  for (const h of plan.houses) {
    const gain = Math.min(
      PROSPERITY_DAILY_CAP,
      Math.max(0, signalsOf(h.index).reduce((s, sig) => s + sig.value, 0)),
    );
    if (gain <= 0) continue;
    deltas.mutate(`h_${h.index}`, (d) => {
      d.prosperity = (d.prosperity ?? 0) + gain;
    });
  }
  // Spend: richest first, center-out on ties; one build per town per day.
  const ranked = [...plan.houses]
    .map((h, i) => ({
      h,
      i,
      p: deltas.get(`h_${h.index}`)?.prosperity ?? 0,
      r: Math.hypot(h.dx + h.w / 2, h.dy + h.h / 2),
    }))
    .filter((e) => e.p >= PROSPERITY_THRESHOLD)
    .sort((a, b) => b.p - a.p || a.r - b.r || a.h.index - b.h.index);
  const orders: ConstructionOrder[] = [];
  for (const e of ranked) {
    const key = `h_${e.h.index}`;
    const delta = deltas.get(key);
    const housePlan = houseRoomPlan(center, e.h, delta);
    const want = nextAnnexWant(housePlan);
    if (!want) continue; // content — prosperity keeps banking harmlessly
    const neighbors = rects.filter((_, ri) => ri !== e.i);
    const opts = annexOptions(center, e.h, housePlan, neighbors, delta, want);
    if (!opts.length) continue; // out of ground — try the next-richest
    const candidate = opts[0]!;
    if (!requestAnnex(deltas, key, candidate).ok) continue;
    deltas.mutate(key, (d) => {
      d.prosperity = Math.max(0, (d.prosperity ?? 0) - PROSPERITY_THRESHOLD);
    });
    orders.push({ buildingKey: key, action: { kind: "annex", cluster: want, candidate } });
    break; // one build per town per day
  }
  return orders;
}

// ── door-graph helpers (request-time validation) ────────────────────────

const doorPointKey = (r: HouseRoom, d: RoomDoorway): string => {
  const at =
    d.edge === "north" ? { x: r.rect.x + d.offset, y: r.rect.y }
    : d.edge === "south" ? { x: r.rect.x + d.offset, y: r.rect.y + r.rect.h }
    : d.edge === "west" ? { x: r.rect.x, y: r.rect.y + d.offset }
    : { x: r.rect.x + r.rect.w, y: r.rect.y + d.offset };
  return `${at.x.toFixed(3)},${at.y.toFixed(3)}`;
};

function shareDoor(a: HouseRoom, b: HouseRoom): boolean {
  const pts = new Set(a.doorways.map((d) => doorPointKey(a, d)));
  return b.doorways.some((d) => pts.has(doorPointKey(b, d)));
}

function rectUnionIsRect(a: Rect, b: Rect): boolean {
  const EPS = 1e-6;
  const sameCols = Math.abs(a.x - b.x) < EPS && Math.abs(a.w - b.w) < EPS;
  const sameRows = Math.abs(a.y - b.y) < EPS && Math.abs(a.h - b.h) < EPS;
  if (sameCols) {
    return Math.abs(a.y + a.h - b.y) < EPS || Math.abs(b.y + b.h - a.y) < EPS;
  }
  if (sameRows) {
    return Math.abs(a.x + a.w - b.x) < EPS || Math.abs(b.x + b.w - a.x) < EPS;
  }
  return false;
}

/** Would the door graph stay connected with `gone` merged into `host`?
 *  (The merge keeps every door on surviving walls — doors into `gone`
 *  become doors into the union — so BFS over the merged adjacency.) */
function staysConnected(plan: HouseRoomPlan, gone: string, host: string): boolean {
  // Build adjacency by shared door points, then contract `gone` → `host`.
  const byPoint = new Map<string, string[]>();
  for (const r of plan.rooms) {
    for (const d of r.doorways) {
      const k = doorPointKey(r, d);
      byPoint.set(k, [...(byPoint.get(k) ?? []), r.id]);
    }
  }
  const norm = (id: string): string => (id === gone ? host : id);
  const adj = new Map<string, Set<string>>();
  for (const linked of byPoint.values()) {
    for (const a of linked) {
      for (const b of linked) {
        if (a === b) continue;
        const na = norm(a);
        const nb = norm(b);
        if (na === nb) continue;
        adj.set(na, (adj.get(na) ?? new Set()).add(nb));
      }
    }
  }
  const ids = plan.rooms.map((r) => r.id).filter((id) => id !== gone);
  const start = norm(plan.rooms[0]!.id);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return ids.every((id) => seen.has(id));
}
