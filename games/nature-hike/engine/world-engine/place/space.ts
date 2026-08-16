// shared/place/space.ts
//
// The GENERIC PLACE MODEL: a believable, puzzle-blind space — rooms + circulation
// + fixtures — carrying exactly the affordances a puzzle EMBEDDING needs
// (accessibility depth, lockable doors, room roles/needs, container + surface
// slots for content). Place-kind agnostic: a house, a dungeon, an office all
// produce a PlaceSpace; embed.ts maps a puzzle onto any of them.
//
// No goal-tree dependency lives here — a SpaceGenerator knows nothing about the
// puzzle it will host. That one-way boundary (embed.ts depends on this, never the
// reverse) is what lets the same generators serve any puzzle DAG, and the same
// embedder serve any place. See docs/SPACE_EMBEDDING.md.

/** Axis-aligned rectangle, world meters (min-corner + size). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Which functional role a room plays. Circulation kinds (entrance/living/hall)
 *  are the "plaza + streets"; the rest are "districts with needs". Open string
 *  friendly at the edges, but these are the vocabulary the house speaks. */
export type RoomKind =
  | "entrance"
  | "living"
  | "hall"
  | "kitchen"
  | "dining"
  | "bedroom"
  | "bath"
  | "study"
  | "storage"
  | "utility";

/** A furniture fixture: a thing that stands in a room. Its two flags are the
 *  affordances the embedding places content against — an OPENABLE hides items
 *  until opened (a clue in a drawer); a SURFACE shows what sits on it (a toy on
 *  the table is seen at a glance). */
export interface Fixture {
  id: string;
  kind:
    | "bed"
    | "table"
    | "counter"
    | "chest"
    | "cupboard"
    | "shelf"
    | "oven"
    | "sofa"
    | "sink"
    | "desk";
  /** Footprint (min-corner + size), world meters. */
  rect: Rect;
  /** Which way the front/opening faces (radians, 0 = +x) — into the room. */
  facing: number;
  /** A container that can be opened; hides its contents until then. */
  openable: boolean;
  /** A surface things rest ON (visible without opening). */
  surface: boolean;
}

export interface PlaceRoom {
  id: string;
  kind: RoomKind;
  /** Interior floor rect (rooms tile edge-to-edge; walls are drawn on the shared
   *  boundaries when the building is raised). */
  rect: Rect;
  /** Circulation distance from the entrance, in DOORS (entrance = 0). The
   *  accessibility gradient — deeper is more private, where later puzzle steps
   *  and stronger gates naturally belong. */
  depth: number;
  /** True for entrance/living/hall — the common circulation that is NEVER gated.
   *  Role rooms (false) can host a gate on their door. */
  circulation: boolean;
  /** What naturally belongs here — the embedding matches puzzle item categories
   *  to these ("kitchen" → ["food"], a kid's "bedroom" → ["toy"]). Empty for
   *  pure circulation. */
  affinity: string[];
  fixtures: Fixture[];
  /** A clear standing spot (a resident/figure stands here; content staged near
   *  it). Guaranteed inside the room and off the fixtures. */
  anchor: Vec2;
}

export interface PlaceDoor {
  id: string;
  /** The two rooms it joins (undirected). `a` is the shallower room (toward the
   *  entrance); `b` the deeper — so gating `b` behind `a` reads with the grain. */
  a: string;
  b: string;
  /** Center of the opening. */
  at: Vec2;
  /** The wall edge the opening sits on, relative to room `a`. */
  edge: "north" | "south" | "east" | "west";
  width: number;
  /** How plausibly this door can be LOCKED without reading as arbitrary:
   *  0 = never (an open-plan kitchen↔living arch), 1 = totally natural (a bedroom
   *  door, a cabinet). The embedding spends gates on the most lockable doors. */
  lockability: number;
}

export interface PlaceSpace {
  /** The generator that made it ("house", …). */
  kind: string;
  rooms: PlaceRoom[];
  doors: PlaceDoor[];
  /** The single outer shell (one building footprint), world meters. */
  footprint: Rect;
  /** The room the visitor enters at — the puzzle spawn. */
  entranceRoomId: string;
}

export interface SpaceRequest {
  /** How many role rooms the puzzle must be housed in (givers etc.). The
   *  generator adds circulation + surplus rooms around this — the place is always
   *  richer than the puzzle needs. */
  roomsNeeded: number;
  seed: number;
  /** Optional: role kinds the puzzle demands exist at least one of (a kitchen for
   *  a food quest). The generator guarantees them. */
  demandKinds?: RoomKind[];
}

/** The extension point: a house, a dungeon, an office each implement this. The
 *  embedder (embed.ts) is written once against PlaceSpace and serves them all. */
export interface SpaceGenerator {
  readonly kind: string;
  generate(req: SpaceRequest): PlaceSpace;
}

// ---------------------------------------------------------------------------
// Generic helpers (shared by generators, the embedder, and tests)
// ---------------------------------------------------------------------------

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectsOverlap(a: Rect, b: Rect, eps = 1e-6): boolean {
  return (
    a.x < b.x + b.w - eps &&
    b.x < a.x + a.w - eps &&
    a.y < b.y + b.h - eps &&
    b.y < a.y + a.h - eps
  );
}

/** roomId → the rooms it shares a door with (adjacency of the place graph). */
export function adjacency(space: PlaceSpace): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const r of space.rooms) adj.set(r.id, []);
  for (const d of space.doors) {
    adj.get(d.a)?.push(d.b);
    adj.get(d.b)?.push(d.a);
  }
  return adj;
}

/** Every room reachable from the entrance through doors? A believable place is
 *  fully connected — no walled-off islands. */
export function isConnected(space: PlaceSpace): boolean {
  const adj = adjacency(space);
  const seen = new Set<string>([space.entranceRoomId]);
  const stack = [space.entranceRoomId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen.size === space.rooms.length;
}
