// The house SPACE generator (shared/place/house): a believable, puzzle-blind
// floor plan — living hub + hall spine + role rooms + furniture, a TREE rooted
// at the living room, with the affordances the puzzle embedder needs (depth,
// lockability, role affinity, openable/surface fixtures).
//
// Pure geometry — no DB / LLM / GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import { generateHouse } from "@shared/world-engine/place/house.js";
import {
  adjacency,
  isConnected,
  rectsOverlap,
  type PlaceSpace,
} from "@shared/world-engine/place/space.js";

const roleRooms = (s: PlaceSpace) => s.rooms.filter((r) => !r.circulation);

describe("house space generator", () => {
  it("is deterministic — same (roomsNeeded, seed) rebuilds the identical house", () => {
    expect(JSON.stringify(generateHouse(4, 7))).toBe(JSON.stringify(generateHouse(4, 7)));
    // A different seed varies it.
    expect(JSON.stringify(generateHouse(4, 7))).not.toBe(JSON.stringify(generateHouse(4, 8)));
  });

  it("has one entrance living room at depth 0, and is fully connected", () => {
    const s = generateHouse(4, 3);
    expect(s.entranceRoomId).toBe("living");
    const living = s.rooms.find((r) => r.id === "living")!;
    expect(living.kind).toBe("living");
    expect(living.depth).toBe(0);
    expect(isConnected(s)).toBe(true);
  });

  it("is a room TREE that tiles ONE rectangle without overlaps", () => {
    const s = generateHouse(5, 11);
    // Tree: exactly rooms-1 doors (connected + acyclic).
    expect(s.doors.length).toBe(s.rooms.length - 1);
    // No two rooms overlap, and every room sits inside the footprint.
    for (let i = 0; i < s.rooms.length; i++) {
      const a = s.rooms[i]!.rect;
      expect(a.x).toBeGreaterThanOrEqual(-1e-6);
      expect(a.y).toBeGreaterThanOrEqual(-1e-6);
      expect(a.x + a.w).toBeLessThanOrEqual(s.footprint.w + 1e-6);
      expect(a.y + a.h).toBeLessThanOrEqual(s.footprint.h + 1e-6);
      for (let j = i + 1; j < s.rooms.length; j++) {
        expect(rectsOverlap(a, s.rooms[j]!.rect)).toBe(false);
      }
    }
  });

  it("houses at least the rooms the puzzle needs, plus surplus, and scales up", () => {
    const small = generateHouse(1, 2);
    const big = generateHouse(6, 2);
    expect(roleRooms(small).length).toBeGreaterThanOrEqual(1);
    expect(roleRooms(big).length).toBeGreaterThanOrEqual(6);
    // Always richer than a one-giver puzzle: a real home is never just a box.
    expect(roleRooms(small).length).toBeGreaterThanOrEqual(2);
    expect(big.rooms.length).toBeGreaterThan(small.rooms.length);
  });

  it("always has a kitchen, a bath, and at least one bedroom", () => {
    const kinds = new Set(generateHouse(4, 99).rooms.map((r) => r.kind));
    expect(kinds.has("kitchen")).toBe(true);
    expect(kinds.has("bath")).toBe(true);
    expect(kinds.has("bedroom")).toBe(true);
  });

  it("follows a public → private depth gradient (bedrooms deeper than the kitchen)", () => {
    const s = generateHouse(6, 5);
    const kitchen = s.rooms.find((r) => r.kind === "kitchen")!;
    const bedrooms = s.rooms.filter((r) => r.kind === "bedroom");
    // The open-plan kitchen sits shallow (off the living room); bedrooms are
    // private, down the hall (deeper).
    for (const bed of bedrooms) expect(bed.depth).toBeGreaterThan(kitchen.depth);
    // A big house grows a genuinely deep, private spot (an ensuite behind a
    // bedroom) — where a strong gate can hide.
    const maxDepth = Math.max(...s.rooms.map((r) => r.depth));
    expect(maxDepth).toBeGreaterThanOrEqual(3);
  });

  it("tags doors by how plausibly they can be locked", () => {
    const s = generateHouse(5, 8);
    const byId = new Map(s.rooms.map((r) => [r.id, r]));
    for (const d of s.doors) {
      const deeper = byId.get(d.b)!;
      if (deeper.kind === "bedroom") {
        expect(d.lockability).toBeGreaterThanOrEqual(0.7); // a bedroom door locks naturally
      }
      // Circulation is never a plausible lock (you don't wall off your own hall).
      if (byId.get(d.a)!.circulation && deeper.circulation) {
        expect(d.lockability).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it("furnishes rooms with things to open and surfaces to see on", () => {
    const s = generateHouse(5, 4);
    const fixtures = s.rooms.flatMap((r) => r.fixtures);
    expect(fixtures.some((f) => f.openable)).toBe(true); // a drawer to hide a clue in
    expect(fixtures.some((f) => f.surface)).toBe(true); // a table to leave a toy on
    // Circulation carries no role content; every role room is furnished.
    for (const r of roleRooms(s)) expect(r.fixtures.length).toBeGreaterThan(0);
  });

  it("gives every private room an affinity for the content that belongs there", () => {
    const s = generateHouse(5, 6);
    const kitchen = s.rooms.find((r) => r.kind === "kitchen")!;
    expect(kitchen.affinity).toContain("food");
    for (const r of roleRooms(s)) expect(r.affinity.length).toBeGreaterThan(0);
  });

  it("keeps the door graph a spanning tree over the rooms (adjacency)", () => {
    const s = generateHouse(6, 13);
    const adj = adjacency(s);
    // Every room has at least one door; the living hub has several.
    for (const r of s.rooms) expect((adj.get(r.id) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((adj.get("living") ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
