// THE CONSTRUCTION OVERLAY (shared/world-engine/kernel/town/construction.ts):
// the one mutable geometry state a town carries — annexes, demolitions,
// placed/stowed furniture — consumed by the pure generators as INPUT.
// Pins: determinism (same base + same delta ⇒ identical plan, JSON
// round-trip included), THE LIVING-ROOM INVARIANT, prefix stability
// (untouched rooms keep their exact rects), and the request-time
// validation reasons. Pure geometry — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  ANNEX_CLEARANCE,
  ANNEX_DEPTH_CAP,
  MAX_ANNEXES,
  annexOptions,
  annexWorldRect,
  createTownDeltas,
  demolishRoom,
  deltaIsEmpty,
  emptyDelta,
  nextPlacedSerial,
  placeFurniture,
  removePlacedPiece,
  requestAnnex,
  seedFoundingWorkshops,
  stowGeneratedPiece,
  type AnnexCandidate,
} from "@shared/world-engine/kernel/town/construction.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import { frameDims, houseRoomPlan, livingRect } from "@shared/world-engine/kernel/town/rooms.js";
import {
  makePlacementContext,
  placementCandidates,
  placementFeasible,
  zoneAt,
} from "@shared/world-engine/kernel/town/placement.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const center = { x: 100, y: 100 };
const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];
const house: TownHouse = {
  index: 0, dx: -6, dy: -5, w: 12, h: 10, door: "south", color: "#a8875f", floors: 1,
};

const basePlan = () => houseRoomPlan(center, house);

describe("TownDeltas: the overlay store", () => {
  it("mutate bumps the building rev and the store version", () => {
    const deltas = createTownDeltas();
    expect(deltas.version).toBe(0);
    deltas.mutate("h_0", (d) => d.placed.push({
      id: "furn_0_p0", kind: "chair", x: 0, y: 0, radius: 0.22, facing: 0, openable: false, roomId: "h_0",
    }));
    expect(deltas.version).toBe(1);
    expect(deltas.get("h_0")!.rev).toBe(1);
    deltas.mutate("h_0", () => {});
    expect(deltas.get("h_0")!.rev).toBe(2);
    expect(deltas.version).toBe(2);
  });

  it("JSON round-trip reproduces the identical delta-applied plan", () => {
    const deltas = createTownDeltas();
    const opts = annexOptions(center, house, basePlan(), [], deltas.get("h_0"), "sleep");
    expect(opts.length).toBeGreaterThan(0);
    expect(requestAnnex(deltas, "h_0", opts[0]!)).toEqual({ ok: true });

    const restored = createTownDeltas(deltas.toJSON());
    const a = houseRoomPlan(center, house, deltas.get("h_0"));
    const b = houseRoomPlan(center, house, restored.get("h_0"));
    expect(b).toEqual(a);
  });

  it("deltaIsEmpty / emptyDelta agree", () => {
    expect(deltaIsEmpty(undefined)).toBe(true);
    expect(deltaIsEmpty(emptyDelta())).toBe(true);
    const d = emptyDelta();
    d.removedPieces.push("furn_0_bin");
    expect(deltaIsEmpty(d)).toBe(false);
  });
});

describe("annexOptions: feasibility inside the candidate test", () => {
  it("a house with a free back garden offers rear candidates within the depth cap", () => {
    const opts = annexOptions(center, house, basePlan(), [], undefined, "sleep");
    expect(opts.length).toBeGreaterThan(0);
    for (const c of opts) {
      if (c.side === "rear") expect(c.v1).toBeLessThanOrEqual(ANNEX_DEPTH_CAP);
      // The door berths into a real room of the plan.
      expect(basePlan().rooms.some((r) => r.id === c.doorInto)).toBe(true);
    }
  });

  it("a neighbor pressed against the rear kills the rear candidates", () => {
    const all = annexOptions(center, house, basePlan(), [], undefined, "store");
    const rear = all.filter((c) => c.side === "rear");
    expect(rear.length).toBeGreaterThan(0);
    // South-door house: rear = north side (y decreasing). Wall the whole
    // north garden off with a neighbor slab just past the footprint.
    const slab = { x: center.x + house.dx - 20, y: center.y + house.dy - 6, w: 52, h: 6 };
    const blocked = annexOptions(center, house, basePlan(), [slab], undefined, "store");
    for (const c of blocked.filter((q) => q.side === "rear")) {
      const w = annexWorldRect(center, house, c);
      const gap = Math.max(
        slab.y - (w.y + w.h),
        w.y - (slab.y + slab.h),
        slab.x - (w.x + w.w),
        w.x - (slab.x + slab.w),
      );
      expect(gap).toBeGreaterThanOrEqual(ANNEX_CLEARANCE - 1e-9);
    }
  });

  it("the annex cap closes the option list", () => {
    const deltas = createTownDeltas();
    for (let i = 0; i < MAX_ANNEXES; i++) {
      const plan = houseRoomPlan(center, house, deltas.get("h_0"));
      const opts = annexOptions(center, house, plan, [], deltas.get("h_0"), i % 2 ? "store" : "sleep");
      if (!opts.length) break; // the lot ran out of ground first — also legal
      expect(requestAnnex(deltas, "h_0", opts[0]!)).toEqual({ ok: true });
    }
    const d = deltas.get("h_0")!;
    if (d.annexes.length >= MAX_ANNEXES) {
      expect(annexOptions(center, house, houseRoomPlan(center, house, d), [], d, "sleep")).toEqual([]);
      expect(requestAnnex(deltas, "h_0", {
        side: "rear", cluster: "sleep", u0: 0, u1: 3, v0: 10, v1: 13,
        doorInto: "h_0", doorAt: { u: 1.5, v: 10, width: 1.8 },
      } as AnnexCandidate)).toEqual({ ok: false, reason: "cap" });
    }
  });
});

describe("applyDelta: annexes join the plan, the base stays put", () => {
  const built = () => {
    const deltas = createTownDeltas();
    const opts = annexOptions(center, house, basePlan(), [], undefined, "sleep");
    expect(opts.length).toBeGreaterThan(0);
    expect(requestAnnex(deltas, "h_0", opts[0]!)).toEqual({ ok: true });
    return { deltas, plan: houseRoomPlan(center, house, deltas.get("h_0")) };
  };

  it("the annex room exists, doored and reachable (finite depth)", () => {
    const { plan } = built();
    const annex = plan.rooms.find((r) => r.id === "h_0_a0");
    expect(annex).toBeDefined();
    expect(annex!.kind).toBe("bedroom");
    expect(annex!.doorways.length).toBeGreaterThan(0);
    expect(Number.isFinite(annex!.depth)).toBe(true);
    expect(annex!.depth).toBeGreaterThan(0);
    expect(plan.bedrooms).toContain("h_0_a0");
  });

  it("THE LIVING-ROOM INVARIANT: rooms[0] byte-equal to the base; untouched rooms keep their rects", () => {
    const base = basePlan();
    const { plan } = built();
    expect(plan.rooms[0]!.rect).toEqual(base.rooms[0]!.rect);
    expect(plan.rooms[0]!.id).toBe(base.rooms[0]!.id);
    expect(livingRect(center, house)).toEqual(base.rooms[0]!.rect); // goods stay delta-blind
    for (const r of base.rooms) {
      const after = plan.rooms.find((q) => q.id === r.id);
      expect(after).toBeDefined();
      expect(after!.rect).toEqual(r.rect); // prefix stability — no room teleports
    }
  });

  it("the annex rect sits flush past the footprint, inside the world", () => {
    const { deltas } = built();
    const a = deltas.get("h_0")!.annexes[0]!;
    const { D } = frameDims(house);
    if (a.side === "rear") expect(a.v0).toBeCloseTo(D, 9);
    const w = annexWorldRect(center, house, a);
    expect(w.w).toBeGreaterThan(0);
    expect(w.h).toBeGreaterThan(0);
  });

  it("furniture generates INTO a kitchen annex (the stove moves off the hearth wall)", () => {
    // The 12×10 house realizes its full sleep demand already, so a fourth
    // bedroom honestly gets no furniture (no station names sleep index 3).
    // A KITCHEN annex is the telling case: the base plan has no kitchen
    // cell (the stove stands in the living room), and the kitchen-cluster
    // stations seek their cell wherever it lands — including an annex.
    const deltas = createTownDeltas();
    const opts = annexOptions(center, house, basePlan(), [], undefined, "kitchen");
    expect(opts.length).toBeGreaterThan(0);
    expect(requestAnnex(deltas, "h_0", opts[0]!)).toEqual({ ok: true });
    const delta = deltas.get("h_0")!;
    const plan = houseRoomPlan(center, house, delta);
    const annex = plan.rooms.find((r) => r.id === "h_0_a0")!;
    expect(annex.kind).toBe("kitchen");
    const pieces = houseFurniture(center, house, goods, "", delta);
    const stove = pieces.find((p) => p.kind === "oven")!;
    expect(stove).toBeDefined();
    const inAnnex = (p: { x: number; y: number }): boolean =>
      p.x >= annex.rect.x && p.x <= annex.rect.x + annex.rect.w &&
      p.y >= annex.rect.y && p.y <= annex.rect.y + annex.rect.h;
    expect(inAnnex(stove)).toBe(true);
  });
});

describe("demolishRoom: what may come down, and what it says", () => {
  it("the living room refuses", () => {
    const deltas = createTownDeltas();
    const r = demolishRoom(deltas, "h_0", basePlan(), "h_0");
    expect(r).toEqual({ ok: false, reason: "living" });
    expect(deltaIsEmpty(deltas.get("h_0"))).toBe(true);
  });

  it("an unknown room refuses", () => {
    const deltas = createTownDeltas();
    expect(demolishRoom(deltas, "h_0", basePlan(), "h_0_r9")).toEqual({ ok: false, reason: "no-room" });
  });

  it("an annex demolishes by spec removal — the footprint shrinks back to base", () => {
    const deltas = createTownDeltas();
    const opts = annexOptions(center, house, basePlan(), [], undefined, "store");
    expect(requestAnnex(deltas, "h_0", opts[0]!)).toEqual({ ok: true });
    const withAnnex = houseRoomPlan(center, house, deltas.get("h_0"));
    expect(withAnnex.rooms.some((r) => r.id === "h_0_a0")).toBe(true);
    const r = demolishRoom(deltas, "h_0", withAnnex, "h_0_a0");
    expect(r.ok).toBe(true);
    const after = houseRoomPlan(center, house, deltas.get("h_0"));
    expect(after.rooms.map((q) => q.id)).toEqual(basePlan().rooms.map((q) => q.id));
  });

  it("placed pieces in the demolished room come back as stowed stacks", () => {
    const deltas = createTownDeltas();
    const opts = annexOptions(center, house, basePlan(), [], undefined, "store");
    expect(requestAnnex(deltas, "h_0", opts[0]!)).toEqual({ ok: true });
    const plan = houseRoomPlan(center, house, deltas.get("h_0"));
    const annex = plan.rooms.find((r) => r.id === "h_0_a0")!;
    placeFurniture(deltas, "h_0", {
      id: "furn_0_p0", kind: "chair",
      x: annex.rect.x + annex.rect.w / 2, y: annex.rect.y + annex.rect.h / 2,
      radius: 0.22, facing: 0, openable: false, roomId: "h_0_a0",
    });
    const r = demolishRoom(deltas, "h_0", houseRoomPlan(center, house, deltas.get("h_0")), "h_0_a0");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stowed).toEqual({ chair: 1 });
    expect(deltas.get("h_0")!.placed).toEqual([]);
  });
});

describe("placed + stowed furniture through the generator", () => {
  it("a placed piece is seeded and the generated set fits around it", () => {
    const deltas = createTownDeltas();
    // Find a genuinely feasible spot in the empty living room first.
    const plan = basePlan();
    const ctx = makePlacementContext(center, house, plan, goods);
    const spot = placementCandidates(ctx, { kind: "chest", radius: 0.5, roomId: plan.rooms[0]!.id }, 1)[0]!;
    expect(spot).toBeDefined();
    placeFurniture(deltas, "h_0", {
      id: `furn_0_p${nextPlacedSerial(deltas.get("h_0"))}`, kind: "chest",
      x: spot.x, y: spot.y, radius: 0.5, facing: spot.facing, openable: true, roomId: spot.roomId,
    });
    const pieces = houseFurniture(center, house, goods, "", deltas.get("h_0"));
    const placed = pieces.find((p) => p.id === "furn_0_p0");
    expect(placed).toBeDefined();
    // Every generated piece keeps daylight from the placed fact.
    const ctx2 = makePlacementContext(center, house, plan, goods, []);
    for (const p of pieces) {
      if (p.id === "furn_0_p0" || p.good) continue;
      const zone = zoneAt(ctx2, p.x, p.y)!;
      void zone;
      const dx = Math.abs(p.x - placed!.x);
      const dy = Math.abs(p.y - placed!.y);
      expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(p.radius + placed!.radius);
    }
  });

  it("a stowed generated piece never emits — and its anchored followers go with it", () => {
    const deltas = createTownDeltas();
    stowGeneratedPiece(deltas, "h_0", "furn_0_table");
    const pieces = houseFurniture(center, house, goods, "", deltas.get("h_0"));
    expect(pieces.some((p) => p.id === "furn_0_table")).toBe(false);
    // The chairs anchor on the table — no table, no chairs at it.
    expect(pieces.some((p) => p.id.startsWith("furn_0_chair"))).toBe(false);
    // The bowl falls back to a wall (registry fallbackWalls) — still exists.
    expect(pieces.some((p) => p.kind === "bowl")).toBe(true);
  });

  it("removePlacedPiece hands the stack back", () => {
    const deltas = createTownDeltas();
    placeFurniture(deltas, "h_0", {
      id: "furn_0_p0", kind: "box", x: 100, y: 100, radius: 0.45, facing: 0, openable: false, roomId: "h_0",
    });
    expect(removePlacedPiece(deltas, "h_0", "furn_0_p0")).toBe("box");
    expect(removePlacedPiece(deltas, "h_0", "furn_0_p0")).toBeNull();
    expect(deltas.get("h_0")!.placed).toEqual([]);
  });
});

describe("determinism under deltas", () => {
  it("same delta rev returns the memoized identical plan; a bumped rev evicts and rebuilds equal", () => {
    const deltas = createTownDeltas();
    const opts = annexOptions(center, house, basePlan(), [], undefined, "sleep");
    requestAnnex(deltas, "h_0", opts[0]!);
    const d = deltas.get("h_0")!;
    const a = houseRoomPlan(center, house, d);
    const b = houseRoomPlan(center, house, d);
    expect(b).toBe(a); // memo hit
    // A placement bump re-keys but reproduces an EQUAL room plan
    // (placed furniture never shapes rooms).
    placeFurniture(deltas, "h_0", {
      id: "furn_0_p0", kind: "chair", x: 100, y: 100, radius: 0.22, facing: 0, openable: false, roomId: "h_0",
    });
    const c = houseRoomPlan(center, house, deltas.get("h_0"));
    expect(c).toEqual(a);
  });

  it("placementFeasible agrees between a fresh context and a delta-applied one for annex rooms", () => {
    const deltas = createTownDeltas();
    const opts = annexOptions(center, house, basePlan(), [], undefined, "sleep");
    requestAnnex(deltas, "h_0", opts[0]!);
    const delta = deltas.get("h_0")!;
    const plan = houseRoomPlan(center, house, delta);
    const pieces = houseFurniture(center, house, goods, "", delta);
    const ctx = makePlacementContext(center, house, plan, goods, [...pieces]);
    // The annex is a first-class room of the fit machinery: candidates
    // inside it validate like any base room.
    const spots = placementCandidates(ctx, { kind: "box", radius: 0.45, roomId: "h_0_a0" }, 4);
    for (const s of spots) {
      expect(placementFeasible(ctx, "h_0_a0", { x: s.x, y: s.y, radius: 0.45, kind: "box" }).ok).toBe(true);
    }
  });
});

describe("founding workshops: the optional room, seeded (construction v1)", () => {
  const mk = (index: number, dx: number, dy: number, w: number, h: number, door: TownHouse["door"]): TownHouse =>
    ({ index, dx, dy, w, h, door, color: "#a8875f", floors: 1 });
  const mkPlan = () => ({
    houses: [
      mk(0, -6, -5, 12, 10, "south"),
      mk(1, -4, -4, 8, 8, "north"),
      mk(2, -4.5, -4, 9, 8, "west"),
      mk(3, -6.5, -5, 13, 10, "east"),
    ].map((h, i) => ({ ...h, dx: h.dx + i * 40 })), // spread lots apart
    works: [],
  });

  it("is deterministic, guarantees at least one carpenter, and raises a real workshop", () => {
    const a = createTownDeltas();
    const b = createTownDeltas();
    const seededA = seedFoundingWorkshops(center, mkPlan(), a, 7);
    const seededB = seedFoundingWorkshops(center, mkPlan(), b, 7);
    expect(seededA).toEqual(seededB);
    expect(seededA.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));

    const hi = seededA[0]!;
    const h = mkPlan().houses.find((q) => q.index === hi)!;
    const plan = houseRoomPlan(center, h, a.get(`h_${hi}`));
    const shop = plan.rooms.find((r) => r.kind === "workshop");
    expect(shop).toBeDefined();
    // The bench + wood store are cellOnly — they exist exactly where the
    // workshop cell does.
    const pieces = houseFurniture(center, h, goods, "", a.get(`h_${hi}`));
    const bench = pieces.find((p) => p.kind === "workbench");
    expect(bench).toBeDefined();
    expect(
      bench!.x >= shop!.rect.x && bench!.x <= shop!.rect.x + shop!.rect.w &&
      bench!.y >= shop!.rect.y && bench!.y <= shop!.rect.y + shop!.rect.h,
    ).toBe(true);
    // A house WITHOUT the workshop annex never grows a bench.
    const plain = mkPlan().houses.find((q) => !seededA.includes(q.index));
    if (plain) {
      expect(houseFurniture(center, plain, goods).some((p) => p.kind === "workbench")).toBe(false);
    }
  });

  it("a restored session does not re-seed (the guard is the caller's config check)", () => {
    const fresh = createTownDeltas();
    const seeded = seedFoundingWorkshops(center, mkPlan(), fresh, 7);
    const restored = createTownDeltas(fresh.toJSON());
    // The restored overlay already carries the workshops — byte-equal plans.
    for (const hi of seeded) {
      const h = mkPlan().houses.find((q) => q.index === hi)!;
      expect(houseRoomPlan(center, h, restored.get(`h_${hi}`)))
        .toEqual(houseRoomPlan(center, h, fresh.get(`h_${hi}`)));
    }
  });
});
