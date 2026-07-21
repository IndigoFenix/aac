// House FLOOR PLANS (shared/world-engine/kernel/town/rooms.ts) — round 5:
// GENERATED from need (program → topology → embedding), not a fixed
// template. The invariants a generator must never break: the granularity
// gradient holds (studio → merged-wet two-cell → bath + bedrooms, §9
// slice 3), every bedroom is a real cell, rooms TILE the
// footprint exactly, every room is reachable through the door graph, the
// privacy gradient (door-graph depth) is annotated and monotone, and no
// partition door ever lands on a goods chest's standing spot. Pure
// geometry — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  PARTITION_L,
  houseIndexOfBuildingId,
  houseRoomPlan,
  livingRect,
  memberRoomOf,
  type HouseRoom,
} from "@shared/world-engine/kernel/town/rooms.js";
import { goodBoxAt } from "@shared/world-engine/kernel/town/goods.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const center = { x: 200, y: 200 };
const DOORS = ["north", "south", "east", "west"] as const;

function mkHouse(index: number, w: number, h: number, door: TownHouse["door"]): TownHouse {
  return { index, dx: -w / 2, dy: -h / 2, w, h, door, color: "#a8875f", floors: 1 };
}

/** A representative sweep across every door side and the size range the
 *  plan generator emits (dimensions.ts: 7–13 frontage × 7–10 deep) —
 *  varied indices so the program's hash jitter is exercised too. */
function sweep(): TownHouse[] {
  const houses: TownHouse[] = [];
  let i = 0;
  for (const door of DOORS) {
    for (let w = 7; w <= 13.01; w += 1.2) {
      for (let h = 7; h <= 10.01; h += 1.4) {
        // Frontage runs along the door wall — mkHouse's w/h are world
        // extents, so swap for east/west doors like the plan does.
        const sideways = door === "east" || door === "west";
        houses.push(mkHouse(i++, sideways ? h : w, sideways ? w : h, door));
      }
    }
  }
  return houses;
}

const frontageOf = (h: TownHouse): number =>
  h.door === "north" || h.door === "south" ? h.w : h.h;

/** Recover a doorway's world midpoint (embed.ts convention). */
const doorPoint = (r: HouseRoom, d: HouseRoom["doorways"][number]): string => {
  const at =
    d.edge === "north" ? { x: r.rect.x + d.offset, y: r.rect.y }
    : d.edge === "south" ? { x: r.rect.x + d.offset, y: r.rect.y + r.rect.h }
    : d.edge === "west" ? { x: r.rect.x, y: r.rect.y + d.offset }
    : { x: r.rect.x + r.rect.w, y: r.rect.y + d.offset };
  return `${at.x.toFixed(3)},${at.y.toFixed(3)}`;
};

describe("houseRoomPlan: the generated split", () => {
  it("is deterministic", () => {
    for (const h of sweep().slice(0, 12)) {
      expect(JSON.stringify(houseRoomPlan(center, h))).toBe(JSON.stringify(houseRoomPlan(center, h)));
    }
  });

  it("the PROGRAM: the granularity gradient (studio → merged-wet → bath + bedrooms); big back bands earn more sleeping cells", () => {
    let sawThree = false;
    let sawHall = false;
    let sawMerged = false;
    let sawStudio = false;
    for (const h of sweep()) {
      const plan = houseRoomPlan(center, h);
      if (!plan.partitioned) {
        // The full merge — everything in one cell.
        sawStudio = true;
        expect(plan.rooms).toHaveLength(1);
        expect(frontageOf(h)).toBeLessThan(PARTITION_L);
        continue;
      }
      if (plan.bathId === null) {
        // §9 slice 3: the MERGED-WET form — below the full-form frontage
        // the wet cluster gave up its cell (its stations stand in the
        // living room; privacy rank 1 merges before rank-2 sleep does).
        sawMerged = true;
        expect(frontageOf(h)).toBeLessThan(PARTITION_L);
        expect(plan.rooms).toHaveLength(2);
        expect(plan.bedrooms).toHaveLength(1);
      } else {
        expect(frontageOf(h)).toBeGreaterThanOrEqual(PARTITION_L);
        expect(plan.bedrooms.length).toBeGreaterThanOrEqual(1);
        expect(plan.bedrooms.length).toBeLessThanOrEqual(3);
      }
      if (plan.bedrooms.length === 3) sawThree = true;
      if (plan.rooms.some((r) => r.kind === "hall")) sawHall = true;
      // Every bedroom is a REAL cell (min width the program promised).
      for (const id of plan.bedrooms) {
        const r = plan.rooms.find((rr) => rr.id === id)!;
        expect(Math.min(r.rect.w, r.rect.h)).toBeGreaterThanOrEqual(2.4);
      }
    }
    // The need knob actually moves: the sweep contains 3-bed programs,
    // the SPINE topology (a hall) appears where it earns its area, and
    // BOTH ends of the granularity gradient occur.
    expect(sawThree).toBe(true);
    expect(sawHall).toBe(true);
    expect(sawMerged).toBe(true);
    expect(sawStudio).toBe(true);
  });

  it("rooms TILE the footprint: inside it, disjoint, areas sum to the lot", () => {
    for (const h of sweep()) {
      const plan = houseRoomPlan(center, h);
      const x0 = center.x + h.dx;
      const y0 = center.y + h.dy;
      let area = 0;
      for (const r of plan.rooms) {
        expect(r.rect.x).toBeGreaterThanOrEqual(x0 - 1e-6);
        expect(r.rect.y).toBeGreaterThanOrEqual(y0 - 1e-6);
        expect(r.rect.x + r.rect.w).toBeLessThanOrEqual(x0 + h.w + 1e-6);
        expect(r.rect.y + r.rect.h).toBeLessThanOrEqual(y0 + h.h + 1e-6);
        area += r.rect.w * r.rect.h;
      }
      expect(area).toBeCloseTo(h.w * h.h, 6);
      for (let i = 0; i < plan.rooms.length; i++) {
        for (let j = i + 1; j < plan.rooms.length; j++) {
          const a = plan.rooms[i]!.rect;
          const b = plan.rooms[j]!.rect;
          const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          expect(Math.min(overlapW, overlapH)).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });

  it("the living room keeps the historical id and the street door; ids map back", () => {
    for (const h of sweep()) {
      const plan = houseRoomPlan(center, h);
      const living = plan.rooms[0]!;
      expect(living.id).toBe(`h_${h.index}`);
      expect(living.kind).toBe("living");
      expect(living.doorways.some((d) => d.edge === h.door)).toBe(true);
      for (const r of plan.rooms) expect(houseIndexOfBuildingId(r.id)).toBe(h.index);
      // The exported living rect IS rooms[0]'s rect (goods.ts anchors on it).
      expect(livingRect(center, h)).toEqual(living.rect);
    }
    expect(houseIndexOfBuildingId("w_3")).toBeNull();
    expect(houseIndexOfBuildingId("well")).toBeNull();
  });

  it("every room is REACHABLE from the living room; depth IS the privacy gradient", () => {
    for (const h of sweep()) {
      const plan = houseRoomPlan(center, h);
      const byPoint = new Map<string, HouseRoom[]>();
      for (const r of plan.rooms) {
        for (const d of r.doorways) {
          const k = doorPoint(r, d);
          byPoint.set(k, [...(byPoint.get(k) ?? []), r]);
        }
      }
      // Every INTERIOR door joins exactly two rooms.
      for (const [pt, rs] of byPoint) {
        expect(`${pt}: ${rs.length <= 2}`).toBe(`${pt}: true`);
      }
      // BFS reachability from the living room…
      const adj = new Map<string, Set<string>>();
      for (const rs of byPoint.values()) {
        for (const a of rs) for (const b of rs) {
          if (a.id === b.id) continue;
          (adj.get(a.id) ?? adj.set(a.id, new Set()).get(a.id)!).add(b.id);
        }
      }
      const dist = new Map<string, number>([[plan.rooms[0]!.id, 0]]);
      const queue = [plan.rooms[0]!.id];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nxt of adj.get(cur) ?? []) {
          if (!dist.has(nxt)) {
            dist.set(nxt, dist.get(cur)! + 1);
            queue.push(nxt);
          }
        }
      }
      expect(dist.size).toBe(plan.rooms.length);
      for (const r of plan.rooms) {
        // …and the annotated depth is exactly the BFS distance: the
        // privacy gradient the privacy need will read.
        expect(`${r.id}: ${r.depth}`).toBe(`${r.id}: ${dist.get(r.id)}`);
        if (r.kind === "bedroom" || r.kind === "bath") {
          expect(r.depth).toBeGreaterThanOrEqual(1); // private rooms sit DEEPER than the living
        }
      }
    }
  });

  it("no living-room interior door corridor covers a goods chest's standing spot", () => {
    for (const h of sweep()) {
      const plan = houseRoomPlan(center, h);
      if (!plan.partitioned) continue;
      const spots = [0, 1, 2, 3].map((slot) => goodBoxAt(center, h, slot));
      const living = plan.rooms[0]!;
      for (const d of living.doorways) {
        if (d.edge === h.door) continue; // the street door — spots avoid it by layout
        const at =
          d.edge === "north" ? { x: living.rect.x + d.offset, y: living.rect.y }
          : d.edge === "south" ? { x: living.rect.x + d.offset, y: living.rect.y + living.rect.h }
          : d.edge === "west" ? { x: living.rect.x, y: living.rect.y + d.offset }
          : { x: living.rect.x + living.rect.w, y: living.rect.y + d.offset };
        for (const s of spots) {
          // The corridor is door-width wide and reaches ROOM_DOOR_DEPTH
          // (1.1) into the room; the spot needs a body's berth (0.5).
          // 2D rule (matches furniture's fits()): clear when separated
          // ALONG the wall OR standing beyond the corridor's reach —
          // round 7's front-kitchen door is a SIDE-wall living door
          // whose spots sit across from it at the 1.75 m inset, clear
          // in depth though not in along.
          const along = d.edge === "north" || d.edge === "south" ? Math.abs(s.x - at.x) : Math.abs(s.y - at.y);
          const into = d.edge === "north" || d.edge === "south" ? Math.abs(s.y - at.y) : Math.abs(s.x - at.x);
          const clear = along >= d.width / 2 + 0.5 - 1e-6 || into >= 1.1 + 0.5 - 1e-6;
          expect(`${d.edge}@${d.offset.toFixed(2)} vs spot: ${clear}`).toBe(`${d.edge}@${d.offset.toFixed(2)} vs spot: true`);
        }
      }
    }
  });

  it("members pair off over the bedrooms in order; studios keep everyone in the living room", () => {
    for (const h of sweep()) {
      const plan = houseRoomPlan(center, h);
      if (!plan.partitioned) {
        expect(memberRoomOf(plan, 0).kind).toBe("living");
        continue;
      }
      expect(memberRoomOf(plan, 0).id).toBe(plan.bedrooms[0]);
      expect(memberRoomOf(plan, 1).id).toBe(plan.bedrooms[0]);
      const b1 = plan.bedrooms[Math.min(1, plan.bedrooms.length - 1)];
      expect(memberRoomOf(plan, 2).id).toBe(b1);
      expect(memberRoomOf(plan, 3).id).toBe(b1);
      const b2 = plan.bedrooms[Math.min(2, plan.bedrooms.length - 1)];
      expect(memberRoomOf(plan, 4).id).toBe(b2);
      for (let m = 0; m < 5; m++) expect(memberRoomOf(plan, m).kind).toBe("bedroom");
    }
  });

  it("round-7 KITCHEN: the culture coin's front galley — doored from the living, beds intact", () => {
    // Kitchens appear (the coin at ~50% over eligible footprints — front
    // galleys off the living room, plus the spine's hall-doored cell),
    // and every one obeys the room's law: exactly one `_rk` room, depth
    // 1 from the living or the hall, never entered through a bedroom.
    let sawFront = 0;
    for (const h of sweep()) {
      const plan = houseRoomPlan(center, h);
      const kitchens = plan.rooms.filter((r) => r.kind === "kitchen");
      expect(kitchens.length).toBeLessThanOrEqual(1);
      const k = kitchens[0];
      if (!k) continue;
      expect(k.id).toBe(`h_${h.index}_rk`);
      expect(k.depth).toBeLessThanOrEqual(k.doorways.length > 0 ? 2 : 0);
      // Its door joins the LIVING room or the HALL — never a bedroom.
      const points = new Set(k.doorways.map((d) => doorPoint(k, d)));
      const neighbors = plan.rooms.filter(
        (r) => r !== k && r.doorways.some((d) => points.has(doorPoint(r, d))),
      );
      expect(neighbors.length).toBeGreaterThanOrEqual(1);
      for (const nb of neighbors) expect(["living", "hall"]).toContain(nb.kind);
      if (neighbors.some((nb) => nb.kind === "living")) sawFront++;
      // The front cut never starves the living room of its chest ends:
      // the goods-corner spots still sit inside it.
      const lr = plan.rooms[0]!.rect;
      for (const slot of [0, 1, 2, 3]) {
        const s = goodBoxAt(center, h, slot);
        expect(s.x).toBeGreaterThanOrEqual(lr.x);
        expect(s.x).toBeLessThanOrEqual(lr.x + lr.w);
        expect(s.y).toBeGreaterThanOrEqual(lr.y);
        expect(s.y).toBeLessThanOrEqual(lr.y + lr.h);
      }
    }
    expect(sawFront).toBeGreaterThan(0); // the galley really occurs in-range
  });

  it("stays MICROSECOND-cheap: the plan runs for every staged house", () => {
    // Fresh centers defeat the memo so this times COLD builds (the
    // founding pass's real cost); warm lookups are map hits. The metric
    // is the BEST batch: a mean is dominated by scheduler preemption
    // when the whole suite set shares the box, while the fastest batch
    // is what the solver actually costs.
    const houses = sweep();
    let best = Number.POSITIVE_INFINITY;
    for (let rep = 0; rep < 10; rep++) {
      const c = { x: 1000 + rep * 7, y: 1000 };
      const t0 = performance.now();
      for (const h of houses) houseRoomPlan(c, h);
      best = Math.min(best, (performance.now() - t0) / houses.length);
    }
    // ms — founding lays out hundreds per yield. Solo the cold solve
    // measures ~0.09 ms/plan (round 7 bench, kitchen variants included).
    expect(best).toBeLessThan(0.8);
  });
});
