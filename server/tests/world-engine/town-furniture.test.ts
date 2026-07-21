// House FURNITURE placement (shared/world-engine/kernel/town/furniture.ts):
// chests and cupboards hug the WALLS (chests in corners), the table earns
// the middle of the room, and the household STATIONS (two beds, two chairs
// at the table, a box — Sims-mode) fill what's left, omitted rather
// than overlapped when a house is too small (THE FIT RULE). Pure geometry
// — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import { houseFurniture, type FurniturePiece } from "@shared/world-engine/kernel/town/furniture.js";
import { houseRoomPlan, livingRect } from "@shared/world-engine/kernel/town/rooms.js";
import { goodBoxAt } from "@shared/world-engine/kernel/town/goods.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

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

  it("goods boxes sit flush in CORNERS — against two walls each", () => {
    // Goods boxes only — the members' personal BOXES (round 4) share the
    // "chest" kind but live in bedrooms, tagged by the absent goods key.
    // The FOOD good raises a refrigerator rather than a chest, so match on
    // the goods key, not the kind.
    const chests = pieces.filter(p => !!p.good);
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

  it("the cupboard is flush against a LIVING-room wall", () => {
    // The 12×10 reference house PARTITIONS (rooms.ts): the living room's
    // far wall is the partition, whose door corridors push the cupboard to
    // a side wall — flush against SOME living wall, always inside living.
    const cup = pieces.find(p => p.kind === "cupboard")!;
    const lr = livingRect(center, house);
    const gaps = [
      cup.x - cup.radius - lr.x,
      lr.x + lr.w - (cup.x + cup.radius),
      cup.y - cup.radius - lr.y,
      lr.y + lr.h - (cup.y + cup.radius),
    ];
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(-1e-9); // inside living
    expect(Math.min(...gaps)).toBeLessThanOrEqual(FLUSH); // flush somewhere
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

/** Every pair of pieces whose bounding boxes overlap ("a × b"). */
function overlappingPairs(pieces: FurniturePiece[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i]!;
      const b = pieces[j]!;
      if (
        Math.abs(a.x - b.x) < a.radius + b.radius - 1e-9 &&
        Math.abs(a.y - b.y) < a.radius + b.radius - 1e-9
      ) {
        bad.push(`${a.id} × ${b.id}`);
      }
    }
  }
  return bad;
}

describe("household stations: beds, chairs at the table, a box", () => {
  const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];
  const pieces = houseFurniture(center, house, goods);
  const byKind = (k: FurniturePiece["kind"]): FurniturePiece[] => pieces.filter(p => p.kind === k);

  it("a typical house gets them all: three beds (burgher size), two chairs, a box per member", () => {
    // 12 m frontage ⇒ a 4-room house (rooms.ts) ⇒ a third single bed.
    expect(byKind("bed").map(b => b.id)).toEqual(["furn_0_bed_0", "furn_0_bed_1", "furn_0_bed_2"]);
    expect(byKind("chair").map(c => c.id)).toEqual(["furn_0_chair_0", "furn_0_chair_1"]);
    // Boxes are PER MEMBER — there is no separate communal toy chest; a box is
    // a box, and what makes one a toy box is only what's inside it.
    const boxes = byKind("box").map(t => t.id);
    expect(boxes.length).toBeGreaterThan(0);
    for (const id of boxes) expect(id).toMatch(/^furn_0_box_\d+$/);
    const [double, single] = byKind("bed");
    expect(double!.radius).toBeGreaterThan(single!.radius); // bed_0 is the double
  });

  it("every piece stays inside the house rect", () => {
    for (const p of pieces) {
      for (const g of wallGaps(p)) expect(g).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("no two pieces overlap (bounding boxes)", () => {
    expect(overlappingPairs(pieces)).toEqual([]);
  });

  it("nothing sits in the door swing area", () => {
    // South door at the wall's middle: a ~2 m wide, 2 m deep corridor
    // (doorTransit's inside point is 1 m in) must stay clear.
    const doorX = (x0 + x1) / 2;
    for (const p of pieces) {
      const inSwing = Math.abs(p.x - doorX) < p.radius + 1.0 && y1 - (p.y + p.radius) < 2.0;
      expect(`${p.id}: ${inSwing}`).toBe(`${p.id}: false`);
    }
  });

  it("beds lie flush against a wall AWAY from the door", () => {
    for (const bed of byKind("bed")) {
      expect(Math.min(...wallGaps(bed))).toBeLessThanOrEqual(FLUSH); // flush somewhere
      expect(y1 - (bed.y + bed.radius)).toBeGreaterThan(FLUSH); // never the south (door) wall
    }
  });

  it("chairs tuck at the table on opposite sides, facing it", () => {
    const table = pieces.find(p => p.kind === "table")!;
    const chairs = byKind("chair");
    expect(chairs).toHaveLength(2);
    const [a, b] = chairs;
    // Opposite sides: the table center lies between them.
    expect((a!.x - table.x) * (b!.x - table.x) + (a!.y - table.y) * (b!.y - table.y)).toBeLessThan(0);
    for (const c of chairs) {
      const d = Math.hypot(table.x - c.x, table.y - c.y);
      expect(d).toBeLessThan(table.radius + c.radius + 0.2); // tucked close
      // The facing ray points straight at the table's center.
      const dot = Math.cos(c.facing) * (table.x - c.x) + Math.sin(c.facing) * (table.y - c.y);
      expect(dot).toBeCloseTo(d, 5);
    }
  });

  it("the goods chests' standing spots stay clear (goodBoxAt, 1.75 m in)", () => {
    const spots = [
      { x: x0 + 1.75, y: y1 - 1.75 }, // slot 0, SW
      { x: x1 - 1.75, y: y1 - 1.75 }, // slot 1, SE
    ];
    for (const s of spots) {
      for (const p of pieces) {
        const covers = Math.abs(s.x - p.x) < p.radius + 0.3 && Math.abs(s.y - p.y) < p.radius + 0.3;
        expect(`${p.id}: ${covers}`).toBe(`${p.id}: false`);
      }
    }
  });

  it("is deterministic: same house, same stations", () => {
    expect(JSON.stringify(houseFurniture(center, house, goods))).toBe(JSON.stringify(pieces));
  });

  it("round-2 stations (bath / privy / barrel / bin / bowl) fit the typical house", () => {
    // The 12×10 reference house has wall to spare — every new station lands.
    expect(byKind("bath").map(p => p.id)).toEqual(["furn_0_bath"]);
    expect(byKind("privy").map(p => p.id)).toEqual(["furn_0_privy"]);
    expect(byKind("barrel").map(p => p.id)).toEqual(["furn_0_barrel"]);
    expect(byKind("bin").map(p => p.id)).toEqual(["furn_0_bin"]);
    expect(byKind("bowl").map(p => p.id)).toEqual(["furn_0_bowl"]);
    // The barrel opens (a lidded water store — grasp-gated in play); the
    // tub, privy and bowl don't.
    expect(byKind("barrel")[0]!.openable).toBe(true);
    expect(byKind("bin")[0]!.openable).toBe(true);
    for (const k of ["bath", "privy", "bowl"] as const) expect(byKind(k)[0]!.openable).toBe(false);
  });

  it("round-5 ROOMS: every piece stays inside ITS room, by role", () => {
    const plan = houseRoomPlan(center, house);
    // The 12×10 reference house's PROGRAM earns three sleeping cells.
    // Round 5 needed the SPINE hall for that; round 6's circulation
    // search also reaches three by CHAINING a bedroom (no hall), so the
    // room set is derived from the plan rather than pinned to one shape.
    expect(plan.bedrooms).toHaveLength(3);
    const halls = plan.rooms.filter(r => r.kind === "hall").length;
    expect(plan.rooms).toHaveLength(2 + plan.bedrooms.length + halls); // living + bath + beds (+ hall)
    const inRect = (p: FurniturePiece, r: { x: number; y: number; w: number; h: number }) =>
      p.x - p.radius >= r.x - 1e-9 && p.x + p.radius <= r.x + r.w + 1e-9 &&
      p.y - p.radius >= r.y - 1e-9 && p.y + p.radius <= r.y + r.h + 1e-9;
    const roomOf = (id: string) => plan.rooms.find(r => r.id === id)!;
    const living = plan.rooms[0]!.rect;
    // Kitchen set lives in the LIVING room… (personal boxes share the
    // "chest" kind but live in bedrooms — filter by the goods tag.)
    for (const kind of ["cupboard", "table", "chair", "barrel", "bin", "bowl"] as const) {
      for (const p of byKind(kind)) expect(`${p.id}: ${inRect(p, living)}`).toBe(`${p.id}: true`);
    }
    for (const p of byKind("chest").filter(c => c.good)) {
      expect(`${p.id}: ${inRect(p, living)}`).toBe(`${p.id}: true`);
    }
    // …one bed per BEDROOM (bed_k in bedrooms[k]), wet stations in the
    // BATH, boxes in bedrooms, and the HALL stays furniture-free.
    byKind("bed").forEach((b, i) => {
      expect(`${b.id}: ${inRect(b, roomOf(plan.bedrooms[i]!).rect)}`).toBe(`${b.id}: true`);
    });
    const bath = roomOf(plan.bathId!).rect;
    for (const kind of ["bath", "privy"] as const) {
      for (const p of byKind(kind)) expect(`${p.id}: ${inRect(p, bath)}`).toBe(`${p.id}: true`);
    }
    const bedRects = plan.bedrooms.map(id => roomOf(id).rect);
    for (const p of pieces.filter(x => x.id.includes("_box_"))) {
      expect(`${p.id}: ${bedRects.some(r => inRect(p, r))}`).toBe(`${p.id}: true`);
    }
    const hall = plan.rooms.find(r => r.kind === "hall");
    if (hall) {
      for (const p of pieces) {
        expect(`${p.id}: ${inRect(p, hall.rect)}`).toBe(`${p.id}: false`);
      }
    }
    // No piece straddles a partition: each is fully inside exactly one room.
    for (const p of pieces) {
      const homes = plan.rooms.filter(r => inRect(p, r.rect)).length;
      expect(`${p.id}: ${homes}`).toBe(`${p.id}: 1`);
    }
  });

  it("round-4 ROOMS: the goods boxes sit at goodBoxAt's living-room corners", () => {
    for (const [i, g] of goods.entries()) {
      // Match on the goods key — food's box is a refrigerator, not a chest.
      const chest = pieces.find(p => p.good === g.key)!;
      const spot = goodBoxAt(center, house, g.slot ?? i);
      // The chest hugs the corner the standing spot is 1.75 m in from —
      // within the corner-inset difference of it.
      expect(Math.hypot(chest.x - spot.x, chest.y - spot.y)).toBeLessThan(1.75);
    }
  });

  it("round-4 ROOMS: nothing blocks an interior doorway's corridor", () => {
    const plan = houseRoomPlan(center, house);
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
          if (p.kind === "chair" || p.kind === "bowl") continue; // pass-through
          const along = horiz ? Math.abs(p.x - at.x) : Math.abs(p.y - at.y);
          const into = horiz ? Math.abs(p.y - at.y) : Math.abs(p.x - at.x);
          const blocks = along < p.radius + d.width / 2 && into < p.radius + 1.0;
          expect(`${room.id} ${d.edge}@${d.offset.toFixed(1)} ${p.id}: ${blocks}`).toBe(
            `${room.id} ${d.edge}@${d.offset.toFixed(1)} ${p.id}: false`,
          );
        }
      }
    }
  });

  it("FULL SWEEP: every generated floor plan places furniture in-room, non-overlapping, doors clear", () => {
    // The same representative sweep town-rooms.test.ts runs (all 4 door
    // sides × the TOWN_DIMS size range × varied indices for the hash
    // jitter) — the reference-house checks above must hold for EVERY
    // house the generator can emit, not just 12×10/south.
    const sweepHouses: TownHouse[] = [];
    let idx = 0;
    for (const door of ["north", "south", "east", "west"] as const) {
      for (let w = 7; w <= 13.01; w += 1.2) {
        for (let h = 7; h <= 10.01; h += 1.4) {
          const sideways = door === "east" || door === "west";
          const ww = sideways ? h : w;
          const hh = sideways ? w : h;
          sweepHouses.push({
            index: idx++, dx: -ww / 2, dy: -hh / 2, w: ww, h: hh, door, color: "#a8875f", floors: 1,
          });
        }
      }
    }
    const inRect = (p: FurniturePiece, r: { x: number; y: number; w: number; h: number }) =>
      p.x - p.radius >= r.x - 1e-9 && p.x + p.radius <= r.x + r.w + 1e-9 &&
      p.y - p.radius >= r.y - 1e-9 && p.y + p.radius <= r.y + r.h + 1e-9;
    for (const hh of sweepHouses) {
      const ps = houseFurniture(center, hh, goods);
      const plan = houseRoomPlan(center, hh);
      const hx0 = center.x + hh.dx;
      const hy0 = center.y + hh.dy;
      // Inside the house, no two solids overlapping.
      for (const p of ps) {
        expect(p.x - p.radius).toBeGreaterThanOrEqual(hx0 - 1e-9);
        expect(p.y - p.radius).toBeGreaterThanOrEqual(hy0 - 1e-9);
        expect(p.x + p.radius).toBeLessThanOrEqual(hx0 + hh.w + 1e-9);
        expect(p.y + p.radius).toBeLessThanOrEqual(hy0 + hh.h + 1e-9);
      }
      expect(`house ${hh.index} ${hh.w}x${hh.h} ${hh.door}: ${overlappingPairs(ps).join("; ")}`)
        .toBe(`house ${hh.index} ${hh.w}x${hh.h} ${hh.door}: `);
      // Every piece fully inside exactly ONE room (never straddling a
      // partition — a chest half-buried in a wall blocks the room beyond).
      for (const p of ps) {
        const homes = plan.rooms.filter(r => inRect(p, r.rect)).length;
        expect(`house ${hh.index} ${p.id}: rooms=${homes}`).toBe(`house ${hh.index} ${p.id}: rooms=1`);
      }
      // NO DOORWAY CORRIDOR BLOCKED — checked from BOTH sides of every
      // door (a piece flush against the shared wall in the NEIGHBORING
      // room can pinch the opening just as well): every solid piece, in
      // whatever room, keeps out of the door-width lane through each
      // doorway, one meter deep to each side.
      for (const room of plan.rooms) {
        for (const d of room.doorways) {
          const r = room.rect;
          const at =
            d.edge === "north" ? { x: r.x + d.offset, y: r.y }
            : d.edge === "south" ? { x: r.x + d.offset, y: r.y + r.h }
            : d.edge === "west" ? { x: r.x, y: r.y + d.offset }
            : { x: r.x + r.w, y: r.y + d.offset };
          const horiz = d.edge === "north" || d.edge === "south";
          for (const p of ps) {
            if (p.kind === "chair" || p.kind === "bowl") continue; // pass-through
            const along = horiz ? Math.abs(p.x - at.x) : Math.abs(p.y - at.y);
            const into = horiz ? Math.abs(p.y - at.y) : Math.abs(p.x - at.x);
            const blocks = along < p.radius + d.width / 2 && into < p.radius + 1.0;
            expect(`house ${hh.index} ${hh.w}x${hh.h} ${hh.door} ${room.id} ${d.edge}@${d.offset.toFixed(1)} ${p.id}: ${blocks}`)
              .toBe(`house ${hh.index} ${hh.w}x${hh.h} ${hh.door} ${room.id} ${d.edge}@${d.offset.toFixed(1)} ${p.id}: false`);
          }
        }
      }
      // Goods chests' standing spots stay clear of every solid piece.
      for (const [i, g] of goods.entries()) {
        const spot = goodBoxAt(center, hh, g.slot ?? i);
        for (const p of ps) {
          if (p.kind === "chair" || p.kind === "bowl") continue;
          if (p.kind === "chest" && p.good === g.key) continue; // its own crate stands behind the spot
          const covers = Math.abs(spot.x - p.x) < p.radius + 0.3 && Math.abs(spot.y - p.y) < p.radius + 0.3;
          expect(`house ${hh.index} spot ${g.key} ${p.id}: ${covers}`).toBe(`house ${hh.index} spot ${g.key} ${p.id}: false`);
        }
      }
      // The HALL (when the plan has one) stays furniture-free.
      const hall = plan.rooms.find(r => r.kind === "hall");
      if (hall) {
        for (const p of ps) {
          expect(`house ${hh.index} hall ${p.id}: ${inRect(p, hall.rect)}`).toBe(`house ${hh.index} hall ${p.id}: false`);
        }
      }
    }
  });

  it("round-6 MERGED-WET (§9 slice 3): the wet stations stand in the living room and the tub SURVIVES", () => {
    // Narrow-frontage, deep houses take the merged form: living +
    // bedroom, no bath cell. The point of handing the living room the
    // spare depth is that the tub still finds a wall — a merged house
    // must never be WORSE-equipped than the studio it replaced
    // (requireStation hygiene would block forever). Both door-side
    // chest-corner orientations checked.
    for (const door of ["south", "north", "east", "west"] as const) {
      const sideways = door === "east" || door === "west";
      const hh: TownHouse = {
        index: 7, dx: sideways ? -4.2 : -3.5, dy: sideways ? -3.5 : -4.2,
        w: sideways ? 8.4 : 7, h: sideways ? 7 : 8.4, door, color: "#a8875f", floors: 1,
      };
      const plan = houseRoomPlan(center, hh);
      expect(`${door}: ${plan.partitioned} ${plan.bathId}`).toBe(`${door}: true null`);
      expect(plan.rooms).toHaveLength(2);
      const ps = houseFurniture(center, hh, goods);
      const living = plan.rooms[0]!.rect;
      const bedRect = plan.rooms[1]!.rect;
      const inRect = (p: FurniturePiece, r: { x: number; y: number; w: number; h: number }) =>
        p.x - p.radius >= r.x - 1e-9 && p.x + p.radius <= r.x + r.w + 1e-9 &&
        p.y - p.radius >= r.y - 1e-9 && p.y + p.radius <= r.y + r.h + 1e-9;
      // The merged wet cluster followed its fallback into the COMMUNAL cell…
      for (const kind of ["bath", "privy"] as const) {
        const p = ps.find(x => x.kind === kind);
        expect(`${door} ${kind}: ${!!p && inRect(p, living)}`).toBe(`${door} ${kind}: true`);
      }
      // …while the sleep cluster kept its own cell.
      const bed = ps.find(x => x.id.endsWith("_bed_0"));
      expect(`${door} bed_0: ${!!bed && inRect(bed, bedRect)}`).toBe(`${door} bed_0: true`);
      expect(overlappingPairs(ps)).toEqual([]);
    }
  });

  it("a tiny house GOES WITHOUT what can't fit — never overlapping", () => {
    const tiny: TownHouse = {
      index: 3, dx: -2.1, dy: -1.7, w: 4.2, h: 3.4, door: "south", color: "#a8875f", floors: 1,
    };
    const p1 = houseFurniture(center, tiny, goods);
    expect(JSON.stringify(houseFurniture(center, tiny, goods))).toBe(JSON.stringify(p1));
    // No wall stretch clears the door swing AND the cupboard: beds are
    // omitted; the chairs would crowd the door lane: omitted too.
    expect(p1.filter(p => p.kind === "bed")).toHaveLength(0);
    expect(p1.filter(p => p.kind === "chair")).toHaveLength(0);
    // Boxes are per-member and live in member cells, which a studio this size
    // never realizes — so it goes without them too. Nothing is stranded by
    // that: an item's designated container falls back to the cupboard.
    expect(p1.filter(p => p.kind === "box")).toHaveLength(0);
    // And whatever IS emitted never overlaps.
    expect(overlappingPairs(p1)).toEqual([]);
  });
});

// ── round 6e: THE SERVICE LANE ──────────────────────────────────────────
// fits() keeps pieces off doors and off each other; the service lane
// keeps every station REACHABLE — a body (radius 0.4, wall keep-out 0.6)
// must be able to walk from a door to a standing cell beside each solid
// piece, and to every goods standing spot. This checker is an
// INDEPENDENT implementation (world-space, its own grid) of the
// invariant furniture.ts enforces frame-side.
describe("round-6e SERVICE LANE: every station stays reachable from a door", () => {
  const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];
  const SOLID = (k: FurniturePiece["kind"]): boolean => k !== "chair" && k !== "bowl";

  function assertRoomsServed(
    label: string,
    plan: ReturnType<typeof houseRoomPlan>,
    pieces: FurniturePiece[],
    spots: Array<{ x: number; y: number }>,
  ): void {
    for (const room of plan.rooms) {
      const r = room.rect;
      const step = 0.25;
      const nu = Math.max(2, Math.ceil(r.w / step));
      const nv = Math.max(2, Math.ceil(r.h / step));
      const xAt = (i: number): number => r.x + ((i + 0.5) * r.w) / nu;
      const yAt = (j: number): number => r.y + ((j + 0.5) * r.h) / nv;
      // Door corridors, world rects (uniform 1.1 m passage — stricter
      // than the generator's street porch, fine for connectivity).
      const corr = room.doorways.map(d => {
        const half = d.width / 2 + 0.1;
        const depth = 1.1;
        switch (d.edge) {
          case "north": return { x0: r.x + d.offset - half, x1: r.x + d.offset + half, y0: r.y, y1: r.y + depth };
          case "south": return { x0: r.x + d.offset - half, x1: r.x + d.offset + half, y0: r.y + r.h - depth, y1: r.y + r.h };
          case "west": return { x0: r.x, x1: r.x + depth, y0: r.y + d.offset - half, y1: r.y + d.offset + half };
          default: return { x0: r.x + r.w - depth, x1: r.x + r.w, y0: r.y + d.offset - half, y1: r.y + d.offset + half };
        }
      });
      const inCorr = (x: number, y: number): boolean =>
        corr.some(c => x > c.x0 && x < c.x1 && y > c.y0 && y < c.y1);
      const solids = pieces.filter(
        p => SOLID(p.kind) &&
          p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h,
      );
      const state = new Int8Array(nu * nv);
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const x = xAt(i);
          const y = yAt(j);
          let blocked = solids.some(
            p => Math.abs(x - p.x) < p.radius + 0.4 && Math.abs(y - p.y) < p.radius + 0.4,
          );
          if (!blocked) {
            const wallBand =
              x < r.x + 0.6 || x > r.x + r.w - 0.6 || y < r.y + 0.6 || y > r.y + r.h - 0.6;
            if (wallBand && !inCorr(x, y)) blocked = true;
          }
          state[j * nu + i] = blocked ? 2 : 1;
        }
      }
      const queue: number[] = [];
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const k = j * nu + i;
          if (state[k] === 1 && inCorr(xAt(i), yAt(j))) { state[k] = 3; queue.push(k); }
        }
      }
      while (queue.length) {
        const k = queue.pop()!;
        const i = k % nu;
        const j = (k / nu) | 0;
        if (i > 0 && state[k - 1] === 1) { state[k - 1] = 3; queue.push(k - 1); }
        if (i < nu - 1 && state[k + 1] === 1) { state[k + 1] = 3; queue.push(k + 1); }
        if (j > 0 && state[k - nu] === 1) { state[k - nu] = 3; queue.push(k - nu); }
        if (j < nv - 1 && state[k + nu] === 1) { state[k + nu] = 3; queue.push(k + nu); }
      }
      const reachedNear = (tx: number, ty: number, reach: number): boolean => {
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu; i++) {
            if (state[j * nu + i] !== 3) continue;
            if (Math.abs(xAt(i) - tx) <= reach && Math.abs(yAt(j) - ty) <= reach) return true;
          }
        }
        return false;
      };
      for (const p of solids) {
        expect(`${label} ${room.id} ${p.id} served: ${reachedNear(p.x, p.y, p.radius + 1.3)}`)
          .toBe(`${label} ${room.id} ${p.id} served: true`);
      }
      for (const [si, s] of spots.entries()) {
        if (s.x < r.x || s.x > r.x + r.w || s.y < r.y || s.y > r.y + r.h) continue;
        expect(`${label} ${room.id} spot${si} served: ${reachedNear(s.x, s.y, 0.3)}`)
          .toBe(`${label} ${room.id} spot${si} served: true`);
      }
    }
  }

  it("FULL SWEEP: every house's stations and goods spots keep a walkable approach", () => {
    let idx = 0;
    for (const door of ["north", "south", "east", "west"] as const) {
      for (let w = 7; w <= 13.01; w += 1.2) {
        for (let h = 7; h <= 10.01; h += 1.4) {
          const sideways = door === "east" || door === "west";
          const ww = sideways ? h : w;
          const hh = sideways ? w : h;
          const hhh: TownHouse = {
            index: idx++, dx: -ww / 2, dy: -hh / 2, w: ww, h: hh, door, color: "#a8875f", floors: 1,
          };
          const plan = houseRoomPlan(center, hhh);
          const ps = houseFurniture(center, hhh, goods);
          const spots = goods.map((g, i) => goodBoxAt(center, hhh, g.slot ?? i));
          assertRoomsServed(`house ${hhh.index} ${ww}x${hh} ${door}`, plan, ps, spots);
        }
      }
    }
  });
});

// ── Round 7: the KITCHEN cell — the cluster's stations follow their cell.
describe("round-7 kitchen: stove/cupboard/barrel stand IN the kitchen room when one exists", () => {
  const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];
  const inRoom = (p: FurniturePiece, r: { x: number; y: number; w: number; h: number }): boolean =>
    p.x - p.radius >= r.x - 1e-9 && p.x + p.radius <= r.x + r.w + 1e-9 &&
    p.y - p.radius >= r.y - 1e-9 && p.y + p.radius <= r.y + r.h + 1e-9;

  it("kitchen-cluster pieces live in the kitchen; the stove falls back to the hearth room otherwise", () => {
    let sawKitchen = 0;
    let sawFallbackStove = 0;
    let i = 0;
    for (const door of ["north", "south", "east", "west"] as const) {
      for (let w = 8; w <= 13.01; w += 0.8) {
        for (let d = 7.5; d <= 10.01; d += 0.7) {
          const sideways = door === "east" || door === "west";
          const h: TownHouse = {
            index: i++, dx: -(sideways ? d : w) / 2, dy: -(sideways ? w : d) / 2,
            w: sideways ? d : w, h: sideways ? w : d, door, color: "#a8875f", floors: 1,
          };
          const plan = houseRoomPlan(center, h);
          const kitchen = plan.rooms.find((r) => r.kind === "kitchen");
          const pieces = houseFurniture(center, h, goods);
          const kitPieces = pieces.filter((p) => ["oven", "cupboard", "barrel"].includes(p.kind));
          if (kitchen) {
            sawKitchen++;
            for (const p of kitPieces) {
              expect(`${h.index} ${p.id} in kitchen: ${inRoom(p, kitchen.rect)}`)
                .toBe(`${h.index} ${p.id} in kitchen: true`);
            }
            // The dedicated cell always fits its own stations (that's
            // what its minW floor bought).
            expect(kitPieces.some((p) => p.kind === "oven")).toBe(true);
          } else if (plan.partitioned) {
            const stove = pieces.find((p) => p.kind === "oven");
            if (stove) {
              sawFallbackStove++;
              expect(inRoom(stove, plan.rooms[0]!.rect)).toBe(true); // the hearth room
            }
          }
        }
      }
    }
    expect(sawKitchen).toBeGreaterThan(0);
    expect(sawFallbackStove).toBeGreaterThan(0);
  });
});
