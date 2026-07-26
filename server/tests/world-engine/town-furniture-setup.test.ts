// DELIVERED-FURNITURE SETUP (construction pipeline ⑥ visuals) + the wood glyph,
// at the pure layer. A furniture piece placed but not yet assembled carries a
// `setUp: false` flag that the geometry driver seeds through onto its
// FurniturePiece (the renderer stands the real model on its side); standing it
// up flips the flag on the delta. Generic over every kind — the flag drives it,
// no per-kind code. Plus: the "wood" product glyph resolves to the wood-log
// emoji. No DOM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  createTownDeltas,
  markPieceSetUp,
  placeFurniture,
} from "@shared/world-engine/kernel/town/construction.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";
import { resolveEmoji } from "@shared/emoji-registry.js";

const center = { x: 200, y: 200 };
const HOUSE: TownHouse = {
  index: 0, dx: -4, dy: -4, w: 8, h: 8, door: "south", color: "#a8875f", floors: 1,
};
const goods = [{ key: "food", slot: 0 }, { key: "cloth", slot: 1 }];

/** A chair delivered into the living room, not yet set up. */
const delivered = () => ({
  id: "furn_0_p0", kind: "chair" as const, x: center.x, y: center.y,
  radius: 0.22, facing: 0, openable: false, roomId: "h0_r0", setUp: false,
});

describe("delivered furniture exposes a TIPPED flag through the geometry driver", () => {
  it("a placed setUp:false piece seeds a FurniturePiece with setUp:false", () => {
    const deltas = createTownDeltas();
    placeFurniture(deltas, "h_0", delivered());
    const piece = houseFurniture(center, HOUSE, goods, "", deltas.get("h_0")).find(
      (p) => p.id === "furn_0_p0",
    );
    expect(piece).toBeDefined();
    expect(piece!.setUp).toBe(false);
  });

  it("GENERATED stations carry no setUp — absent reads as set up (upright)", () => {
    const pieces = houseFurniture(center, HOUSE, goods);
    expect(pieces.length).toBeGreaterThan(0);
    for (const p of pieces) expect(p.setUp).toBeUndefined();
  });

  it("markPieceSetUp stands the piece up — the flag flips true, once", () => {
    const deltas = createTownDeltas();
    placeFurniture(deltas, "h_0", delivered());
    const v0 = deltas.version;
    expect(markPieceSetUp(deltas, "h_0", "furn_0_p0")).toBe(true);
    expect(deltas.version).toBeGreaterThan(v0); // a real transition bumped the rev
    const piece = houseFurniture(center, HOUSE, goods, "", deltas.get("h_0")).find(
      (p) => p.id === "furn_0_p0",
    );
    expect(piece!.setUp).toBe(true);
    // Idempotent: a second call is a no-op (no spurious refurnish).
    const v1 = deltas.version;
    expect(markPieceSetUp(deltas, "h_0", "furn_0_p0")).toBe(false);
    expect(deltas.version).toBe(v1);
  });

  it("markPieceSetUp is a no-op for an unknown piece", () => {
    const deltas = createTownDeltas();
    const v0 = deltas.version;
    expect(markPieceSetUp(deltas, "h_0", "nope")).toBe(false);
    expect(deltas.version).toBe(v0);
  });

  it("the flag survives a delta serialization round-trip", () => {
    const deltas = createTownDeltas();
    placeFurniture(deltas, "h_0", delivered());
    const reloaded = createTownDeltas(deltas.toJSON());
    const piece = reloaded.get("h_0")!.placed.find((p) => p.id === "furn_0_p0");
    expect(piece!.setUp).toBe(false);
  });
});

describe("the wood glyph resolves to the wood-log emoji", () => {
  it("resolveEmoji('wood') is the log", () => {
    expect(resolveEmoji("wood")).toBe("🪵");
  });
});
