// shared/goal-tree/projector2d.ts
//
// Map projection: LogicalWorld → Layout2D, plus clinician layout overrides
// and the layout validator. Exports, one lifecycle:
//
//   projectGameLayout      — the projector games actually use: VILLAGE
//                            geometry for star-shaped worlds, east-icicle
//                            fallback for deeper trees
//   projectLayout2D        — the deterministic east-icicle geometry
//   projectVillage2D       — plaza + houses geometry (null when the zone
//                            graph isn't a star)
//   applyLayout2DOverrides — sparse hand-edit diff on top of the projection
//   validateLayout2D       — invariants any layout (projected or edited)
//                            must satisfy before reaching a student
//
// East-icicle algorithm: the zone graph is a tree, so each zone's rect height
// equals its subtree band (own height, or the sum of its children's bands if
// larger) and children stack top-to-bottom on the parent's east edge in
// passage order. Non-overlap holds by construction: sibling subtrees occupy
// disjoint vertical bands, children sit strictly east of the parent column.
// Doors are centered on each child's shared edge segment.
//
// Village algorithm: when EVERY non-start zone hangs directly off the start
// zone (the shape the symbol-game quest generators emit), the start zone
// becomes a central PLAZA and each child zone a HOUSE footprint attached to
// one of its four edges, spread along it — the geometric bones the world
// engine's buildings are later raised on. Seeded (meta.seed): house order,
// edge assignment, and small size jitter vary per seed while every rect stays
// derived, so the same seed reproduces the same village.
//
// Determinism & stability: pure arithmetic over construction-ordered arrays
// (+ an explicit seeded rng for the village) — same world + seed, same
// layout. Inside a zone, content is placed on a golden-angle spiral in a
// fixed order (figures, target items, distractors), so APPENDING content
// never moves earlier placements. Structural edits can still shift sibling
// bands; clinician overrides pin what matters and orphaned overrides drop
// silently.

import type { GoalTreeGame } from "./types.js";
import { hashSeed, mulberry32 } from "@shared/prng.js";
import type { LogicalWorld, ZoneKind } from "./logical-world.js";
import type {
  DoorLayout,
  FigureLayout,
  ItemLayout,
  Layout2D,
  Rect,
  Vec2,
  ZoneLayout,
} from "./layout2d.js";
import { dist, rectCenter, rectContains } from "./layout2d.js";
import { createRuntimeContext } from "./runtime.js";
import { SPACE2D_DEFAULTS } from "./space2d.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Projector2DConfig {
  zoneSizes: Record<ZoneKind, { w: number; h: number }>;
  /** Zones holding more than this many placed things use crowdedSize. */
  crowdedAt: number;
  crowdedSize: { w: number; h: number };
  /** Content keep-away from zone walls. */
  margin: number;
  /** Minimum spacing between placed figures/items (and the spawn). */
  minSeparation: number;
  /** Door extent along the shared edge. */
  doorLength: number;
  /** Door extent across the shared edge (half into each zone). */
  doorThickness: number;
  /** Content keep-away from door centers (don't block doorways). */
  doorClearance: number;
  /** Distractors per collect ≈ targets × ratio, clamped to [min, max]. */
  distractorRatio: number;
  distractorMin: number;
  distractorMax: number;
}

export const PROJECTOR2D_DEFAULTS: Projector2DConfig = {
  // Rooms are sized so each space comfortably CONTAINS its content (figures +
  // items + the poser) with room to walk between them — icons are ~1.3 world
  // units, so separation/margin are scaled to leave a real gap. Enlarged from
  // the original 10×8 prototype per the symbol-game layout pass.
  zoneSizes: {
    start: { w: 14, h: 14 },
    reach: { w: 14, h: 12 },
    collect: { w: 14, h: 12 },
    pocket: { w: 9, h: 9 },
  },
  crowdedAt: 6,
  crowdedSize: { w: 18, h: 15 },
  margin: 1.8,
  minSeparation: 2.4,
  doorLength: 3,
  doorThickness: 1,
  doorClearance: 2,
  distractorRatio: 0.5,
  distractorMin: 2,
  distractorMax: 4,
};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface DistractorPlanEntry {
  instanceId: string;
  entityId: string;
  zoneId: string;
}

/** Distractor instances are a projector decision (density), not authored. */
function planDistractors(
  world: LogicalWorld,
  config: Projector2DConfig,
): DistractorPlanEntry[] {
  const targetsByNode = new Map<string, number>();
  for (const placement of world.items) {
    targetsByNode.set(
      placement.forNodeId,
      (targetsByNode.get(placement.forNodeId) ?? 0) + placement.count,
    );
  }
  const out: DistractorPlanEntry[] = [];
  for (const spec of world.distractors) {
    const targets = targetsByNode.get(spec.forNodeId) ?? 0;
    const count = Math.min(
      config.distractorMax,
      Math.max(config.distractorMin, Math.round(targets * config.distractorRatio)),
    );
    for (let i = 0; i < count; i++) {
      out.push({
        instanceId: `distractor:${spec.forNodeId}:${i}`,
        entityId: spec.entityIds[i % spec.entityIds.length],
        zoneId: spec.zoneId,
      });
    }
  }
  return out;
}

/** Content expansion + per-zone tallies — zone sizing reads these. */
function planContent(game: GoalTreeGame, world: LogicalWorld, config: Projector2DConfig) {
  const ctx = createRuntimeContext(game, world);
  const distractorPlan = planDistractors(world, config);
  const tally = new Map<string, number>();
  const bump = (zoneId: string) => tally.set(zoneId, (tally.get(zoneId) ?? 0) + 1);
  for (const figure of world.figures) bump(figure.zoneId);
  for (const instance of ctx.instances) bump(instance.zoneId);
  for (const distractor of distractorPlan) bump(distractor.zoneId);

  const kindByZone = new Map(world.zones.map((z) => [z.id, z.kind]));
  const sizeOf = (zoneId: string): { w: number; h: number } => {
    if ((tally.get(zoneId) ?? 0) > config.crowdedAt) return config.crowdedSize;
    return config.zoneSizes[kindByZone.get(zoneId) ?? "reach"];
  };
  return { ctx, distractorPlan, sizeOf };
}

type ContentPlan = ReturnType<typeof planContent>;

/** Shared content pass: spawn at the start-zone center, then figures, target
 *  items, distractors on the spiral — identical for every zone geometry. */
function placeContent(
  world: LogicalWorld,
  plan: ContentPlan,
  zoneRects: Map<string, Rect>,
  doors: DoorLayout[],
  config: Projector2DConfig,
): Pick<Layout2D, "figures" | "items" | "spawn"> {
  // Door centers per zone (content keeps doorways clear on both sides).
  const passageEnds = new Map(world.passages.map((p) => [p.id, p]));
  const doorCentersByZone = new Map<string, Vec2[]>();
  for (const door of doors) {
    const passage = passageEnds.get(door.passageId);
    if (!passage) continue;
    const center = rectCenter(door.rect);
    for (const zoneId of [passage.from, passage.to]) {
      const list = doorCentersByZone.get(zoneId) ?? [];
      list.push(center);
      doorCentersByZone.set(zoneId, list);
    }
  }

  // Spawn first (content avoids it), then figures, targets, distractors —
  // appending content never moves earlier placements.
  const spawn = rectCenter(zoneRects.get(world.startZoneId)!);
  const occupiedByZone = new Map<string, Vec2[]>([[world.startZoneId, [spawn]]]);
  const placeInZone = (zoneId: string): Vec2 => {
    const rect = zoneRects.get(zoneId)!;
    const occupied = occupiedByZone.get(zoneId) ?? [];
    occupiedByZone.set(zoneId, occupied);
    const doorCenters = doorCentersByZone.get(zoneId) ?? [];
    const pos = findSpot(rect, occupied, doorCenters, config);
    occupied.push(pos);
    return pos;
  };

  const figures: FigureLayout[] = world.figures.map((figure) => ({
    nodeId: figure.forNodeId,
    entityId: figure.entityId,
    pos: placeInZone(figure.zoneId),
  }));

  const items: ItemLayout[] = [];
  for (const instance of plan.ctx.instances) {
    items.push({
      instanceId: instance.id,
      entityId: instance.entityId,
      pos: placeInZone(instance.zoneId),
    });
  }
  for (const distractor of plan.distractorPlan) {
    items.push({
      instanceId: distractor.instanceId,
      entityId: distractor.entityId,
      pos: placeInZone(distractor.zoneId),
      distractor: true,
    });
  }

  return { figures, items, spawn };
}

export function projectLayout2D(
  game: GoalTreeGame,
  world: LogicalWorld,
  config: Projector2DConfig = PROJECTOR2D_DEFAULTS,
): Layout2D {
  // Children per zone, in passage (construction) order.
  const children = new Map<string, { zoneId: string; passageId: string }[]>();
  for (const passage of world.passages) {
    const list = children.get(passage.from) ?? [];
    list.push({ zoneId: passage.to, passageId: passage.id });
    children.set(passage.from, list);
  }

  const plan = planContent(game, world, config);
  const { sizeOf } = plan;

  // Subtree bands (post-order).
  const band = new Map<string, number>();
  const computeBand = (zoneId: string): number => {
    const kids = children.get(zoneId) ?? [];
    const kidsTotal = kids.reduce((acc, kid) => acc + computeBand(kid.zoneId), 0);
    const h = Math.max(sizeOf(zoneId).h, kidsTotal);
    band.set(zoneId, h);
    return h;
  };
  computeBand(world.startZoneId);

  // Placement (pre-order): children stack on the parent's east edge.
  const zoneRects = new Map<string, Rect>();
  const doors: DoorLayout[] = [];
  const place = (zoneId: string, x: number, bandTop: number): void => {
    const h = band.get(zoneId)!;
    const { w } = sizeOf(zoneId);
    zoneRects.set(zoneId, { x, y: bandTop, w, h });

    const kids = children.get(zoneId) ?? [];
    const kidsTotal = kids.reduce((acc, kid) => acc + band.get(kid.zoneId)!, 0);
    let cursor = bandTop + (h - kidsTotal) / 2;
    for (const kid of kids) {
      const kidBand = band.get(kid.zoneId)!;
      place(kid.zoneId, x + w, cursor);
      const doorCenterY = cursor + kidBand / 2;
      doors.push({
        passageId: kid.passageId,
        rect: {
          x: x + w - config.doorThickness / 2,
          y: doorCenterY - config.doorLength / 2,
          w: config.doorThickness,
          h: config.doorLength,
        },
      });
      cursor += kidBand;
    }
  };
  place(world.startZoneId, 0, 0);

  const zones: ZoneLayout[] = world.zones.map((zone) => ({
    zoneId: zone.id,
    rect: zoneRects.get(zone.id)!,
  }));

  return { zones, doors, ...placeContent(world, plan, zoneRects, doors, config) };
}

/**
 * Place a world's CONTENT (spawn, figures, target items, distractors) into a
 * caller-supplied set of zone rects + doors — the same spiral placement every
 * built-in projection uses, exposed so an external layout (e.g. the shared/place
 * house embedder) reuses the exact, validateLayout2D-safe placement instead of
 * reinventing it. `zoneRects` must cover every world zone; `doors` every passage.
 */
export function projectContentOnZones(
  game: GoalTreeGame,
  world: LogicalWorld,
  zoneRects: Map<string, Rect>,
  doors: DoorLayout[],
  config: Projector2DConfig = PROJECTOR2D_DEFAULTS,
): Pick<Layout2D, "figures" | "items" | "spawn"> {
  const plan = planContent(game, world, config);
  return placeContent(world, plan, zoneRects, doors, config);
}

// ---------------------------------------------------------------------------
// Village projection (star-shaped worlds: plaza + houses)
// ---------------------------------------------------------------------------

/** Gap between neighboring houses on one plaza edge. */
const VILLAGE_GAP = 2.5;
/** Keep-away from the plaza corners, so houses on adjacent edges never meet. */
const VILLAGE_CORNER = 2.5;

/**
 * Project a STAR-shaped world (every non-start zone a direct child of start)
 * as a village: the start zone is a central plaza, each child zone a house
 * footprint attached to one of the plaza's four edges with its door on the
 * shared edge. Returns null when the world isn't a star — callers fall back
 * to the east-icicle projection. `rng` drives house order, edge assignment
 * and size jitter; seed it (see projectGameLayout) for reproducible villages.
 */
export function projectVillage2D(
  game: GoalTreeGame,
  world: LogicalWorld,
  config: Projector2DConfig = PROJECTOR2D_DEFAULTS,
  rng: () => number = Math.random,
): Layout2D | null {
  const kids = world.passages
    .filter((p) => p.from === world.startZoneId)
    .map((p) => ({ zoneId: p.to, passageId: p.id }));
  if (kids.length === 0 || kids.length !== world.zones.length - 1) return null;

  const plan = planContent(game, world, config);

  // Seeded house order + a little outward size jitter (never shrinking below
  // the content-driven size, so the spiral placement always fits).
  const order = [...kids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const houses = order.map((kid) => {
    const base = plan.sizeOf(kid.zoneId);
    return {
      ...kid,
      w: base.w + Math.floor(rng() * 3),
      h: base.h + Math.floor(rng() * 3),
    };
  });

  // Distribute around the plaza; edges fill round-robin so 2–5 houses spread
  // out instead of stacking on one side.
  type Edge = "south" | "east" | "north" | "west";
  const EDGES: Edge[] = ["south", "east", "north", "west"];
  const byEdge = new Map<Edge, typeof houses>(EDGES.map((e) => [e, []]));
  houses.forEach((h, i) => byEdge.get(EDGES[i % 4]!)!.push(h));

  // The plaza must fit its longest edge row (and stay a comfortable square).
  const along = (h: { w: number; h: number }, edge: Edge) =>
    edge === "south" || edge === "north" ? h.w : h.h;
  let side = Math.max(config.zoneSizes.start.w, config.zoneSizes.start.h);
  for (const edge of EDGES) {
    const row = byEdge.get(edge)!;
    if (!row.length) continue;
    const len =
      row.reduce((acc, h) => acc + along(h, edge), 0) +
      VILLAGE_GAP * (row.length - 1) +
      VILLAGE_CORNER * 2;
    side = Math.max(side, len);
  }

  const zoneRects = new Map<string, Rect>([
    [world.startZoneId, { x: 0, y: 0, w: side, h: side }],
  ]);
  const doors: DoorLayout[] = [];
  for (const edge of EDGES) {
    const row = byEdge.get(edge)!;
    if (!row.length) continue;
    const rowLen =
      row.reduce((acc, h) => acc + along(h, edge), 0) + VILLAGE_GAP * (row.length - 1);
    let cursor = (side - rowLen) / 2;
    for (const house of row) {
      const rect: Rect =
        edge === "south"
          ? { x: cursor, y: side, w: house.w, h: house.h }
          : edge === "north"
            ? { x: cursor, y: -house.h, w: house.w, h: house.h }
            : edge === "east"
              ? { x: side, y: cursor, w: house.w, h: house.h }
              : { x: -house.w, y: cursor, w: house.w, h: house.h };
      zoneRects.set(house.zoneId, rect);

      // The door sits on the shared edge, centered on the house's span,
      // straddling it (half in the plaza, half in the house) exactly like the
      // icicle doors — validateLayout2D's reach-into-both-zones check holds.
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const t = config.doorThickness;
      const l = config.doorLength;
      doors.push({
        passageId: house.passageId,
        rect:
          edge === "south"
            ? { x: cx - l / 2, y: side - t / 2, w: l, h: t }
            : edge === "north"
              ? { x: cx - l / 2, y: -t / 2, w: l, h: t }
              : edge === "east"
                ? { x: side - t / 2, y: cy - l / 2, w: t, h: l }
                : { x: -t / 2, y: cy - l / 2, w: t, h: l },
      });
      cursor += along(house, edge) + VILLAGE_GAP;
    }
  }

  const zones: ZoneLayout[] = world.zones.map((zone) => ({
    zoneId: zone.id,
    rect: zoneRects.get(zone.id)!,
  }));

  return { zones, doors, ...placeContent(world, plan, zoneRects, doors, config) };
}

/**
 * The projector games CERTIFY on: village geometry for star worlds, east-icicle
 * for deeper trees. Seeded from `meta.seed` (falling back to a stable hash of the
 * zone ids), so certification, the client, and tests all derive the SAME layout
 * for the same game. `layout: "house"` games certify on this too (the certificate
 * is topology-only); their real floor plan is built later by the shared/place
 * embedder (docs/SPACE_EMBEDDING.md), a topology-preserving reskin.
 */
export function projectGameLayout(
  game: GoalTreeGame,
  world: LogicalWorld,
  config: Projector2DConfig = PROJECTOR2D_DEFAULTS,
): Layout2D {
  const seed = game.meta.seed ?? hashSeed(game.meta.title, ...world.zones.map((z) => z.id));
  const village = projectVillage2D(game, world, config, mulberry32(hashSeed(seed, "village")));
  return village ?? projectLayout2D(game, world, config);
}

/**
 * Deterministic golden-angle spiral from the zone center; candidates must be
 * inside the margin, off doorways, and clear of prior placements. Falls back
 * to a grid scan with relaxing separation — placement ALWAYS terminates.
 */
function findSpot(
  rect: Rect,
  occupied: Vec2[],
  doorCenters: Vec2[],
  config: Projector2DConfig,
): Vec2 {
  const center = rectCenter(rect);
  const GOLDEN_ANGLE = 2.399963229728653;
  const maxR = Math.hypot(rect.w, rect.h) / 2;

  const valid = (p: Vec2, separation: number, clearance: number): boolean =>
    rectContains(rect, p, config.margin) &&
    occupied.every((o) => dist(o, p) >= separation) &&
    doorCenters.every((d) => dist(d, p) >= clearance);

  for (let k = 0; k < 600; k++) {
    const r = 0.6 * Math.sqrt(k);
    if (r > maxR) break;
    const p = {
      x: center.x + Math.cos(k * GOLDEN_ANGLE) * r,
      y: center.y + Math.sin(k * GOLDEN_ANGLE) * r,
    };
    if (valid(p, config.minSeparation, config.doorClearance)) return p;
  }

  for (const relax of [1, 0.6, 0.3, 0]) {
    for (let gy = rect.y + config.margin; gy <= rect.y + rect.h - config.margin; gy += 0.5) {
      for (let gx = rect.x + config.margin; gx <= rect.x + rect.w - config.margin; gx += 0.5) {
        const p = { x: gx, y: gy };
        if (valid(p, config.minSeparation * relax, config.doorClearance * relax)) {
          return p;
        }
      }
    }
  }
  return center;
}

// ---------------------------------------------------------------------------
// Overrides (clinician hand edits — sparse replacement diff)
// ---------------------------------------------------------------------------

export interface Layout2DOverrides {
  /** Zone rect replacements, by zone id. */
  zones?: Record<string, Rect>;
  /** Door rect replacements, by passage id. */
  doors?: Record<string, Rect>;
  /** Figure position replacements, by goal node id. */
  figures?: Record<string, Vec2>;
  /** Item position replacements, by instance id. */
  items?: Record<string, Vec2>;
  spawn?: Vec2;
}

/**
 * Applies a sparse override diff onto a projected layout. Overrides whose
 * subject no longer exists are silently ignored (they orphan harmlessly when
 * the tree is regenerated). Always re-validate the result.
 */
export function applyLayout2DOverrides(
  layout: Layout2D,
  overrides: Layout2DOverrides | undefined,
): Layout2D {
  if (!overrides) return layout;
  return {
    zones: layout.zones.map((z) =>
      overrides.zones?.[z.zoneId] ? { ...z, rect: overrides.zones[z.zoneId] } : z,
    ),
    doors: layout.doors.map((d) =>
      overrides.doors?.[d.passageId] ? { ...d, rect: overrides.doors[d.passageId] } : d,
    ),
    figures: layout.figures.map((f) =>
      overrides.figures?.[f.nodeId] ? { ...f, pos: overrides.figures[f.nodeId] } : f,
    ),
    items: layout.items.map((i) =>
      overrides.items?.[i.instanceId]
        ? { ...i, pos: overrides.items[i.instanceId] }
        : i,
    ),
    spawn: overrides.spawn ?? layout.spawn,
  };
}

// ---------------------------------------------------------------------------
// Validation (any layout — projected or hand-edited)
// ---------------------------------------------------------------------------

const EPS = 1e-6;

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - EPS &&
    b.x < a.x + a.w - EPS &&
    a.y < b.y + b.h - EPS &&
    b.y < a.y + a.h - EPS
  );
}

function deflate(rect: Rect, by: number): Rect {
  return { x: rect.x + by, y: rect.y + by, w: rect.w - by * 2, h: rect.h - by * 2 };
}

export interface ValidateLayoutOptions {
  playerRadius?: number;
}

/**
 * The invariants Space2D's walkability and the solver's certificate rely on.
 * Returns human-readable errors (empty = valid). The clinician editor calls
 * this on every layout edit; certification calls it on the projection.
 */
export function validateLayout2D(
  game: GoalTreeGame,
  world: LogicalWorld,
  layout: Layout2D,
  options: ValidateLayoutOptions = {},
): string[] {
  const errors: string[] = [];
  const radius = options.playerRadius ?? SPACE2D_DEFAULTS.playerRadius;

  // -- zones: exact set match, sane dims, pairwise non-overlap
  const zoneRect = new Map(layout.zones.map((z) => [z.zoneId, z.rect]));
  const worldZoneIds = new Set(world.zones.map((z) => z.id));
  for (const id of worldZoneIds) {
    if (!zoneRect.has(id)) errors.push(`layout is missing zone "${id}"`);
  }
  for (const zone of layout.zones) {
    if (!worldZoneIds.has(zone.zoneId)) {
      errors.push(`layout has unknown zone "${zone.zoneId}"`);
    }
    if (zone.rect.w < radius * 4 || zone.rect.h < radius * 4) {
      errors.push(`zone "${zone.zoneId}" is too small to walk in`);
    }
  }
  for (let i = 0; i < layout.zones.length; i++) {
    for (let j = i + 1; j < layout.zones.length; j++) {
      if (rectsOverlap(layout.zones[i].rect, layout.zones[j].rect)) {
        errors.push(
          `zones "${layout.zones[i].zoneId}" and "${layout.zones[j].zoneId}" overlap`,
        );
      }
    }
  }

  // -- doors: exact set match; crossable; bridging both zones' interiors
  const doorByPassage = new Map(layout.doors.map((d) => [d.passageId, d]));
  for (const passage of world.passages) {
    const door = doorByPassage.get(passage.id);
    if (!door) {
      errors.push(`layout is missing a door for passage "${passage.id}"`);
      continue;
    }
    if (Math.min(door.rect.w, door.rect.h) < radius * 2 + 0.1) {
      errors.push(`door "${passage.id}" is too narrow to walk through`);
    }
    for (const zoneId of [passage.from, passage.to]) {
      const rect = zoneRect.get(zoneId);
      if (!rect) continue;
      if (!rectsOverlap(door.rect, deflate(rect, radius))) {
        errors.push(
          `door "${passage.id}" does not reach into zone "${zoneId}" — the passage is not crossable`,
        );
      }
    }
  }
  for (const door of layout.doors) {
    if (!world.passages.some((p) => p.id === door.passageId)) {
      errors.push(`layout has a door for unknown passage "${door.passageId}"`);
    }
  }

  // -- figures: one per world figure, right entity, inside its zone
  const figureByNode = new Map(layout.figures.map((f) => [f.nodeId, f]));
  for (const figure of world.figures) {
    const placed = figureByNode.get(figure.forNodeId);
    if (!placed) {
      errors.push(`layout is missing the figure for goal "${figure.forNodeId}"`);
      continue;
    }
    if (placed.entityId !== figure.entityId) {
      errors.push(
        `figure for goal "${figure.forNodeId}" shows entity "${placed.entityId}" — expected "${figure.entityId}"`,
      );
    }
    const rect = zoneRect.get(figure.zoneId);
    if (rect && !rectContains(rect, placed.pos, radius)) {
      errors.push(
        `figure for goal "${figure.forNodeId}" is outside its zone "${figure.zoneId}"`,
      );
    }
  }

  // -- target items: exact instance match with the runtime expansion
  const ctx = createRuntimeContext(game, world);
  const targets = layout.items.filter((i) => !i.distractor);
  const targetById = new Map(targets.map((i) => [i.instanceId, i]));
  for (const instance of ctx.instances) {
    const placed = targetById.get(instance.id);
    if (!placed) {
      errors.push(`layout is missing target item "${instance.id}"`);
      continue;
    }
    if (placed.entityId !== instance.entityId) {
      errors.push(
        `item "${instance.id}" shows entity "${placed.entityId}" — expected "${instance.entityId}"`,
      );
    }
    const rect = zoneRect.get(instance.zoneId);
    if (rect && !rectContains(rect, placed.pos, radius)) {
      errors.push(`item "${instance.id}" is outside its zone "${instance.zoneId}"`);
    }
  }
  const instanceIds = new Set(ctx.instances.map((i) => i.id));
  for (const item of targets) {
    if (!instanceIds.has(item.instanceId)) {
      errors.push(`layout has unknown target item "${item.instanceId}"`);
    }
  }

  // -- distractors: inside some zone, distinct ids, known entities
  const entityIds = new Set(game.entities.map((e) => e.id));
  for (const item of layout.items.filter((i) => i.distractor)) {
    if (instanceIds.has(item.instanceId)) {
      errors.push(
        `distractor "${item.instanceId}" collides with a target instance id`,
      );
    }
    if (!entityIds.has(item.entityId)) {
      errors.push(`distractor "${item.instanceId}" uses unknown entity "${item.entityId}"`);
    }
    if (!layout.zones.some((z) => rectContains(z.rect, item.pos, radius))) {
      errors.push(`distractor "${item.instanceId}" is not inside any zone`);
    }
  }

  // -- spawn
  const startRect = zoneRect.get(world.startZoneId);
  if (startRect && !rectContains(startRect, layout.spawn, radius)) {
    errors.push(`spawn point is outside the start zone`);
  }

  return errors;
}
