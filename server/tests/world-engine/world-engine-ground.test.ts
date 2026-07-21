// IRREGULAR GROUND + WATER seams: optional pure samplers on the world state.
// The sim stays plan-view 2D, but terrain is now "2.5D" MECHANICS: the ground
// gradient scales the stride between the slow/wall angles and blocks like a
// wall past it, and water is impassable — both with the stuck-escape failsafe.
// These tests pin the FLAT LAW (no sampler / constant / sub-threshold slope ⇒
// trajectories byte-identical to the sampler-free sim), the slope/water gates,
// and the renderer placement helpers. Headless — no GL.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  expandWorldBuildings,
  groundHeightAt,
  terrainWalkable,
  tickWorld,
  type GroundSampler,
  type WaterSampler,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { buildingBaseY, buildRoadRibbon, standHeightAt } from "@shared/world-engine/render3d.js";
import { runWorldHost } from "@shared/world-engine/world-host.js";
import type { WorldView } from "@shared/world-engine/world-view.js";
import type { BuildingSpec, WorldSpec } from "@shared/world-engine/types.js";

const DT = 1 / 60;

/** A deterministic tilted plane — heights vary along both axes. Gradient
 *  magnitude ≈0.112 → slope angle ≈0.111 rad, well under the slow threshold. */
const slope: GroundSampler = (x, y) => x * 0.1 + y * 0.05;
/** 45° plane (gradient 1 → angle ≈0.785 rad): inside the slow…wall band. */
const moderate: GroundSampler = (x) => x;
/** Flat until x=20, then a 2:1 climb — wall-steep (angle ≈1.107 ≥ 0.95) once
 *  both FD samples sit on the face (x ≥ 21.5; partially from x ≈ 20.6). */
const cliff: GroundSampler = (x) => Math.max(0, x - 20) * 2;
/** A lake covering the east half of the field. */
const lake: WaterSampler = (x) => x > 20;

const building: BuildingSpec = {
  id: "house",
  footprint: { x: 10, y: 10, w: 12, h: 12 },
  wallThickness: 0.6,
  floors: 1,
  doorways: [{ edge: "south", offset: 6, width: 2 }],
};

function spec(extra: Partial<WorldSpec> = {}): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 40, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 20, facing: 0 }],
    objects: [],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Engine seam
// ---------------------------------------------------------------------------

describe("GroundSampler (engine)", () => {
  it("defaults flat: no sampler ⇒ height 0 everywhere", () => {
    const state = createWorldState(spec(), "me");
    expect(state.ground).toBeUndefined();
    expect(groundHeightAt(state, 0, 0)).toBe(0);
    expect(groundHeightAt(state, 33, 7)).toBe(0);
  });

  /** Run the same turning walk on both states and assert byte-identical poses. */
  const expectIdenticalWalk = (flat: WorldState, other: WorldState): void => {
    for (let i = 0; i < 300; i++) {
      // A path that turns, so facing/velocity get exercised too.
      const aim = i < 150 ? { x: 35, y: 20 } : { x: 35, y: 35 };
      tickWorld(flat, { aim }, DT);
      tickWorld(other, { aim }, DT);
    }
    const a = flat.avatars.me;
    const b = other.avatars.me;
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(b.vx).toBe(a.vx);
    expect(b.vy).toBe(a.vy);
    expect(b.fx).toBe(a.fx);
    expect(b.fy).toBe(a.fy);
    expect(b.floor).toBe(a.floor);
  };

  it("the FLAT LAW: a constant-0 sampler (and dry water) is byte-identical to no sampler", () => {
    expectIdenticalWalk(
      createWorldState(spec(), "me"),
      createWorldState(spec(), "me", 0, undefined, () => 0, () => false),
    );
  });

  it("a gentle slope (below the slow angle) costs nothing — trajectories stay identical", () => {
    expectIdenticalWalk(
      createWorldState(spec(), "me"),
      createWorldState(spec(), "me", 0, undefined, slope),
    );
  });

  it("reports the sampler's height under the avatar as it walks", () => {
    const state = createWorldState(spec(), "me", 0, undefined, slope);
    const me = state.avatars.me;
    const h0 = groundHeightAt(state, me.x, me.y);
    expect(h0).toBe(slope(me.x, me.y));
    const seen = new Set<number>([h0]);
    for (let i = 0; i < 300; i++) {
      tickWorld(state, { aim: { x: 35, y: 20 } }, DT);
      seen.add(groundHeightAt(state, me.x, me.y));
    }
    // It climbed: the height tracked the sampler along the walk.
    expect(seen.size).toBeGreaterThan(10);
    expect(groundHeightAt(state, me.x, me.y)).toBe(slope(me.x, me.y));
    expect(groundHeightAt(state, me.x, me.y)).toBeGreaterThan(h0 + 1);
  });
});

// ---------------------------------------------------------------------------
// Slope mechanics — the stride shrinks between the slow/wall angles; at the
// wall angle terrain blocks like a wall (with the stuck-escape failsafe)
// ---------------------------------------------------------------------------

describe("slope movement cost (engine)", () => {
  /** Ticks `state` toward `aim` and returns plan distance covered from spawn. */
  const walkFor = (state: WorldState, aim: { x: number; y: number }, ticks = 300): number => {
    const { x: x0, y: y0 } = state.avatars.me;
    for (let i = 0; i < ticks; i++) tickWorld(state, { aim }, DT);
    const me = state.avatars.me;
    return Math.hypot(me.x - x0, me.y - y0);
  };

  it("a moderate slope shortens the ground covered per tick (uphill AND downhill — symmetric v1)", () => {
    const flatD = walkFor(createWorldState(spec(), "me"), { x: 35, y: 20 });
    // Uphill on the 45° plane (scale ≈ 0.41 inside the slow…wall band).
    const upD = walkFor(createWorldState(spec(), "me", 0, undefined, moderate), { x: 35, y: 20 });
    // Downhill: same plane, walking -x from the east side. The scale is
    // direction-blind (gradient magnitude), so downhill costs the same.
    const down = createWorldState(spec(), "me", 0, undefined, moderate);
    down.avatars.me.x = 35;
    const downD = walkFor(down, { x: 5, y: 20 });
    expect(upD).toBeLessThan(flatD * 0.6);
    expect(downD).toBeLessThan(flatD * 0.6);
    expect(downD).toBeCloseTo(upD, 3);
    expect(upD).toBeGreaterThan(1); // slowed, not stopped
  });

  it("wall-steep ground blocks like a wall", () => {
    const state = createWorldState(spec(), "me", 0, undefined, cliff);
    for (let i = 0; i < 600; i++) tickWorld(state, { aim: { x: 35, y: 20 } }, DT);
    const me = state.avatars.me;
    // Marched to the face, but never past the wall-steep band (x ≈ 20.6+).
    expect(me.x).toBeGreaterThan(15);
    expect(me.x).toBeLessThan(21.5);
    expect(Number.isFinite(me.x) && Number.isFinite(me.y)).toBe(true);
    expect(terrainWalkable(state, { x: 25, y: 20 })).toBe(false);
    expect(terrainWalkable(state, { x: 5, y: 20 })).toBe(true);
  });

  it("a body ALREADY on wall-steep ground walks out (stuck-escape failsafe)", () => {
    const state = createWorldState(spec(), "me", 0, undefined, cliff, undefined);
    state.avatars.me.x = 30; // deep in the over-steep face
    expect(terrainWalkable(state, { x: 30, y: 20 })).toBe(false);
    for (let i = 0; i < 600; i++) tickWorld(state, { aim: { x: 5, y: 20 } }, DT);
    // Escaped to open ground and kept walking — never imprisoned.
    expect(state.avatars.me.x).toBeLessThan(15);
  });
});

// ---------------------------------------------------------------------------
// Water — impassable to walkers, same gate + escape failsafe
// ---------------------------------------------------------------------------

describe("water (engine)", () => {
  it("a walker stops at the water's edge", () => {
    const state = createWorldState(spec(), "me", 0, undefined, undefined, lake);
    for (let i = 0; i < 600; i++) tickWorld(state, { aim: { x: 35, y: 20 } }, DT);
    const me = state.avatars.me;
    expect(me.x).toBeGreaterThan(18); // reached the shore…
    expect(me.x).toBeLessThanOrEqual(20); // …but never entered the lake
    expect(terrainWalkable(state, { x: 25, y: 20 })).toBe(false);
  });

  it("a body ALREADY in water walks out (stuck-escape failsafe)", () => {
    const state = createWorldState(spec(), "me", 0, undefined, undefined, lake);
    state.avatars.me.x = 30; // dropped in the lake
    for (let i = 0; i < 600; i++) tickWorld(state, { aim: { x: 5, y: 20 } }, DT);
    expect(state.avatars.me.x).toBeLessThan(15);
  });
});

// ---------------------------------------------------------------------------
// World-host seam — deps.groundAt rides the state; an NPC errand walks uphill
// ---------------------------------------------------------------------------

/** A no-op view: the host's loop needs no drawing or camera here. */
function fakeView(): WorldView {
  return {
    screenToWorld: () => null,
    render: () => undefined,
    resize: () => undefined,
    dispose: () => undefined,
  };
}

describe("runWorldHost groundAt", () => {
  it("stores the sampler on the state and an errand-walking NPC changes height", () => {
    let pending: ((nowMs: number) => void) | null = null;
    let clock = 0;
    const host = runWorldHost({
      view: fakeView(),
      spec: spec({ npcs: [{ id: "npc_walker", x: 8, y: 8, behavior: { movement: "stationary" } }] }),
      localId: "you",
      spawnIndex: 0,
      hostNpcs: true,
      groundAt: slope,
      scheduleFrame: (cb) => {
        pending = cb;
        return () => { pending = null; };
      },
      now: () => clock,
    });
    host.start();
    expect(host.state.ground).toBe(slope);

    const npc = host.state.avatars.npc_walker;
    const h0 = groundHeightAt(host.state, npc.x, npc.y);
    host.setNpcErrand("npc_walker", { points: [{ x: 32, y: 8 }] });
    for (let i = 0; i < 500; i++) {
      clock += 16;
      pending?.(clock);
    }
    // The body walked its errand across the slope; its ground height followed.
    const h1 = groundHeightAt(host.state, npc.x, npc.y);
    expect(npc.x).toBeGreaterThan(25);
    expect(h1).toBe(slope(npc.x, npc.y));
    expect(h1).toBeGreaterThan(h0 + 1);
    host.stop();
  });

  it("an NPC errand into a wall-steep band stalls gracefully (no spin, bounded tick cost)", () => {
    let pending: ((nowMs: number) => void) | null = null;
    let clock = 0;
    // Count terrain samples: a busy-looping NPC (re-detouring/re-probing every
    // frame against the blocked face) would blow this budget.
    let groundCalls = 0;
    const countedCliff: GroundSampler = (x, y) => {
      groundCalls++;
      return cliff(x, y);
    };
    const host = runWorldHost({
      view: fakeView(),
      spec: spec({ npcs: [{ id: "npc_walker", x: 8, y: 8, behavior: { movement: "stationary" } }] }),
      localId: "you",
      spawnIndex: 0,
      hostNpcs: true,
      groundAt: countedCliff,
      scheduleFrame: (cb) => {
        pending = cb;
        return () => { pending = null; };
      },
      now: () => clock,
    });
    host.start();

    let done = false;
    // The errand target sits beyond the wall-steep face; the leg budget
    // (4 s + 1 s/unit ≈ 28 s) gives up on the unreachable waypoint.
    host.setNpcErrand("npc_walker", { points: [{ x: 32, y: 8 }], onDone: () => { done = true; } });
    const FRAMES = 2200; // ×16 ms ≈ 35 s of sim — past the leg deadline
    for (let i = 0; i < FRAMES; i++) {
      clock += 16;
      pending?.(clock);
    }
    const npc = host.state.avatars.npc_walker;
    // It stalled at the face — never wedged into (or past) the wall-steep band…
    expect(Number.isFinite(npc.x) && Number.isFinite(npc.y)).toBe(true);
    expect(npc.x).toBeLessThan(21.5);
    // …the errand gave up cleanly rather than spinning forever…
    expect(done).toBe(true);
    // …and per-frame terrain sampling stayed bounded (detour probes + gates).
    expect(groundCalls / FRAMES).toBeLessThan(1000);
    host.stop();
  });

  it("stores deps.waterAt on the state (the QuestHostDeps-style passthrough)", () => {
    const host = runWorldHost({
      view: fakeView(),
      spec: spec(),
      localId: "you",
      spawnIndex: 0,
      waterAt: lake,
      scheduleFrame: () => () => undefined,
      now: () => 0,
    });
    expect(host.state.water).toBe(lake);
  });
});

// ---------------------------------------------------------------------------
// Renderer placement helpers (pure — the meshes apply exactly these heights)
// ---------------------------------------------------------------------------

describe("render3d ground placement", () => {
  const hillyHouse = (): WorldState =>
    createWorldState(expandWorldBuildings(spec({ buildings: [building] })), "me", 0, undefined, slope);

  it("a building sits at its footprint-center height", () => {
    expect(buildingBaseY(slope, building.footprint)).toBe(slope(16, 16));
    expect(buildingBaseY(undefined, building.footprint)).toBe(0);
  });

  it("standHeightAt: terrain outdoors, the building's flat base indoors, 0 when flat", () => {
    const state = hillyHouse();
    // Outdoors: raw terrain under the point.
    expect(standHeightAt(state, 5, 20)).toBe(slope(5, 20));
    // Indoors: every point in the footprint stands on the footprint-center base.
    expect(standHeightAt(state, 11, 21)).toBe(slope(16, 16));
    expect(standHeightAt(state, 21, 11)).toBe(slope(16, 16));
    // No sampler ⇒ 0 (flat worlds unchanged).
    const flat = createWorldState(expandWorldBuildings(spec({ buildings: [building] })), "me");
    expect(standHeightAt(flat, 5, 20)).toBe(0);
    expect(standHeightAt(flat, 11, 21)).toBe(0);
  });

  it("road ribbons lift each centerline vertex by the terrain (and stay flat without one)", () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const flat = buildRoadRibbon(points, 2).getAttribute("position");
    const lifted = buildRoadRibbon(points, 2, slope).getAttribute("position");
    expect(lifted.count).toBe(flat.count);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      // Left + right edge vertices of a centerline point share its lift.
      expect(lifted.getY(2 * i)).toBeCloseTo(flat.getY(2 * i) + slope(p.x, p.y), 5);
      expect(lifted.getY(2 * i + 1)).toBeCloseTo(flat.getY(2 * i + 1) + slope(p.x, p.y), 5);
      // X/Z (the plan view) are untouched by the lift.
      expect(lifted.getX(2 * i)).toBe(flat.getX(2 * i));
      expect(lifted.getZ(2 * i)).toBe(flat.getZ(2 * i));
    }
  });
});
