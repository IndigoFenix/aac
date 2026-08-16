// shared/place/house.ts
//
// houseSpaceGenerator — a believable house FLOOR PLAN, generated puzzle-blind
// from function (the town's plaza/streets/districts logic, shrunk to one home):
//
//   • a LIVING ROOM across the front — the common hub (the "plaza"), where the
//     visitor enters (spawn) and everything hangs off.
//   • a HALL spine running back from it (the "street") — pure circulation, never
//     gated, the private rooms front it.
//   • ROLE ROOMS (the "districts with needs") in two bays either side of the
//     hall: the public rooms (kitchen, dining) open straight off the living room;
//     the private rooms (bedrooms, bath) sit down the hall. A bath tucked behind
//     the deepest bedroom becomes an ENSUITE — a naturally deeper, more private
//     room, the kind of chokepoint a gate can hide behind.
//
// The result is a TREE of rooms rooted at the living room, tiling ONE rectangle,
// with every door tagged by how plausibly it could be LOCKED and every room by
// its role, its content AFFINITY, and its accessibility DEPTH from the entrance.
// That is exactly the surface embed.ts maps a puzzle onto — the house knows
// nothing about the puzzle. Deterministic: same (roomsNeeded, seed) → same house.

import { mulberry32, hashSeed } from "@shared/prng.js";
import type {
  Fixture,
  PlaceDoor,
  PlaceRoom,
  PlaceSpace,
  Rect,
  RoomKind,
  SpaceGenerator,
  SpaceRequest,
  Vec2,
} from "./space.js";
import { rectCenter } from "./space.js";

// ---------------------------------------------------------------------------
// Dimensions (world meters) — a domestic, walk-around scale.
// ---------------------------------------------------------------------------

const HALL_W = 2.2; // corridor width
const BAY_W = 4.6; // a room's width across a bay
const LIVING_H = 6.0; // living-room depth (front block)
const DOOR_W = 1.4; // an interior doorway
const OPEN_W = 2.2; // an open-plan arch (living ↔ kitchen/dining)

/** Natural front-to-back depth of each role's room, before both bays are scaled
 *  to a common height (so the footprint stays a clean rectangle). */
const ROLE_H: Record<RoomKind, number> = {
  entrance: 3.0,
  living: LIVING_H,
  hall: 3.0,
  kitchen: 4.0,
  dining: 3.6,
  bedroom: 4.2,
  bath: 2.8,
  study: 3.6,
  storage: 3.2,
  utility: 3.0,
};

/** What naturally lives in each role — the embedder matches puzzle item
 *  categories to these (see shared/symbol-game/pools KIND_CATEGORY). */
const ROLE_AFFINITY: Record<RoomKind, string[]> = {
  entrance: [],
  living: ["toy", "book"],
  hall: [],
  kitchen: ["food", "drink"],
  dining: ["food", "tableware"],
  bedroom: ["toy", "clothing", "book"],
  bath: ["toiletry"],
  study: ["book", "tool"],
  storage: ["tool", "misc"],
  utility: ["tool"],
};

/** How plausibly a room's door can be LOCKED without reading as arbitrary. */
const ROLE_LOCKABILITY: Record<RoomKind, number> = {
  entrance: 0.8,
  living: 0.0,
  hall: 0.2,
  kitchen: 0.1,
  dining: 0.3,
  bedroom: 0.9,
  bath: 0.7,
  study: 0.5,
  storage: 0.5,
  utility: 0.4,
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Composition — which rooms this house holds (always richer than the puzzle
// asks: a kitchen and a bath exist even for a one-giver puzzle).
// ---------------------------------------------------------------------------

/** The role of each room per bay, front (nearest the living room) → back. The
 *  two FRONT rooms are the public ones (they open onto the living room); the
 *  rest are private, off the hall, bath deepest. */
function composeRooms(roomsNeeded: number, demand: RoomKind[]): { left: RoomKind[]; right: RoomKind[] } {
  // Total role rooms: what the puzzle needs plus surplus, so the place is never
  // just the puzzle. Floor of 4 guarantees kitchen + a public room + a bedroom +
  // a bath; cap keeps the home domestic.
  const P = clamp(roomsNeeded + 2, 4, 8);
  const roles: RoomKind[] = [];
  roles.push("kitchen"); // front-left: the open-plan kitchen
  roles.push(P >= 6 ? "dining" : "study"); // front-right: the other public room
  // The private wing: bedrooms down the hall, a bath at the very back.
  const backCount = P - 2;
  for (let i = 0; i < backCount; i++) {
    roles.push(i === backCount - 1 ? "bath" : "bedroom");
  }
  // Honor demanded kinds the composition missed (e.g. a food quest wants a
  // kitchen — already present; a study for a book quest) by retyping a bedroom.
  for (const kind of demand) {
    if (roles.includes(kind)) continue;
    const swap = roles.lastIndexOf("bedroom");
    if (swap >= 0) roles[swap] = kind;
  }

  // Deal into two bays: the two fronts lead, the rest alternate so both bays
  // grow backward evenly and the bath lands deepest in its bay (→ ensuite).
  const left: RoomKind[] = [roles[0]!];
  const right: RoomKind[] = [roles[1]!];
  roles.slice(2).forEach((r, i) => (i % 2 === 0 ? left : right).push(r));
  return { left, right };
}

// ---------------------------------------------------------------------------
// Furniture — a couple of role-flavored fixtures per room (containers to open,
// surfaces to place/see on). Deterministic from the room geometry.
// ---------------------------------------------------------------------------

function fix(
  id: string,
  kind: Fixture["kind"],
  rect: Rect,
  facing: number,
  openable: boolean,
  surface: boolean,
): Fixture {
  return { id, kind, rect, facing, openable, surface };
}

/** A small rect hugging a wall of `room`, `edge` side, centered along it. */
function atWall(room: Rect, edge: "north" | "south" | "east" | "west", w: number, h: number): Rect {
  const cx = room.x + room.w / 2;
  const cy = room.y + room.h / 2;
  const off = 0.12; // a hair off the wall (no z-fight)
  switch (edge) {
    case "north": return { x: cx - w / 2, y: room.y + off, w, h };
    case "south": return { x: cx - w / 2, y: room.y + room.h - h - off, w, h };
    case "west": return { x: room.x + off, y: cy - h / 2, w, h };
    case "east": return { x: room.x + room.w - w - off, y: cy - h / 2, w, h };
  }
}

const faceInto = (room: Rect, piece: Rect): number => {
  const c = rectCenter(room);
  const p = rectCenter(piece);
  return Math.atan2(c.y - p.y, c.x - p.x);
};

function furnishRoom(room: PlaceRoom, doorEdgeAwayFrom: "north" | "south" | "east" | "west"): Fixture[] {
  const r = room.rect;
  const out: Fixture[] = [];
  // The wall OPPOSITE the door takes the big piece (a bed, a sofa) — you don't
  // block your own doorway with furniture.
  const opp: Record<string, "north" | "south" | "east" | "west"> = {
    north: "south", south: "north", east: "west", west: "east",
  };
  const back = opp[doorEdgeAwayFrom];
  const p = (suffix: string) => `${room.id}_${suffix}`;
  switch (room.kind) {
    case "bedroom": {
      const bed = atWall(r, back, 2.0, 1.3);
      out.push(fix(p("bed"), "bed", bed, faceInto(r, bed), false, true));
      const wardrobe = atWall(r, doorEdgeAwayFrom === "east" ? "north" : "east", 0.9, 0.7);
      out.push(fix(p("wardrobe"), "cupboard", wardrobe, faceInto(r, wardrobe), true, false));
      break;
    }
    case "kitchen": {
      const counter = atWall(r, back, Math.min(2.6, r.w - 0.5), 0.7);
      out.push(fix(p("counter"), "counter", counter, faceInto(r, counter), false, true));
      const oven = atWall(r, "west", 0.8, 0.8);
      out.push(fix(p("oven"), "oven", oven, faceInto(r, oven), false, true));
      const cup = atWall(r, "east", 0.9, 0.7);
      out.push(fix(p("cupboard"), "cupboard", cup, faceInto(r, cup), true, false));
      break;
    }
    case "dining": {
      const table = { x: r.x + r.w / 2 - 0.9, y: r.y + r.h / 2 - 0.6, w: 1.8, h: 1.2 };
      out.push(fix(p("table"), "table", table, 0, false, true));
      const cup = atWall(r, back, 1.0, 0.6);
      out.push(fix(p("cupboard"), "cupboard", cup, faceInto(r, cup), true, false));
      break;
    }
    case "study": {
      const desk = atWall(r, back, 1.6, 0.7);
      out.push(fix(p("desk"), "desk", desk, faceInto(r, desk), false, true));
      const shelf = atWall(r, doorEdgeAwayFrom === "east" ? "north" : "east", 1.2, 0.5);
      out.push(fix(p("shelf"), "shelf", shelf, faceInto(r, shelf), true, false));
      break;
    }
    case "bath": {
      const sink = atWall(r, back, 0.8, 0.6);
      out.push(fix(p("sink"), "sink", sink, faceInto(r, sink), false, true));
      const cab = atWall(r, "west", 0.7, 0.5);
      out.push(fix(p("cabinet"), "cupboard", cab, faceInto(r, cab), true, false));
      break;
    }
    case "storage":
    case "utility": {
      const shelf = atWall(r, back, Math.min(2.2, r.w - 0.5), 0.6);
      out.push(fix(p("shelf"), "shelf", shelf, faceInto(r, shelf), true, false));
      const chest = atWall(r, "west", 0.8, 0.8);
      out.push(fix(p("chest"), "chest", chest, faceInto(r, chest), true, false));
      break;
    }
    case "living": {
      const sofa = atWall(r, "south", 2.4, 0.9);
      out.push(fix(p("sofa"), "sofa", sofa, faceInto(r, sofa), false, true));
      const table = { x: r.x + r.w / 2 - 0.7, y: r.y + r.h / 2 - 0.5, w: 1.4, h: 1.0 };
      out.push(fix(p("table"), "table", table, 0, false, true));
      break;
    }
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** BFS door-depth from the entrance room; fills room.depth in place. */
function assignDepths(rooms: PlaceRoom[], doors: PlaceDoor[], entranceId: string): void {
  const adj = new Map<string, string[]>();
  for (const r of rooms) adj.set(r.id, []);
  for (const d of doors) {
    adj.get(d.a)!.push(d.b);
    adj.get(d.b)!.push(d.a);
  }
  const byId = new Map(rooms.map((r) => [r.id, r]));
  for (const r of rooms) r.depth = Infinity;
  byId.get(entranceId)!.depth = 0;
  const queue = [entranceId];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = byId.get(cur)!.depth;
    for (const next of adj.get(cur)!) {
      const nr = byId.get(next)!;
      if (nr.depth > d + 1) {
        nr.depth = d + 1;
        queue.push(next);
      }
    }
  }
}

class HouseGenerator implements SpaceGenerator {
  readonly kind = "house";

  generate(req: SpaceRequest): PlaceSpace {
    const rng = mulberry32(hashSeed(req.seed, "house"));
    const jit = (base: number, amt: number) => base + (rng() - 0.5) * 2 * amt;

    const { left, right } = composeRooms(req.roomsNeeded, req.demandKinds ?? []);
    const bayW = jit(BAY_W, 0.5);
    const livingH = jit(LIVING_H, 0.6);
    const W = bayW * 2 + HALL_W;

    // Both bays scale to a common height so the footprint is a clean rectangle.
    const bayNat = (bay: RoomKind[]) => bay.reduce((a, k) => a + ROLE_H[k], 0);
    const BH = Math.max(bayNat(left), bayNat(right));
    const H = livingH + BH;

    const rooms: PlaceRoom[] = [];
    const doors: PlaceDoor[] = [];

    // The living room — full-width front block, the entrance hub.
    const living: PlaceRoom = {
      id: "living",
      kind: "living",
      rect: { x: 0, y: 0, w: W, h: livingH },
      depth: 0,
      circulation: true,
      affinity: ROLE_AFFINITY.living,
      fixtures: [],
      anchor: { x: W / 2, y: livingH / 2 },
    };
    living.fixtures = furnishRoom(living, "north");
    rooms.push(living);

    // The hall — the circulation spine up the middle, behind the living room.
    const hall: PlaceRoom = {
      id: "hall",
      kind: "hall",
      rect: { x: bayW, y: livingH, w: HALL_W, h: BH },
      depth: 1,
      circulation: true,
      affinity: [],
      fixtures: [],
      anchor: { x: bayW + HALL_W / 2, y: livingH + BH / 2 },
    };
    rooms.push(hall);
    doors.push({
      id: "d_living_hall",
      a: "living",
      b: "hall",
      at: { x: bayW + HALL_W / 2, y: livingH },
      edge: "north",
      width: Math.min(HALL_W, OPEN_W),
      lockability: ROLE_LOCKABILITY.hall,
    });

    // Lay a bay: rooms stacked front→back, scaled to fill BH. The front room
    // opens onto the LIVING room (public); the rest onto the HALL (private). A
    // bath behind a bedroom becomes an ENSUITE (door to that bedroom, not the
    // hall) — a deeper, more private room.
    const layBay = (bay: RoomKind[], side: "left" | "right"): void => {
      const nat = bayNat(bay);
      const x = side === "left" ? 0 : bayW + HALL_W;
      const hallEdge: PlaceDoor["edge"] = side === "left" ? "east" : "west";
      const hallX = side === "left" ? bayW : bayW + HALL_W;
      let y = livingH;
      let prevBedroom: PlaceRoom | null = null;
      bay.forEach((kind, i) => {
        const h = (ROLE_H[kind] * BH) / nat;
        const rect: Rect = { x, y, w: bayW, h };
        const id = `${side}${i}`;
        const room: PlaceRoom = {
          id,
          kind,
          rect,
          depth: Infinity,
          circulation: false,
          affinity: ROLE_AFFINITY[kind],
          fixtures: [],
          anchor: { x: x + bayW / 2, y: y + h / 2 },
        };

        if (i === 0) {
          // Front room: an open-plan arch onto the living room.
          const doorEdge: PlaceDoor["edge"] = "north"; // on living's north wall
          room.fixtures = furnishRoom(room, "south"); // door is on room's south
          doors.push({
            id: `d_living_${id}`,
            a: "living",
            b: id,
            at: { x: x + bayW / 2, y: livingH },
            edge: doorEdge,
            width: OPEN_W,
            lockability: ROLE_LOCKABILITY[kind],
          });
        } else if (kind === "bath" && prevBedroom) {
          // Ensuite: reached through the bedroom in front of it, not the hall.
          room.fixtures = furnishRoom(room, side === "left" ? "east" : "west");
          doors.push({
            id: `d_${prevBedroom.id}_${id}`,
            a: prevBedroom.id,
            b: id,
            at: { x: x + bayW / 2, y },
            edge: "north", // on the bedroom's north wall
            width: DOOR_W,
            lockability: ROLE_LOCKABILITY.bath,
          });
        } else {
          // Private room off the hall.
          room.fixtures = furnishRoom(room, hallEdge);
          doors.push({
            id: `d_hall_${id}`,
            a: "hall",
            b: id,
            at: { x: hallX, y: y + h / 2 },
            edge: hallEdge,
            width: DOOR_W,
            lockability: ROLE_LOCKABILITY[kind],
          });
        }

        rooms.push(room);
        if (kind === "bedroom") prevBedroom = room;
        y += h;
      });
    };
    layBay(left, "left");
    layBay(right, "right");

    assignDepths(rooms, doors, "living");
    // Orient every door a=shallower, b=deeper (gate `b` behind `a` with the
    // accessibility grain), now that depths are known.
    const depthOf = new Map(rooms.map((r) => [r.id, r.depth]));
    for (const d of doors) {
      if ((depthOf.get(d.a) ?? 0) > (depthOf.get(d.b) ?? 0)) {
        [d.a, d.b] = [d.b, d.a];
      }
    }

    return {
      kind: "house",
      rooms,
      doors,
      footprint: { x: 0, y: 0, w: W, h: H },
      entranceRoomId: "living",
    };
  }
}

/** The house space generator (shared/place SpaceGenerator). */
export const houseSpaceGenerator: SpaceGenerator = new HouseGenerator();

/** Convenience: generate a house directly. */
export function generateHouse(roomsNeeded: number, seed: number, demandKinds?: RoomKind[]): PlaceSpace {
  return houseSpaceGenerator.generate({ roomsNeeded, seed, ...(demandKinds ? { demandKinds } : {}) });
}
