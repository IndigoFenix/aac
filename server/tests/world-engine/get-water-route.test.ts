// THE "GET WATER" ANTI-PASS-THROUGH PIN — the Spirit Dollhouse wedge (house
// h_149), reconstructed from the live geometry that reproduced it. A resident
// sent to the kitchen barrel routed STRAIGHT THROUGH the living-room table and
// stuck: the barrel sits in a back kitchen, and the table + refrigerator leave
// a ~0.37 m gap between them, so reaching the kitchen doorway needs an S-curve
// (LEFT past the table, then back to the MIDDLE for the door — the two clear
// lanes don't overlap in x).
//
// Root cause (fixed): the router planned FATTER and COARSER than the house was
// FURNISHED for. A house stays navigable at the design body radius on a 0.3 m
// flood grid (kernel/town/placement.ts SVC_BODY/SVC_STEP); the router gridded at
// 0.45 m and probed at 0.42 m, so the legal 0.37 m gap read as a wall — the BFS
// found no path, kept the straight leg through the table, and (the leg being a
// tight door transit) the reactive detour was suppressed too. Plus corridorClear
// sampled at 0.3 m, stepping OVER the table's corner so a corner-clipping
// straight read "clear". Fixes: floor-route `planGeom` plans at the mover's
// radius on a grid >= as fine as the generator's, and corridorClear samples at
// 0.1 m. This pins the PLAN (routeIndoorAware output): the reactive follower can
// sometimes rescue a bad plan headlessly, but the live dollhouse suppresses the
// detour on the tight transit leg and never gives up while watched, so a plan
// that crosses the table IS the bug.
import { describe, it, expect } from "@jest/globals";
import { createWorldState, expandWorldBuildings, fixturesWalkable } from "@shared/world-engine/engine.js";
import { routeIndoorAware } from "@shared/world-engine/interaction/quest/floor-route.js";
import { nearestClearSpot } from "@shared/world-engine/interaction/quest/stand-points.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

const BODY_R = 0.4; // the design species (human_cute) — what the house is furnished for

// Captured from the live h_149 (world-lab Spirit Dollhouse) — the living room,
// the back kitchen behind its south wall, and the furniture that forms the pinch.
const LIVING = { x: 612.54, y: 311.34, w: 5.08, h: 10.01 };
const KITCHEN = { x: 612.54, y: 321.35, w: 5.08, h: 2.8 };
const DOOR_OFFSET = 2.54; // ~x=615.1 along the shared wall, where the live transit sat
const buildings: BuildingSpec[] = [
  { id: "h_149", footprint: LIVING, floors: 1, stairs: false, wallThickness: 0.4, color: "#a8875f",
    doorways: [{ edge: "south", offset: DOOR_OFFSET, width: 1.0 }] },
  { id: "h_149_rk", footprint: KITCHEN, floors: 1, stairs: false, wallThickness: 0.4, color: "#a8875f",
    doorways: [{ edge: "north", offset: DOOR_OFFSET, width: 1.0 }] },
];
const FURN: Array<{ id: string; fixture: ObjectSpec["fixture"]; x: number; y: number; radius: number }> = [
  { id: "furn_149_table", fixture: "table", x: 615.638, y: 318.144, radius: 0.8 },
  { id: "furn_149_chest_food", fixture: "refrigerator", x: 613.188, y: 320.699, radius: 0.55 },
  { id: "furn_149_chest_cloth", fixture: "chest", x: 616.97, y: 320.7, radius: 0.55 },
  { id: "furn_149_chest_clothing", fixture: "chest", x: 617.0, y: 312.0, radius: 0.55 },
  { id: "furn_149_oven", fixture: "oven", x: 616.87, y: 322.05, radius: 0.6 },
  { id: "furn_149_cupboard", fixture: "cupboard", x: 613.37, y: 322.05, radius: 0.6 },
  { id: "furn_149_barrel", fixture: "barrel", x: 617.1, y: 323.6, radius: 0.4 },
];
const TABLE = FURN.find((f) => f.id === "furn_149_table")!;
const BARREL = FURN.find((f) => f.id === "furn_149_barrel")!;

function world(): WorldState {
  const objects: ObjectSpec[] = FURN.map((f) => ({
    id: f.id, x: f.x, y: f.y, shape: "box", radius: f.radius, fixture: f.fixture, interactions: [],
  }));
  const spec: WorldSpec = {
    engine: "world", engineVersion: 1, meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 700, height: 700 }, terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3 }], objects, buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" }, content: { kind: "sandbox" },
  };
  const s = createWorldState(expandWorldBuildings(spec), "me");
  for (const d of Object.values(s.doors)) (d as { open: number }).open = 1; // the family's doors stand open
  return s;
}

/** True if the straight `a→b` passes through the TABLE's collision box at body
 *  radius — the exact "walks into the table" failure. */
function crossesTable(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const half = TABLE.radius + BODY_R;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / 0.05));
  for (let i = 0; i <= n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
    if (Math.abs(p.x - TABLE.x) < half && Math.abs(p.y - TABLE.y) < half) return true;
  }
  return false;
}

describe("Spirit Dollhouse: the get-water route goes AROUND the table, not through it", () => {
  it("h_149: no leg of the barrel route passes through the table", () => {
    const s = world();
    // The family gathers in the living room, north of the table.
    const body = { x: 615.2, y: 315.0 };
    const target = nearestClearSpot(s, { x: BARREL.x, y: BARREL.y }, body);
    const route = routeIndoorAware(s, body, target, BODY_R);
    // The straight body→barrel WOULD cross the table (the trap this must avoid).
    expect(crossesTable(body, { x: BARREL.x, y: BARREL.y })).toBe(true);
    // No leg of the planned route may pass through the table.
    let prev = body;
    const through: string[] = [];
    for (const pt of route) {
      if (crossesTable(prev, pt)) through.push(`(${prev.x.toFixed(2)},${prev.y.toFixed(2)})->(${pt.x.toFixed(2)},${pt.y.toFixed(2)})`);
      prev = pt;
    }
    expect(through).toEqual([]);
  });

  it("h_149: the route reaches the barrel's room without walking through any fixture", () => {
    const s = world();
    const body = { x: 615.2, y: 315.0 };
    const target = nearestClearSpot(s, { x: BARREL.x, y: BARREL.y }, body);
    const route = routeIndoorAware(s, body, target, BODY_R);
    // The stand point sits BESIDE the barrel (tangent to its kitchen neighbours),
    // so the arrival zone is exempt — only the WALKED corridor must stay clear.
    const STAND_ZONE = 1.15;
    let prev = body;
    let hit: { x: number; y: number } | null = null;
    for (const pt of route) {
      const len = Math.hypot(pt.x - prev.x, pt.y - prev.y);
      const n = Math.max(1, Math.ceil(len / 0.08));
      for (let i = 1; i <= n && !hit; i++) {
        const p = { x: prev.x + ((pt.x - prev.x) * i) / n, y: prev.y + ((pt.y - prev.y) * i) / n };
        if (Math.hypot(p.x - target.x, p.y - target.y) <= STAND_ZONE) continue;
        if (!fixturesWalkable(s, p, BODY_R)) hit = p;
      }
      prev = pt;
    }
    expect(hit).toBeNull();
  });
});
