// A body walking OUTDOORS (no room, no door) must still route AROUND a large
// solid obstacle sitting directly on the straight line to its target — the case
// the reactive `detourAim` alone can't solve (it bends a line once) and the
// grid router used to skip because there was no shared room. Runs the real
// pipeline: routeIndoorAware (now grids the leg's bounding box when there is no
// room) → the world-host detour block → the pure-pursuit controller → steerAvatar.
// Pure engine logic, no GL — safe in `npm test`.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  createWorldState,
  steerAvatar,
  structuresWalkable,
  fixturesWalkable,
  tickWorld,
  type WorldState,
} from "@shared/world-engine/engine.js";
import {
  createDetourMemory,
  createNpcController,
  detourAim,
} from "@shared/world-engine/npc-controller.js";
import { routeIndoorAware } from "@shared/world-engine/interaction/quest/floor-route.js";
import type { ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

/** A flat, roofless world with one big solid fixture centred at `obs`. */
function world(obs: { x: number; y: number; radius: number }): WorldState {
  const table: ObjectSpec = {
    id: "slab",
    x: obs.x,
    y: obs.y,
    shape: "box",
    radius: obs.radius,
    fixture: "table", // a solid, non-passthrough fixture
    facing: 0,
    interactions: [],
  };
  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 80, height: 80 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 2, y: 2 }],
    objects: [table],
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  return createWorldState(spec, "me");
}

/** Walk `from → to` the way the live host does; returns whether it arrived and
 *  never crossed the obstacle's solid footprint. */
function walk(
  s: WorldState,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { arrived: boolean; enteredObstacle: boolean; t: number } {
  const body = addLocalAvatar(s, "npc", from.x, from.y);
  const ctrl = createNpcController({ id: "npc", x: from.x, y: from.y, behavior: { movement: "stationary" } });
  const mem = createDetourMemory();
  const walkable = (p: { x: number; y: number }, r: number) =>
    structuresWalkable(s, p, r, 0) && fixturesWalkable(s, p, r, 0);
  ctrl.setErrand({ points: routeIndoorAware(s, from, to) });
  const dt = 1 / 60;
  let t = 0;
  let enteredObstacle = false;
  for (let f = 0; f < 40 * 60; f++) {
    // The body must never be INSIDE the solid footprint (routed straight through).
    if (!fixturesWalkable(s, { x: body.x, y: body.y }, 0.1, 0)) enteredObstacle = true;
    const aim = ctrl.computeAim({
      self: body,
      humans: [],
      now: t,
      width: 80,
      height: 80,
      rng: () => 0.5,
      walkable,
      radius: 0.4,
    });
    let bent = aim;
    if (aim && !ctrl.errandLegTight()) {
      bent = detourAim({ x: body.x, y: body.y }, aim, walkable, 0.4, mem.prefer("npc", t));
      if (bent !== aim) mem.record("npc", 1, t);
    }
    steerAvatar(s, "npc", bent, dt);
    tickWorld(s, { aim: null }, dt);
    t += dt;
    if (!ctrl.hasErrand()) break;
  }
  return { arrived: Math.hypot(to.x - body.x, to.y - body.y) <= 1.3, enteredObstacle, t };
}

describe("outdoor routing around a large obstacle", () => {
  it("routes around a big slab sitting directly on the straight line", () => {
    // Slab spans ~5 m across (radius 2.5), centred between (2,40) and (78,40).
    const s = world({ x: 40, y: 40, radius: 2.5 });
    const r = walk(s, { x: 2, y: 40 }, { x: 78, y: 40 });
    expect(r.enteredObstacle).toBe(false); // never grinds through the footprint
    expect(r.arrived).toBe(true); // and gets to the far side
  });

  it("a clear straight is left untouched (no needless detour)", () => {
    // Obstacle far off the line — the straight is clean, refinement returns null.
    const s = world({ x: 40, y: 70, radius: 2.5 });
    const legs = routeIndoorAware(s, { x: 2, y: 40 }, { x: 78, y: 40 });
    expect(legs.length).toBe(1); // just the endpoint, no inserted corners
  });
});
