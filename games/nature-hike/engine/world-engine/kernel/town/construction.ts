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
import { ANNEX_ROOM_KIND, CLUSTERS, type AnnexCluster, type StationKind } from "./stations";
import { annexBill, blockCosts, partitionBill } from "./block-bill.js";
import { growStreets, type GrowSeed, type TownStreets } from "./streets";
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
  stackHead,
  stackUnits,
  type SerializedTransferLedger,
  type TransferLedger,
} from "./transfer.js";
// Same one-direction rule: the SPOKEN-FOR ledger (construction pipeline ①)
// serializes with the deltas so reservations survive reload beside the
// stacks they speak for.
import {
  createReservationLedger,
  type ReservationLedger,
  type SerializedReservationLedger,
} from "./reservations.js";
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

/** One INTERIOR room (pipeline ⑤b — subdivision): a room carved OUT OF a
 *  standing room's floor (a guillotine cut — the host keeps the remainder,
 *  the new room takes the band, one shared door joins them). This is how an
 *  empty shell grows its first rooms, and how a demolished base room rises
 *  again in its exact old place (the union host re-splits along the old
 *  partition line). Stored exactly, like an annex, so re-materialization is
 *  exact on every replay. */
export interface InteriorSpec {
  /** Ordinal — interior room k of this building, forever (ids `_i<ord>`). */
  ord: number;
  /** The room whose floor is split — its id AT APPLY TIME (a base room, a
   *  demolition union, an annex `_a*`, or an earlier interior `_i*`). */
  hostId: string;
  /** The structural kind the room is raised AS (its DERIVED kind still
   *  follows its furniture — programs.ts roomKindOf; this is the label the
   *  order named and the cluster its furniture pull reads). */
  kind: HouseRoom["kind"];
  /** Frame rect (door-local u/v), strictly inside the host's rect and
   *  flush against it on three sides (the guillotine law). */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** The shared-wall door's center on the new partition (frame) + width. */
  doorAt: { u: number; v: number; width: number };
}

/** A candidate interior room — an InteriorSpec minus the ordinal. */
export type InteriorCandidate = Omit<InteriorSpec, "ord">;

/** Discriminate a pending designation's candidate: interior rooms carry
 *  their host, annexes carry their side. */
export const isInteriorCandidate = (
  c: AnnexCandidate | InteriorCandidate,
): c is InteriorCandidate => "hostId" in c;

/** A PENDING ANNEX (pipeline ⑤ — annex staging): an ordered-but-unbuilt
 *  room. The AnnexSpec delta row (the room itself) is written only when the
 *  pile covers the costs AND the labor clock ran — until then the order is
 *  a serialized designation gathering materials into `pile` (the
 *  FoundedBuilding costs/pile/laborStartDay model, one level down;
 *  endpoint `annexpile:<ord>`). */
export interface PendingAnnex {
  /** Pending ordinal — town-wide, monotone, never reused. */
  ord: number;
  /** The building it grows ("h_3"; works key by workDeltaKey below). */
  buildingKey: string;
  /** The annex cluster (annex candidates only — an interior candidate
   *  carries its kind itself; see pendingRoomKindOf). */
  cluster?: AnnexCluster;
  /** The exact validated geometry (annexOptions / interiorOptions output) —
   *  committed via requestAnnex / requestInterior at completion, so
   *  re-materialization stays exact. */
  candidate: AnnexCandidate | InteriorCandidate;
  costs: Record<string, number>;
  /** The growth-rect material heap (live stack map, the `stock` pattern). */
  pile: Record<string, number>;
  startedDay: number;
  buildDays: number;
  /** Street-day the pile covered the costs — building MAY begin here. */
  laborStartDay?: number;
  /** BANKED LABOR, in build-days (pipeline ⑥ — builders make buildings):
   *  accrues only while builders stand at the site (more builders bank
   *  faster, capped); the room rises at `labor >= buildDays`. Absent = 0. */
  labor?: number;
  /** ⚖️ A PLAYER SPOKE THIS ROOM (`FoundedBuilding.spoken`'s twin, surplus
   *  control 2026-08-12): the row came from `orderAnnex` / `orderWorkRoom` /
   *  a lit growth area, not from the daily prosperity spend. Absent =
   *  AUTOMATED (every growth row, every save before this field), and an
   *  automated row's staging draws only the COMMONS SPARE. */
  spoken?: boolean;
}

/** The room kind a pending designation raises — the interior candidate's
 *  own kind, else the annex cluster's realized kind. */
export function pendingRoomKindOf(p: PendingAnnex): string {
  if (isInteriorCandidate(p.candidate)) return p.candidate.kind;
  return p.cluster ? ANNEX_ROOM_KIND[p.cluster] : "room";
}

/**
 * A PENDING DEMOLITION — the designation twin of PendingAnnex for taking a
 * room DOWN. Ordering a demolition stakes the work, it never fells the room
 * on the spot: builders must claim the site and work the labor off (⑥ —
 * builders make buildings, and they unmake them too). No costs/pile — tearing
 * down needs hands, not materials — so labor runs from the order itself.
 * The actual demolish (demolishRoom, with its stow banking) happens at
 * completion, re-checked honestly against the live plan.
 */
export interface PendingDemolition {
  /** Pending ordinal — town-wide, monotone, never reused. */
  ord: number;
  /** The building it shrinks ("h_3"; works key by workDeltaKey). */
  buildingKey: string;
  /** The delta-applied plan's room id the order named. */
  roomId: string;
  startedDay: number;
  /** Street-days of labor to bring it down. */
  buildDays: number;
  /** "empty" (phase 4): furniture OUT, walls STAY — the commit runs
   *  emptyRoom instead of demolishRoom (same row, same ladder, same
   *  labor; only the executor differs). Absent = a full demolition. */
  mode?: "empty";
  /** BANKED LABOR, in build-days — accrues only while builders stand at
   *  the room (the buildwork machinery). Absent = 0. */
  labor?: number;
}

/** Is a pending demolition's labor worked off? (No staging gate — labor
 *  runs from the order; tearing down needs no materials.) */
export function demolitionLaborDone(p: PendingDemolition): boolean {
  return (p.labor ?? 0) >= p.buildDays - 1e-9;
}

// ── ONE CONSTRUCTION ORDER (phase 2 — construction-phase2-plan.md) ──────
// The three parallel row families above were the same designation machine
// written three times: costs gather into a pile, labor banks while builders
// stand there, a commit executes at the bar. What differed was keyed on WHO
// CREATED the row — the "builds itself" bug class. They now live in ONE
// ordered list with ONE town-wide ordinal sequence; the per-kind difference
// is the commit executor and the payload geometry, nothing in the lifecycle.
// The kind-typed interfaces above remain THE payload shapes (every consumer
// keeps reading b.dx / p.candidate / p.roomId exactly as before); an order
// is one of them plus its `kind` tag.

export type ConstructionOrderKind = "found" | "annex" | "interior" | "demolish" | "refine";

export interface FoundedOrder extends FoundedBuilding {
  kind: "found";
}
/** An ordered room — outward growth ("annex") or a subdivision cut
 *  ("interior"); the candidate carries the geometry either way (the
 *  PendingAnnex shape, unchanged). */
export interface RoomOrder extends PendingAnnex {
  kind: "annex" | "interior";
  /** The per-kind ordinal this row carried BEFORE the one-sequence adapter
   *  renumbered it (pre-phase-2 saves only) — in-flight pile agreements
   *  (`annexpile:<old>`) resolve through it. Absent on new rows. */
  legacyOrd?: number;
}
export interface DemolishOrder extends PendingDemolition {
  kind: "demolish";
  /** See RoomOrder.legacyOrd (demolitions have no pile — kept only so a
   *  round-trip preserves the adapter's work byte-stably). */
  legacyOrd?: number;
}
/**
 * A REFINE order (phase 3 — the block chain): mill `count` units of a
 * refined stack (`block.material_wood`) out of the raw bill in `costs`
 * (`{ wood: count × inPerOut }`, head-paid), gathered into `pile` at the
 * mill spot exactly like a site stages — the SAME costed-order lifecycle
 * (gather → stage → labor → commit), so the one order loop drives it with
 * no new machinery. TRANSIENT: the commit mints the product into a real
 * container and REMOVES the row — a refine is work, not a standing thing.
 */
export interface RefineOrder {
  /** Order ordinal — town-wide, monotone, never reused. */
  ord: number;
  kind: "refine";
  /** The faceted stack the commit mints ("block.material_wood"). */
  produces: string;
  /** Units the commit mints. */
  count: number;
  /** The raw bill (head → count × inPerOut) — the one costed-order shape,
   *  shared verbatim with the staging/pile machinery. */
  costs: Record<string, number>;
  /** The mill-spot heap (live stack map, the `stock` pattern). */
  pile: Record<string, number>;
  /** The mill spot (world coords), stamped at post — the order's anchor
   *  for hauls, observation and the working pose. */
  at: { x: number; y: number };
  startedDay: number;
  /** Street-days of milling (count × the per-unit rate). */
  buildDays: number;
  /** Street-day the pile covered the bill — milling MAY begin here. */
  laborStartDay?: number;
  /** BANKED LABOR, in build-days (the ⑥ pair, unchanged semantics). */
  labor?: number;
  /**
   * ⚖️ WHOSE ORDER BOOK THIS ROW SITS IN (order-scoping law ①, 2026-08-12).
   *
   * `"house:<index>"` = a HOUSEHOLD's own mill queue; absent = the town/civic
   * book (every site bill, every ambient growth row, and every save written
   * before this field). The chain keeps ONE standing refine order per
   * (scope, refined head) — so a family short of 4 blocks posts its OWN
   * 4-block order at its OWN bench instead of reading the town's 198-block
   * workshop bill as "already covered" and waiting behind it (measured: the
   * GL closing sweep, `fx-doll-bench-long`).
   *
   * 🚨 SCOPES CONTEND FOR MATERIAL, NEVER FOR TURNS. There is no cross-scope
   * priority anywhere: both books post real orders, and the raws they both
   * want are arbitrated by the reservation ledger exactly as two sites are.
   */
  scope?: string;
  /**
   * ⚖️ THE BILL THAT ASKED FOR IT WAS SPOKEN (surplus control, user addendum
   * 2026-08-12). A refine order is never spoken in its own right — nobody says
   * "mill four blocks" — so it INHERITS the flag from the order that chained
   * it: a spoken `make workbench` starving on blocks posts a spoken mill, the
   * town's ambient site posts an automated one. Absent = AUTOMATED (every
   * growth row, every save before this field).
   *
   * WHAT IT BUYS, and the only thing it buys: the raw hauls that stage this
   * mill may draw the COMMONS RESERVE (`commonsReserveOf`). An automated mill
   * draws SPARE ONLY, so the town's own appetite can never leave the shelf
   * bare for the family that spoke.
   */
  spoken?: boolean;
}
export type ConstructionOrder = FoundedOrder | RoomOrder | DemolishOrder | RefineOrder;

/** ONE stage ladder over every order kind (⑦ — the per-kind functions
 *  below it are the projections the stage renderer already consumes). */
export function orderStage(o: ConstructionOrder, day: number): BuildStage {
  switch (o.kind) {
    case "found":
      return foundedStage(o, day);
    case "annex":
    case "interior":
      return pendingAnnexStage(o);
    case "demolish":
      return demolitionStage(o);
    case "refine": {
      // The same ladder shape as a staged room (refines emit no ground
      // site, but the one loop and the tests read the stage uniformly).
      if (o.laborStartDay === undefined) return 0;
      const f = laborFraction(o);
      return f >= 1 ? 3 : f >= BUILD_PILLARS_AT ? 2 : 1;
    }
  }
}

/** ONE done check over every order kind — the commit bar. */
export function orderDone(o: ConstructionOrder, day: number): boolean {
  switch (o.kind) {
    case "found":
      return foundedBuildingDone(o, day);
    case "annex":
    case "interior":
      return pendingLaborDone(o);
    case "demolish":
      return demolitionLaborDone(o);
    case "refine":
      return o.laborStartDay !== undefined && (o.labor ?? 0) >= o.buildDays - 1e-9;
  }
}

// ── VISIBLE BUILD STAGES (⑦) ────────────────────────────────────────────
// Construction is WATCHED, not waited out: a designation is marked ground
// while its materials gather, gets a FLOOR the moment builders start, PILLARS
// halfway through, and only then the walls. A demolition runs the very same
// ladder in reverse — walls, pillars, floor, gone — so unbuilding reads as
// the film of building played backwards rather than a room blinking out.
//
// The stage is a pure read of the SAME labor the pipeline already banks
// (⑥ — builders make buildings): nothing here is its own clock, so a site
// with nobody standing at it holds its stage exactly as it holds its labor.

/** 0 = marked ground, 1 = floor laid, 2 = pillars up, 3 = walls standing
 *  (a finished building — never emitted as a construction site). */
export type BuildStage = 0 | 1 | 2 | 3;

/** Labor fraction the PILLARS go up at. The floor lands at the FIRST worked
 *  moment (a builder's first act is to lay it), so there is no floor
 *  threshold — staging alone earns stage 1. */
export const BUILD_PILLARS_AT = 0.5;

/** How far a designation's banked labor has come, 0..1. */
export function laborFraction(b: { buildDays: number; labor?: number }): number {
  if (b.buildDays <= 0) return 1;
  return Math.max(0, Math.min(1, (b.labor ?? 0) / b.buildDays));
}

/** The stage a RISING designation shows: marked ground until its materials
 *  are staged, then floor, then pillars. A no-cost row the driver has
 *  ADOPTED (phase 2 step 3 — `laborStartDay` stamped, elapsed fraction
 *  banked as labor) reads labor like every staged row; an UNADOPTED
 *  no-cost row (growth's collapsed twin, pre-pipeline worldgen, sessions
 *  with no construction driver) keeps its pure clock — it has no labor to
 *  bank, and a staked plot that never changes shape would be a worse lie
 *  than an approximate one. */
export function foundedStage(b: FoundedBuilding, day: number): BuildStage {
  if (b.completed === true) return 3;
  if (!b.costs && b.laborStartDay === undefined) {
    if (b.buildDays <= 0) return 3;
    const f = Math.max(0, Math.min(1, (day - b.startedDay) / b.buildDays));
    return f >= 1 ? 3 : f >= BUILD_PILLARS_AT ? 2 : 1;
  }
  if (b.laborStartDay === undefined) return 0;
  const f = laborFraction(b);
  return f >= 1 ? 3 : f >= BUILD_PILLARS_AT ? 2 : 1;
}

/** The raw 0..1 build fraction behind `foundedStage` — the wall-course
 *  driver (phase 3 worked pieces). Same arms: completed = 1; an unadopted
 *  no-cost row reads its clock; a staged row reads banked labor;
 *  unstaged = 0. */
export function foundedProgress(b: FoundedBuilding, day: number): number {
  if (b.completed === true) return 1;
  if (!b.costs && b.laborStartDay === undefined) {
    if (b.buildDays <= 0) return 1;
    return Math.max(0, Math.min(1, (day - b.startedDay) / b.buildDays));
  }
  if (b.laborStartDay === undefined) return 0;
  return laborFraction(b);
}

/** The stage a pending ANNEX/interior room shows — the same ladder, one
 *  level down. */
export function pendingAnnexStage(p: PendingAnnex): BuildStage {
  if (p.laborStartDay === undefined) return 0;
  const f = laborFraction(p);
  return f >= 1 ? 3 : f >= BUILD_PILLARS_AT ? 2 : 1;
}

/** The stage a room COMING DOWN shows — the ladder in reverse. The walls
 *  stand (3) until the work has really begun, then pillars, then bare
 *  floor; at 0 the room is gone and the row commits. */
export function demolitionStage(p: PendingDemolition): BuildStage {
  const f = laborFraction(p);
  if (f >= 1) return 0;
  if (f >= 2 / 3) return 1;
  if (f >= 1 / 3) return 2;
  return 3;
}

/** The construction-delta KEY of a plan WORK row: a FOUNDED work keys by its
 *  immortal founding ordinal (`f_<ord>` — plan indices shift as the base
 *  town grows works, the delta must not), a base work by its plan index.
 *  Every consumer (stage, board, orders) resolves through this one door. */
export function workDeltaKey(wk: { foundedOrd?: number }, index: number): string {
  return wk.foundedOrd !== undefined ? `f_${wk.foundedOrd}` : `w_${index}`;
}

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
  /** SET-UP state (construction pipeline ⑥ — delivered-then-assembled): a
   *  freshly delivered/placed piece is `false` — it stands on the ground as
   *  its real model TIPPED ON ITS SIDE (not yet assembled). A resident (or a
   *  short grace) sets it up, flipping this to `true` and the fixture rises
   *  upright. ABSENT ⇒ set up (every generated fixture, and every piece
   *  placed before this field existed — the field is purely additive). Kept
   *  generic: no furniture kind carries its own tipped pose — the flag is a
   *  placement property every kind inherits (emergent-over-scripted). */
  setUp?: boolean;
  /** THE DOORWAY THIS PIECE HANGS IN (construction phase 5): a `door` row is
   *  pinned to an opening (`doorwayKeyOf`, rooms.ts) instead of standing on a
   *  floor spot. A pinned row is NOT floor furniture and is excluded wherever
   *  furniture is enumerated (furnishPlan) — it must not be a placement
   *  obstacle, must not render as an object (it renders as the wall's own door
   *  STRUCTURE, via the doorway's `leaf`), and must never designate a room
   *  (a door tells you nothing about what a room is for). `x`/`y` still hold
   *  the opening's midpoint so break/inspection paths have somewhere to aim. */
  doorway?: string;
  /** The street good whose household box this chest IS (pantry…) — carried on
   *  the row once the building is `materialized`, because from then on the row
   *  IS the box and the goods economy keys on it. */
  good?: string;
  /**
   * THE PLAYER PUT IT EXACTLY HERE (blueprint.ts). A spoken "put the chair by
   * the window" is a change to the DRAWING, so the blueprint keeps the row as
   * given and arranges everything else around it.
   *
   * ABSENT is the default and covers every autonomous placement — a delivery
   * standing itself up, a program install. Those rows say where a piece HAPPENS
   * to be, not where it belongs, so the drawing re-slots them by kind: kitchen
   * things stood in the main room because there was no kitchen get carried into
   * one the day a kitchen exists. Honouring them unconditionally is what would
   * make that impossible.
   */
  pinned?: boolean;
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
  /** INTERIOR rooms (⑤b) — carved out of standing rooms in ord order,
   *  AFTER annexes (an annex room may itself be split). Removal is spec
   *  removal, order-guarded (demolishCheck). Absent = none. */
  interior?: InteriorSpec[];
  placed: PlacedPiece[];
  /** Generated piece ids removed/stowed — furnishPlan never emits them
   *  (their space genuinely frees; an anchored piece follows its anchor). */
  removedPieces: string[];
  /**
   * THE FURNITURE HAS BEEN MADE REAL (blueprint.ts — the blueprint/house
   * split). `placed` is now the WHOLE physical contents of this building, and
   * `furnishPlan` stops generating for it entirely.
   *
   * WHY. The station generator answers "where should furniture stand in a
   * house shaped like this" — it draws a BLUEPRINT. Reading its output as the
   * furniture itself is what made a house re-arrange in a single frame the
   * instant a room went up: nothing had moved, the answer to the question had
   * changed. So the generator keeps drawing (it is still the only thing that
   * knows where a bed belongs), but the furniture is instantiated from that
   * drawing ONCE and is a fact thereafter. A room going up re-draws; the
   * furniture stays where it is until somebody carries it.
   *
   * Set lazily, at the first structural change to a building — a town nobody
   * has rebuilt keeps an empty overlay and derives its furniture as it always
   * did, so worldgen and serialization are untouched for every untouched
   * house. `blueprintDelta` clears this flag, which is exactly how the drawing
   * keeps being drawn after the house has stopped deriving.
   */
  materialized?: boolean;
  /**
   * DOORWAYS WITH NO LEAF (construction phase 5) — the exact mirror of
   * `removedPieces`, one level up: that list says "this generated FIXTURE is
   * not there", this one says "this generated DOORWAY has no door in it".
   * Rows are `doorwayKeyOf` keys (rooms.ts — the quantized world midpoint, so
   * the two rooms that both record a shared opening produce ONE row).
   *
   * ABSENT ⇒ every doorway has its leaf, which is what keeps worldgen towns
   * exactly as they were: the law lets a finished worldgen building abstract
   * its walls, and its doors come with them. A building the CONSTRUCTION
   * pipeline raises seeds this with all of its openings at shell completion
   * and then hangs them one at a time, so you watch the doors go in.
   *
   * OUT OF SCOPE, deliberately: a partition cut AFTER founding gets the
   * default leaf (no row is added for it), and a row left behind by a room
   * that moved or came down is INERT — it names a point nothing opens at, and
   * nothing ever reads it again.
   */
  doorless?: string[];
  /** The auto-expansion accumulator (construction v1 §5). */
  prosperity?: number;
  /** PERSISTENT ROOM PROGRAMS (pipeline ④, REMOVABLE since phase 4): the
   *  rooms this building is ORDERED to have — standing wants. An unmet
   *  program outranks the default differentiation in nextAnnexWant; its
   *  furniture requirement (programs.ts roomProgramOf) drives crafting
   *  until met. Phase 4 reversed the old append-only law: demolishing or
   *  breaking what a program stood for DROPS the row (removeProgram) —
   *  a designation must never re-order what the player tore out.
   *  `roomId` (optional) pins the want to a specific EXISTING room (the
   *  empty-room-reuse path) so the furnish sweeps aim there. */
  programs?: Array<{ ord: number; room: string; roomId?: string }>;
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
  /** PIPELINE ② (construction-pipeline.md): the material bill that must be
   *  STAGED at the site before labor starts (glyph → count, recorded at
   *  order time). ABSENT = a pre-pipeline / collapsed row — paid at order,
   *  labor ran from `startedDay` (the legacy clock). */
  costs?: Record<string, number>;
  /** The SITE PILE — materials hauled to the staked plot so far (a live
   *  stack map, the `stock` pattern; endpoint `sitepile:<ord>`). Consumed
   *  into the building at completion. */
  pile?: Record<string, number>;
  /** Street-day the pile covered the costs — BUILDING may begin (recorded
   *  when staging lands; unset while the site waits for materials). */
  laborStartDay?: number;
  /** BANKED LABOR, in build-days (pipeline ⑥ — builders make buildings,
   *  they never rise by themselves): accrues only while builders stand at
   *  the site, faster with more of them (capped); done at `labor >=
   *  buildDays`. Absent = 0. Legacy rows (no costs — growth's collapsed
   *  twin) keep the pure clock instead. */
  labor?: number;
  /** The WALL MATERIAL the building was raised from (phase 3 — the pile's
   *  dominant block material, recorded at commit): the same-material
   *  abstraction hook (a complete one-material building abstracts its
   *  walls) and the deconstruction refund's glyph. Absent = legacy /
   *  unrecorded (reads as wood). */
  material?: string;
  /** ⚖️ A PLAYER SPOKE THIS ONE (order-scoping law ①, 2026-08-12): the row
   *  came from `orderBuild`, not from ambient growth. Within ONE scope a
   *  spoken order outranks an automated one, and the only lever the town
   *  scope has is the shared crew — `crewShareOf` pours the hand pool into
   *  spoken rows first. Absent = automated (every growth row, every save
   *  written before this field). NEVER a cross-scope priority: a household's
   *  book is its own list, and the two contend for MATERIAL, not for turns. */
  spoken?: boolean;
}

/** A founding candidate — a FoundedBuilding minus the ordinal/clock fields
 *  (assigned when the order is accepted). */
export type FoundingCandidate = Omit<
  FoundedBuilding,
  | "ord" | "startedDay" | "buildDays" | "completed" | "costs" | "pile" | "laborStartDay"
  | "material" | "spoken"
>;

/** A standing MAKE-ORDER (pipeline ③), one per house. The job carries a
 *  RECIPE, not a furniture row: furniture was the first thing the pipeline
 *  made but never the only possible one — a toy is made exactly the same way
 *  (real inputs drawn from real stacks, the same labor clock, the same bench
 *  discount, the same honest wait when an input is missing). PERSISTED on
 *  TownDeltas (construction rewrite 1b) so a reload RESUMES the work — its
 *  haul agreements and craftspot reservations keep their owner. */
export interface CraftJob {
  /** The finished stack glyph one job mints (`furn.chair`, `rabbit.toy`). */
  produces: string;
  /** Input glyphs → units the job consumes. */
  consumes: Record<string, number>;
  /** The station that SPEEDS the work, and NEVER gates it (the bench law). */
  at?: StationKind;
  /** Short provenance label for haul rows and logs (`chair`, `rabbit.toy`). */
  label: string;
  /** The container the inputs pile into and the finished stack lands in. */
  spotId: string;
  /** Haul agreements feeding the spot (reservations ride their ids). */
  agreements: string[];
  /** townClock s labor began — unset while inputs are still gathering. */
  laborStart?: number;
  laborS: number;
  /** townClock s this job has been waiting on hauls it cannot see land —
   *  the deadlock watchdog's clock. */
  waitingSince?: number;
  /** townClock s the crafter was last actually present. Work only advances
   *  while somebody is there to do it, so an absence shifts the finish line
   *  rather than counting toward it. */
  lastWorkedAt?: number;
  /**
   * 🚨 WHO COMMISSIONED IT — the stock endpoint the finished piece is OWED to
   * (`bfurn:<buildingKey>`, a shell's delivery pile). Absent = the house made
   * it for itself (every player-spoken make, every program craft, every save
   * before this field), and the piece stays where it was made.
   *
   * WHY THE JOB HAS TO REMEMBER. `stepShellPrograms` designates a craft at a
   * NEIGHBOURING household and then forgets it asked: the piece lands in that
   * household's cupboard (unwatched) or on its floor (watched), and NEITHER is
   * reachable by the shell's haul — `siteMaterialSources` sees container
   * stacks only, and `mayUse` refuses another household's boxes outright. The
   * shell's own re-ask then answers `"held"` (`buildingUnits(…,"anywhere")`
   * sees the piece perfectly well) and waits for a delivery nobody scheduled,
   * forever. Recording the commission is what closes the loop: the maker
   * SENDS it, the `inbound` test sees the haul, and the two sides finally
   * mean the same thing by "one exists".
   */
  for?: string;
  /** ⚖️ A PLAYER SPOKE THIS ONE (order-scoping law ①, 2026-08-12) — a `make`
   *  order, or a row popped off the house's spoken waiting line. Absent =
   *  AUTOMATED (the program-fulfilment craft, the workshop's daily restock
   *  rotation, every save before this field). Within the household scope a
   *  spoken order outranks an automated one: it takes the slot, and an
   *  automated job that has not yet begun labour yields it. */
  spoken?: boolean;
}

/** A QUEUED make-order (phase 4 — full craft queueing): what to make,
 *  waiting for the house's ONE craft slot. Deliberately spot-less: the
 *  CraftJob is built at POP time so the spot follows the bench of that
 *  moment, and no stale reservations ride the queue. */
export type QueuedCraft = Pick<CraftJob, "produces" | "consumes" | "at" | "label">;

/** A persisted growth seed: the kernel's `GrowSeed` plus the ord that
 *  makes the list append-only (the ZONES discipline). */
export type SeedRecord = GrowSeed & { ord: number };

/**
 * A FOUNDED SERVICE POINT (growth phase C §3.2) — the neighbourhood market
 * stall a lot became, or the lot whose verge got a well. Named by its
 * street SLOT, which is the town's own position identity (`LotSlot`
 * ordinal), so it survives a regrow the way a founded building's slot does.
 *
 * 🔴 WHY THIS EXISTS. `foundServicePoints` documented itself as
 * "prefix-stable": a grown town kept its old stalls and appended, because
 * tree routing was prefix-stable — a bigger town's extra streets are LEAVES,
 * and a tree path between two lots both towns already had can never run
 * through a leaf, so the founding walk replayed verbatim. Phase C §2's LOOPS
 * broke that: **a link is not a leaf.** An appended link SHORTENS a walk
 * between two lots both towns already had — the entire point of cutting it —
 * so the argmin that chooses where a stall opens can legitimately move
 * (MEASURED over 60 town × growth pairs: full positional prefix held 18/60,
 * worst set survival 56.3%; the count never shrank).
 *
 * The durable fix is not routing's: it is the SLOTS-ARE-HISTORY law the rest
 * of this file already lives by. A town's civic set is a RECORD of what its
 * people built, not a re-derivation from today's street metres — so the pass
 * runs once, its answer is written here, and every later plan honours it and
 * only APPENDS what the recorded set still leaves unserved.
 */
export interface ServicePoint {
  /** `stall` — the lot CONVERTS into a market stall (same footprint, same
   *  door). `well` — the lot stays a home and gets a well on its verge. */
  kind: "stall" | "well";
  /** The frontage slot (`LotSlot` ordinal) the point stands on. */
  slot: number;
}

/** A persisted service point: `ServicePoint` plus the ord that makes the
 *  list append-only (the ZONES/SEEDS discipline). */
export type ServiceRecord = ServicePoint & { ord: number };

export interface SerializedTownDeltas {
  version: number;
  buildings: Record<string, BuildingDelta>;
  /** CONSTRUCTION ORDERS (phase 2 — the ONE row family), in ordinal order.
   *  The only field written since phase 2; absent on older saves (the
   *  legacy trio below adapts in at load). */
  orders?: ConstructionOrder[];
  /** The ordinal sequence's HIGH-WATER mark (phase 3) — ordinals are never
   *  reused even after a TRANSIENT row (a committed refine) leaves the
   *  list. Absent (older saves) = derived from the rows present. */
  ordSeq?: number;
  /** LEGACY (pre-phase-2) — founded whole buildings, in founding order
   *  (①b). READ FOREVER, never written: the loader adapts these rows into
   *  `orders`, founding ordinals preserved (f_<ord> keys are immortal). */
  founded?: FoundedBuilding[];
  /** The town's builder's-yard STOCK (material glyph → count) build costs
   *  draw from. Absent = empty. (A wilderness FoundedSite keeps its own
   *  stock until its town builds; siteTownConfig copies it in here.) */
  stock?: Record<string, number>;
  /** ZONE CHARTERS (③), in charter (ord) order. Absent = none. */
  zones?: ZoneCharter[];
  /** THE TOWN'S GROWTH SEEDS (growth-phase-B §1.1) — what the street tree
   *  was grown around, in seed (ord) order, on the ZONES discipline:
   *  ordinals are monotone, never reused, and rows are only ever appended,
   *  so a replay lays byte-identical streets. Absent = the tree grew from
   *  the legacy `bearings` echo (every pre-phase-B save). */
  seeds?: SeedRecord[];
  /** THE TOWN'S FOUNDED SERVICE POINTS (growth phase C §3.2) — the stalls
   *  its demand founded and the lots its wells stand beside, in founding
   *  (ord) order, on the same append-only discipline. Absent = the plan
   *  re-derives them (every pre-phase-C save, and the byte-identical
   *  legacy path for a town that never recorded any). */
  services?: ServiceRecord[];
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
  /** THE SPOKEN-FOR LEDGER (construction pipeline ①) — units of stock
   *  reserved by pending tasks/designations, so two orders never draw the
   *  same wood. Absent = empty ledger. */
  reservations?: SerializedReservationLedger;
  /** LEGACY (pre-phase-2) — pending annexes, in posting order. READ
   *  FOREVER, never written: adapted into `orders` at load (renumbered
   *  into the one sequence; `legacyOrd` keeps the pile endpoints live). */
  annexSites?: PendingAnnex[];
  /** LEGACY (pre-phase-2) — pending demolitions, in posting order. READ
   *  FOREVER, never written: adapted into `orders` at load. */
  demolitionSites?: PendingDemolition[];
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
  /** CRAFT JOBS (③ — rewrite 1b), house index → the standing make-order.
   *  Absent = none (every pre-1b save). */
  craftJobs?: Record<string, CraftJob>;
  /** BUILDING furniture-delivery piles (⑥ — the stacks `bfurn:<deltaKey>`
   *  endpoints alias), persisted beside the agreements that feed them
   *  (rewrite 1b). Absent = none. */
  shellFurnPiles?: Record<string, Record<string, number>>;
  /** QUEUED make-orders (phase 4), house index → the waiting line behind
   *  the one craft slot. Absent = none (every pre-phase-4 save). */
  craftQueue?: Record<string, QueuedCraft[]>;
  /** ⚖️ THE IMPORT BANK (R&T ⑤ T3b), drift SCALAR → units this session's
   *  landed caravans credited to the town's books. `TownWorld.step` runs
   *  only during the boot fast-forward, so a live session's injections
   *  would evaporate on reload; this is the ledger that re-injects them,
   *  exactly as a completed founded producer re-injects its count scalar.
   *  Keyed by the scalar (never the good) so the re-inject needs no
   *  economy lookup. Absent = none (every pre-⑤ save). */
  driftBank?: Record<string, number>;
  /** ⚖️ THE DOMESTIC HERD (band-settlement-round B-⑥), species → row:
   *  owned animals CONVERTED at the homestead→town promotion seam
   *  (city-founding's decided handoff law — individual owned-animal
   *  containers are physics only at homestead scale; never both accounts
   *  at once). `n` is the counts half of a collective record (`Band.mix`'s
   *  vocabulary); `stock` is the animals' own live produce (wool on the
   *  sheep), pooled per species — riding the record so the cycle conserves
   *  goods exactly, the wild codec's own "live stack, not the initial
   *  roll" law. Absent = none (every pre-B-⑥ save). */
  herd?: Record<string, HerdRow>;
}

/** One species' converted herd: head count + their pooled live produce. */
export interface HerdRow {
  n: number;
  stock: Record<string, number>;
}

/** Sum `add` into `into` per species — the ONE herd-merge shape (mergeSites,
 *  siteTownConfig and the bank all fold through it, so they cannot drift). */
export function mergeHerd(
  into: Record<string, HerdRow>, add: Readonly<Record<string, HerdRow>> | undefined,
): Record<string, HerdRow> {
  for (const [sp, row] of Object.entries(add ?? {})) {
    const t = into[sp] ?? (into[sp] = { n: 0, stock: {} });
    t.n += row.n;
    for (const [g, u] of Object.entries(row.stock)) t.stock[g] = (t.stock[g] ?? 0) + u;
  }
  return into;
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
  /** EVERY construction order (phase 2 — the ONE row family), in ordinal
   *  order. The kind-scoped reads below are filtered views of this list. */
  orders(): readonly ConstructionOrder[];
  /** STAGE order `ord` (kind-agnostic, idempotent): its pile covers its
   *  costs — labor runs from `day`. No-op for cost-free orders. Bumps the
   *  version. */
  stageOrder(ord: number, day: number): void;
  /** Drop order `ord` (committed or cancelled — the caller banks any pile
   *  remainder first). Bumps the version. */
  removeOrder(ord: number): void;
  /** FOUNDED whole buildings, in founding order (①b). Read-only view of
   *  `orders()` (kind "found"). */
  founded(): readonly FoundedBuilding[];
  /** Commit a validated founding candidate (from foundingOptions) — assigns
   *  its ordinal, stamps the clock, bumps the version. With `costs` the row
   *  is a pipeline-② DESIGNATION: nothing paid, an empty site pile, labor
   *  waiting on staging. Without, the legacy pre-paid clock (the collapsed
   *  twin growth uses — materials already drawn from the yard). */
  foundBuilding(
    c: FoundingCandidate,
    startedDay: number,
    buildDays: number,
    costs?: Record<string, number>,
  ): FoundedBuilding;
  /** STAGE founded building `ord` (pipeline ②, idempotent): the pile covers
   *  the costs — labor runs from `day`. Bumps the version. */
  stageFounded(ord: number, day: number): void;
  /** Mark founded building `ord` construction-COMPLETE (idempotent). Bumps
   *  the version so the stage re-stages doors + furniture the same frame.
   *  Consumes the site pile — the materials ARE the building now. */
  completeFounding(ord: number): void;
  /** Mark founded house `ord` HOUSEHOLDED (④ move-in, idempotent). Bumps
   *  the version so the stage reconciles the work-row→house conversion. */
  admitHousehold(ord: number): void;
  /** CALL OFF an unfinished founding (⑦ — the deconstruction menu on work in
   *  progress): drop the row and hand back whatever was hauled to its plot,
   *  so nothing is lost. A COMPLETED building is not cancellable — that is a
   *  demolition, which is work of its own. Returns the returned pile, or
   *  null when the row is gone/finished. */
  cancelFounding(ord: number): Record<string, number> | null;
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
  /** THE GROWTH SEEDS (growth-phase-B §1.1) in seed (ord) order — what the
   *  street tree grew around. Read-only view; the tree is regrown from
   *  exactly this list, so a replay is byte-identical. Empty = the town
   *  still grows from its legacy `bearings` echo. */
  seeds(): readonly SeedRecord[];
  /** Record a seed the town grew (or has just annexed) — assigns its
   *  ordinal, bumps the version. APPEND-ONLY: an existing seed is never
   *  rewritten, because the streets already grew around it. */
  addSeed(s: GrowSeed): SeedRecord;
  /** THE FOUNDED SERVICE POINTS (growth phase C §3.2) in founding (ord)
   *  order — the town's civic set as HISTORY. Read-only view; the plan
   *  honours these verbatim and only appends what they leave unserved.
   *  Empty = the plan re-derives (byte-identical legacy behaviour). */
  services(): readonly ServiceRecord[];
  /** Record a service point the town founded — assigns its ordinal, bumps
   *  the version. APPEND-ONLY: a stall that opened does not un-open
   *  because a later shortcut made somebody else's walk shorter. */
  addService(s: ServicePoint): ServiceRecord;
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
  /** THE SPOKEN-FOR LEDGER (pipeline ①) — reservations on abstract stock;
   *  material resolution draws FREE units only (reservations.ts
   *  resolveMaterials). Serializes with the deltas. */
  readonly reservations: ReservationLedger;
  /** PENDING ANNEXES (pipeline ⑤) — read-only view of `orders()` (kinds
   *  "annex" + "interior"), posting order. */
  annexSites(): readonly PendingAnnex[];
  /** Post an annex DESIGNATION (assigns its ordinal, bumps the version —
   *  the staked growth rect is orderable state). */
  postAnnexSite(p: Omit<PendingAnnex, "ord">): PendingAnnex;
  /** STAGE pending annex `ord` (idempotent): the pile covers the costs —
   *  labor runs from `day`. Bumps the version. */
  stageAnnexSite(ord: number, day: number): void;
  /** Drop pending annex `ord` (committed via requestAnnex, or cancelled —
   *  the caller banks any pile remainder first). Bumps the version. */
  removeAnnexSite(ord: number): void;
  /** REFINE orders (phase 3 — the block chain) — read-only view of
   *  `orders()` (kind "refine"), posting order. */
  refineOrders(): readonly RefineOrder[];
  /** Post a refine order (assigns its ordinal, bumps the version). The
   *  mill runs it through the one order loop; the commit removes it. */
  postRefineOrder(p: Omit<RefineOrder, "ord" | "kind">): RefineOrder;
  /** PENDING DEMOLITIONS — read-only view of `orders()` (kind
   *  "demolish"), posting order. */
  demolitionSites(): readonly PendingDemolition[];
  /** Post a demolition DESIGNATION (assigns its ordinal, bumps the
   *  version) — the room comes down later, when builders work it off. */
  postDemolitionSite(p: Omit<PendingDemolition, "ord">): PendingDemolition;
  /** Drop pending demolition `ord` (committed via demolishRoom, or
   *  cancelled/refused honestly). Bumps the version. */
  removeDemolitionSite(ord: number): void;
  /** ABSTRACT-PARTNER SHELVES (⑤) — partner key → synthetic stack, mutated
   *  in place (the `stock` pattern); serializes with the deltas. */
  readonly partnerStock: Record<string, Record<string, number>>;
  /** AUTHORED LAWS (nations P2) — the live rows the session's law book
   *  aliases (the cohorts pattern: append via kernel/laws.ts addLaw);
   *  serializes with the deltas. */
  readonly laws: Law[];
  /** CRAFT JOBS (③ — rewrite 1b): the live rows, house index → job,
   *  mutated in place (the `stock` pattern); serialize with the deltas so a
   *  reload resumes the work. */
  readonly craftJobs: Map<number, CraftJob>;
  /** BUILDING furniture-delivery piles (⑥ — rewrite 1b): the live stacks
   *  `bfurn:<deltaKey>` endpoints alias, mutated in place; serialize with
   *  the deltas. */
  readonly shellFurnPiles: Map<string, Record<string, number>>;
  /** QUEUED make-orders (phase 4): house index → the waiting line behind
   *  the one craft slot, mutated in place (the craftJobs pattern);
   *  serializes with the deltas. */
  readonly craftQueue: Map<number, QueuedCraft[]>;
  /** ⚖️ THE IMPORT BANK (⑤ T3b): drift scalar → units landed caravans have
   *  credited, mutated in place (the `stock` pattern); serializes with the
   *  deltas so a reload re-injects what the lane already delivered. */
  readonly driftBank: Record<string, number>;
  /** ⚖️ THE DOMESTIC HERD (B-⑥): species → {n, stock}, mutated in place
   *  (the `stock` pattern); serializes with the deltas. */
  readonly herd: Record<string, HerdRow>;
  toJSON(): SerializedTownDeltas;
}

export function emptyDelta(): BuildingDelta {
  return { rev: 0, annexes: [], demolished: [], placed: [], removedPieces: [] };
}

/** True when a delta changes nothing (a fresh or fully-undone one). A
 *  standing program row counts — the want must survive serialization. */
export function deltaIsEmpty(d: BuildingDelta | undefined): boolean {
  return (
    !d ||
    (d.annexes.length === 0 &&
      d.demolished.length === 0 &&
      (d.interior?.length ?? 0) === 0 &&
      d.placed.length === 0 &&
      d.removedPieces.length === 0 &&
      (d.doorless?.length ?? 0) === 0 &&
      !d.materialized &&
      (d.programs?.length ?? 0) === 0)
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
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  // ONE order list (phase 2). A phase-2 save carries `orders` verbatim; a
  // pre-phase-2 save carries the legacy trio, adapted here ONCE at load:
  // founding ordinals are IMMORTAL (f_<ord> work keys, sitepile endpoints)
  // so found rows keep their numbers; room/demolition designations
  // renumber into the one town-wide sequence and remember their old
  // per-kind ordinal (`legacyOrd`) so in-flight pile agreements
  // (`annexpile:<old>`) still resolve. Behavior is identical either way —
  // the adapter is shape, never semantics.
  const orders: ConstructionOrder[] = [];
  if (json?.orders) {
    for (const o of json.orders) orders.push(clone(o));
  } else if (json) {
    for (const b of json.founded ?? []) orders.push({ kind: "found", ...clone(b) });
    let next = orders.reduce((m, o) => Math.max(m, o.ord + 1), 0);
    for (const p of json.annexSites ?? []) {
      orders.push({
        kind: isInteriorCandidate(p.candidate) ? "interior" : "annex",
        ...clone(p),
        ord: next++,
        legacyOrd: p.ord,
      });
    }
    for (const p of json.demolitionSites ?? []) {
      orders.push({ kind: "demolish", ...clone(p), ord: next++, legacyOrd: p.ord });
    }
  }
  // Kind-scoped LIVE views (consumers mutate rows in place — labor banks,
  // piles fill — so the views must alias the rows, never copy them).
  // Membership changes only on post/remove; field mutation never dirties.
  let viewsDirty = true;
  let foundedView: FoundedOrder[] = [];
  let annexView: RoomOrder[] = [];
  let demolitionView: DemolishOrder[] = [];
  let refineView: RefineOrder[] = [];
  const views = () => {
    if (viewsDirty) {
      foundedView = orders.filter((o): o is FoundedOrder => o.kind === "found");
      annexView = orders.filter(
        (o): o is RoomOrder => o.kind === "annex" || o.kind === "interior",
      );
      demolitionView = orders.filter((o): o is DemolishOrder => o.kind === "demolish");
      refineView = orders.filter((o): o is RefineOrder => o.kind === "refine");
      viewsDirty = false;
    }
    return { foundedView, annexView, demolitionView, refineView };
  };
  // ONE monotone ordinal sequence, HIGH-WATER tracked (phase 3): a
  // TRANSIENT refine row commits and leaves the list, and deriving the
  // next ordinal from live rows alone would hand its number to a later
  // founding — in-flight `orderpile:<ord>` remnants would then resolve
  // against the wrong row. The sequence serializes so ordinals stay
  // immortal across reloads too; legacy saves derive it from their rows.
  let ordSeq = Math.max(
    json?.ordSeq ?? 0,
    orders.reduce((m, o) => Math.max(m, o.ord + 1), 0),
  );
  const nextOrd = () => {
    const n = Math.max(
      ordSeq,
      orders.reduce((m, o) => Math.max(m, o.ord + 1), 0),
    );
    ordSeq = n + 1;
    return n;
  };
  const stock: Record<string, number> = { ...(json?.stock ?? {}) };
  const zones: ZoneCharter[] = (json?.zones ?? []).map((z) => ({ ...z }));
  const seeds: SeedRecord[] = (json?.seeds ?? []).map(
    (s) => JSON.parse(JSON.stringify(s)) as SeedRecord,
  );
  const services: ServiceRecord[] = (json?.services ?? []).map((s) => ({ ...s }));
  const civic = { prosperity: json?.civicProsperity ?? 0 };
  const cohorts: CohortRow[] = (json?.cohorts ?? []).map(
    (r) => JSON.parse(JSON.stringify(r)) as CohortRow,
  );
  const transfers = createTransferLedger(json?.transfers);
  const reservations = createReservationLedger(json?.reservations);
  const partnerStock: Record<string, Record<string, number>> = JSON.parse(
    JSON.stringify(json?.partnerStock ?? {}),
  ) as Record<string, Record<string, number>>;
  const laws: Law[] = (json?.laws ?? []).map((l) => JSON.parse(JSON.stringify(l)) as Law);
  const craftJobs = new Map<number, CraftJob>(
    Object.entries(json?.craftJobs ?? {}).map(([k, j]) => [
      Number(k),
      JSON.parse(JSON.stringify(j)) as CraftJob,
    ]),
  );
  const shellFurnPiles = new Map<string, Record<string, number>>(
    Object.entries(json?.shellFurnPiles ?? {}).map(([k, s]) => [k, { ...s }]),
  );
  const craftQueue = new Map<number, QueuedCraft[]>(
    Object.entries(json?.craftQueue ?? {}).map(([k, q]) => [
      Number(k),
      q.map((e) => JSON.parse(JSON.stringify(e)) as QueuedCraft),
    ]),
  );
  const driftBank: Record<string, number> = { ...(json?.driftBank ?? {}) };
  const herd: Record<string, HerdRow> = mergeHerd({}, json?.herd);
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
    orders: () => orders,
    stageOrder: (ord, day) => {
      const o = orders.find((q) => q.ord === ord);
      if (!o || o.kind === "demolish") return; // no costs — nothing stages
      if (o.laborStartDay !== undefined) return;
      o.laborStartDay = day;
      store.version++;
    },
    removeOrder: (ord) => {
      const i = orders.findIndex((q) => q.ord === ord);
      if (i < 0) return;
      orders.splice(i, 1);
      viewsDirty = true;
      store.version++;
    },
    founded: () => views().foundedView,
    foundBuilding: (c, startedDay, buildDays, costs) => {
      const b: FoundedOrder = {
        kind: "found",
        ord: nextOrd(),
        ...c,
        startedDay,
        buildDays,
        ...(costs ? { costs: { ...costs }, pile: {} } : {}),
      };
      orders.push(b);
      viewsDirty = true;
      store.version++;
      return b;
    },
    stageFounded: (ord, day) => store.stageOrder(ord, day),
    completeFounding: (ord) => {
      const b = views().foundedView.find((f) => f.ord === ord);
      if (!b || b.completed) return;
      b.completed = true;
      delete b.pile; // consumed — the materials are the building
      store.version++;
    },
    cancelFounding: (ord) => {
      const b = views().foundedView.find((f) => f.ord === ord);
      if (!b) return null;
      if (b.completed) return null; // finished — taking it down is a demolition
      const pile = { ...(b.pile ?? {}) };
      store.removeOrder(ord);
      return pile;
    },
    admitHousehold: (ord) => {
      const b = views().foundedView.find((f) => f.ord === ord);
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
    seeds: () => seeds,
    addSeed: (s) => {
      const ord = seeds.reduce((m, r) => Math.max(m, r.ord + 1), 0);
      const row = { ord, ...JSON.parse(JSON.stringify(s)) } as SeedRecord;
      seeds.push(row);
      store.version++;
      return row;
    },
    services: () => services,
    addService: (s) => {
      const ord = services.reduce((m, r) => Math.max(m, r.ord + 1), 0);
      const row: ServiceRecord = { ord, kind: s.kind, slot: s.slot };
      services.push(row);
      store.version++;
      return row;
    },
    civic,
    cohorts,
    transfers,
    reservations,
    annexSites: () => views().annexView,
    postAnnexSite: (p) => {
      const row: RoomOrder = {
        kind: isInteriorCandidate(p.candidate) ? "interior" : "annex",
        ord: nextOrd(),
        ...clone(p),
      };
      orders.push(row);
      viewsDirty = true;
      store.version++;
      return row;
    },
    stageAnnexSite: (ord, day) => store.stageOrder(ord, day),
    removeAnnexSite: (ord) => store.removeOrder(ord),
    refineOrders: () => views().refineView,
    postRefineOrder: (p) => {
      const row: RefineOrder = { kind: "refine", ord: nextOrd(), ...clone(p) };
      orders.push(row);
      viewsDirty = true;
      store.version++;
      return row;
    },
    demolitionSites: () => views().demolitionView,
    postDemolitionSite: (p) => {
      const row: DemolishOrder = { kind: "demolish", ord: nextOrd(), ...clone(p) };
      orders.push(row);
      viewsDirty = true;
      store.version++;
      return row;
    },
    removeDemolitionSite: (ord) => store.removeOrder(ord),
    partnerStock,
    laws,
    craftJobs,
    shellFurnPiles,
    craftQueue,
    driftBank,
    herd,
    toJSON: () => ({
      version: store.version,
      buildings: Object.fromEntries(
        [...buildings.entries()].map(([k, d]) => [k, JSON.parse(JSON.stringify(d)) as BuildingDelta]),
      ),
      // Phase 2 writes ONLY `orders` — the legacy trio (founded /
      // annexSites / demolitionSites) is read-forever, written-never.
      orders: orders.map((o) => clone(o)),
      ordSeq,
      stock: { ...stock },
      zones: zones.map((z) => ({ ...z })),
      seeds: seeds.map((s) => JSON.parse(JSON.stringify(s)) as SeedRecord),
      services: services.map((s) => ({ ...s })),
      civicProsperity: civic.prosperity,
      cohorts: cohorts.map((r) => JSON.parse(JSON.stringify(r)) as CohortRow),
      transfers: transfers.toJSON(),
      reservations: reservations.toJSON(),
      partnerStock: JSON.parse(JSON.stringify(partnerStock)) as Record<string, Record<string, number>>,
      laws: laws.map((l) => JSON.parse(JSON.stringify(l)) as Law),
      craftJobs: Object.fromEntries(
        [...craftJobs.entries()].map(([k, j]) => [String(k), JSON.parse(JSON.stringify(j)) as CraftJob]),
      ),
      shellFurnPiles: Object.fromEntries(
        [...shellFurnPiles.entries()].map(([k, s]) => [k, { ...s }]),
      ),
      craftQueue: Object.fromEntries(
        [...craftQueue.entries()]
          .filter(([, q]) => q.length > 0)
          .map(([k, q]) => [String(k), q.map((e) => JSON.parse(JSON.stringify(e)) as QueuedCraft)]),
      ),
      driftBank: { ...driftBank },
      // Absent-tolerant on read; emitted only when someone lives here, so
      // every pre-B-⑥ save's serialized form stays byte-identical.
      ...(Object.keys(herd).length ? { herd: mergeHerd({}, herd) } : {}),
    }),
  };
  return store;
}

/** Is founded building `b` construction-complete at town street-day `day`?
 *  The serialized `completed` fact wins (a reboot resets the clock). A
 *  pipeline row (carrying `costs`) needs its materials STAGED and its
 *  labor WORKED (⑥ — builders make buildings: `labor` banks only while
 *  bodies stand at the site, so an unattended plot honestly waits at any
 *  clock). A no-cost row the driver ADOPTED (phase 2 step 3 — staged with
 *  its elapsed fraction banked) is labor-driven the same way; an unadopted
 *  one (growth's collapsed twin, pre-pipeline worldgen, driver-less
 *  sessions) keeps the pure clock. */
export function foundedBuildingDone(b: FoundedBuilding, day: number): boolean {
  if (b.completed === true) return true;
  if (b.costs || b.laborStartDay !== undefined) {
    if (b.laborStartDay === undefined) return false;
    return (b.labor ?? 0) >= b.buildDays - 1e-9;
  }
  return day >= b.startedDay + b.buildDays;
}

/** Bank worked labor on a designation (⑥): `days` of build-day credit —
 *  the sweep calls this with (elapsed × builders-present, capped). Works
 *  for FoundedBuilding and PendingAnnex alike. */
export function bankLabor(b: { labor?: number }, days: number): void {
  if (days <= 0) return;
  b.labor = (b.labor ?? 0) + days;
}

/** Is a pending designation's labor worked off (⑥)? Staged + banked. */
export function pendingLaborDone(p: PendingAnnex): boolean {
  return p.laborStartDay !== undefined && (p.labor ?? 0) >= p.buildDays - 1e-9;
}

/** The units still MISSING from a designation's pile (head → count; empty =
 *  staged, or a legacy pre-paid row). Works for FoundedBuilding and
 *  PendingAnnex alike (the one costs/pile shape). Facted pile variants pay
 *  toward their head, the missingCosts convention. */
export function stagingMissing(b: {
  costs?: Readonly<Record<string, number>>;
  pile?: Readonly<Record<string, number>>;
}): Record<string, number> {
  const missing: Record<string, number> = {};
  if (!b.costs) return missing;
  const need = new Map<string, number>();
  for (const [glyph, n] of Object.entries(b.costs)) {
    const head = stackHead(glyph);
    need.set(head, (need.get(head) ?? 0) + Math.max(0, n));
  }
  for (const [head, n] of need) {
    const short = n - stackUnits(b.pile ?? {}, head);
    if (short > 0) missing[head] = short;
  }
  return missing;
}

/** The town builder's-yard STOCK ENDPOINT id — the registered yard crate's
 *  id in the host AND the endpoint reservations key the kernel growth step
 *  reads (one id, both sides — the coincidence law). */
export const TOWN_YARD_EP = "town:yard";

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
/**
 * Materials a PLAYER-ORDERED annex or interior cut spends (city-founding ③
 * structure board). BLOCKS since phase 3 (the one construction primitive;
 * raws refine into them at a bench — head-paid, so any material's block
 * covers the bill). Auto-expansion keeps paying in banked prosperity.
 *
 * DERIVED FROM THE ROOM'S OWN RECT since phase 6 (block-bill.ts): these were
 * one flat block for everything, which made a broom-cupboard partition and a
 * full outbuilding cost the same, and made a room 1/3 of a whole house. An
 * annex brings floor, roof and its unshared walls; an interior cut brings one
 * partition and nothing else, so subdividing a shell is now properly the
 * cheap way to get a room — which is what it is.
 */
export function annexCosts(candidate: AnnexCandidate, conversionDial = 1): Record<string, number> {
  void conversionDial; // ⚖️ INERT (S3 review): bills are dial-free — conversion applies only at effectiveInPerOut/par/acres
  return blockCosts(annexBill(candidate));
}

/** {@link annexCosts} for an INTERIOR cut — the partition alone. */
export function interiorCosts(
  spec: Omit<InteriorSpec, "ord">,
  conversionDial = 1,
): Record<string, number> {
  void conversionDial; // ⚖️ INERT (S3 review): bills are dial-free
  return blockCosts(partitionBill(spec));
}

/** THE ORDER-TIME BILL for either kind of room the stake path accepts. An
 *  outward annex carries a `side` (which wall it shares with the house); an
 *  interior cut carries a `hostId` (whose floor it is taken out of) — the one
 *  discriminator, so a caller holding the union never has to know which.
 *  `conversionDial` — see `blockCosts`; default 1, byte-identical. */
export function roomOrderCosts(
  candidate: AnnexCandidate | InteriorCandidate,
  conversionDial = 1,
): Record<string, number> {
  return "side" in candidate ? annexCosts(candidate, conversionDial) : interiorCosts(candidate, conversionDial);
}

/**
 * What comes down when a BASE room is demolished — the PARTITION between it
 * and the room that absorbs its floor, and nothing else. A base room is part
 * of the original footprint: its floor and roof do not disappear, they join
 * the neighbour (`DemolishedRoom.into` — the rect union), and the outer walls
 * are the building's own. Only the wall between the two is dismantled, so only
 * that wall's blocks come back.
 *
 * This is what keeps the demolish/rebuild loop CONSERVATIVE: tearing out a
 * base room and cutting it again pays and refunds the same partition, so the
 * pair is a wash instead of a block mint.
 */
export function baseRoomCosts(rect: { w: number; h: number }, conversionDial = 1): Record<string, number> {
  void conversionDial; // ⚖️ INERT (S3 review): bills are dial-free
  return blockCosts(partitionBill({ u0: 0, u1: rect.w, v0: 0, v1: rect.h }));
}

/**
 * The bill of the CHEAPEST room anyone could order — what the structure board
 * probes with before it enumerates anywhere to put one. A single bay of
 * partition is the floor: no legal cut is smaller, so a builder who cannot
 * afford this cannot afford any room, and one who can is offered the
 * enumeration and gets a NAMED shortfall on whichever they pick.
 *
 * ⚖️ S&D S3 — a MODULE CONSTANT, computed once at the real (dial-1) anchor;
 * `blockCosts`'s own doc records this as the deliberate, safe-direction
 * residual (an OVER-estimate at dial > 1, never an under-estimate).
 */
export const MIN_ROOM_COSTS: Readonly<Record<string, number>> = blockCosts(
  partitionBill({ u0: 0, u1: 1, v0: 0, v1: 1 }),
);

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

// ── INTERIOR SUBDIVISION (pipeline ⑤b) ──────────────────────────────────
// The annexOptions law turned INWARD: candidates are guillotine cuts of a
// standing room's floor — the new room takes a band flush against three of
// the host's walls, the host keeps the rectangular remainder, one shared
// door joins them. Feasibility lives INSIDE the candidate test: a cut that
// reaches the caller keeps every existing doorway of the host (street door
// included) on the REMAINDER's walls with full jamb berth — circulation is
// untouched by construction, so no post-hoc connectivity repair exists.

/** Interior rooms per building — the footprint's floors bound it long
 *  before this does; the cap is the runaway backstop. */
export const MAX_INTERIOR_ROOMS = 6;

/** Smallest dimension a HOST keeps after a cut (each shrunk axis). */
const INTERIOR_HOST_MIN = 2.8;

/** A room kind's geometry floors — through its annex cluster where one
 *  exists (the CLUSTERS registry stays the one rulebook), a modest room
 *  otherwise (hall, living, culture kinds). */
const CLUSTER_OF_KIND: Readonly<Partial<Record<string, AnnexCluster>>> = Object.fromEntries(
  Object.entries(ANNEX_ROOM_KIND).map(([cluster, kind]) => [kind, cluster as AnnexCluster]),
);
function interiorFloors(kind: string): { minW: number; minD: number } {
  const c = CLUSTER_OF_KIND[kind];
  return c ? clusterFloors(c) : { minW: 2.8, minD: 2.8 };
}

/** Frame rects of DEMOLISHED base rooms of `kind` — the in-place
 *  re-creation candidates (construction-pipeline.md: a rebuilt room
 *  reoccupies its footprint when it still fits). The union host re-splits
 *  along the exact old partition; a rect already re-taken fails
 *  interiorOptions' containment and drops out naturally. */
export function demolishedRects(
  center: { x: number; y: number },
  house: HouseShape,
  basePlan: HouseRoomPlan,
  delta: BuildingDelta | undefined,
  kind: HouseRoom["kind"],
): Array<{ u0: number; u1: number; v0: number; v1: number }> {
  const out: Array<{ u0: number; u1: number; v0: number; v1: number }> = [];
  for (const dem of delta?.demolished ?? []) {
    const r = basePlan.rooms.find((rr) => rr.id === dem.roomId);
    if (r && r.kind === kind) out.push(frameOfRect(center, house, r.rect));
  }
  return out;
}

/**
 * Feasible interior rooms for one building, best-first. `preferred` frame
 * rects (demolished-room re-creation) are tried FIRST and exactly; then
 * generic cuts of every OPEN host — a room of kind living/hall (the shell's
 * root, a corridor grown wide) — far band, then sides, then the street
 * band. `keepRoot` guards rooms[0] (the living-room invariant: a HOUSE's
 * goods anchors hang off it; a shell's root may shrink). `excludeHosts`
 * removes rooms a pending designation already targets — two staked cuts
 * never share a host.
 */
export function interiorOptions(
  center: { x: number; y: number },
  house: HouseShape,
  plan: HouseRoomPlan,
  delta: BuildingDelta | undefined,
  want: HouseRoom["kind"],
  opts?: {
    keepRoot?: boolean;
    preferred?: ReadonlyArray<{ u0: number; u1: number; v0: number; v1: number }>;
    excludeHosts?: ReadonlySet<string>;
  },
): InteriorCandidate[] {
  if ((delta?.interior?.length ?? 0) >= MAX_INTERIOR_ROOMS) return [];
  const EPS = 1e-3;
  const M = metricsOf(house);
  const doorW = want === "bath" ? M.bathDoorW : M.roomDoorW;
  const jamb = M.doorJamb;
  const { minW, minD } = interiorFloors(want);
  const gone = new Set((delta?.demolished ?? []).map((d) => d.roomId));
  const rooms = plan.rooms.filter(
    (r) => !gone.has(r.id) && !opts?.excludeHosts?.has(r.id),
  );
  const out: InteriorCandidate[] = [];
  const seen = new Set<string>();

  /** Every doorway of `host` must survive — on the REMAINDER's walls, or
   *  TRANSFERRED whole to the new room's walls (re-creation: the union
   *  host carries the demolished room's old doors; the re-cut hands them
   *  back — applyDelta re-homes them). Full width + jamb berth either
   *  way; the ROOT's street-wall doors (frame v = 0) must stay with the
   *  root — rooms[0] remains the street door's room. */
  const doorsSurvive = (
    host: HouseRoom,
    rem: { u0: number; u1: number; v0: number; v1: number },
    cut: { u0: number; u1: number; v0: number; v1: number },
    isRoot: boolean,
  ): boolean => {
    for (const d of host.doorways) {
      const at = doorwayFramePoint(center, house, host, d);
      const half = d.width / 2 + jamb;
      const onRect = (r: { u0: number; u1: number; v0: number; v1: number }): boolean => {
        if (
          (Math.abs(at.v - r.v0) < EPS || Math.abs(at.v - r.v1) < EPS) &&
          at.u - half >= r.u0 - EPS && at.u + half <= r.u1 + EPS
        ) return true;
        return (
          (Math.abs(at.u - r.u0) < EPS || Math.abs(at.u - r.u1) < EPS) &&
          at.v - half >= r.v0 - EPS && at.v + half <= r.v1 + EPS
        );
      };
      if (isRoot && Math.abs(at.v) < EPS) {
        if (!onRect(rem)) return false;
        continue;
      }
      if (!onRect(rem) && !onRect(cut)) return false;
    }
    return true;
  };

  const tryCut = (host: HouseRoom, cut: { u0: number; u1: number; v0: number; v1: number }): void => {
    const hf = frameOfRect(center, house, host.rect);
    // Inside the host, dims above the kind's floors (either orientation).
    if (
      cut.u0 < hf.u0 - EPS || cut.u1 > hf.u1 + EPS ||
      cut.v0 < hf.v0 - EPS || cut.v1 > hf.v1 + EPS
    ) return;
    const cw = cut.u1 - cut.u0;
    const ch = cut.v1 - cut.v0;
    if (Math.min(cw, ch) < Math.min(minW, minD) - EPS) return;
    if (Math.max(cw, ch) < Math.max(minW, minD) - EPS) return;
    // The guillotine law: full host span on one axis, flush at one end of
    // the other — the remainder is a rectangle by construction.
    const fullU = Math.abs(cut.u0 - hf.u0) < EPS && Math.abs(cut.u1 - hf.u1) < EPS;
    const fullV = Math.abs(cut.v0 - hf.v0) < EPS && Math.abs(cut.v1 - hf.v1) < EPS;
    let rem: { u0: number; u1: number; v0: number; v1: number };
    let wall: { axis: "u" | "v"; at: number };
    if (fullU) {
      if (Math.abs(cut.v0 - hf.v0) < EPS) {
        rem = { u0: hf.u0, u1: hf.u1, v0: cut.v1, v1: hf.v1 };
        wall = { axis: "v", at: cut.v1 };
      } else if (Math.abs(cut.v1 - hf.v1) < EPS) {
        rem = { u0: hf.u0, u1: hf.u1, v0: hf.v0, v1: cut.v0 };
        wall = { axis: "v", at: cut.v0 };
      } else return;
      if (rem.v1 - rem.v0 < INTERIOR_HOST_MIN - EPS) return;
    } else if (fullV) {
      if (Math.abs(cut.u0 - hf.u0) < EPS) {
        rem = { u0: cut.u1, u1: hf.u1, v0: hf.v0, v1: hf.v1 };
        wall = { axis: "u", at: cut.u1 };
      } else if (Math.abs(cut.u1 - hf.u1) < EPS) {
        rem = { u0: hf.u0, u1: cut.u0, v0: hf.v0, v1: hf.v1 };
        wall = { axis: "u", at: cut.u0 };
      } else return;
      if (rem.u1 - rem.u0 < INTERIOR_HOST_MIN - EPS) return;
    } else return;
    if (!doorsSurvive(host, rem, cut, host === plan.rooms[0])) return;
    // The shared door: centered on the partition, jamb-clamped to the span
    // both rooms share on that wall.
    const lo = (wall.axis === "v" ? cut.u0 : cut.v0) + jamb + doorW / 2;
    const hi = (wall.axis === "v" ? cut.u1 : cut.v1) - jamb - doorW / 2;
    if (hi - lo < -EPS) return;
    const mid = Math.min(Math.max((lo + hi) / 2, lo), hi);
    const doorAt =
      wall.axis === "v"
        ? { u: mid, v: wall.at, width: doorW }
        : { u: wall.at, v: mid, width: doorW };
    const key = `${host.id}|${cut.u0.toFixed(3)},${cut.u1.toFixed(3)},${cut.v0.toFixed(3)},${cut.v1.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ hostId: host.id, kind: want, ...cut, doorAt });
  };

  // PREFERRED rects first (re-creation in place) — against ANY standing
  // host that contains them (the demolition union), root included when
  // allowed.
  const hostable = rooms.filter((r) => !(opts?.keepRoot && r === plan.rooms[0]));
  for (const p of opts?.preferred ?? []) {
    for (const host of hostable) tryCut(host, p);
  }
  // GENERIC cuts — only OPEN hosts (the shell's root, a hall): carving a
  // band off someone's bedroom is never a default.
  const bandT = (need: number, span: number): number | null => {
    let t = Math.max(need, 3.0);
    if (span - t < INTERIOR_HOST_MIN) t = span - INTERIOR_HOST_MIN;
    return t >= need - 1e-9 ? t : null;
  };
  for (const host of hostable) {
    if (host.kind !== "living" && host.kind !== "hall") continue;
    const hf = frameOfRect(center, house, host.rect);
    const HU = hf.u1 - hf.u0;
    const HV = hf.v1 - hf.v0;
    // Far band first (deepest from the street door), then the sides, then
    // the street band (usually rejected — the street door lives there).
    const tV = HU >= minW - 1e-9 ? bandT(minD, HV) : null;
    const tU = HV >= minD - 1e-9 ? bandT(minW, HU) : null;
    if (tV !== null) tryCut(host, { u0: hf.u0, u1: hf.u1, v0: hf.v1 - tV, v1: hf.v1 });
    if (tU !== null) {
      tryCut(host, { u0: hf.u0, u1: hf.u0 + tU, v0: hf.v0, v1: hf.v1 });
      tryCut(host, { u0: hf.u1 - tU, u1: hf.u1, v0: hf.v0, v1: hf.v1 });
    }
    if (tV !== null) tryCut(host, { u0: hf.u0, u1: hf.u1, v0: hf.v0, v1: hf.v0 + tV });
  }
  return out;
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

/** Accept a candidate from interiorOptions — assigns its ordinal and bumps
 *  the revision. The candidate was validated by construction; this only
 *  re-checks the cap (the requestAnnex law — commit-time geometry drift is
 *  the caller's to re-validate against the live plan). */
export function requestInterior(
  deltas: TownDeltas,
  buildingKey: string,
  c: InteriorCandidate,
): ConstructionResult {
  const d = deltas.get(buildingKey);
  if ((d?.interior?.length ?? 0) >= MAX_INTERIOR_ROOMS) return { ok: false, reason: "cap" };
  const ord = (d?.interior ?? []).reduce((m, s) => Math.max(m, s.ord + 1), 0);
  deltas.mutate(buildingKey, (bd) => {
    (bd.interior ??= []).push({ ord, ...c });
  });
  return { ok: true };
}

/** Drop a standing room-program row (phase 4 — designations are DERIVED
 *  and REMOVABLE, reversing ④'s append-only law). The FIRST delete path
 *  programs have ever had: a room whose required furniture the player
 *  removes must lose its standing want, or the sweeps re-order the bed
 *  forever. The room's DISPLAYED kind re-derives from what's left
 *  (roomKindOf) — rows are the wants, derivation is the fact. Returns
 *  whether a row was removed (no rev bump otherwise). */
export function removeProgram(deltas: TownDeltas, buildingKey: string, room: string): boolean {
  const d = deltas.get(buildingKey);
  if (!d?.programs?.some((pr) => pr.room === room)) return false;
  deltas.mutate(buildingKey, (bd) => {
    bd.programs = bd.programs?.filter((pr) => pr.room !== room);
  });
  return true;
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
  const interiorMatch = /_i(\d+)$/.exec(roomId);
  if (interiorMatch) {
    const spec = d?.interior?.find((s) => String(s.ord) === interiorMatch[1]);
    if (!spec) return { ok: false, reason: "no-room" };
    // Interior: spec removal, ORDER-GUARDED — later specs replay against
    // the geometry this one left behind, so it may go only while nothing
    // later depends on it: it hosts no later cut, and no later cut shares
    // its host (whose remainder this removal would move).
    const later = (d?.interior ?? []).filter((s) => s.ord > spec.ord);
    if (later.some((s) => s.hostId === roomId || s.hostId === spec.hostId)) {
      return { ok: false, reason: "not-rect" };
    }
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
 *
 * A DOORWAY-PINNED row (a hung door leaf, phase 5) is NOT the room's
 * furniture — "doorways are part of the wall" — so it neither stows nor
 * moves: it stays exactly where the wall is. Stowing one would ALSO mint a
 * `furn.door` stack while the leaf kept hanging (the leaf is drawn from
 * `doorless`, not from this list), which is a duplicated unit — the same
 * item-conservation trap the street-good boxes sit in.
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
  const interiorMatch = /_i(\d+)$/.exec(roomId);
  const into = check.into;

  const stowed: Partial<Record<StationKind, number>> = {};
  deltas.mutate(buildingKey, (bd) => {
    if (annexMatch && bd.annexes.some((a) => String(a.ord) === annexMatch[1])) {
      bd.annexes = bd.annexes.filter((a) => String(a.ord) !== annexMatch[1]);
    } else if (interiorMatch && bd.interior?.some((s) => String(s.ord) === interiorMatch[1])) {
      // Interior: the partition comes back down — the host re-absorbs the
      // floor (spec removal, order-guarded by demolishCheck above).
      bd.interior = bd.interior.filter((s) => String(s.ord) !== interiorMatch[1]);
    } else if (into) {
      bd.demolished.push({ roomId, into });
    }
    const stay: PlacedPiece[] = [];
    for (const p of bd.placed) {
      if (p.roomId === roomId && p.doorway === undefined) {
        stowed[p.kind] = (stowed[p.kind] ?? 0) + 1;
        // NEVER RE-ORDER WHAT THE PLAYER TORE OUT. A materialized row carries
        // the generator's own id (blueprint.ts), so without this the drawing
        // would ask for the piece straight back the moment the room went.
        if (!bd.removedPieces.includes(p.id)) bd.removedPieces.push(p.id);
      } else stay.push(p);
    }
    bd.placed = stay;
  });
  return { ok: true, stowed };
}

/**
 * EMPTY one room (phase 4 — the law's "empty" verb): furniture OUT, walls
 * STAY. The stow-half of demolishRoom with none of its structural rules —
 * emptying tears nothing down, so even the living room may be emptied.
 * Placed pieces stow exactly as demolishRoom stows them (including its
 * doorway-pinned exception — clearing a room out never takes its door off
 * the wall); GENERATED pieces (which would simply re-derive if left alone)
 * are passed in by the caller — their ids join `removedPieces` and their
 * kinds stow too (decision 5: worldgen furniture lazily mints its component
 * at deconstruction).
 */
export function emptyRoom(
  deltas: TownDeltas,
  buildingKey: string,
  plan: HouseRoomPlan,
  roomId: string,
  generated?: ReadonlyArray<{ id: string; kind: StationKind }>,
): { ok: true; stowed: Partial<Record<StationKind, number>> } | { ok: false; reason: "no-room" } {
  if (!plan.rooms.some((r) => r.id === roomId)) return { ok: false, reason: "no-room" };
  const stowed: Partial<Record<StationKind, number>> = {};
  const d = deltas.get(buildingKey);
  const hasPlaced = d?.placed.some((p) => p.roomId === roomId && p.doorway === undefined) ?? false;
  const fresh = (generated ?? []).filter((g) => !d?.removedPieces.includes(g.id));
  if (!hasPlaced && fresh.length === 0) return { ok: true, stowed }; // already bare — no rev bump
  deltas.mutate(buildingKey, (bd) => {
    const stay: PlacedPiece[] = [];
    for (const p of bd.placed) {
      if (p.roomId === roomId && p.doorway === undefined) {
        stowed[p.kind] = (stowed[p.kind] ?? 0) + 1;
        // Withheld for demolishRoom's reason — clearing a room out is a player
        // act, and the drawing must not simply ask for it all back.
        if (!bd.removedPieces.includes(p.id)) bd.removedPieces.push(p.id);
      } else stay.push(p);
    }
    bd.placed = stay;
    for (const g of fresh) {
      bd.removedPieces.push(g.id);
      stowed[g.kind] = (stowed[g.kind] ?? 0) + 1;
    }
  });
  return { ok: true, stowed };
}

/** Record a validated placement (the caller ran placementFeasible). */
export function placeFurniture(deltas: TownDeltas, buildingKey: string, piece: PlacedPiece): void {
  deltas.mutate(buildingKey, (d) => {
    d.placed.push(piece);
  });
}

/** Mark a delivered (tipped) placed piece as SET UP — the fixture rises
 *  upright (construction pipeline ⑥). Idempotent; a no-op for an unknown id
 *  or an already-standing piece (so the rev/version only bumps on a real
 *  transition, and the stage refurnishes exactly once). Returns whether it
 *  changed anything. */
export function markPieceSetUp(deltas: TownDeltas, buildingKey: string, pieceId: string): boolean {
  // Peek first — mutate() unconditionally bumps the rev (and refurnishes the
  // building), so only enter it on a real transition.
  const d = deltas.get(buildingKey);
  const p = d?.placed.find((q) => q.id === pieceId);
  if (!p || p.setUp !== false) return false;
  deltas.mutate(buildingKey, (bd) => {
    const q = bd.placed.find((r) => r.id === pieceId);
    if (q) q.setUp = true;
  });
  return true;
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

// DELIBERATELY ABSENT: `movePlacedPiece`, which rewrote a row's coordinates in
// place. It was how the re-flow sweep "moved" furniture, and it was the
// teleport: the piece stood on its old mark for the whole walk and the row was
// edited at the far end, so nothing was ever carried. A carry is a piece
// LEAVING one place and ARRIVING at another (construction-director's
// liftPieceIntoHands / landPieceFromHands — remove the row, hold it, place it),
// and there is no third thing a move could be.

/** Stow a GENERATED piece (its id never re-emits; its space frees, and
 *  an anchored piece follows its anchor out). */
export function stowGeneratedPiece(deltas: TownDeltas, buildingKey: string, pieceId: string): void {
  deltas.mutate(buildingKey, (d) => {
    if (!d.removedPieces.includes(pieceId)) d.removedPieces.push(pieceId);
  });
}

// ── DOORS AS FURNITURE (phase 5) ────────────────────────────────────────
// `doorless` is the mirror of `removedPieces` and these three are the mirror
// of `stowGeneratedPiece` / `removePlacedPiece`: ONE place that writes the
// list, so no caller ever has to remember that absent means "leaf".

/** The openings of `buildingKey` with no leaf — a Set for the staging path,
 *  which asks once per doorway per re-registration. */
export function doorlessOf(delta: BuildingDelta | undefined): ReadonlySet<string> {
  return new Set(delta?.doorless ?? []);
}

/** TAKE THE LEAF OFF an opening (the shell seeding its doorways, and `break`
 *  on a hung door). Idempotent — a doorway already bare doesn't re-bump the
 *  rev, so re-seeding a completed shell never re-stages the whole building. */
export function markDoorless(deltas: TownDeltas, buildingKey: string, keys: readonly string[]): boolean {
  const have = doorlessOf(deltas.get(buildingKey));
  const add = keys.filter((k) => !have.has(k));
  if (!add.length) return false;
  deltas.mutate(buildingKey, (d) => {
    d.doorless = [...(d.doorless ?? []), ...add];
  });
  return true;
}

/** HANG A LEAF: drop the opening's key (the doorway gets its door back) and
 *  record the piece that IS that leaf. One move, because the two halves must
 *  never be observable apart — a `door` PlacedPiece with its key still listed
 *  would render a leaf in a hole the engine still says is open. */
export function hangDoor(deltas: TownDeltas, buildingKey: string, piece: PlacedPiece): boolean {
  const key = piece.doorway;
  if (!key || !doorlessOf(deltas.get(buildingKey)).has(key)) return false;
  deltas.mutate(buildingKey, (d) => {
    d.doorless = (d.doorless ?? []).filter((k) => k !== key);
    d.placed.push(piece);
  });
  return true;
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
  /** What the town's tree was grown around (TownStreets.seeds) — regrowing
   *  with the same triple (seed, key, seeds) is PREFIX-CONSISTENT with the
   *  plan's own tree. Takes precedence over `bearings`. */
  seeds?: readonly GrowSeed[];
  /** LEGACY: arterial bearings the tree was grown with
   *  (TownStreets.bearings), compiled to stub seeds by growStreets' one
   *  adapter. Ignored when `seeds` is given. */
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
  /** STANDING GROUND the regrown tree must bend around (`groundObstacles` —
   *  annexed homesteads, growth phase C §3.3). MUST match what `plan.ts`
   *  grew with, or the two lattices disagree. Absent = none, and the tree
   *  is byte-identical to every pre-phase-C enumeration. */
  obstacles?: readonly Rect[];
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
  /** HOW `near` MEASURES (growth phase C §1.4 — the time tax reaches the
   *  steering). Metres between two TOWN-LOCAL points; the host passes its
   *  `sourceDistanceM`, which walks the street tree where one exists and
   *  falls back to the chord where it doesn't, so "near the stranded
   *  quarter" stops meaning "near as the crow flies over the rooftops".
   *
   *  Absent = the chord, and BYTE-IDENTICAL to the legacy order: the default
   *  path is the original squared-chord comparison, untouched (only the
   *  ORDER is ever read, so squaring is free — and keeping the exact
   *  expression means no float can reorder a tie). */
  distM?(a: { x: number; y: number }, b: { x: number; y: number }): number;
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

/** ONE-ENTRY STREET MEMO. Growing the tree is the expensive half of a lot
 *  enumeration, and it depends on nothing the per-structure loop varies —
 *  so asking "where could a house / a farm / a smithy go?" in one breath
 *  (⑦ build spots: once per catalog entry) grows it once instead of nine
 *  times. Read-only by contract: `foundingOptions` only reads `slots` and
 *  `streets`, and it is the sole user of this memo (plan.ts keeps its own
 *  fresh call — the town layout must never share a mutable net). */
let streetMemo: { key: string; net: TownStreets } | null = null;

function streetsFor(
  seed: number,
  key: string,
  minSlots: number,
  bearings: readonly number[] | undefined,
  seeds: readonly GrowSeed[] | undefined,
  obstacles: readonly Rect[] | undefined,
): TownStreets {
  const memoKey = `${seed}|${key}|${minSlots}|${
    seeds?.length ? JSON.stringify(seeds) : (bearings ?? []).join(",")
  }|${obstacles?.length ? JSON.stringify(obstacles) : ""}`;
  if (streetMemo && streetMemo.key === memoKey) return streetMemo.net;
  const obs = obstacles?.length ? { obstacles } : {};
  const net = seeds?.length
    ? growStreets(seed, key, minSlots, { seeds, ...obs })
    : growStreets(seed, key, minSlots, { bearings: [...(bearings ?? [])], ...obs });
  streetMemo = { key: memoKey, net };
  return net;
}

/**
 * THE STANDING GROUND a town's streets must bend around: the footprints of
 * founded rows that stand on GROUND rather than on a frontage lot
 * (`slot < 0` — annexed homesteads, growth phase C §3.3). Town-local.
 *
 * Read identically by `plan.ts`'s tree and by the founding enumeration's,
 * because the two trees MUST agree: a lot the plan laid around a homestead
 * and a lot the enumeration laid through it are different lattices, and a
 * founded building would land on the wrong ground.
 */
export function groundObstacles(deltas: Pick<TownDeltas, "founded">): Rect[] {
  return deltas.founded()
    .filter(b => b.slot < 0)
    .map(b => ({ x: b.dx, y: b.dy, w: b.w, h: b.h }));
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
  const net: TownStreets = streetsFor(
    input.seed, input.key, minSlots, input.bearings, input.seeds, input.obstacles,
  );
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
    const walk = input.distM;
    const d2 = walk
      // STREET METRES where the caller gave us a way to measure them.
      ? (c: FoundingCandidate): number => walk({ x: c.dx + c.w / 2, y: c.dy + c.h / 2 }, n)
      // ...the legacy squared chord otherwise, character for character.
      : (c: FoundingCandidate): number =>
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

/** An auto-expansion REQUEST (constructionStep output) — a validated
 *  candidate the caller posts as a pending-annex ORDER. Renamed from
 *  `ConstructionOrder` in phase 2: that name now means the persisted row. */
export interface ConstructionRequest {
  buildingKey: string;
  action: { kind: "annex"; cluster: AnnexCluster; candidate: AnnexCandidate };
}

/** Prosperity a household must bank before it builds (with the daily cap
 *  this is ~a week of full signals — tune in playtests). */
export const PROSPERITY_THRESHOLD = 6;
/** Prosperity accrual cap per credited day (hysteresis: no single lucky
 *  day builds an annex). */
export const PROSPERITY_DAILY_CAP = 1.5;

/** Annex cluster a programmed room kind rises through (ANNEX_ROOM_KIND
 *  inverted). Kinds with no cluster (living, hall, culture-authored) are
 *  not annexable — their programs wait for interior subdivision (⑤). */
const CLUSTER_OF_ROOM: Readonly<Record<string, AnnexCluster>> = Object.fromEntries(
  Object.entries(ANNEX_ROOM_KIND).map(([cluster, kind]) => [kind, cluster as AnnexCluster]),
);

/**
 * ⚖️ THE BEDROOM STANDARD (growth-motive law ②, S&D S1) — souls one sleep
 * cell houses without crowding. The want above it is a REAL unmet need; below
 * it there is nothing to want, however rich the household.
 *
 * 2 is the ordinary crowding standard (a couple, or two children, per room).
 * Note what it derives, and that it is a derivation and not a coincidence:
 * `HOUSEHOLD` = 5 souls ⇒ ⌈5/2⌉ = 3 bedrooms, which is exactly the constant
 * `nextAnnexWant` used to ASSERT. A full household therefore wants the same
 * three rooms it always did; a SHRUNKEN one (a family with excluded members,
 * a newly-admitted small household) now stops sooner, and a GROWN one
 * (endogenous births) asks for a fourth. That is the whole point: the ladder
 * stopped being a number and became a reading.
 */
export const SOULS_PER_BEDROOM = 2;

/** ⚖️ WHAT A HOUSEHOLD IS LIVING WITH (S&D S1) — the occupancy/pressure
 *  reading `nextAnnexWant` scores its wants against. Every field OPTIONAL and
 *  every absence meaning "no reading, keep the historical want", so a caller
 *  that knows only its soul count says only that. */
export interface HouseOccupancy {
  /** Souls sleeping in this house (HOUSEHOLD minus authored exclusions, plus
   *  whatever the population model has since done to it). */
  souls: number;
  /** How full the household's OWN containers sit, 0..1+ (1 = no room left).
   *  A store room is wanted when the boxes are full, not on principle. */
  storagePressure?: number;
  /** Craft work the household has in hand with nowhere to bench it (>0 wants
   *  a workshop). */
  craftPressure?: number;
}

/** The next annex CLUSTER a house wants, from its realized plan — ORDERED
 *  programs first (pipeline ④ persistent wants: a standing want is raised
 *  before any default differentiation), then the unmet occupant program (a
 *  third sleep cell), then the differentiations in historical order
 *  (kitchen → store → workshop). Null = content.
 *
 *  PHASE 4: this used to be documented as "a demolished programmed room
 *  re-rises". It no longer does — `removeProgram` drops the row at the
 *  demolition/empty/break commit, so a house never re-orders what the player
 *  tore out. The precedence over the rows it IS given is unchanged.
 *
 *  ⚖️ S&D S1 — `occupancy` REPLACES THE FIXED CHECKLIST (growth-motive law ②:
 *  "growth happens due to unfulfilled needs"). The sleep want was
 *  `bedrooms.length < 3`, a number that made every house on the map want a
 *  third bedroom forever, whoever lived in it. Supplied, it becomes the
 *  BEDROOM STANDARD over the real soul count, and the store/workshop
 *  differentiations become need-bound too. The KITCHEN want stays
 *  unconditional on purpose: a household cooks every day, so a house without
 *  one has a standing unmet need and needs no pressure reading to prove it.
 *
 *  ABSENT ⇒ the shipped ladder, clause for clause — every worldgen caller,
 *  every fixture and every abstract twin is byte-identical. */
export function nextAnnexWant(
  plan: HouseRoomPlan,
  programs?: ReadonlyArray<{ room: string }>,
  occupancy?: HouseOccupancy,
): AnnexCluster | null {
  if (programs) {
    for (const p of programs) {
      const cluster = CLUSTER_OF_ROOM[p.room];
      if (!cluster) continue;
      if (!plan.rooms.some((r) => r.kind === p.room)) return cluster;
    }
  }
  const crowded = occupancy
    ? plan.bedrooms.length === 0 ||
      occupancy.souls > plan.bedrooms.length * SOULS_PER_BEDROOM
    : plan.bedrooms.length < 3;
  if (crowded) return "sleep";
  if (!plan.rooms.some((r) => r.kind === "kitchen")) return "kitchen";
  const wantsStore = (occupancy?.storagePressure ?? 1) >= 1;
  if (wantsStore && !plan.rooms.some((r) => r.kind === "store")) return "store";
  const wantsShop = (occupancy?.craftPressure ?? 1) > 0;
  if (wantsShop && !plan.rooms.some((r) => r.kind === "workshop")) return "workshop";
  return null;
}

/**
 * ONE construction tick (call once per credited town day): accrue each
 * household's prosperity from the caller's signals, and let AT MOST ONE
 * house per town spend a full threshold on its best annex candidate —
 * center-out on ties, exactly the build-up knob's distribution
 * philosophy. Deterministic given (plan, deltas, signals); `day` is
 * carried into the order log only.
 *
 * A BUILDING NEVER RISES BY ITSELF (⑥ user law). This step DESIGNATES —
 * it accrues prosperity, spends the threshold and hands the caller a
 * validated candidate; the caller posts it as a pending annex so the same
 * hauls and the same banked builder labor raise it as a player's order
 * would. It used to `requestAnnex` on the spot, which is how a room could
 * appear on a watched house with nobody standing anywhere near it.
 *
 * `busy` is ground already spoken for by a live designation — the caller's
 * pending sites. Without it the same house would re-order its annex every
 * day while the first one is still gathering materials.
 *
 * ⚖️ SURPLUS CONTROL (user addendum 2026-08-12: "the town's own demands are
 * exceeding its capacity … patchable with a simple surplus control").
 * `opts.canAfford` is the caller's SPARE test over the candidate's own bill,
 * asked BEFORE the threshold is spent — an ambient room the commons cannot
 * cover out of surplus is simply not ordered today, and the household keeps
 * its banked prosperity for a day when it can. Absent ⇒ no test, which is
 * every pre-patch caller and every test fixture, byte-for-byte.
 */
export function constructionStep(
  center: { x: number; y: number },
  plan: Pick<TownPlan, "houses" | "works">,
  deltas: TownDeltas,
  signalsOf: (houseIndex: number) => ConstructionSignal[],
  day: number,
  busy: ReadonlyArray<Rect> = [],
  gates: {
    canAfford?: (buildingKey: string, candidate: AnnexCandidate) => boolean;
    /** ⚖️ S&D S1 — the household's OCCUPANCY reading, so its want is a need
     *  and not a checklist (`nextAnnexWant`). Absent (or an absent answer for
     *  one house) ⇒ the historical ladder for that house. */
    occupancyOf?: (houseIndex: number) => HouseOccupancy | undefined;
  } = {},
): ConstructionRequest[] {
  void day;
  const canAfford = gates.canAfford;
  const rects: Rect[] = [
    ...plan.houses.map((h) => ({ x: center.x + h.dx, y: center.y + h.dy, w: h.w, h: h.h })),
    ...plan.works.map((w) => ({ x: center.x + w.dx, y: center.y + w.dy, w: w.w, h: w.h })),
    ...busy.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
  ];
  /** Buildings a designation is already raising a room on — one at a time. */
  const designated = new Set(deltas.annexSites().map((p) => p.buildingKey));
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
  const requests: ConstructionRequest[] = [];
  for (const e of ranked) {
    const key = `h_${e.h.index}`;
    if (designated.has(key)) continue; // its last order is still being built
    const delta = deltas.get(key);
    const housePlan = houseRoomPlan(center, e.h, delta);
    const want = nextAnnexWant(housePlan, delta?.programs, gates.occupancyOf?.(e.h.index));
    if (!want) continue; // content — prosperity keeps banking harmlessly
    const neighbors = rects.filter((_, ri) => ri !== e.i);
    const opts = annexOptions(center, e.h, housePlan, neighbors, delta, want);
    if (!opts.length) continue; // out of ground — try the next-richest
    const candidate = opts[0]!;
    // ⚖️ SPARE ONLY, and BEFORE the spend: an ambient room whose bill would
    // eat into the commons reserve waits for a richer day. The threshold is
    // untouched, so nothing is lost by waiting (contrast the shipped path,
    // which spent it and staked a plot that could not be stocked).
    if (canAfford && !canAfford(key, candidate)) continue;
    deltas.mutate(key, (d) => {
      d.prosperity = Math.max(0, (d.prosperity ?? 0) - PROSPERITY_THRESHOLD);
    });
    requests.push({ buildingKey: key, action: { kind: "annex", cluster: want, candidate } });
    break; // one build per town per day
  }
  return requests;
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
