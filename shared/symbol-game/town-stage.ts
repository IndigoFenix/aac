// shared/symbol-game/town-stage.ts
//
// The town HOSTED at avatar scale: a certified world-engine WorldSpec plus
// the streaming plan that materializes it around the player — buildings
// near you become real walls (setStructures), the quest CAST stands at its
// real anchors (the wanter's own doorstep, the vendor's own counter), and
// ambient residents embody mid-errand exactly where the goods clock says
// they are, within the engine's NPC budget.
//
// OPEN TOWN (decided 2026-07-09): the goal-tree artifact keeps its formal
// root — a tree needs a spine to certify — but the stage builds NO gate and
// NO star. The locked door was a placeholder; a town session is open-ended
// until real win conditions are designed.
//
// Body-authority, restated: this module drives resident BODIES from the
// town's errand clock (NpcErrand points = the goods layer's walkTo, the
// same closed form grand-dream's streets run). The creature sim never
// steers a body; conversation freezes one, and the cycle resumes on its
// own clock afterwards.

import {
  certifyWorldSpec,
  type BuildingSpec,
  type NpcSpec,
  type ObjectSpec,
  type RoadPath,
  type WorldSpec,
} from "@shared/world-engine/index.js";
import type { CompiledEconomy } from "@shared/engine/modules/economy/index.js";
import { houseFurniture } from "@shared/engine/town/furniture.js";
import type { TownHost } from "@shared/engine/town/host.js";
import type { TownHouse, TownPlan, TownWork } from "@shared/engine/town/plan.js";
import { ERRAND_WALK, doorTransit, houseDoorstep, streetGoods, type TownGoods } from "@shared/engine/town/goods.js";
import { createResidentModel, STREET_NPCS } from "@shared/engine/town/residents.js";
import type { TownQuestBundle } from "./town-quests.js";

export { residentId } from "@shared/engine/town/residents.js";

// Structure streaming, the 2D manager's numbers: buildings become real
// walls inside the load radius and stay until they drift past the unload
// radius (hysteresis) — grand-dream's STRUCT_LOAD_R / STRUCT_UNLOAD_R.
const STRUCT_LOAD_R = 100;
const STRUCT_UNLOAD_R = 130;

export interface TownStageOpts {
  seed: number;
  /** Resident-body budget (defaults to the shared STREET_NPCS — these
   *  are pure steering bodies; pass the same number to
   *  `runWorldHost({ maxNpcs })` plus the cast's own count). */
  ambient?: number;
  /** Ship the quest cast as spec-time NPCs (default true). Hosts that
   *  embody the cast themselves (the goal-tree player raises npc_{nodeId}
   *  bodies from layout figures) pass false — the cast still reserves its
   *  share of the NPC budget, and castSpawns still carries the anchors. */
  castNpcs?: boolean;
}

export interface TownStageFrame {
  /** Full replacement set for host.setBuildings — null when unchanged.
   *  BUILDINGS, not flattened walls: the volumes carry the roofs, the
   *  see-inside fade and the indoor-avatar cull; the host lowers them
   *  into wall/door structures itself. */
  buildings: BuildingSpec[] | null;
  /** Residents entering the world (host.addNpc). */
  add: NpcSpec[];
  /** Residents leaving it (host.removeNpc). */
  remove: string[];
  /** Fresh shopping trips (host.setNpcErrand) — once per cycle. */
  errands: Array<{ npcId: string; points: Array<{ x: number; y: number; dwell?: number }> }>;
  /** FURNITURE arriving with its house (host.addObject) — solid,
   *  openable fixtures; abstracted away when the house unloads. */
  addObjects: ObjectSpec[];
  /** Furniture leaving with its house (host.removeObject). */
  removeObjects: string[];
}

export interface TownStage {
  /** Certified sparse world: ground, plaza spawn, and the quest cast. */
  spec: WorldSpec;
  center: { x: number; y: number };
  /** The town's street network as flat ground ribbons (world coords) — the 3D
   *  view paints these on the field. Render-only; the sim never reads them. The
   *  same organic street tree the 2D map draws (streets.ts), just the whole set
   *  (a single town fits one manifold; no streaming). */
  roads: RoadPath[];
  /** Where each cast member stands (fulfill node id → world point). */
  castSpawns: Map<string, { x: number; y: number }>;
  /**
   * Stream the town around the player. `bodyPos` reports a live body's
   * current position (the resident model's lock + candidacy read REAL
   * positions, not spawn points); `visibleR` is the camera's world
   * reach, feeding only the pop-in rule. Mechanics never depend on the
   * renderer — a top-down map and the 3D view pass different visibleR
   * and get the SAME people in the SAME places.
   */
  frame(
    p: { x: number; y: number },
    tSec: number,
    bodyPos?: (id: string) => { x: number; y: number } | null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
  ): TownStageFrame;
}

const houseBuilding = (
  center: { x: number; y: number },
  id: string,
  b: { dx: number; dy: number; w: number; h: number; door: TownHouse["door"]; color: string; floors?: number },
): BuildingSpec => {
  const along = b.door === "north" || b.door === "south" ? b.w : b.h;
  return {
    id,
    footprint: { x: center.x + b.dx, y: center.y + b.dy, w: b.w, h: b.h },
    // Storeys from the plan (the build-up knob). Upper floors are visual
    // for now — no stairs staged; ground floor keeps every mechanic.
    floors: b.floors ?? 1,
    stairs: false,
    wallThickness: 0.4,
    // Door gap centered on its wall — the same midpoint houseDoorstep /
    // doorTransit aim at (grand-dream's centred-gap lesson).
    doorways: [{ edge: b.door, offset: along / 2, width: 2 }],
    color: b.color,
  };
};

export function createTownStage(
  town: TownHost,
  eco: CompiledEconomy,
  plan: TownPlan,
  bundle: TownQuestBundle,
  opts: TownStageOpts,
): TownStage {
  const side = plan.radius * 2 + 80;
  const center = { x: side / 2, y: side / 2 };
  const siteKey = plan.key;

  // Roads: the organic street tree (streets.ts), town-local points lifted into
  // world coords. Widths follow the 2D map's read — the plaza ring and arterials
  // are broader than the branch lanes — so the same hierarchy shows underfoot.
  const roads: RoadPath[] = plan.streets.streets
    .filter(s => s.pts.length >= 2)
    .map(s => ({
      points: s.pts.map(p => ({ x: center.x + p.x, y: center.y + p.y })),
      width: s.ring ? 2.8 : s.gen === 0 ? 3.4 : 2.4,
    }));

  // --- The quest cast: always-on NPCs at their REAL town anchors. ---
  const castSpawns = new Map<string, { x: number; y: number }>();
  const labelOf = (entityId: string): string | undefined =>
    bundle.game.entities.find(e => e.id === entityId)?.label;
  const castNpcs: NpcSpec[] = bundle.cast.map(entry => {
    let at: { x: number; y: number };
    if (entry.role === "wanter") {
      const house = plan.houses.find(h => h.index === entry.house) ?? plan.houses[0];
      at = house ? houseDoorstep(center, house) : { x: center.x, y: center.y + 6 };
    } else {
      const wk: TownWork | undefined =
        plan.works.find(w => w.type === entry.workType) ?? plan.works.find(w => w.type === "hall");
      at = wk ? doorTransit(center, wk).outside : { x: center.x, y: center.y - 6 };
    }
    castSpawns.set(entry.nodeId, at);
    return {
      id: entry.npcEntityId,
      x: at.x,
      y: at.y,
      ...(labelOf(entry.npcEntityId) ? { name: labelOf(entry.npcEntityId) } : {}),
      // A quest-giver is a resident with FROZEN needs (a fixed puzzle ask) — the
      // flag that sets it apart from the ambient residents below (whose needs
      // drift on the town clock). Same kind of NPC; see docs/TOWN_AND_NPCS.md.
      needsFrozen: true,
      behavior: { movement: "stationary" as const, conversationRadius: 5 },
    };
  });

  const raw: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: {
      title: bundle.game.meta.title,
      description: "A living town — its people, stalls and needs stream in around you.",
      locale: bundle.game.meta.locale,
      theme: `a ${plan.biome} town going about its day`,
    },
    manifold: { kind: "flat", width: side, height: side },
    terrain: { kind: "flat", groundColor: plan.groundColor },
    // Plaza CENTER — the open band between the hall (north side) and the
    // market hall (south side); never inside either footprint.
    spawns: [{ id: "plaza", x: center.x, y: center.y }],
    objects: [],
    npcs: opts.castNpcs === false ? [] : castNpcs,
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  const cert = certifyWorldSpec(raw);
  if (!cert.ok) {
    throw new Error(`createTownStage(${siteKey}): spec failed certification: ${JSON.stringify(cert.errors)}`);
  }

  // --- Ambient residents: the founding good's shoppers, nearest first. ---
  const goods: TownGoods[] = streetGoods(town, eco, { key: siteKey, center, plan }, opts.seed);
  // The cast holds its NPC-budget share whether it ships in the spec or
  // the host embodies it itself.
  // RESIDENTS: the shared model owns the mechanics (who exists where,
  // doing what) — the same rules the 2D canvas manager runs. This stage
  // only maps its output onto host calls.
  const residents = createResidentModel({ center, plan, goods, seed: opts.seed });
  const bodyBudget = Math.max(0, (opts.ambient ?? STREET_NPCS) - bundle.cast.length);

  /** Buildings currently lowered into real walls (hysteresis set). */
  const solid = new Set<string>();
  const buildingById = new Map<string, BuildingSpec>();
  const allBuildings: Array<{ id: string; cx: number; cy: number }> = [];
  const register = (id: string, b: { dx: number; dy: number; w: number; h: number; door: TownHouse["door"]; color: string }): void => {
    buildingById.set(id, houseBuilding(center, id, b));
    allBuildings.push({ id, cx: center.x + b.dx + b.w / 2, cy: center.y + b.dy + b.h / 2 });
  };
  for (const h of plan.houses) register(`h_${h.index}`, h);
  plan.works.forEach((wk, i) => register(`w_${i}`, wk));

  // FURNITURE per house (deterministic — same house, same room forever):
  // the goods chests at their errand corners, a cupboard, a table.
  const goodDefs = goods.map(g => ({ key: g.good.key, slot: g.good.slot }));
  const furnitureOf = new Map<string, ObjectSpec[]>();
  for (const h of plan.houses) {
    furnitureOf.set(`h_${h.index}`, houseFurniture(center, h, goodDefs).map(piece => ({
      id: piece.id,
      x: piece.x,
      y: piece.y,
      shape: "box" as const,
      radius: piece.radius,
      fixture: piece.kind,
      openable: piece.openable,
      facing: piece.facing,
      interactions: [],
      contains: [{ relation: piece.kind === "table" ? ("on" as const) : ("in" as const), capacity: 2 }],
    })));
  }
  /** House ids whose furniture is currently in the world. */
  const furnished = new Set<string>();

  const frame = (
    p: { x: number; y: number },
    tSec: number,
    bodyPos: (id: string) => { x: number; y: number } | null = () => null,
    visibleR?: number,
    isVisible?: (houseIndex: number) => boolean,
  ): TownStageFrame => {
    // BUILDINGS: load within reach, keep until past the unload radius.
    let changed = false;
    for (const b of allBuildings) {
      const d = Math.hypot(b.cx - p.x, b.cy - p.y);
      if (solid.has(b.id)) {
        if (d > STRUCT_UNLOAD_R) {
          solid.delete(b.id);
          changed = true;
        }
      } else if (d <= STRUCT_LOAD_R) {
        solid.add(b.id);
        changed = true;
      }
    }
    const buildings = changed ? [...solid].map(id => buildingById.get(id)!) : null;

    // FURNITURE: a house's interior fixtures follow the SAME roof-transparency
    // gate the residents use — present while the interior is ON SHOW (the player
    // occupies it, so the renderer fades its roof), abstracted the moment it's
    // hidden again. Keying furniture and people on ONE signal keeps them in
    // lockstep: no furnished-but-empty room, no peopled-but-bare room, and they
    // appear/vanish together. A closed house you merely walk past shows only its
    // exterior walls, so we never build a roomful of fixtures per house as the
    // town scrolls by. No signal ⇒ fall back to the raw footprint test (the 2D
    // lab). Runs every frame so it flips with occupancy, not just wall-set changes.
    const houseVisible = (h: TownHouse): boolean =>
      isVisible
        ? isVisible(h.index)
        : p.x > center.x + h.dx && p.x < center.x + h.dx + h.w &&
          p.y > center.y + h.dy && p.y < center.y + h.dy + h.h;
    const wantFurnished = new Set<string>();
    for (const h of plan.houses) {
      if (houseVisible(h)) wantFurnished.add(`h_${h.index}`);
    }
    const addObjects: ObjectSpec[] = [];
    const removeObjects: string[] = [];
    for (const id of [...furnished]) {
      if (wantFurnished.has(id)) continue;
      for (const o of furnitureOf.get(id) ?? []) removeObjects.push(o.id);
      furnished.delete(id);
    }
    for (const id of wantFurnished) {
      if (furnished.has(id) || !furnitureOf.has(id)) continue;
      addObjects.push(...furnitureOf.get(id)!);
      furnished.add(id);
    }

    // RESIDENTS: one model step; map spawns onto engine NPCs with the
    // behavior that keeps the clock honest (indoor tether, errand pace).
    const upd = residents.update(p, tSec, bodyBudget, bodyPos, visibleR, isVisible);
    const add: NpcSpec[] = upd.spawn.map(s => ({
      id: s.id,
      x: s.x,
      y: s.y,
      behavior: {
        movement: "wander" as const,
        conversationRadius: 5,
        wanderRadius: s.wanderRadius,
        home: s.home,
        speed: ERRAND_WALK,
      },
    }));
    const errands: TownStageFrame["errands"] = [
      // A body spawned mid-trip walks the REMAINDER of its trip...
      ...upd.spawn.flatMap(s => (s.walkTo ? [{ npcId: s.id, points: s.walkTo }] : [])),
      // ...and embodied runners head out when their cycle says so.
      ...upd.trips.map(t => ({ npcId: t.id, points: t.points })),
    ];

    return { buildings, add, remove: upd.despawn, errands, addObjects, removeObjects };
  };

  return { spec: cert.spec, center, roads, castSpawns, frame };
}
