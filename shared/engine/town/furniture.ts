/**
 * furniture.ts — WHAT STANDS IN A ROOM: archetypal containers along the
 * walls of a house, derived deterministically from the house geometry
 * (no dice — same house, same furniture, forever). Renderer-agnostic:
 * the 3D view raises solid, openable fixtures from these pieces; the
 * overhead canvas draws their rects when the roof is revealed. Views
 * may ABSTRACT furniture away with the unloaded house (it exists only
 * while its interior can matter — collision is meaningless in a house
 * nobody can be inside of).
 *
 * The pieces:
 *   CHESTS   — the household GOODS BOXES made physical: one lidded chest
 *              per street good, tucked FLUSH into its corner (the pantry
 *              crate, the wares chest, the linen chest ARE these). The
 *              errand's standing spot (goodBoxAt, 1.75 m in) sits in
 *              FRONT of the chest, so a shopper walks up to it.
 *   CUPBOARD — flush against the wall opposite the door.
 *   TABLE    — in the room, shifted toward the door half. Holds things
 *              "on" — what's on a table can be SEEN.
 *
 * Furniture (bar the table) hugs the WALLS, in CORNERS — a chest or a
 * cupboard stranded mid-room reads wrong. The table earns the middle.
 */

import type { TownHouse } from "./plan";

export interface FurniturePiece {
  id: string;
  kind: "chest" | "cupboard" | "table";
  /** Center, world meters. */
  x: number;
  y: number;
  /** Half-extent (square footprint — also the collision box). */
  radius: number;
  /** Which way the lid/front faces (radians, 0 = +x) — into the room. */
  facing: number;
  openable: boolean;
  /** The street good whose household box this chest IS (pantry…). */
  good?: string;
}

/** The furniture of one house. `goods` in slot order (a town's street
 *  goods) — each gets its chest at its own box corner. */
export function houseFurniture(
  center: { x: number; y: number },
  house: TownHouse,
  goods: ReadonlyArray<{ key: string; slot?: number }>,
  /** Id scope for multi-town worlds ("_riverton") — ids must be unique
   *  across every loaded town's furniture. */
  scope = "",
): FurniturePiece[] {
  const cx = center.x + house.dx + house.w / 2;
  const cy = center.y + house.dy + house.h / 2;
  const faceRoom = (x: number, y: number): number => Math.atan2(cy - y, cx - x);
  const pieces: FurniturePiece[] = [];

  // The goods chests, tucked FLUSH into their corners (edge against both
  // walls). The slot picks the corner (goodBoxAt's mapping: 0 SW · 1 SE ·
  // 2 NE · 3 NW); the errand's standing spot (goodBoxAt, 1.75 m in) sits
  // in FRONT of the chest, so the shopper walks up to a spot that's clear
  // of the solid crate — no stall, no stranding.
  const CHEST_R = 0.55;
  const inWall = CHEST_R + 0.1; // edge a hair off the wall (no z-fight)
  const westX = center.x + house.dx + inWall;
  const eastX = center.x + house.dx + house.w - inWall;
  const northY = center.y + house.dy + inWall;
  const southY = center.y + house.dy + house.h - inWall;
  goods.forEach((g, i) => {
    const corner = (g.slot ?? i) % 4;
    const chX = corner === 1 || corner === 2 ? eastX : westX;
    const chY = corner === 0 || corner === 1 ? southY : northY;
    pieces.push({
      id: `furn${scope}_${house.index}_chest_${g.key}`,
      kind: "chest",
      x: chX,
      y: chY,
      radius: CHEST_R,
      facing: faceRoom(chX, chY),
      openable: true,
      good: g.key,
    });
  });

  // The cupboard: midpoint of the wall OPPOSITE the door, FLUSH against
  // it (radius 0.6 + a hair). The corner chests hug the corners, so a
  // cupboard at the wall's middle never crowds them.
  const inset = 0.7;
  const cup =
    house.door === "north" ? { x: cx, y: center.y + house.dy + house.h - inset }
    : house.door === "south" ? { x: cx, y: center.y + house.dy + inset }
    : house.door === "west" ? { x: center.x + house.dx + house.w - inset, y: cy }
    : { x: center.x + house.dx + inset, y: cy };
  pieces.push({
    id: `furn${scope}_${house.index}_cupboard`,
    kind: "cupboard",
    x: cup.x,
    y: cup.y,
    radius: 0.6,
    facing: faceRoom(cup.x, cup.y),
    openable: true,
  });

  // The table: off room-center toward the door half, leaving the middle
  // (the indoor wander tether's anchor) walkable around it.
  const toward = house.door === "north" ? { x: 0, y: -1 }
    : house.door === "south" ? { x: 0, y: 1 }
    : house.door === "west" ? { x: -1, y: 0 }
    : { x: 1, y: 0 };
  const shift = Math.min(house.w, house.h) * 0.18;
  pieces.push({
    id: `furn${scope}_${house.index}_table`,
    kind: "table",
    x: cx + toward.x * shift,
    y: cy + toward.y * shift,
    radius: 0.8,
    facing: 0,
    openable: false,
  });

  return pieces;
}
