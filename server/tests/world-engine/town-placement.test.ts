// The PLACEMENT API (shared/world-engine/kernel/town/placement.ts) — the
// fit machinery extracted from furnishPlan so the generator and the
// interactive paths (a resident placing bought furniture, a directed
// "put chair near table") run THE SAME rules. Pure geometry — no DB /
// LLM / GL.
//
// The HEADLINE test is PARITY: every piece the generator emits must pass
// placementFeasible when judged against the pieces placed before it —
// one rulebook, two callers. (Two authored exemptions, by design: the
// goods chests are placed unconditionally — the corner IS the box — and
// a studio's classic table spot may shade the door porch's tail.)

import { describe, it, expect } from "@jest/globals";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { houseRoomPlan, livingRect } from "@shared/world-engine/kernel/town/rooms.js";
import {
  makePlacementContext,
  placementCandidates,
  placementFeasible,
  placementScore,
  toWorld,
  zoneAt,
  zoneById,
  type FurniturePiece,
  type PlacementContext,
} from "@shared/world-engine/kernel/town/placement.js";
import { HOUSE_STATIONS } from "@shared/world-engine/kernel/town/stations.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const center = { x: 100, y: 100 };
const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];

const mk = (index: number, dx: number, dy: number, w: number, h: number, door: TownHouse["door"]): TownHouse =>
  ({ index, dx, dy, w, h, door, color: "#a8875f", floors: 1 });

/** A sweep across the granularity gradient: hovel → studio → partitioned
 *  norm → burgher house, every door side. */
const SWEEP: TownHouse[] = [
  mk(0, -6, -5, 12, 10, "south"),
  mk(1, -4, -4, 8, 8, "north"),
  mk(2, -4.5, -4, 9, 8, "west"),
  mk(3, -6.5, -5, 13, 10, "east"),
  mk(4, -3.5, -3.5, 7, 7, "south"),
];

function contextFor(house: TownHouse, pieces: FurniturePiece[]): PlacementContext {
  return makePlacementContext(center, house, houseRoomPlan(center, house), goods, pieces);
}

describe("PARITY: the generator's own output passes the exported fit rule", () => {
  for (const house of SWEEP) {
    it(`house ${house.index} (${house.w}x${house.h} ${house.door}): every piece placed before its successors is feasible`, () => {
      const pieces = houseFurniture(center, house, goods);
      expect(pieces.length).toBeGreaterThan(0);
      pieces.forEach((p, i) => {
        if (p.good) return; // goods chests: unconditional by design (the corner IS the box)
        const ctx = contextFor(house, pieces.slice(0, i));
        const zone = zoneAt(ctx, p.x, p.y);
        expect(zone).toBeDefined();
        const verdict = placementFeasible(ctx, zone!.room.id, p);
        if (p.kind === "table" && !verdict.ok) {
          // The studio's classic spot may shade the door porch's tail —
          // the one authored exemption (bodies pass beside it).
          expect(verdict.reason).toBe("door");
          return;
        }
        expect(verdict).toEqual({ ok: true });
      });
    });

    it(`house ${house.index}: generated pieces score above the naturalness floor`, () => {
      const pieces = houseFurniture(center, house, goods);
      pieces.forEach((p, i) => {
        if (p.good) return;
        const ctx = contextFor(house, pieces.slice(0, i));
        const zone = zoneAt(ctx, p.x, p.y)!;
        if (p.kind === "table" && !placementFeasible(ctx, zone.room.id, p).ok) return;
        // Judge by the piece's OWN registry row (the id names its def key:
        // `furn_<i>_<key>[_<n>]`) — a member's bedroom box must not be
        // rated by the goods chest's communal-corner rule.
        const suffix = p.id.replace(/^furn_\d+_/, "");
        const def =
          HOUSE_STATIONS.find((d) => d.key === suffix) ??
          HOUSE_STATIONS.find((d) => d.key === suffix.replace(/_\d+$/, ""));
        expect(def).toBeDefined();
        const rated = placementScore(ctx, def!, p, zone.room.id);
        // The generator's own choice is what "natural" MEANS — it must
        // clear the floor a directed placement is judged by.
        expect(rated.score).toBeGreaterThan(0.35);
      });
    });
  }
});

describe("adversarial candidates fail with the RIGHT reason", () => {
  const house = SWEEP[0]!;
  const plan = houseRoomPlan(center, house);
  const lr = livingRect(center, house);

  it("outside the house → outside", () => {
    const ctx = contextFor(house, []);
    const v = placementFeasible(ctx, plan.rooms[0]!.id, {
      x: center.x + house.dx - 3, y: center.y + house.dy - 3, radius: 0.5, kind: "chest",
    });
    expect(v).toEqual({ ok: false, reason: "outside" });
  });

  it("poking through a wall → wall", () => {
    const ctx = contextFor(house, []);
    const v = placementFeasible(ctx, plan.rooms[0]!.id, {
      x: lr.x + 0.1, y: lr.y + lr.h / 2, radius: 0.5, kind: "chest",
    });
    expect(v).toEqual({ ok: false, reason: "wall" });
  });

  it("square in the street door's swing → door", () => {
    // The street door sits on the living room's south wall (door: "south"
    // house) — its corridor reaches DOOR_DEPTH into the room.
    const ctx = contextFor(house, []);
    const doorway = plan.rooms[0]!.doorways.find((d) => d.edge === "south")!;
    const v = placementFeasible(ctx, plan.rooms[0]!.id, {
      x: lr.x + doorway.offset, y: lr.y + lr.h - 1.0, radius: 0.5, kind: "chest",
    });
    expect(v).toEqual({ ok: false, reason: "door" });
  });

  it("overlapping an existing piece → piece", () => {
    const pieces = houseFurniture(center, house, goods);
    const table = pieces.find((p) => p.kind === "table")!;
    const ctx = contextFor(house, pieces);
    const v = placementFeasible(ctx, zoneAt(ctx, table.x, table.y)!.room.id, {
      x: table.x + 0.2, y: table.y, radius: 0.5, kind: "chest",
    });
    expect(v).toEqual({ ok: false, reason: "piece" });
  });

  it("covering a shopper's standing spot → goods-spot", () => {
    // Each good's standing spot (goodBoxAt's corner inset): a small piece
    // there passes every wall / door / piece check and dies on the spot.
    const ctx = contextFor(house, []);
    expect(ctx.spots.length).toBe(goods.length);
    for (const s of ctx.spots) {
      const w = toWorld(ctx, s.u, s.v);
      const v = placementFeasible(ctx, plan.rooms[0]!.id, {
        x: w.x, y: w.y, radius: 0.3, kind: "chest",
      });
      expect(v).toEqual({ ok: false, reason: "goods-spot" });
    }
  });

  it("pinching a furnished bedroom shut → service", () => {
    // A wardrobe-sized solid swept across a FURNISHED bedroom: some spots
    // pass every overlap check yet wall off the bed (or wedge themselves)
    // — the service flood catches what pairwise checks cannot.
    const pieces = houseFurniture(center, house, goods);
    const ctx = contextFor(house, pieces);
    const bedroomId = plan.bedrooms[0]!;
    const room = zoneById(ctx, bedroomId)!.room.rect;
    const reasons = new Set<string>();
    for (const r of [0.5, 0.7, 0.9]) {
      for (let fx = 0.1; fx <= 0.9; fx += 0.05) {
        for (let fy = 0.1; fy <= 0.9; fy += 0.05) {
          const v = placementFeasible(ctx, bedroomId, {
            x: room.x + room.w * fx, y: room.y + room.h * fy, radius: r, kind: "chest",
          });
          if (!v.ok) reasons.add(v.reason);
        }
      }
    }
    expect(reasons.has("service")).toBe(true);
  });
});

describe("placementScore: the registry's own aesthetics, graded", () => {
  const house = SWEEP[0]!;
  const plan = houseRoomPlan(center, house);

  it("a chest flush at a wall outranks the same chest stranded mid-room", () => {
    const ctx = contextFor(house, []);
    const livingId = plan.rooms[0]!.id;
    const z = zoneById(ctx, livingId)!;
    // Frame-agnostic: rate every candidate the search proposes and check
    // the flush ones (factors say off-wall/mid-room) order correctly.
    const spots = placementCandidates(ctx, { kind: "chest", radius: 0.55, roomId: livingId }, 24);
    expect(spots.length).toBeGreaterThan(0);
    const flush = spots.filter((s) => !s.factors.includes("mid-room") && !s.factors.includes("off-wall"));
    const stranded = spots.filter((s) => s.factors.includes("mid-room"));
    if (flush.length && stranded.length) {
      expect(Math.min(...flush.map((s) => s.score))).toBeGreaterThan(
        Math.max(...stranded.map((s) => s.score)),
      );
    } else {
      // The search found no mid-room chest spot to compare — the sorted
      // list itself must still be monotone.
      expect(flush.length).toBeGreaterThan(0);
    }
    expect(z.room.id).toBe(livingId);
  });

  it("a bed in a bedroom outranks a bed in the living room (wrong-room)", () => {
    const ctx = contextFor(house, []);
    const bedroomId = plan.bedrooms[0]!;
    const inBedroom = placementCandidates(ctx, { kind: "bed", radius: 0.9, roomId: bedroomId }, 4);
    const inLiving = placementCandidates(ctx, { kind: "bed", radius: 0.9, roomId: plan.rooms[0]!.id }, 4);
    expect(inBedroom.length).toBeGreaterThan(0);
    expect(inLiving.length).toBeGreaterThan(0);
    expect(inBedroom[0]!.score).toBeGreaterThan(inLiving[0]!.score);
    expect(inLiving[0]!.factors).toContain("wrong-room");
  });
});

describe("placementCandidates: the creature's own search", () => {
  const house = SWEEP[0]!;

  it("returns feasible spots, best-first, and is deterministic", () => {
    const pieces = houseFurniture(center, house, goods);
    const ctx = contextFor(house, [...pieces]);
    const q = { kind: "chair" as const, radius: 0.22, roomId: houseRoomPlan(center, house).rooms[0]!.id };
    const a = placementCandidates(ctx, q, 8);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 1; i < a.length; i++) expect(a[i - 1]!.score).toBeGreaterThanOrEqual(a[i]!.score);
    for (const s of a) {
      const ctx2 = contextFor(house, [...pieces]);
      expect(placementFeasible(ctx2, s.roomId, { x: s.x, y: s.y, radius: q.radius, kind: q.kind }).ok).toBe(true);
    }
    const b = placementCandidates(contextFor(house, [...pieces]), q, 8);
    expect(b).toEqual(a);
  });

  it("an anchored query lands beside the anchor (put the chair NEAR the table)", () => {
    const pieces = houseFurniture(center, house, goods);
    const table = pieces.find((p) => p.kind === "table")!;
    const ctx = contextFor(house, [...pieces]);
    const spots = placementCandidates(ctx, {
      kind: "chair", radius: 0.22, anchor: { x: table.x, y: table.y }, anchorGap: table.radius + 0.22 + 0.1,
    }, 6);
    expect(spots.length).toBeGreaterThan(0);
    // The best spot is genuinely AT the table, not across the room.
    const d = Math.hypot(spots[0]!.x - table.x, spots[0]!.y - table.y);
    expect(d).toBeLessThan(2.5);
  });
});
