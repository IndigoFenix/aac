// shared/world-engine/interaction/town/structure-board.ts
//
// STRUCTURE-SCOPED CONTROLS (city-founding ③): the pure model behind the
// focused-building board. Town-level words (build/area/trade) belong to the
// TOWN scope; when the spirit ladder's structure rung (or the boot dollhouse)
// focuses ONE building, the board speaks THAT house's acts instead — annex a
// room, demolish a room, place stored furniture. This module is the
// kernel-pure side: the quest host feeds it live state and shapes the
// presenter view from what comes back, so the board never shows a dead
// button (every act returned is one the kernel would accept right now).

import {
  MIN_ROOM_COSTS,
  annexOptions,
  demolishCheck,
  demolishedRects,
  interiorOptions,
  type AnnexCandidate,
  type AnnexCluster,
  type BuildingDelta,
  type InteriorCandidate,
  type TownDeltas,
} from "../../kernel/town/construction";
import {
  ANNEX_ROOM_KIND,
  FURNITURE_ITEMS,
  furnitureGlyph,
  type StationKind,
} from "../../kernel/town/stations";
import { costsMet } from "../../kernel/town/structures";
import { withRefinableCredit } from "../../products";
import type { HouseRoom, HouseRoomPlan, HouseShape } from "../../kernel/town/rooms";

/** What a spirit focus frame lands on: a plan house (annex/demolish/furnish
 *  apply), a work building (structure scope, no house acts yet), or nothing. */
export type StructureFocus = { kind: "house" | "work"; index: number };

/** A lot rect as the ladder providers hand it back: sim coords (town center
 *  already applied) — planet-provider's buildingFrame and flat-provider's
 *  raw lot agree on this shape. */
export interface FocusFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FOCUS_EPS = 0.5;

/**
 * Match a focused-building frame back to the plan lot it came from. Both
 * ladder providers build the frame FROM a plan lot (center + dx/dy, exact
 * w/h), so the match is equality within epsilon — a frame that matches
 * nothing (a stale frame across a rebuild, a founded-work scaffold) is
 * honestly null and the caller keeps town scope.
 */
export function resolveStructureFocus(
  frame: FocusFrame,
  center: { x: number; y: number },
  plan: {
    houses: ReadonlyArray<{ dx: number; dy: number; w: number; h: number; index: number }>;
    works: ReadonlyArray<{ dx: number; dy: number; w: number; h: number }>;
  },
): StructureFocus | null {
  const hits = (dx: number, dy: number, w: number, h: number): boolean =>
    Math.abs(center.x + dx - frame.x) < FOCUS_EPS &&
    Math.abs(center.y + dy - frame.y) < FOCUS_EPS &&
    Math.abs(w - frame.w) < FOCUS_EPS &&
    Math.abs(h - frame.h) < FOCUS_EPS;
  for (const h of plan.houses) {
    if (hits(h.dx, h.dy, h.w, h.h)) return { kind: "house", index: h.index };
  }
  for (let i = 0; i < plan.works.length; i++) {
    const w = plan.works[i]!;
    if (hits(w.dx, w.dy, w.w, w.h)) return { kind: "work", index: i };
  }
  return null;
}

/** The annex clusters the board offers, in the historical differentiation
 *  order (nextAnnexWant's order — sleep first, workshop last). */
export const ANNEX_ORDER: ReadonlyArray<AnnexCluster> = [
  "sleep",
  "kitchen",
  "store",
  "wet",
  "workshop",
];

/** The board GLYPH word a room kind reads as ("build + bedroom",
 *  "break + kitchen") — every word exists in the game languages. */
export const ROOM_GLYPH: Readonly<Record<HouseRoom["kind"], string>> = {
  living: "home",
  bedroom: "bedroom",
  bath: "bathroom",
  hall: "room",
  store: "store",
  kitchen: "kitchen",
  workshop: "workshop",
};

/** WHERE a room could rise, exactly — the validated candidate behind one
 *  entry of `annex` / `interior`. The lit ground is made of these: a growth
 *  area is a place, and the order it raises is pinned to the geometry that
 *  was lit, never re-derived to somewhere else. */
export interface StructureGrowCandidate {
  kind: HouseRoom["kind"];
  /** The annex cluster the house order path speaks through (every kind the
   *  board offers has one; a shell's own kinds order by kind). */
  cluster?: AnnexCluster;
  /** True = outward growth, false = a cut inside a standing floor. */
  outward: boolean;
  /** Door-local frame rect — annexWorldRect turns it into world coords. */
  candidate: AnnexCandidate | InteriorCandidate;
}

export interface StructureActs {
  /** Clusters an annex could rise for RIGHT NOW — ground feasible, under the
   *  annex cap, and the builder's stock covers MIN_ROOM_COSTS (the cheapest
   *  room anyone could order; bills are per-rect since phase 6, and the room's
   *  own shortfall is NAMED at order time rather than refused here). */
  annex: AnnexCluster[];
  /** Room kinds an INTERIOR room could rise for (⑤b — subdivision of an
   *  open host, or re-creation of a demolished base room in place) that
   *  no annex already offers. The order path prefers in-place anyway;
   *  this list is the kinds the board would otherwise never show. */
  interior: Array<HouseRoom["kind"]>;
  /** Every candidate behind `annex` and `interior`, best-first per kind —
   *  the same enumeration those two lists were derived from, kept instead
   *  of thrown away, so the ground can be LIT without running it twice. */
  grow: StructureGrowCandidate[];
  /** Rooms whose demolition the kernel would accept right now (never the
   *  living room, never a merge that breaks the door graph). */
  demolish: HouseRoom[];
  /** Every room standing in the delta-applied plan — what the ground offers
   *  one aim each (a room with nothing to do stays dark; `demolish` is the
   *  subset that can come down). */
  rooms: HouseRoom[];
  /** Furniture kinds standing as stacks in the house's own storage. */
  furnish: StationKind[];
}

/** Candidates kept per kind. The enumeration is best-first and near-identical
 *  rects merge into one area anyway, so a handful is every distinct PLACE a
 *  kind could take without walking the whole tail. */
const GROW_PER_KIND = 4;

/**
 * Everything the focused BUILDING can DO right now. Pure: reads the
 * deltas, never writes them (demolish feasibility runs the check, not the
 * act). `furnStock` reads the building's own container stacks (the host
 * closes over session.containerStock — the ONE container abstraction
 * stays its). Houses pass their `h_<i>` key with `keepRoot` (the
 * living-room invariant); a founded shell passes its work delta key with
 * an open root and no outward growth.
 */
export function structureActsOf(input: {
  center: { x: number; y: number };
  house: HouseShape;
  plan: HouseRoomPlan;
  deltas: TownDeltas;
  /** The building's construction-delta key (`h_<i>` / workDeltaKey). */
  buildingKey?: string;
  /** The PURE base plan (no delta) — demolished-room rects for in-place
   *  re-creation come from here. Absent = no re-creation candidates. */
  basePlan?: HouseRoomPlan;
  /** Never offer rooms[0] as an interior host (houses — the living-room
   *  invariant). Default true. */
  keepRoot?: boolean;
  /** Offer outward annex growth (houses). Default true; a shell grows
   *  inward first. */
  growOutward?: boolean;
  /** World rects of every OTHER footprint the annex must clear. */
  neighbors: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
  /** The builder's stock the annex would spend from (yard / site). */
  stock: Readonly<Record<string, number>>;
  furnStock: (glyph: string) => number;
}): StructureActs {
  const key = input.buildingKey ?? `h_${input.house.index}`;
  const delta: BuildingDelta | undefined = input.deltas.get(key);
  // CHAIN-AWARE (phase 3): raws count at their milled value — a yard of
  // wood affords a block-costed room; the refine chain fills the bill.
  // The probe is the CHEAPEST room anyone could order (phase 6 — bills are
  // per-rect now, and this gate runs before there is a rect to bill). It gates
  // the board, not the order: pick a room this stock can't quite reach and the
  // designation still posts, naming its shortfall (the "missing materials
  // never refuse" law).
  const affordable = costsMet({ costs: { ...MIN_ROOM_COSTS } }, withRefinableCredit(input.stock));
  // THE ENUMERATION IS THE LIT GROUND. It used to be run for its LENGTH and
  // thrown away, which left the board naming kinds with no idea where they
  // would go; the candidates are what the player aims at now, so they are
  // kept as they come back.
  const grow: StructureGrowCandidate[] = [];
  const annex: AnnexCluster[] = [];
  if (affordable && (input.growOutward ?? true)) {
    for (const c of ANNEX_ORDER) {
      const cands = annexOptions(input.center, input.house, input.plan, input.neighbors, delta, c);
      if (!cands.length) continue;
      annex.push(c);
      for (const candidate of cands.slice(0, GROW_PER_KIND)) {
        grow.push({ kind: ANNEX_ROOM_KIND[c], cluster: c, outward: true, candidate });
      }
    }
  }
  const annexKinds = new Set(annex.map((c) => ANNEX_ROOM_KIND[c]));
  const interior: Array<HouseRoom["kind"]> = [];
  if (affordable) {
    for (const c of ANNEX_ORDER) {
      const k = ANNEX_ROOM_KIND[c];
      if (annexKinds.has(k)) continue;
      const cands = interiorOptions(input.center, input.house, input.plan, delta, k, {
        keepRoot: input.keepRoot ?? true,
        preferred: input.basePlan
          ? demolishedRects(input.center, input.house, input.basePlan, delta, k)
          : [],
      });
      if (!cands.length) continue;
      interior.push(k);
      for (const candidate of cands.slice(0, GROW_PER_KIND)) {
        grow.push({ kind: k, cluster: c, outward: false, candidate });
      }
    }
  }
  // A room a pending demolition already targets is spoken for — the order
  // stands, the button would be a dead re-press.
  const comingDown = new Set(
    input.deltas
      .demolitionSites()
      .filter((p) => p.buildingKey === key)
      .map((p) => p.roomId),
  );
  // A room a pending order already owns is not aimable either — its own site
  // marking answers for that ground while the work runs.
  const rooms = input.plan.rooms.filter((r) => !comingDown.has(r.id));
  const demolish = rooms.filter((r) => demolishCheck(input.deltas, key, input.plan, r.id).ok);
  const furnish = FURNITURE_ITEMS.filter((f) => input.furnStock(furnitureGlyph(f.kind)) > 0).map(
    (f) => f.kind,
  );
  return { annex, interior, grow, demolish, rooms, furnish };
}
