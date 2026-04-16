/**
 * Pure selectors over RuntimeState + GameDefinition.
 * No mutation; all functions are safe to call at render time.
 */

import type {
  ClassDef,
  GameDefinition,
  GridCoord,
  Layer,
  MatchSpec,
  OverridableProp,
  RelativePosition,
  RoomDef,
} from "@shared/custom-app-types";
import type { EntityInstance, RuntimeState } from "./engine-types";

const LAYER_ORDER: Record<Layer, number> = {
  background: 0,
  entity: 1,
  overlay: 2,
};

export function getRoom(def: GameDefinition, roomId: string): RoomDef {
  const r = def.rooms.find((r) => r.id === roomId);
  if (!r) throw new Error(`unknown room: ${roomId}`);
  return r;
}

export function getClass(def: GameDefinition, classId: string): ClassDef {
  const c = def.classes.find((c) => c.id === classId);
  if (!c) throw new Error(`unknown class: ${classId}`);
  return c;
}

export function getEntity(state: RuntimeState, uid: string): EntityInstance | undefined {
  return state.entities[uid];
}

/** Resolve a property on an entity: state override > instance override > class default. */
export function getProp<K extends OverridableProp>(
  def: GameDefinition,
  entity: EntityInstance,
  prop: K,
): unknown {
  if (prop in entity.overrides) return entity.overrides[prop];
  const cls = getClass(def, entity.classId);
  return (cls as unknown as Record<string, unknown>)[prop];
}

export function getLayer(def: GameDefinition, entity: EntityInstance): Layer {
  const cls = getClass(def, entity.classId);
  return cls.layer ?? "entity";
}

export function isTile(def: GameDefinition, entity: EntityInstance): boolean {
  const cls = getClass(def, entity.classId);
  return cls.isTile ?? false;
}

export function isSolid(def: GameDefinition, entity: EntityInstance): boolean {
  const v = getProp(def, entity, "isSolid");
  return typeof v === "boolean" ? v : false;
}

/** All entities in the current room (excludes contained entities). */
export function getRoomEntities(state: RuntimeState): EntityInstance[] {
  return Object.values(state.entities).filter((e) => !e.containerUid);
}

/** Entities whose position overlaps the given cell. Contained entities are excluded. */
export function getEntitiesAtCell(
  def: GameDefinition,
  state: RuntimeState,
  cell: GridCoord,
): EntityInstance[] {
  const [cx, cy] = cell;
  const out: EntityInstance[] = [];
  for (const e of getRoomEntities(state)) {
    const cls = getClass(def, e.classId);
    const [w, h] = cls.size ?? [1, 1];
    const [x, y] = e.position;
    if (cx >= x && cx < x + w && cy >= y && cy < y + h) out.push(e);
  }
  return out;
}

/** Entities currently contained inside the given uid. */
export function getContainedEntities(state: RuntimeState, containerUid: string): EntityInstance[] {
  return Object.values(state.entities).filter((e) => e.containerUid === containerUid);
}

/**
 * Order entities at a cell from bottom (drawn first) to top (drawn last / clicked first).
 * Lower layer < higher layer; within layer, tiles below non-tiles; then insertion order.
 */
export function sortStackBottomToTop(
  def: GameDefinition,
  entities: EntityInstance[],
): EntityInstance[] {
  return [...entities].sort((a, b) => {
    const la = LAYER_ORDER[getLayer(def, a)];
    const lb = LAYER_ORDER[getLayer(def, b)];
    if (la !== lb) return la - lb;
    const ta = isTile(def, a) ? 0 : 1;
    const tb = isTile(def, b) ? 0 : 1;
    if (ta !== tb) return ta - tb;
    return 0;
  });
}

export function topmostAtCell(
  def: GameDefinition,
  state: RuntimeState,
  cell: GridCoord,
): EntityInstance | undefined {
  const stack = sortStackBottomToTop(def, getEntitiesAtCell(def, state, cell));
  return stack[stack.length - 1];
}

// ---------------------------------------------------------------------------
// Match resolution
// ---------------------------------------------------------------------------

/** Does `entity` satisfy a match_spec (ignoring position, which is resolved elsewhere)? */
export function entityMatchesSpec(
  def: GameDefinition,
  entity: EntityInstance,
  spec: MatchSpec,
): boolean {
  const cls = getClass(def, entity.classId);
  const types = cls.types ?? [];

  if (spec.classId !== undefined && entity.classId !== spec.classId) return false;
  if (spec.states !== undefined && !spec.states.includes(entity.state)) return false;
  if (spec.types !== undefined && !spec.types.some((t) => types.includes(t))) return false;
  if (spec.requiredTypes !== undefined && !spec.requiredTypes.every((t) => types.includes(t))) return false;
  if (spec.forbiddenTypes !== undefined && spec.forbiddenTypes.some((t) => types.includes(t))) return false;

  if (spec.counter !== undefined) {
    const val = entity.counters[spec.counter.id];
    if (val === undefined) return false;
    const { op, value } = spec.counter;
    if (op === "gt" && !(val > value)) return false;
    if (op === "lt" && !(val < value)) return false;
    if (op === "eq" && !(val === value)) return false;
    if (op === "gte" && !(val >= value)) return false;
    if (op === "lte" && !(val <= value)) return false;
  }
  return true;
}

/**
 * Candidate "other" entities for a given self and relative position.
 * Does NOT filter by the rest of the match_spec — caller does that.
 */
export function candidatesByPosition(
  def: GameDefinition,
  state: RuntimeState,
  self: EntityInstance,
  position: RelativePosition,
): EntityInstance[] {
  const selfCls = getClass(def, self.classId);
  const [w, h] = selfCls.size ?? [1, 1];
  const [sx, sy] = self.position;

  switch (position) {
    case "sameCell": {
      const seen = new Set<string>();
      const out: EntityInstance[] = [];
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
          for (const e of getEntitiesAtCell(def, state, [sx + dx, sy + dy])) {
            if (e.uid === self.uid) continue;
            if (seen.has(e.uid)) continue;
            seen.add(e.uid);
            out.push(e);
          }
        }
      }
      return out;
    }
    case "adjacent": {
      const seen = new Set<string>();
      const out: EntityInstance[] = [];
      const cells: GridCoord[] = [];
      for (let x = sx; x < sx + w; x++) {
        cells.push([x, sy - 1]);
        cells.push([x, sy + h]);
      }
      for (let y = sy; y < sy + h; y++) {
        cells.push([sx - 1, y]);
        cells.push([sx + w, y]);
      }
      for (const c of cells) {
        for (const e of getEntitiesAtCell(def, state, c)) {
          if (e.uid === self.uid) continue;
          if (seen.has(e.uid)) continue;
          seen.add(e.uid);
          out.push(e);
        }
      }
      return out;
    }
    case "inside":
      return getContainedEntities(state, self.uid);
    case "contains":
      if (self.containerUid === undefined) return [];
      {
        const c = state.entities[self.containerUid];
        return c ? [c] : [];
      }
  }
}

/**
 * Resolve the `other` entity for a trigger: pick the topmost candidate that satisfies
 * both position and the rest of the match_spec. Returns undefined if nothing matches.
 */
export function resolveOther(
  def: GameDefinition,
  state: RuntimeState,
  self: EntityInstance,
  other: MatchSpec,
): EntityInstance | undefined {
  const position = other.position ?? "sameCell";
  const candidates = candidatesByPosition(def, state, self, position);
  const filtered = candidates.filter((c) => entityMatchesSpec(def, c, other));
  const sorted = sortStackBottomToTop(def, filtered);
  return sorted[sorted.length - 1];
}

// ---------------------------------------------------------------------------
// Drop rule resolution
// ---------------------------------------------------------------------------

/** Can `entity` be dropped at `cell`? Considers isSolid, dropRules, and footprint. */
export function canDropAt(
  def: GameDefinition,
  state: RuntimeState,
  entity: EntityInstance,
  cell: GridCoord,
): boolean {
  const cls = getClass(def, entity.classId);
  const [w, h] = cls.size ?? [1, 1];
  const [cx, cy] = cell;
  const room = getRoom(def, state.currentRoomId);
  const [rw, rh] = room.size;

  if (cx < 0 || cy < 0 || cx + w > rw || cy + h > rh) return false;

  // Allow drops back to the original position.
  const [ox, oy] = entity.position;
  const isOriginal = ox === cx && oy === cy && entity.containerUid === undefined;
  if (isOriginal) return true;

  // Check solid collisions across footprint.
  if (isSolid(def, entity)) {
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        for (const occupant of getEntitiesAtCell(def, state, [cx + dx, cy + dy])) {
          if (occupant.uid === entity.uid) continue;
          if (isSolid(def, occupant)) return false;
        }
      }
    }
  }
  // Check tile-on-same-layer exclusion.
  if (isTile(def, entity)) {
    const entityLayer = getLayer(def, entity);
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        for (const occupant of getEntitiesAtCell(def, state, [cx + dx, cy + dy])) {
          if (occupant.uid === entity.uid) continue;
          if (isTile(def, occupant) && getLayer(def, occupant) === entityLayer) return false;
        }
      }
    }
  }

  // dropRules check: the cell must match at least one rule.
  if (!cls.dropRules || cls.dropRules.length === 0) return false;

  for (const rule of cls.dropRules) {
    if (rule.type === "sameCell") {
      const here = getEntitiesAtCell(def, state, cell).filter((e) => e.uid !== entity.uid);
      if (here.some((e) => rule.classIds.includes(e.classId))) return true;
    } else if (rule.type === "adjacentTo") {
      const adj: GridCoord[] = [
        [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
      ];
      for (const a of adj) {
        const occ = getEntitiesAtCell(def, state, a).filter((e) => e.uid !== entity.uid);
        if (occ.some((e) => rule.classIds.includes(e.classId))) return true;
      }
    }
    // "inside" is checked by canDropInsideContainer — not applicable for a cell drop.
  }

  return false;
}

/** Can `entity` be dropped inside `container`? */
export function canDropInsideContainer(
  def: GameDefinition,
  state: RuntimeState,
  entity: EntityInstance,
  container: EntityInstance,
): boolean {
  const cls = getClass(def, entity.classId);
  if (!cls.canBeContained) return false;
  const containerCls = getClass(def, container.classId);
  if (containerCls.maxCapacity === undefined) return false;

  const rule = (cls.dropRules ?? []).find(
    (r) => r.type === "inside" && r.classIds.includes(container.classId),
  );
  if (!rule) return false;

  const containedNow = getContainedEntities(state, container.uid);
  const usedSize = containedNow.reduce((sum, e) => {
    const ec = getClass(def, e.classId);
    return sum + (ec.containSize ?? 1);
  }, 0);
  const addSize = cls.containSize ?? 1;
  return usedSize + addSize <= containerCls.maxCapacity;
}
