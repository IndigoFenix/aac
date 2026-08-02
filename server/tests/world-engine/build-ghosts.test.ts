// WHERE THE BLOCKS ARE GOING (construction phase 6 — build-ghosts.ts). A
// construction site used to be a rectangle with a clock on it: nothing said
// what would stand there, how much was paid for, or whether it was stuck. The
// ghosts are the BILL OF MATERIALS drawn in place — one outline per bay, in
// build order, coloured by what is holding each one up. These tests pin the
// layout against the bill it must agree with, and the fill rule. No DOM/GL.

import { describe, it, expect } from "@jest/globals";
import {
  freeEdgesOf,
  paintGhosts,
  shellGhostPieces,
  sharedEdgeWith,
  type GhostPiece,
} from "@shared/world-engine/kernel/town/build-ghosts.js";
import {
  BLOCKS_PER_BAY,
  annexBill,
  baysAcross,
  partitionBill,
  shellBill,
} from "@shared/world-engine/kernel/town/block-bill.js";

const RECT = { x: 10, y: -4, w: 9, h: 8 };
const sum = (ps: readonly GhostPiece[]): number => ps.reduce((n, p) => n + p.blocks, 0);

describe("the ghosts ARE the bill", () => {
  it("a shell's pieces add up to exactly what the shell costs", () => {
    // THE invariant of the whole feature: if these two ever disagree, the
    // outlines are decoration and counting them tells the player nothing.
    const pieces = shellGhostPieces("g", RECT);
    expect(sum(pieces)).toBe(shellBill({ w: RECT.w, h: RECT.h }).total);
  });

  it("one piece per bay of each surface", () => {
    const pieces = shellGhostPieces("g", RECT);
    const of = (k: GhostPiece["kind"]): GhostPiece[] => pieces.filter((p) => p.kind === k);
    const bill = shellBill({ w: RECT.w, h: RECT.h });
    expect(of("floor")).toHaveLength(bill.floorBays);
    expect(of("roof")).toHaveLength(bill.roofBays);
    expect(of("wall")).toHaveLength(bill.wallBays);
    for (const p of of("wall")) expect(p.blocks).toBe(BLOCKS_PER_BAY.wall);
  });

  it("ids are unique — a ghost is keyed by identity, and the fill re-keys on state", () => {
    const ids = shellGhostPieces("g", RECT).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("floor, then walls, then roof — the order a builder works in", () => {
    const kinds = shellGhostPieces("g", RECT).map((p) => p.kind);
    expect(kinds.indexOf("floor")).toBe(0);
    expect(kinds.lastIndexOf("floor")).toBeLessThan(kinds.indexOf("wall"));
    expect(kinds.lastIndexOf("wall")).toBeLessThan(kinds.indexOf("roof"));
  });
});

describe("the pieces stand where the building will", () => {
  it("floor bays tile the footprint and stay inside it", () => {
    const floor = shellGhostPieces("g", RECT).filter((p) => p.kind === "floor");
    let area = 0;
    for (const p of floor) {
      area += p.w * p.h;
      expect(p.x - p.w / 2).toBeGreaterThanOrEqual(RECT.x - 1e-9);
      expect(p.x + p.w / 2).toBeLessThanOrEqual(RECT.x + RECT.w + 1e-9);
      expect(p.y - p.h / 2).toBeGreaterThanOrEqual(RECT.y - 1e-9);
      expect(p.y + p.h / 2).toBeLessThanOrEqual(RECT.y + RECT.h + 1e-9);
    }
    expect(area).toBeCloseTo(RECT.w * RECT.h, 6);
  });

  it("wall bays sit ON the perimeter lines, running along their own edge", () => {
    const walls = shellGhostPieces("g", RECT).filter((p) => p.kind === "wall");
    for (const p of walls) {
      const onVertical = Math.abs(p.x - RECT.x) < 1e-9 || Math.abs(p.x - (RECT.x + RECT.w)) < 1e-9;
      const onHorizontal = Math.abs(p.y - RECT.y) < 1e-9 || Math.abs(p.y - (RECT.y + RECT.h)) < 1e-9;
      expect(onVertical || onHorizontal).toBe(true);
      // A run along +y is a quarter turn from a run along +x — GAME angles.
      expect(p.facing === 0 || Math.abs(p.facing! - Math.PI / 2) < 1e-9).toBe(true);
      if (onVertical && !onHorizontal) expect(p.facing).toBeCloseTo(Math.PI / 2, 9);
    }
  });
});

describe("a room's ghosts match the room's own bill", () => {
  it("an annex skips the wall it shares — and the count follows the bill", () => {
    const rect = { x: 0, y: 0, w: 6, h: 3.5 };
    const house = { x: 0, y: -8, w: 9, h: 8 }; // sits to the NORTH of the annex
    const edge = sharedEdgeWith(rect, house);
    expect(edge).toBe("north");
    const pieces = shellGhostPieces("a", rect, { skipWall: [edge] });
    const bill = annexBill({ u0: 0, u1: 6, v0: 0, v1: 3.5, side: "rear" });
    expect(sum(pieces)).toBe(bill.total);
    // Nothing drawn on the shared line — that wall is already standing.
    expect(pieces.some((p) => p.kind === "wall" && Math.abs(p.y - rect.y) < 1e-9)).toBe(false);
  });

  it("sharedEdgeWith finds the abutting side from ANY direction", () => {
    const rect = { x: 0, y: 0, w: 6, h: 4 };
    expect(sharedEdgeWith(rect, { x: 0, y: 6, w: 9, h: 8 })).toBe("south");
    expect(sharedEdgeWith(rect, { x: -10, y: 0, w: 9, h: 8 })).toBe("west");
    expect(sharedEdgeWith(rect, { x: 10, y: 0, w: 9, h: 8 })).toBe("east");
  });

  it("an interior cut draws ONE partition — no floor, no roof, no outer wall", () => {
    // Flush on north, west and east; the free edge is the cut line.
    const host = { x: 0, y: 0, w: 8, h: 6 };
    const cut = { x: 0, y: 0, w: 8, h: 2.5 };
    const free = freeEdgesOf(cut, host);
    expect(free).toEqual(["south"]);
    const pieces = shellGhostPieces("i", cut, { wallsOnly: true, onlyWall: free });
    expect(pieces.every((p) => p.kind === "wall")).toBe(true);
    expect(sum(pieces)).toBe(partitionBill({ u0: 0, u1: 8, v0: 0, v1: 2.5 }).total);
    expect(pieces).toHaveLength(baysAcross(8));
  });

  it("freeEdgesOf tolerates the float noise two independent rect computations leave", () => {
    const host = { x: 0, y: 0, w: 8, h: 6 };
    const cut = { x: 1e-9, y: -2e-9, w: 8, h: 2.5 };
    expect(freeEdgesOf(cut, host)).toEqual(["south"]);
  });
});

describe("paintGhosts — the fill is the pile", () => {
  const pieces = shellGhostPieces("g", RECT);
  const total = sum(pieces);

  it("an empty pile with a chain running is all pending", () => {
    const out = paintGhosts(pieces, { staged: 0, supplying: true });
    expect(out.every((p) => p.state === "pending")).toBe(true);
  });

  it("an empty pile with NOTHING reachable is blocked — the state that wants you", () => {
    const out = paintGhosts(pieces, { staged: 0, supplying: false });
    expect(out.every((p) => p.state === "blocked")).toBe(true);
  });

  it("a covered bill is entirely claimed", () => {
    const out = paintGhosts(pieces, { staged: total, supplying: true });
    expect(out.every((p) => p.state === "claimed")).toBe(true);
  });

  it("fills in build order — a prefix is claimed, the rest is not", () => {
    const out = paintGhosts(pieces, { staged: BLOCKS_PER_BAY.floor * 3, supplying: true });
    const firstUnclaimed = out.findIndex((p) => p.state !== "claimed");
    expect(firstUnclaimed).toBe(3);
    expect(out.slice(0, 3).every((p) => p.state === "claimed")).toBe(true);
    expect(out.slice(3).every((p) => p.state === "pending")).toBe(true);
  });

  it("a HALF-paid bay is not claimed — a half-paid wall is not a wall", () => {
    const out = paintGhosts(pieces, { staged: BLOCKS_PER_BAY.floor - 1, supplying: true });
    expect(out[0]!.state).toBe("pending");
  });

  it("an explicitly blocked piece stays blocked however full the pile is", () => {
    const out = paintGhosts(pieces, {
      staged: total,
      supplying: true,
      blocked: new Set([pieces[2]!.id]),
    });
    expect(out[2]!.state).toBe("blocked");
    expect(out[0]!.state).toBe("claimed");
  });

  it("never mutates or reorders the pieces it paints", () => {
    const before = JSON.parse(JSON.stringify(pieces));
    const out = paintGhosts(pieces, { staged: 12, supplying: true });
    expect(pieces).toEqual(before);
    expect(out.map((p) => p.id)).toEqual(pieces.map((p) => p.id));
  });

  it("a nonsense negative pile is treated as empty, not as credit", () => {
    const out = paintGhosts(pieces, { staged: -50, supplying: true });
    expect(out.every((p) => p.state === "pending")).toBe(true);
  });
});
