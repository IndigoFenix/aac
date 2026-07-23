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
  ANNEX_COSTS,
  annexOptions,
  demolishCheck,
  type AnnexCluster,
  type BuildingDelta,
  type TownDeltas,
} from "../../kernel/town/construction";
import {
  ANNEX_ROOM_KIND,
  FURNITURE_ITEMS,
  furnitureGlyph,
  type StationKind,
} from "../../kernel/town/stations";
import { costsMet } from "../../kernel/town/structures";
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

export interface StructureActs {
  /** Clusters an annex could rise for RIGHT NOW — ground feasible, under
   *  the annex cap, and the builder's stock covers ANNEX_COSTS. */
  annex: AnnexCluster[];
  /** Rooms whose demolition the kernel would accept right now (never the
   *  living room, never a merge that breaks the door graph). */
  demolish: HouseRoom[];
  /** Furniture kinds standing as stacks in the house's own storage. */
  furnish: StationKind[];
}

/**
 * Everything the focused house can DO right now. Pure: reads the deltas,
 * never writes them (demolish feasibility runs the check, not the act).
 * `furnStock` reads the house's own container stacks (the host closes over
 * session.containerStock — the ONE container abstraction stays its).
 */
export function structureActsOf(input: {
  center: { x: number; y: number };
  house: HouseShape;
  plan: HouseRoomPlan;
  deltas: TownDeltas;
  /** World rects of every OTHER footprint the annex must clear. */
  neighbors: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
  /** The builder's stock the annex would spend from (yard / site). */
  stock: Readonly<Record<string, number>>;
  furnStock: (glyph: string) => number;
}): StructureActs {
  const key = `h_${input.house.index}`;
  const delta: BuildingDelta | undefined = input.deltas.get(key);
  const affordable = costsMet({ costs: { ...ANNEX_COSTS } }, input.stock);
  const annex = affordable
    ? ANNEX_ORDER.filter(
        (c) =>
          annexOptions(input.center, input.house, input.plan, input.neighbors, delta, c).length > 0,
      )
    : [];
  const demolish = input.plan.rooms.filter(
    (r) => demolishCheck(input.deltas, key, input.plan, r.id).ok,
  );
  const furnish = FURNITURE_ITEMS.filter((f) => input.furnStock(furnitureGlyph(f.kind)) > 0).map(
    (f) => f.kind,
  );
  return { annex, demolish, furnish };
}
