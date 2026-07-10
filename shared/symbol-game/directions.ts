// shared/symbol-game/directions.ts
//
// "Asking for directions" GEOMETRY — pure/headless, so it's unit-testable.
//
// When a townsperson is asked where something is, this decides HOW they answer:
// which proximity phrase ("it's here" / "there" / "on this street" / "close" /
// "far") and, for the close/far phrases, which cardinal direction — plus the
// world point the camera should swivel to face (and the arm should point at).
//
// All positions are TOWN-LOCAL meters, the frame the street network lives in
// (the caller subtracts the town center off world coordinates before calling).
// Distance is measured two ways: straight-line for the "can I see it?" buckets
// (here / there) and street-walk metres (roadDistance) for close / far — the
// distance a person actually experiences. "Same street" is a topology test.

import { project, roadDistance, type TownStreets, type Vec2 } from "@shared/engine/town/streets.js";

/** How near the target is, in the fixed vocabulary the dialogue layer speaks. */
export type Proximity = "here" | "there" | "street" | "close" | "far";

/** Cardinal words. Y-DOWN convention (matches plan.ts doors): north = −y,
 *  south = +y, east = +x, west = −x. */
export type Cardinal = "north" | "south" | "east" | "west";

export interface DirectionsTuning {
  /** Straight-line "very, very close" ("it's here"). */
  hereR: number;
  /** Straight-line "within visual distance" ("it's there"). */
  visibleR: number;
  /** Street-walk metres under which the target is "close" (else "far"). */
  closeR: number;
}

/** Defaults tuned to town scale (plaza ~30 m radius, convenient shopping
 *  ~120 m of street per districts.ts). */
export const DEFAULT_DIRECTIONS_TUNING: DirectionsTuning = {
  hereR: 4,
  visibleR: 45,
  closeR: 140,
};

export interface DirectionAnswer {
  proximity: Proximity;
  /** The compass word for the close/far phrases. Always computed (from the
   *  straight-line bearing) so the caller can point even for here/there. */
  cardinal: Cardinal;
  /** Town-local point the camera swivels to face / the NPC points at. For
   *  "street" this lies down the street toward the target; otherwise it's the
   *  target itself. */
  pointAt: Vec2;
}

/** The cardinal word for the bearing from `from` to `to` (Y-down). */
export function cardinalOf(from: Vec2, to: Vec2): Cardinal {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "east" : "west";
  return dy >= 0 ? "south" : "north";
}

/**
 * Decide the directions answer from `from` to `to`.
 *
 * Priority is bottom-to-top of the spec list — the MOST specific phrasing wins:
 * here → there → same-street → close → far. So a target you can see reads as
 * "there" even if it also happens to sit on your street, and anything within
 * arm's reach reads as "here".
 */
export function directionsTo(
  net: TownStreets,
  from: Vec2,
  to: Vec2,
  tuning: DirectionsTuning = DEFAULT_DIRECTIONS_TUNING,
): DirectionAnswer {
  const straight = Math.hypot(to.x - from.x, to.y - from.y);
  const cardinal = cardinalOf(from, to);

  // 1. very, very close — "it's here"
  if (straight <= tuning.hereR) return { proximity: "here", cardinal, pointAt: to };
  // 2. within visual distance — "it's there"
  if (straight <= tuning.visibleR) return { proximity: "there", cardinal, pointAt: to };

  // 3. same street — "it's on this street" (point down the street toward it)
  const pa = project(net, from);
  const pb = project(net, to);
  if (pa.street === pb.street) {
    return { proximity: "street", cardinal, pointAt: pb.pt };
  }

  // 4/5. close / far by street-walk distance, with a compass bearing.
  const road = roadDistance(net, from, to);
  return { proximity: road <= tuning.closeR ? "close" : "far", cardinal, pointAt: to };
}
