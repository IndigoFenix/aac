// The DRAG seam (construction v1): an optional stride-scale sampler on the
// world state — heavy going (storage-room clutter) slows every body without
// ever BLOCKING one. Pins the FREE-GROUND LAW (no sampler / ×1 sampler ⇒
// trajectories byte-identical to the sampler-free sim), the wading slowdown,
// the clamp (a bad sampler can't freeze or hasten a body), and the host's
// setDragZones compiler. Headless — no GL.

import { describe, it, expect } from "@jest/globals";
import {
  createWorldState,
  dropObject,
  tickWorld,
  type WorldState,
} from "@shared/world-engine/engine.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const DT = 1 / 60;

function spec(): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: 60, height: 40 },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 5, y: 20, facing: 0 }],
    objects: [],
    multiplayer: { maxPlayers: 4, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

const walk = (state: WorldState, steps = 300): void => {
  for (let i = 0; i < steps; i++) tickWorld(state, { aim: { x: 55, y: 20 } }, DT);
};

describe("DragSampler (engine)", () => {
  it("FREE-GROUND LAW: a ×1 sampler is byte-identical to no sampler", () => {
    const bare = createWorldState(spec(), "me");
    const unit = createWorldState(spec(), "me");
    unit.drag = () => 1;
    for (let i = 0; i < 300; i++) {
      const aim = i < 150 ? { x: 55, y: 20 } : { x: 55, y: 35 };
      tickWorld(bare, { aim }, DT);
      tickWorld(unit, { aim }, DT);
    }
    const a = bare.avatars["me"]!;
    const b = unit.avatars["me"]!;
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(b.vx).toBe(a.vx);
    expect(b.vy).toBe(a.vy);
  });

  it("a half-stride zone slows ground covered — velocity keeps the intent", () => {
    const free = createWorldState(spec(), "me");
    const heavy = createWorldState(spec(), "me");
    heavy.drag = (x) => (x > 10 ? 0.5 : 1);
    walk(free);
    walk(heavy);
    expect(heavy.avatars["me"]!.x).toBeLessThan(free.avatars["me"]!.x - 2);
    // The body still MOVES full speed intent-wise (velocity unscaled).
    expect(Math.hypot(heavy.avatars["me"]!.vx, heavy.avatars["me"]!.vy)).toBeGreaterThan(0.5);
  });

  it("the clamp: a zero/negative sampler wades, never freezes; >1 never hastens", () => {
    const stuck = createWorldState(spec(), "me");
    stuck.drag = () => 0;
    walk(stuck, 120);
    expect(stuck.avatars["me"]!.x).toBeGreaterThan(5.5); // 0.15 floor keeps it moving

    const free = createWorldState(spec(), "me");
    const turbo = createWorldState(spec(), "me");
    turbo.drag = () => 5;
    walk(free, 120);
    walk(turbo, 120);
    expect(turbo.avatars["me"]!.x).toBeLessThanOrEqual(free.avatars["me"]!.x + 1e-9);
  });
});

describe("RESERVED GROUND (city-founding construction sites)", () => {
  const siteSpec = (): WorldSpec => ({
    ...spec(),
    objects: [{ id: "ball", x: 8, y: 20, shape: "circle", radius: 0.4, interactions: ["carry"] }],
  });

  it("a drop aimed inside a reserved lot lands just past the nearest edge", () => {
    const state = createWorldState(siteSpec(), "me");
    state.reservedGround = [{ x: 20, y: 10, w: 10, h: 8 }];
    // Deep inside, nearest to the west edge → pushed out west of x=20.
    dropObject(state, "ball", 22, 14);
    const o = state.objects["ball"]!;
    expect(o.x).toBeLessThan(20);
    expect(o.y).toBe(14); // only the crossing axis moves
  });

  it("drops OUTSIDE the lot, and every drop with nothing reserved, land exactly where aimed", () => {
    const state = createWorldState(siteSpec(), "me");
    state.reservedGround = [{ x: 20, y: 10, w: 10, h: 8 }];
    dropObject(state, "ball", 40, 30);
    expect(state.objects["ball"]).toMatchObject({ x: 40, y: 30 });
    const bare = createWorldState(siteSpec(), "me");
    dropObject(bare, "ball", 22, 14);
    expect(bare.objects["ball"]).toMatchObject({ x: 22, y: 14 });
  });

  it("reserved ground never slows or blocks a body walking across it", () => {
    const open = createWorldState(spec(), "me");
    const reserved = createWorldState(spec(), "me");
    reserved.reservedGround = [{ x: 15, y: 15, w: 20, h: 10 }]; // spans the walk line
    walk(open);
    walk(reserved);
    expect(reserved.avatars["me"]!.x).toBe(open.avatars["me"]!.x);
    expect(reserved.avatars["me"]!.y).toBe(open.avatars["me"]!.y);
  });
});
