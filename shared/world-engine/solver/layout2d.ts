// shared/goal-tree/layout2d.ts
//
// The geometric layout format Space2D plays on. Step 4's map projector will
// GENERATE this from a LogicalWorld (and must preserve its topology — that's
// what keeps the solver's certificate valid); until then layouts can be
// hand-authored for tests and engine development.
//
// Conventions:
//   - World units are abstract; the renderer picks pixels-per-unit.
//   - Zones are axis-aligned, non-overlapping rectangles.
//   - A door spans the shared edge of its passage's two zones; it is
//     walkable when unlocked and solid while any guard is uncleared.

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ZoneLayout {
  zoneId: string;
  rect: Rect;
}

export interface DoorLayout {
  passageId: string;
  rect: Rect;
}

export interface FigureLayout {
  /** Goal node this figure belongs to (matches LogicalWorld.figures). */
  nodeId: string;
  entityId: string;
  pos: Vec2;
}

export interface ItemLayout {
  /** Target instances use the runtime's instance ids; distractors use any
   * unique id the projector picks (they never reach runtime state). */
  instanceId: string;
  entityId: string;
  pos: Vec2;
  distractor?: boolean;
}

export interface Layout2D {
  zones: ZoneLayout[];
  doors: DoorLayout[];
  figures: FigureLayout[];
  items: ItemLayout[];
  /** Player spawn point, inside the start zone. */
  spawn: Vec2;
}

// ---------------------------------------------------------------------------
// Geometry helpers (shared by the sim and, later, the projector/renderer)
// ---------------------------------------------------------------------------

export function rectContains(rect: Rect, p: Vec2, inset = 0): boolean {
  return (
    p.x >= rect.x + inset &&
    p.x <= rect.x + rect.w - inset &&
    p.y >= rect.y + inset &&
    p.y <= rect.y + rect.h - inset
  );
}

export function rectCenter(rect: Rect): Vec2 {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
