// shared/goal-tree/space3d.ts
//
// Space3D — the goal-tree quest runtime embedded into the WORLD ENGINE, the
// long-reserved "Space3D" the space.ts boundary anticipates ("Space2D now,
// Space3D … later") and the world-engine's reserved `ContentKind: "goal-tree"`
// ("embed via Space"). It is the headless half of the Phase-0 merge spike:
//
//   • locomotion is the world engine's — the avatar is driven by runWorldHost
//     (the SAME per-frame loop the social world uses), constrained by the quest
//     walls (makeWallConstraint). Space3D no longer runs its own tick; the engine
//     owns movement and Space3D only supplies the wall constraint + detection;
//   • the quest runtime is UNCHANGED — Space3D feeds it the same SpaceInput
//     (enter-zone / pick-item / touch-figure / touch-door) and applies the same
//     SpaceCommand (unlock-passage / collect-item) as Space2D. The reducer,
//     solver, and certification never learn which space drives them.
//
// Walls are REAL: the layout's rooms (zone rects + open door rects) become a
// MoveConstraint the world engine enforces during locomotion (engine.advanceAvatar
// slides the avatar along solid edges). A locked door is solid, so a room stays
// physically sealed until its passage unlocks — the avatar can't reach a marker
// in an unopened room, and the quest can't be won early. This replaces the
// reachability substitute the first spike used; detection is now plain proximity,
// because the avatar can only get near content it can physically reach.
//
// Locked doors are "tried" by approach: a solid door still lets the avatar come
// within doorTouchRadius of it (it slides up against the wall), which fires
// touch-door → the runtime clears the obstacle if its key is done → the passage
// unlocks → the door rect becomes walkable and the avatar passes through.

import type { Layout2D, Rect, Vec2 } from "./layout2d.js";
import { dist, rectCenter, rectContains } from "./layout2d.js";
import type { LogicalWorld } from "./logical-world.js";
import type { SpaceCommand, SpaceInput } from "./space.js";
import type { GoalTreeGame, StationKind, TransportRelation } from "./types.js";
import { STATION_KINDS } from "./types.js";
import { walkGoalTree } from "./walk.js";
import type { ObjectSpec, WorldSpec } from "../types.js";
import type { MoveConstraint } from "../engine.js";

/** The single local avatar id Space3D drives. */
export const PLAYER_ID = "player";

/** Clearance left around the layout's bounding box when sizing the manifold, so
 *  the avatar (clamped to the manifold) can stand at the field's edge cells. */
const EMBED_MARGIN = 1.5;

// ---------------------------------------------------------------------------
// Embedding: Layout2D → WorldSpec
// ---------------------------------------------------------------------------

export interface WorldEmbedding {
  /** The generated world the engine simulates the avatar in. */
  spec: WorldSpec;
  /**
   * The layout TRANSLATED into world-engine coordinates (manifold origin at
   * 0,0). Space3D detection and the 3D overlay both read this — avatar and
   * content then share one coordinate space, so they line up with no per-call
   * offset math.
   */
  layout: Layout2D;
}

function shift(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h };
}
function shiftPoint(p: Vec2, dx: number, dy: number): Vec2 {
  return { x: p.x + dx, y: p.y + dy };
}

/**
 * Build a flat WorldSpec sized to the layout's bounding box (+margin) and
 * translate the layout into it so the manifold starts at (0,0). The world is a
 * single-player sandbox manifold — the quest content rides as the Space layer
 * on top (per the reserved-seam design), NOT encoded into WorldSpec fields, so
 * no world-engine schema change is needed for the spike.
 */
export function embedLayoutInWorld(layout: Layout2D): WorldEmbedding {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const z of layout.zones) {
    minX = Math.min(minX, z.rect.x);
    minY = Math.min(minY, z.rect.y);
    maxX = Math.max(maxX, z.rect.x + z.rect.w);
    maxY = Math.max(maxY, z.rect.y + z.rect.h);
  }
  const dx = EMBED_MARGIN - minX;
  const dy = EMBED_MARGIN - minY;

  const translated: Layout2D = {
    zones: layout.zones.map((z) => ({ ...z, rect: shift(z.rect, dx, dy) })),
    doors: layout.doors.map((d) => ({ ...d, rect: shift(d.rect, dx, dy) })),
    figures: layout.figures.map((f) => ({ ...f, pos: shiftPoint(f.pos, dx, dy) })),
    items: layout.items.map((i) => ({ ...i, pos: shiftPoint(i.pos, dx, dy) })),
    spawn: shiftPoint(layout.spawn, dx, dy),
  };

  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "quest", locale: "en", theme: "quest" },
    manifold: {
      kind: "flat",
      width: maxX - minX + EMBED_MARGIN * 2,
      height: maxY - minY + EMBED_MARGIN * 2,
    },
    terrain: { kind: "flat" },
    spawns: [{ id: "spawn", x: translated.spawn.x, y: translated.spawn.y }],
    objects: [],
    multiplayer: { maxPlayers: 1, authority: "distributed" },
    content: { kind: "sandbox" },
  };

  return { spec, layout: translated };
}

// ---------------------------------------------------------------------------
// Transport puzzles: world objects placed in a transport node's zone
// ---------------------------------------------------------------------------

/** A transport puzzle's runtime handles: the carry object(s) + their destination
 *  container, and the node that completes when the TARGET lands on it. */
export interface TransportPlacement {
  nodeId: string;
  /** World id of the TARGET carryable — the one that completes the beat. */
  objectId: string;
  /** World ids of WRONG carryables (selection beats); empty for plain transport. */
  distractorObjectIds: string[];
  destId: string;
  relation?: TransportRelation;
  /** Composed glyph of the wanted item, for a selection beat — the player shows
   *  it as a bubble over the destination ("bring THIS here"). Absent for a plain
   *  single-object transport. */
  wantGlyph?: string;
}

export interface TransportObjects {
  /** World-engine objects to add to the embedded WorldSpec (carryables + container). */
  objects: ObjectSpec[];
  placements: TransportPlacement[];
}

/**
 * Materialize each `transport` node's carryable(s) and destination CONTAINER as
 * real world-engine objects in the node's (translated) zone. A selection beat
 * (the node has `distractorEntityIds`) fans the target + distractors as a row of
 * carryables; the destination shows the TARGET's icon, so "bring the matching
 * one" reads with no words. The player adds `objects` to the embedded WorldSpec
 * and watches `placements` to know when the target lands (→ place-object) or a
 * distractor lands (→ decline + carry-again).
 */
export function buildTransportObjects(
  game: GoalTreeGame,
  world: LogicalWorld,
  layout: Layout2D,
): TransportObjects {
  const entityOf = (entityId: string) => game.entities.find((e) => e.id === entityId);
  const iconOf = (entityId: string): string | undefined => entityOf(entityId)?.iconRef;

  const objects: ObjectSpec[] = [];
  const placements: TransportPlacement[] = [];
  for (const { node } of walkGoalTree(game.root)) {
    if (node.type !== "transport") continue;
    const rect = layout.zones.find((z) => z.zoneId === world.sites[node.id])?.rect;
    if (!rect) continue;

    const objectId = `obj_${node.id}`;
    const destId = `dest_${node.id}`;
    const distractorIds = (node.distractorEntityIds ?? []).map((_, i) => `${objectId}_d${i}`);

    // Carryables fanned across the lower band of the zone, well separated so each
    // can be dwell-selected on its own.
    const carry: { id: string; iconRef?: string }[] = [
      { id: objectId, iconRef: iconOf(node.objectEntityId) },
      ...(node.distractorEntityIds ?? []).map((eid, i) => ({ id: distractorIds[i]!, iconRef: iconOf(eid) })),
    ];
    const n = carry.length;
    const x0 = rect.x + 1.6;
    const span = Math.max(0, rect.w - 3.2);
    const cyCarry = rect.y + rect.h * 0.34;
    carry.forEach((c, i) => {
      const x = n === 1 ? rect.x + rect.w * 0.5 : x0 + (span * i) / (n - 1);
      objects.push({
        id: c.id,
        x,
        y: cyCarry,
        shape: "box",
        radius: 0.45,
        interactions: ["carry"],
        ...(c.iconRef ? { iconRef: c.iconRef } : {}),
      });
    });

    // Destination shows its OWN icon (a basket/recipient) — NEVER a clone of the
    // item, so a recipient never wears the item's face. For a selection beat the
    // wanted item is communicated by a glyph bubble over it (the player draws it).
    const destIcon = iconOf(node.destEntityId);
    const wantGlyph = distractorIds.length ? entityOf(node.objectEntityId)?.glyph : undefined;
    objects.push({
      id: destId,
      x: rect.x + rect.w * 0.5,
      y: rect.y + rect.h * 0.74,
      shape: "box",
      radius: 1.0,
      interactions: [],
      contains: [{ relation: node.relation ?? "on" }],
      ...(destIcon ? { iconRef: destIcon } : {}),
    });

    placements.push({
      nodeId: node.id,
      objectId,
      distractorObjectIds: distractorIds,
      destId,
      relation: node.relation,
      ...(wantGlyph ? { wantGlyph } : {}),
    });
  }
  return { objects, placements };
}

// ---------------------------------------------------------------------------
// Converse items: physical carry objects + vendor stock behind a counter
// ---------------------------------------------------------------------------

/** One converse item materialized as a REAL world carry object. */
export interface ConverseWorldItem {
  /** World object id. For a prop this IS the runtime instance id, so the player
   *  can dispatch `pick-item` with it when the object is picked up. */
  objectId: string;
  entityId: string;
  forNodeId: string;
  /** prop = loose in the room (pickable); stock = the NPC's own (owned, granted
   *  by dialogue — the vendor fetches and hands it over). */
  kind: "prop" | "stock";
  /** Where it sits (a stock item's fetch-errand target). */
  pos: Vec2;
}

export interface ConverseObjects {
  /** World-engine objects to add to the embedded spec (items + counters). */
  objects: ObjectSpec[];
  items: ConverseWorldItem[];
  /** Per-creature staging: where it stands (home) and stows items (stockpile). */
  staging: { nodeId: string; home: Vec2; stockpile: Vec2 }[];
  /** Placement-need containers (fulfill `needPlacedInEntityId`), staged in the
   *  creature's zone — the player watches drops INTO these (containedIn). */
  dests: { nodeId: string; entityId: string; objectId: string }[];
  /** Transformation stations (fulfill `stationKinds`) — the player watches
   *  drops ON these and applies the state swap. */
  stations: {
    nodeId: string;
    kind: StationKind;
    objectId: string;
    applies: string;
    removes: string;
    /** POWER-gated station (§5): this generator device must be ON to transform. */
    powerDeviceId?: string;
  }[];
}

/** Minimal instance shape (mirrors the runtime's ItemInstance expansion). */
export interface ConverseInstanceRef {
  id: string;
  entityId: string;
  forNodeId: string;
}

/**
 * Materialize every converse node's items as REAL world objects (directive:
 * items use the carry template — holding one means having it):
 *   • props (walk-over placements) become loose carryables at their projected
 *     spots — the player layer dispatches `pick-item` when one is picked up;
 *   • `receive`-granted entities become STOCK: carryables parked BEHIND the
 *     NPC, with a counter box between NPC and room — ownership (player layer)
 *     makes them un-grabbable until the dialogue grants them.
 */
export function buildConverseObjects(
  game: GoalTreeGame,
  instances: ConverseInstanceRef[],
  world: LogicalWorld,
  layout: Layout2D,
): ConverseObjects {
  const iconOf = (entityId: string): string | undefined =>
    game.entities.find((e) => e.id === entityId)?.iconRef;
  // Composed variants (descriptors — "ball.big") render their GLYPH as the
  // floating icon; plain items keep the emoji (identical and cheaper).
  const glyphOf = (entityId: string): string | undefined => {
    const g = game.entities.find((e) => e.id === entityId)?.glyph;
    return g && g.includes(".") ? g : undefined;
  };
  const objects: ObjectSpec[] = [];
  const items: ConverseWorldItem[] = [];
  const staging: ConverseObjects["staging"] = [];
  const dests: ConverseObjects["dests"] = [];
  const stations: ConverseObjects["stations"] = [];

  const converseNodes = [...walkGoalTree(game.root)]
    .map((v) => v.node)
    .filter((n) => n.type === "converse" || n.type === "fulfill");
  const converseIds = new Set(converseNodes.map((n) => n.id));

  // -- props: the projected item instances, as carryables at the same spots
  for (const inst of instances) {
    if (!converseIds.has(inst.forNodeId)) continue;
    const pos = layout.items.find((i) => i.instanceId === inst.id)?.pos;
    if (!pos) continue;
    objects.push({
      id: inst.id,
      x: pos.x,
      y: pos.y,
      shape: "sphere",
      radius: 0.5,
      interactions: ["carry"],
      ...(iconOf(inst.entityId) ? { iconRef: iconOf(inst.entityId) } : {}),
      ...(glyphOf(inst.entityId) ? { glyph: glyphOf(inst.entityId) } : {}),
    });
    items.push({ objectId: inst.id, entityId: inst.entityId, forNodeId: inst.forNodeId, kind: "prop", pos });
  }

  // -- stock + counters, staged around the NPC figure
  for (const node of converseNodes) {
    if (node.type !== "converse" && node.type !== "fulfill") continue;
    const fig = layout.figures.find((f) => f.nodeId === node.id);
    const zoneRect = layout.zones.find((z) => z.zoneId === world.sites[node.id])?.rect;
    if (!fig || !zoneRect) continue;

    const props = new Set(node.propEntityIds ?? []);
    const stockIds: string[] = [];
    if (node.type === "fulfill") {
      // A fulfill creature's stock is declared directly; bound KEEPSAKES stand
      // in the same display row (ownership + bind make them un-grantable).
      for (const id of [...(node.stockEntityIds ?? []), ...(node.boundEntityIds ?? [])]) {
        if (!props.has(id) && !stockIds.includes(id)) stockIds.push(id);
      }
    } else {
      // A converse node's stock is whatever its dialogue can grant.
      for (const turn of node.turns) {
        for (const opt of turn.options) {
          for (const id of opt.receive ?? []) {
            if (!props.has(id) && !stockIds.includes(id)) stockIds.push(id);
          }
        }
      }
    }

    // "Behind" = away from the room center; the counter sits in front. The
    // STOCKPILE (where the creature stows what it's given) sits behind too,
    // offset sideways from the stock row; HOME is where it stands. Every
    // staged point is CLAMPED into the zone with walking clearance — a spot
    // in the wall would wedge the NPC's errand forever.
    const c = rectCenter(zoneRect);
    let dx = fig.pos.x - c.x;
    let dy = fig.pos.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) { dx = 0; dy = -1; } else { dx /= d; dy /= d; }
    const px = -dy; // perpendicular, to fan multiple stock items
    const py = dx;
    const M = 1.0; // wall clearance for staged points
    const inZone = (p: Vec2): Vec2 => ({
      x: Math.min(zoneRect.x + zoneRect.w - M, Math.max(zoneRect.x + M, p.x)),
      y: Math.min(zoneRect.y + zoneRect.h - M, Math.max(zoneRect.y + M, p.y)),
    });
    // Spacing: staged points sit WELL apart (stockpile off to one side, stock
    // row on the other) so dwell-picking one thing never fights its neighbors.
    staging.push({
      nodeId: node.id,
      home: { x: fig.pos.x, y: fig.pos.y },
      stockpile: inZone({
        x: fig.pos.x + dx * 2.6 - px * (((stockIds.length + 1) / 2) * 2.0 + 1.2),
        y: fig.pos.y + dy * 2.6 - py * (((stockIds.length + 1) / 2) * 2.0 + 1.2),
      }),
    });
    // Placement-need container: an open box IN FRONT of the creature, offset
    // to the side so it never overlaps the counter or the dwell-to-talk spot.
    // Same shape as a transport destination — drops land `in` it. An OUTDOORS
    // container (the smelly-food garbage can) stages in the start-zone plaza
    // instead — open ground by construction — off-center so it never sits on
    // the spawn point.
    if (node.type === "fulfill" && node.needPlacedInEntityId) {
      const startRect = layout.zones.find((z) => z.zoneId === world.startZoneId)?.rect;
      const at =
        node.needPlacedOutdoors && startRect
          ? { x: startRect.x + startRect.w * 0.75, y: startRect.y + startRect.h * 0.75 }
          : inZone({ x: fig.pos.x - dx * 2.0 + px * 2.4, y: fig.pos.y - dy * 2.0 + py * 2.4 });
      const objectId = `dest_${node.id}`;
      objects.push({
        id: objectId,
        x: at.x,
        y: at.y,
        shape: "box",
        radius: 1.0,
        interactions: [],
        contains: [{ relation: "in" }],
        ...(iconOf(node.needPlacedInEntityId) ? { iconRef: iconOf(node.needPlacedInEntityId) } : {}),
      });
      dests.push({ nodeId: node.id, entityId: node.needPlacedInEntityId, objectId });
    }
    // Transformation stations: reusable affordances IN FRONT of the creature,
    // fanned to the side opposite the placement container. Items dropped ON
    // one get their state swapped (the player layer watches containedIn).
    if (node.type === "fulfill" && node.stationKinds?.length) {
      node.stationKinds.forEach((kind: StationKind, i: number) => {
        const def = STATION_KINDS[kind];
        const at = inZone({
          x: fig.pos.x - dx * 2.0 - px * (2.4 + i * 2.2),
          y: fig.pos.y - dy * 2.0 - py * (2.4 + i * 2.2),
        });
        const objectId = `station_${node.id}_${kind}`;
        objects.push({
          id: objectId,
          x: at.x,
          y: at.y,
          shape: "box",
          radius: 0.9,
          interactions: [],
          contains: [{ relation: "on" }],
          iconRef: def.iconRef,
        });
        stations.push({
          nodeId: node.id,
          kind,
          objectId,
          applies: def.applies,
          removes: def.removes,
          ...(node.stationPowerDeviceId ? { powerDeviceId: node.stationPowerDeviceId } : {}),
        });
      });
    }
    if (!stockIds.length) continue;

    // (Removed the `counter_<node>` box: it carried no glyph/fixture, so it
    //  rendered as a featureless grey CUBE in front of every vendor and only
    //  added a stray collider. The stock spheres below are the vendor's visible
    //  wares; stores proper are the openable market containers, quest-host §5.)

    stockIds.forEach((entityId, i) => {
      const spread = (i - (stockIds.length - 1) / 2) * 2.0;
      const pos = inZone({
        x: fig.pos.x + dx * 2.4 + px * spread,
        y: fig.pos.y + dy * 2.4 + py * spread,
      });
      const objectId = `stock_${node.id}_${entityId}`;
      objects.push({
        id: objectId,
        x: pos.x,
        y: pos.y,
        shape: "sphere",
        radius: 0.5,
        interactions: ["carry"],
        ...(iconOf(entityId) ? { iconRef: iconOf(entityId) } : {}),
        ...(glyphOf(entityId) ? { glyph: glyphOf(entityId) } : {}),
      });
      items.push({ objectId, entityId, forNodeId: node.id, kind: "stock", pos });
    });
  }

  return { objects, items, staging, dests, stations };
}

// ---------------------------------------------------------------------------
// Config + state
// ---------------------------------------------------------------------------

export interface Space3DConfig {
  /** Auto-pick items within this distance. */
  pickRadius: number;
  /** Figures activate within this distance. */
  touchRadius: number;
  /** A locked door is "tried" when the avatar comes this close to its center. */
  doorTouchRadius: number;
  /** Seconds between repeated touch-door emissions for the same door. */
  doorTouchCooldown: number;
}

export const SPACE3D_DEFAULTS: Space3DConfig = {
  pickRadius: 0.9,
  touchRadius: 1.2,
  doorTouchRadius: 1.1,
  doorTouchCooldown: 1.5,
};

export interface Space3DState {
  /** Last zone the avatar registered as entering. */
  zoneId: string;
  /** Passages opened by the runtime (unguarded ones start open). */
  unlocked: Record<string, true>;
  /** Items removed by the runtime (collected). */
  removed: Record<string, true>;
  inPickRadius: Record<string, true>;
  inTouchRadius: Record<string, true>;
  lastDoorTouch: Record<string, number>;
  time: number;
}

export function createSpace3DState(world: LogicalWorld): Space3DState {
  const unlocked: Record<string, true> = {};
  for (const passage of world.passages) {
    if (passage.guards.length === 0) unlocked[passage.id] = true;
  }
  // The avatar spawns at layout.spawn, which is inside the start zone.
  return {
    zoneId: world.startZoneId,
    unlocked,
    removed: {},
    inPickRadius: {},
    inTouchRadius: {},
    lastDoorTouch: {},
    time: 0,
  };
}

// ---------------------------------------------------------------------------
// Commands from the runtime
// ---------------------------------------------------------------------------

export function applySpace3DCommand(
  state: Space3DState,
  command: SpaceCommand,
): Space3DState {
  switch (command.type) {
    case "unlock-passage":
      state.unlocked[command.passageId] = true;
      return state;
    case "collect-item":
      state.removed[command.instanceId] = true;
      return state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Locomotion seam: a wall constraint the host applies to engine movement
// ---------------------------------------------------------------------------

/**
 * The quest's walls as an engine MoveConstraint: zone interiors + currently-open
 * doors are walkable, locked doors solid. The `walkable` closure reads the live
 * `state.unlocked`, so a door that opens becomes passable immediately. The host
 * (runWorldHost) applies it to the avatar's locomotion — Space3D no longer runs
 * its own tick; the engine owns movement.
 */
export function makeWallConstraint(layout: Layout2D, state: Space3DState): MoveConstraint {
  return { walkable: (p, r) => walkableInLayout(layout, state.unlocked, p, r) };
}

// ---------------------------------------------------------------------------
// Detection: per-frame proximity → SpaceInput (called from the host's onFrame)
// ---------------------------------------------------------------------------

/**
 * Edge-triggered proximity detection against the avatar's CURRENT position,
 * producing the same SpaceInput the runtime consumes. Walls already keep the
 * avatar away from content in an unopened room, so this is plain proximity. `dt`
 * advances the door-cooldown clock.
 */
export function detectSpace3D(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  dt: number,
  config: Space3DConfig = SPACE3D_DEFAULTS,
): SpaceInput[] {
  state.time += Math.max(0, dt);
  const inputs: SpaceInput[] = [];
  detectZoneChange(layout, state, pos, inputs);
  detectItemPickups(layout, state, pos, config, inputs);
  detectFigureTouches(layout, state, pos, config, inputs);
  detectDoorTouches(layout, state, pos, config, inputs);
  return inputs;
}

// ---------------------------------------------------------------------------
// Walls — the walkable region the engine constraint enforces
// ---------------------------------------------------------------------------

/**
 * The walkable region: any zone interior (inset by the avatar radius so it can't
 * stand half-inside a wall) OR an OPEN door rect (the slot bridging two
 * radius-inset zones — checked without inset, exactly as Space2D does, so 2D and
 * 3D agree on what's passable). A locked door is absent from `unlocked` and so is
 * solid.
 */
export function walkableInLayout(
  layout: Layout2D,
  unlocked: Record<string, true>,
  p: Vec2,
  radius: number,
): boolean {
  for (const zone of layout.zones) {
    if (rectContains(zone.rect, p, radius)) return true;
  }
  for (const door of layout.doors) {
    if (unlocked[door.passageId] && rectContains(door.rect, p)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// World queries + detection (edge-triggered, mirroring Space2D)
// ---------------------------------------------------------------------------

export function zoneAt(layout: Layout2D, p: Vec2): string | null {
  for (const zone of layout.zones) {
    if (rectContains(zone.rect, p)) return zone.zoneId;
  }
  return null;
}

function detectZoneChange(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  inputs: SpaceInput[],
): void {
  const zone = zoneAt(layout, pos);
  if (zone && zone !== state.zoneId) {
    state.zoneId = zone;
    inputs.push({ type: "enter-zone", zoneId: zone });
  }
}

function detectItemPickups(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  config: Space3DConfig,
  inputs: SpaceInput[],
): void {
  for (const item of layout.items) {
    if (state.removed[item.instanceId]) continue;
    const within = dist(pos, item.pos) <= config.pickRadius;
    const wasWithin = !!state.inPickRadius[item.instanceId];
    if (within && !wasWithin) {
      inputs.push({
        type: "pick-item",
        instanceId: item.instanceId,
        entityId: item.entityId,
      });
    }
    if (within) state.inPickRadius[item.instanceId] = true;
    else delete state.inPickRadius[item.instanceId];
  }
}

function detectFigureTouches(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  config: Space3DConfig,
  inputs: SpaceInput[],
): void {
  for (const figure of layout.figures) {
    const within = dist(pos, figure.pos) <= config.touchRadius;
    const wasWithin = !!state.inTouchRadius[figure.nodeId];
    if (within && !wasWithin) {
      inputs.push({ type: "touch-figure", nodeId: figure.nodeId });
    }
    if (within) state.inTouchRadius[figure.nodeId] = true;
    else delete state.inTouchRadius[figure.nodeId];
  }
}

function detectDoorTouches(
  layout: Layout2D,
  state: Space3DState,
  pos: Vec2,
  config: Space3DConfig,
  inputs: SpaceInput[],
): void {
  for (const door of layout.doors) {
    if (state.unlocked[door.passageId]) continue; // open — nothing to try
    // The avatar can only get within range of a locked door from a room it has
    // physically reached (the far side is walled off), so proximity alone is the
    // correct trigger — no reachability bookkeeping needed.
    if (dist(pos, rectCenter(door.rect)) <= config.doorTouchRadius) {
      const last = state.lastDoorTouch[door.passageId];
      if (last !== undefined && state.time - last < config.doorTouchCooldown) {
        continue;
      }
      state.lastDoorTouch[door.passageId] = state.time;
      inputs.push({ type: "touch-door", passageId: door.passageId });
    }
  }
}
