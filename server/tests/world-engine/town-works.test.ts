// NON-HOUSE BUILDING INTERIORS (§9 slice 5, kernel/town/rooms.ts
// buildingRoomPlan + stations.ts WORK_PROGRAMS/WORK_STATIONS): a work
// building's interior is its PROGRAM run through the same generator a
// house uses. The invariants: programs pick the form (open hall /
// storefront + stock room / dwelling band), rooms tile the footprint and
// stay reachable, the INN multiplies the sleep cluster past the house's
// three (the spine hall doors what a partition never could), and the
// registry is the mod seam (any program value generates). Pure geometry
// — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  buildingRoomPlan,
  type WorkShape,
} from "@shared/world-engine/kernel/town/rooms.js";
import { workFurniture, type FurniturePiece } from "@shared/world-engine/kernel/town/furniture.js";
import { WORK_PROGRAMS, workProgram } from "@shared/world-engine/kernel/town/stations.js";

const center = { x: 300, y: 300 };
const mkWork = (w: number, h: number, door: WorkShape["door"]): WorkShape =>
  ({ dx: -w / 2, dy: -h / 2, w, h, door });

const inRect = (p: FurniturePiece, r: { x: number; y: number; w: number; h: number }): boolean =>
  p.x - p.radius >= r.x - 1e-9 && p.x + p.radius <= r.x + r.w + 1e-9 &&
  p.y - p.radius >= r.y - 1e-9 && p.y + p.radius <= r.y + r.h + 1e-9;

describe("buildingRoomPlan: programs pick the form", () => {
  it("the market and the hall stay OPEN (their floor is the point)", () => {
    for (const type of ["market", "hall"] as const) {
      const plan = buildingRoomPlan(center, 0, mkWork(20, 12, "south"), workProgram(type));
      expect(plan.rooms).toHaveLength(1);
      expect(plan.partitioned).toBe(false);
      expect(plan.rooms[0]!.id).toBe("w_0");
    }
  });

  it("a workshop grows a STOCK ROOM behind its sales floor; the front keeps the historical id", () => {
    // The farm's 18×12 / weaver's 14×10 / tailor's 12×10 footprints, all
    // four door sides.
    for (const [w, h] of [[18, 12], [14, 10], [12, 10]] as const) {
      for (const door of ["north", "south", "east", "west"] as const) {
        const sideways = door === "east" || door === "west";
        const work = mkWork(sideways ? h : w, sideways ? w : h, door);
        const plan = buildingRoomPlan(center, 3, work, workProgram("farm"));
        expect(plan.rooms).toHaveLength(2);
        expect(plan.rooms[0]!.id).toBe("w_3");
        expect(plan.rooms[0]!.kind).toBe("living");
        expect(plan.rooms[1]!.id).toBe("w_3_rs");
        expect(plan.rooms[1]!.kind).toBe("store");
        expect(plan.rooms[1]!.depth).toBe(1); // reachable, one door deep
        // Rooms TILE the footprint.
        const area = plan.rooms.reduce((s, r) => s + r.rect.w * r.rect.h, 0);
        expect(area).toBeCloseTo(work.w * work.h, 6);
        // The shared door appears on BOTH rooms (embed convention).
        expect(plan.rooms[0]!.doorways.length).toBe(2); // street + partition
        expect(plan.rooms[1]!.doorways.length).toBe(1);
      }
    }
  });

  it("too small for the store cluster's floors ⇒ goes OPEN, never cramped", () => {
    const plan = buildingRoomPlan(center, 4, mkWork(6, 5, "south"), workProgram("weaver"));
    expect(plan.rooms).toHaveLength(1);
  });

  it("is deterministic and memoized-consistent", () => {
    const work = mkWork(14, 10, "east");
    const a = JSON.stringify(buildingRoomPlan(center, 5, work, workProgram("weaver")));
    expect(JSON.stringify(buildingRoomPlan(center, 5, work, workProgram("weaver")))).toBe(a);
  });
});

describe("THE INN: the sleep cluster multiplied (§9's cluster-multiplication stress)", () => {
  it("a 22×14 inn realizes SIX sleeping cells — the spine hall doors what a partition never could", () => {
    const plan = buildingRoomPlan(center, 7, mkWork(22, 14, "south"), WORK_PROGRAMS.inn!);
    expect(plan.bedrooms).toHaveLength(6);
    expect(plan.bathId).not.toBeNull();
    expect(plan.rooms.some((r) => r.kind === "hall")).toBe(true);
    expect(plan.rooms[0]!.id).toBe("w_7"); // the common room keeps the building id
    // Every cell one hall-hop deep; rooms tile.
    for (const id of plan.bedrooms) {
      expect(plan.rooms.find((r) => r.id === id)!.depth).toBe(2); // living → hall → cell
    }
    const area = plan.rooms.reduce((s, r) => s + r.rect.w * r.rect.h, 0);
    expect(area).toBeCloseTo(22 * 14, 6);
  });

  it("a modest footprint clamps the multiplied demand to what its width doors", () => {
    const plan = buildingRoomPlan(center, 8, mkWork(16, 14, "south"), WORK_PROGRAMS.inn!);
    expect(plan.bedrooms.length).toBeGreaterThanOrEqual(3);
    expect(plan.bedrooms.length).toBeLessThan(6); // width caps the row
  });

  it("round 7: a GRAND inn hangs a kitchen off its hall — guest beds never pay for it", () => {
    // 26 m doors six full cells PLUS the kitchen down the spine; at 22 m
    // the width only carries the beds, and beds outrank — the program's
    // kitchen goes unrealized rather than costing a cell.
    const grand = buildingRoomPlan(center, 10, mkWork(26, 14, "south"), WORK_PROGRAMS.inn!);
    expect(grand.bedrooms).toHaveLength(6);
    expect(grand.rooms.filter((r) => r.kind === "kitchen")).toHaveLength(1);
    const tight = buildingRoomPlan(center, 7, mkWork(22, 14, "south"), WORK_PROGRAMS.inn!);
    expect(tight.bedrooms).toHaveLength(6);
    expect(tight.rooms.some((r) => r.kind === "kitchen")).toBe(false);
  });
});

describe("the registry is the MOD SEAM", () => {
  it("an unregistered work type gets the generic workshop program", () => {
    expect(workProgram("mystery-guild")).toEqual({ store: true });
  });

  it("an authored program value generates with no new generator code", () => {
    // A mod hands buildingRoomPlan its own program — a tiny two-bed
    // bunkhouse — and the same machinery realizes it.
    const plan = buildingRoomPlan(center, 9, mkWork(12, 10, "north"), { sleepCells: 2, wet: true });
    expect(plan.bedrooms).toHaveLength(2);
    expect(plan.bathId).not.toBeNull();
  });
});

describe("workFurniture: the shared driver over WORK_STATIONS", () => {
  it("the counter stands on the sales floor, the stock chests in the store room", () => {
    const work = mkWork(18, 12, "south");
    const plan = buildingRoomPlan(center, 3, work, workProgram("farm"));
    const pieces = workFurniture(center, 3, work, workProgram("farm"));
    const front = plan.rooms[0]!.rect;
    const store = plan.rooms[1]!.rect;
    const counter = pieces.find((p) => p.id === "furn_w3_counter")!;
    expect(counter).toBeDefined();
    expect(counter.kind).toBe("table");
    expect(inRect(counter, front)).toBe(true);
    const stock = pieces.filter((p) => p.id.startsWith("furn_w3_stock_"));
    expect(stock.length).toBeGreaterThanOrEqual(1);
    for (const s of stock) expect(inRect(s, store)).toBe(true);
    // Nothing overlaps, everything sits in exactly one room.
    for (const p of pieces) {
      expect(plan.rooms.filter((r) => inRect(p, r.rect)).length).toBe(1);
      for (const q of pieces) {
        if (p === q) continue;
        const apart =
          Math.abs(p.x - q.x) >= p.radius + q.radius ||
          Math.abs(p.y - q.y) >= p.radius + q.radius;
        expect(`${p.id}/${q.id}: ${apart}`).toBe(`${p.id}/${q.id}: true`);
      }
    }
  });

  it("no piece blocks a doorway's corridor", () => {
    for (const type of ["farm", "weaver", "tailor"] as const) {
      const work = mkWork(14, 10, "west");
      const plan = buildingRoomPlan(center, 6, work, workProgram(type));
      const pieces = workFurniture(center, 6, work, workProgram(type));
      for (const room of plan.rooms) {
        for (const d of room.doorways) {
          const r = room.rect;
          const at =
            d.edge === "north" ? { x: r.x + d.offset, y: r.y }
            : d.edge === "south" ? { x: r.x + d.offset, y: r.y + r.h }
            : d.edge === "west" ? { x: r.x, y: r.y + d.offset }
            : { x: r.x + r.w, y: r.y + d.offset };
          const horiz = d.edge === "north" || d.edge === "south";
          for (const p of pieces) {
            const along = horiz ? Math.abs(p.x - at.x) : Math.abs(p.y - at.y);
            const into = horiz ? Math.abs(p.y - at.y) : Math.abs(p.x - at.x);
            const blocks = along < p.radius + d.width / 2 && into < p.radius + 1.0;
            expect(`${type} ${room.id} ${p.id}: ${blocks}`).toBe(`${type} ${room.id} ${p.id}: false`);
          }
        }
      }
    }
  });

  it("is deterministic", () => {
    const work = mkWork(18, 12, "north");
    const a = JSON.stringify(workFurniture(center, 2, work, workProgram("farm")));
    expect(JSON.stringify(workFurniture(center, 2, work, workProgram("farm")))).toBe(a);
  });

  it("round 7: the stove stands ONLY where a kitchen cell does (cellOnly)", () => {
    const work = mkWork(26, 14, "south");
    const plan = buildingRoomPlan(center, 10, work, WORK_PROGRAMS.inn!);
    const pieces = workFurniture(center, 10, work, WORK_PROGRAMS.inn!);
    const stove = pieces.find((p) => p.kind === "oven")!;
    expect(stove).toBeDefined();
    expect(inRect(stove, plan.rooms.find((r) => r.kind === "kitchen")!.rect)).toBe(true);
    // A farm shop earned no kitchen — no stove appears on its sales floor
    // (the house registry's fallback would have parked one there).
    expect(workFurniture(center, 3, mkWork(18, 12, "south"), workProgram("farm"))
      .some((p) => p.kind === "oven")).toBe(false);
  });
});
