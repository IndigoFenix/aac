// House FURNITURE placement (shared/engine/town/furniture.ts): chests
// and cupboards hug the WALLS (chests in corners), the table earns the
// middle of the room. Pure geometry — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { houseFurniture, type FurniturePiece } from "@shared/engine/town/furniture.js";
import type { TownHouse } from "@shared/engine/town/plan.js";

const center = { x: 100, y: 100 };
const house: TownHouse = {
  index: 0, dx: -6, dy: -5, w: 12, h: 10, door: "south", color: "#a8875f", floors: 1,
};
const x0 = center.x + house.dx;
const x1 = x0 + house.w;
const y0 = center.y + house.dy;
const y1 = y0 + house.h;

/** The four wall gaps: distance from the piece's edge to each wall
 *  (negative ⇒ the piece pokes through that wall). */
function wallGaps(p: FurniturePiece): number[] {
  return [
    p.x - p.radius - x0, // west
    x1 - (p.x + p.radius), // east
    p.y - p.radius - y0, // north
    y1 - (p.y + p.radius), // south
  ];
}
const FLUSH = 0.2; // an edge this close to a wall counts as against it

describe("house furniture: against the walls, in corners", () => {
  const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];
  const pieces = houseFurniture(center, house, goods);

  it("nothing pokes through a wall", () => {
    for (const p of pieces) {
      for (const g of wallGaps(p)) expect(g).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("chests sit flush in CORNERS — against two walls each", () => {
    const chests = pieces.filter(p => p.kind === "chest");
    expect(chests).toHaveLength(2); // one per good, at its own corner
    const corners = new Set<string>();
    for (const c of chests) {
      const gaps = wallGaps(c);
      const against = gaps.filter(g => g <= FLUSH).length;
      expect(against).toBe(2); // a corner touches exactly two walls
      // Its box corner is unique (the two goods don't share a corner).
      corners.add(gaps.map(g => (g <= FLUSH ? "1" : "0")).join(""));
    }
    expect(corners.size).toBe(2);
  });

  it("the cupboard is flush against ONE wall (the wall's middle)", () => {
    const cup = pieces.find(p => p.kind === "cupboard")!;
    const against = wallGaps(cup).filter(g => g <= FLUSH).length;
    expect(against).toBe(1);
    // Opposite the SOUTH door ⇒ against the NORTH wall.
    expect(cup.y - cup.radius - y0).toBeLessThanOrEqual(FLUSH);
  });

  it("the table earns the middle — well clear of every wall", () => {
    const table = pieces.find(p => p.kind === "table")!;
    for (const g of wallGaps(table)) expect(g).toBeGreaterThan(0.5);
  });

  it("is deterministic: same house, same furniture", () => {
    const again = houseFurniture(center, house, goods);
    expect(JSON.stringify(again)).toBe(JSON.stringify(pieces));
  });
});
