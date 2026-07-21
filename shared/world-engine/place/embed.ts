// shared/place/embed.ts
//
// embedPuzzle — THE MARRIAGE (docs/SPACE_EMBEDDING.md). Maps a goal-tree
// LogicalWorld (the puzzle DAG — zones + gated passages + content) onto a
// puzzle-blind PlaceSpace (house, dungeon, …), producing the world + geometry the
// engine plays on PLUS the diegetic justification for every gate. Written once
// against PlaceSpace + LogicalWorld, so it serves any generator.
//
// The puzzle these worlds emit is a STAR: every giver/supplier zone hangs off the
// start zone by a FREE passage; only the final prize zone (root marker) is gated,
// behind clearing the whole star. That maps onto a house TREE without strain —
// the circulation (living + hall) becomes free pass-through zones, each helper's
// room is reached freely, and the prize's own door carries the locks. The
// embedding TRANSFORMS the star world into a house-shaped world (adding the
// circulation zones as free passages) that is completability-equivalent, so the
// certificate survives — then lays content and raises one contiguous house.

import { mulberry32, hashSeed } from "@shared/prng.js";
import { projectContentOnZones } from "../solver/projector2d.js";
import { START_ZONE_ID } from "../solver/logical-world.js";
import type {
  LogicalWorld,
  PassageGuard,
  ZoneKind,
  ZoneSpec,
} from "../solver/logical-world.js";
import type { DoorLayout, Layout2D, Rect as LRect } from "../solver/layout2d.js";
import type { GoalTreeGame } from "../solver/types.js";
import type { BuildingDoorway, BuildingSpec } from "../types.js";
import { KIND_CATEGORY } from "../interaction/content/pools.js";
import type { Fixture, PlaceDoor, PlaceRoom, PlaceSpace } from "./space.js";

/** Why a gate is locked, sourced from the PLACE, not the puzzle — the thing that
 *  sells "it wasn't built around the puzzle". */
export interface GateJustification {
  /** The place door the gate sits on. */
  doorId: string;
  /** The world passage it realizes (the puzzle's own gated edge). */
  passageId: string;
  /** Diegetic reason: "locked-bedroom" (a key the owner holds), "cupboard"
   *  (a latched store), "private-room", … */
  reason: string;
}

export interface PuzzleEmbedding {
  /** The house-shaped world the engine plays — the star world with circulation
   *  zones added as free passages (completability-equivalent to the input). */
  world: LogicalWorld;
  /** The certifiable geometry (zones = rooms, doors = passages, content in
   *  role-appropriate rooms). validateLayout2D(game, embedding.world, layout) holds. */
  layout: Layout2D;
  /** One BuildingSpec per room — they tile the footprint into a single
   *  contiguous house with interior walls (raise via expandWorldBuildings). */
  buildings: BuildingSpec[];
  /** Every fixture in the placed rooms (containers to open, surfaces to see on). */
  fixtures: Fixture[];
  /** The chosen room per ORIGINAL world zone ("zone:q0_giver" → "left1"). */
  roomByZone: Record<string, string>;
  /** Gate reasons, one per gated passage. */
  gates: GateJustification[];
}

const EPS = 1e-3;
/** Interior partition wall thickness (metres). */
const HOUSE_WALL = 0.3;
/** Door opening thickness ACROSS the wall (straddles it, half each side). */
const DOOR_T = 1.2;

/** Role-tinted wall colour (looks; the house doesn't use colour as clue vocab). */
const ROOM_COLOR: Record<string, string> = {
  living: "#b8a074",
  hall: "#c8bda0",
  kitchen: "#c7a86a",
  dining: "#c1996b",
  bedroom: "#9fb0c4",
  bath: "#8fb7bf",
  study: "#b09ec4",
  storage: "#a89a86",
  utility: "#9a9a9a",
  entrance: "#c8bda0",
};

/** The diegetic reason a room's door is locked, by role. */
function gateReason(kind: string): string {
  switch (kind) {
    case "bedroom": return "locked-bedroom";
    case "bath": return "private-room";
    case "study": return "study-locked";
    case "storage":
    case "utility": return "cupboard";
    default: return "private-room";
  }
}

/** Content categories staged in a zone (from its placed items' glyph heads) —
 *  what the room that hosts it should have an AFFINITY for. */
function zoneCategories(game: GoalTreeGame, world: LogicalWorld, zoneId: string): Set<string> {
  const glyphOf = new Map(game.entities.map((e) => [e.id, e.glyph ?? e.id]));
  const cats = new Set<string>();
  for (const p of world.items) {
    if (p.zoneId !== zoneId) continue;
    for (const id of p.itemEntityIds) {
      const head = (glyphOf.get(id) ?? id).split(".")[0]!;
      const cat = KIND_CATEGORY[head];
      if (cat) cats.add(cat);
    }
  }
  return cats;
}

/** Which room wall a point sits on, and the offset along it from the room's
 *  min corner (buildingStructures' convention). Null when off every wall. */
function doorwayOnRoom(r: Rect, at: { x: number; y: number }, width: number): BuildingDoorway | null {
  if (Math.abs(at.y - r.y) < EPS) return { edge: "north", offset: at.x - r.x, width };
  if (Math.abs(at.y - (r.y + r.h)) < EPS) return { edge: "south", offset: at.x - r.x, width };
  if (Math.abs(at.x - r.x) < EPS) return { edge: "west", offset: at.y - r.y, width };
  if (Math.abs(at.x - (r.x + r.w)) < EPS) return { edge: "east", offset: at.y - r.y, width };
  return null;
}

type Rect = { x: number; y: number; w: number; h: number };

/** Wall stub each doorway leaves on both sides (a doorway can't be the whole
 *  wall — buildingStructures needs jamb segments). */
const DOOR_STUB = 0.4;

/** The opening width that fits BOTH rooms' shared wall (leaving jambs) — a wide
 *  archway onto the hall still needs a scrap of wall each side. */
function fitWidth(a: PlaceRoom, b: PlaceRoom, d: PlaceDoor): number {
  const horiz = d.edge === "north" || d.edge === "south";
  const la = horiz ? a.rect.w : a.rect.h;
  const lb = horiz ? b.rect.w : b.rect.h;
  return Math.max(0.9, Math.min(d.width, la - 2 * DOOR_STUB, lb - 2 * DOOR_STUB));
}

/** A layout door rect straddling the shared wall the place door sits on. */
function doorRect(d: PlaceDoor, width: number): LRect {
  return d.edge === "north" || d.edge === "south"
    ? { x: d.at.x - width / 2, y: d.at.y - DOOR_T / 2, w: width, h: DOOR_T }
    : { x: d.at.x - DOOR_T / 2, y: d.at.y - width / 2, w: DOOR_T, h: width };
}

/**
 * Embed a STAR puzzle onto a place. Returns null when the world isn't a star
 * (every passage from start) or the place has too few role rooms — the caller
 * then falls back / regenerates a bigger place (the space flexes, never the
 * puzzle). See docs/SPACE_EMBEDDING.md.
 */
export function embedPuzzle(
  game: GoalTreeGame,
  world: LogicalWorld,
  space: PlaceSpace,
  seed: number,
): PuzzleEmbedding | null {
  // STAR check: every passage originates at the start zone.
  if (!world.passages.every((p) => p.from === world.startZoneId)) return null;

  const puzzleZones = world.zones.filter((z) => z.id !== world.startZoneId);
  const roleRooms = space.rooms.filter((r) => !r.circulation);
  if (roleRooms.length < puzzleZones.length) return null;

  const rng = mulberry32(hashSeed(seed, "embed"));

  // The gated zones (the prize behind the star) and their guards.
  const guardsByZone = new Map<string, PassageGuard[]>();
  for (const p of world.passages) {
    if (p.guards.length > 0) guardsByZone.set(p.to, p.guards);
  }

  // Per-room accessibility facts: depth, and the lockability of its ONE incoming
  // door (the door where the room is the deeper side `b`).
  const incomingLock = new Map<string, number>();
  for (const d of space.doors) incomingLock.set(d.b, d.lockability);
  const roomById = new Map(space.rooms.map((r) => [r.id, r]));

  // ---- Assignment (seeded greedy CSP) -------------------------------------
  // Gated zones want a DEEP, lockable room (the locked back room); free zones
  // want a room whose AFFINITY matches their content (food → kitchen).
  const assignedRoom = new Map<string, string>(); // zoneId → roomId
  const usedRooms = new Set<string>();

  const takeRoom = (score: (r: PlaceRoom) => number): string | null => {
    let best: PlaceRoom | null = null;
    let bestScore = -Infinity;
    for (const r of roleRooms) {
      if (usedRooms.has(r.id)) continue;
      const s = score(r) + rng() * 0.01; // deterministic tiny jitter breaks ties
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (!best) return null;
    usedRooms.add(best.id);
    return best.id;
  };

  // Gated zones first — deepest, most lockable rooms.
  const gated = puzzleZones.filter((z) => guardsByZone.has(z.id));
  const free = puzzleZones.filter((z) => !guardsByZone.has(z.id));
  for (const z of gated) {
    const room = takeRoom((r) => r.depth * 2 + (incomingLock.get(r.id) ?? 0) * 3);
    if (!room) return null;
    assignedRoom.set(z.id, room);
  }
  // Free zones by affinity match, then shallower (helpers near the living room).
  for (const z of free) {
    const cats = zoneCategories(game, world, z.id);
    const room = takeRoom((r) => {
      const hit = r.affinity.filter((a) => cats.has(a)).length;
      return hit * 5 - r.depth;
    });
    if (!room) return null;
    assignedRoom.set(z.id, room);
  }

  // roomId → the zone id it carries in the transformed world. Assigned rooms
  // keep the ORIGINAL zone id (figures/items/sites reference it); the entrance
  // is the start zone; every other room is a free circulation/surplus zone.
  const roomToZoneId = new Map<string, string>();
  for (const [zoneId, roomId] of assignedRoom) roomToZoneId.set(roomId, zoneId);
  const zoneIdOfRoom = (roomId: string): string => {
    if (roomId === space.entranceRoomId) return START_ZONE_ID;
    return roomToZoneId.get(roomId) ?? `hzone:${roomId}`;
  };

  // ---- Transformed world --------------------------------------------------
  const origZone = new Map(world.zones.map((z) => [z.id, z]));
  const zones: ZoneSpec[] = space.rooms.map((room) => {
    const zid = zoneIdOfRoom(room.id);
    const orig = origZone.get(zid);
    if (orig) return orig; // start or an assigned puzzle zone — keep it verbatim
    return { id: zid, kind: "reach" as ZoneKind, ownerNodeId: null, hint: room.kind };
  });

  const passages = space.doors.map((d) => {
    const from = zoneIdOfRoom(d.a);
    const to = zoneIdOfRoom(d.b);
    return { id: `hpass:${d.id}`, from, to, guards: guardsByZone.get(to) ?? [] };
  });

  const tWorld: LogicalWorld = {
    startZoneId: START_ZONE_ID,
    zones,
    passages,
    items: world.items,
    distractors: world.distractors,
    figures: world.figures,
    sites: world.sites,
  };

  // ---- Geometry -----------------------------------------------------------
  const zoneRects = new Map<string, Rect>();
  for (const room of space.rooms) zoneRects.set(zoneIdOfRoom(room.id), room.rect);

  // Each opening's width, fitted so it leaves jambs on both rooms' walls.
  const doorWidth = new Map<string, number>();
  for (const d of space.doors) {
    doorWidth.set(d.id, fitWidth(roomById.get(d.a)!, roomById.get(d.b)!, d));
  }

  const doors: DoorLayout[] = space.doors.map((d) => ({
    passageId: `hpass:${d.id}`,
    rect: doorRect(d, doorWidth.get(d.id)!),
  }));

  const content = projectContentOnZones(game, tWorld, zoneRects as Map<string, LRect>, doors);
  const layout: Layout2D = {
    zones: space.rooms.map((room) => ({ zoneId: zoneIdOfRoom(room.id), rect: room.rect })),
    doors,
    figures: content.figures,
    items: content.items,
    spawn: content.spawn,
  };

  // ---- Buildings (one per room → a single contiguous house) ---------------
  const roomDoorways = new Map<string, BuildingDoorway[]>();
  const gates: GateJustification[] = [];
  for (const d of space.doors) {
    const to = zoneIdOfRoom(d.b);
    const locked = guardsByZone.has(to);
    for (const roomId of [d.a, d.b]) {
      const r = roomById.get(roomId)!;
      const dw = doorwayOnRoom(r.rect, d.at, doorWidth.get(d.id)!);
      if (!dw) continue;
      if (locked) dw.locked = true;
      const list = roomDoorways.get(roomId) ?? [];
      list.push(dw);
      roomDoorways.set(roomId, list);
    }
    if (locked) {
      gates.push({ doorId: d.id, passageId: `hpass:${d.id}`, reason: gateReason(roomById.get(d.b)!.kind) });
    }
  }
  const buildings: BuildingSpec[] = space.rooms.map((room) => ({
    id: `house_${room.id}`,
    footprint: room.rect,
    floors: 1,
    wallThickness: HOUSE_WALL,
    doorways: roomDoorways.get(room.id) ?? [],
    color: ROOM_COLOR[room.kind] ?? "#b0a084",
  }));

  const roomByZone: Record<string, string> = {};
  for (const [zoneId, roomId] of assignedRoom) roomByZone[zoneId] = roomId;

  return {
    world: tWorld,
    layout,
    buildings,
    fixtures: space.rooms.flatMap((r) => r.fixtures),
    roomByZone,
    gates,
  };
}
