// Unbounded manifolds — the planet-frame contract (COORDINATE_MODES_PLAN.md).
//
// A planet-mounted session (embedded town, wilderness chunk) marks its
// manifold `bounded: false`: the rect stays the CONTENT extent (procgen,
// certification, framing) but is never a physical wall. These tests pin the
// three walls that used to be there — the locomotion clamp, the handoff spawn
// clamp, and the NPC waypoint clamp — and that bounded worlds are unchanged.

import { describe, it, expect } from "@jest/globals";
import {
  certifyWorldSpec,
  createWorldState,
  tickWorld,
  type WorldSpec,
  type WorldState,
  type Vec2,
} from "@shared/world-engine/index.js";
import {
  createNpcController,
  type NpcControlCtx,
} from "@shared/world-engine/npc-controller.js";

const DT = 1 / 60;
const SIDE = 20;

function makeSpec(bounded: boolean | undefined): WorldSpec {
  const spec: WorldSpec = {
    engine: "world",
    engineVersion: 1,
    meta: { title: "unbounded pin", locale: "en", theme: "test" },
    manifold: {
      kind: "flat",
      width: SIDE,
      height: SIDE,
      ...(bounded === undefined ? {} : { bounded }),
    },
    terrain: { kind: "flat" },
    spawns: [{ id: "c", x: SIDE / 2, y: SIDE / 2 }],
    objects: [],
    multiplayer: { maxPlayers: 1, authority: "distributed" },
    content: { kind: "sandbox" },
  };
  return spec;
}

/** Walk toward a fixed aim for `seconds`. */
function walk(state: WorldState, aim: Vec2, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) tickWorld(state, { aim }, DT);
}

describe("unbounded manifold — physics has no city walls", () => {
  it("certifies: `bounded` is a legal manifold field", () => {
    expect(certifyWorldSpec(makeSpec(false)).ok).toBe(true);
    expect(certifyWorldSpec(makeSpec(true)).ok).toBe(true);
  });

  it("bounded (default): the walker is clamped at the rect edge", () => {
    const state = createWorldState(makeSpec(undefined), "p");
    walk(state, { x: SIDE + 100, y: SIDE / 2 }, 8);
    const a = state.avatars["p"];
    expect(a.x).toBeLessThanOrEqual(SIDE);
    // Parked ON the wall (the historical clamp), not somewhere short of it.
    expect(a.x).toBeGreaterThan(SIDE - 1.5);
  });

  it("unbounded: the walker crosses the rect edge and keeps going", () => {
    const state = createWorldState(makeSpec(false), "p");
    walk(state, { x: SIDE + 100, y: SIDE / 2 }, 8);
    expect(state.avatars["p"].x).toBeGreaterThan(SIDE + 2);
  });

  it("unbounded: a handoff spawn outside the rect is honoured, not clamped", () => {
    const out = { x: SIDE + 30, y: -12 };
    const state = createWorldState(makeSpec(false), "p", 0, out);
    expect(state.avatars["p"].x).toBe(out.x);
    expect(state.avatars["p"].y).toBe(out.y);
    const clamped = createWorldState(makeSpec(true), "p", 0, out);
    expect(clamped.avatars["p"].x).toBeLessThanOrEqual(SIDE);
    expect(clamped.avatars["p"].y).toBeGreaterThanOrEqual(0);
  });
});

describe("unbounded manifold — NPC aims are not confined to the rect", () => {
  const mkCtx = (
    self: { x: number; y: number },
    humans: Array<{ x: number; y: number }>,
    now: number,
    bounded: boolean,
    rng: () => number,
  ): NpcControlCtx => ({
    self: { id: "npc", ...self, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0 },
    humans: humans.map((h, i) => ({
      id: `h${i}`, ...h, fx: 1, fy: 0, vx: 0, vy: 0, floor: 0,
    })),
    now,
    width: SIDE,
    height: SIDE,
    bounded,
    rng,
  });

  it("approach_nearest follows a human far beyond the rect (the follow-me fix)", () => {
    const ctrl = createNpcController({
      id: "npc", x: 5, y: 5,
      behavior: { movement: "approach_nearest", conversationRadius: 8 },
    });
    const aim = ctrl.computeAim(mkCtx({ x: 5, y: 5 }, [{ x: 90, y: 5 }], 0, false, () => 0.5));
    expect(aim).not.toBeNull();
    // The hold ring sits just short of the human — far outside the town rect.
    expect(aim!.x).toBeGreaterThan(SIDE * 2);
  });

  it("tethered wander roams the FULL disc when unbounded, the clamped disc when bounded", () => {
    // Home on the rect edge, tether radius far past it: unbounded draws must
    // reach outside the rect; bounded draws never may.
    const spec = {
      id: "npc", x: SIDE - 1, y: SIDE / 2,
      behavior: {
        movement: "wander" as const,
        home: { x: SIDE - 1, y: SIDE / 2 },
        wanderRadius: 40,
      },
    };
    const draws = (bounded: boolean): Vec2[] => {
      const ctrl = createNpcController(spec);
      let s = 1;
      const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      const out: Vec2[] = [];
      // Wander re-aims on pauses; sweep sim-time so many waypoints are drawn.
      let self = { x: spec.x, y: spec.y };
      for (let t = 0; t < 600; t += 1) {
        const aim = ctrl.computeAim(mkCtx(self, [], t, bounded, rng));
        if (aim) { out.push(aim); self = { x: aim.x, y: aim.y }; }
      }
      return out;
    };
    const free = draws(false);
    expect(free.length).toBeGreaterThan(3);
    expect(free.some((p) => p.x > SIDE || p.x < 0 || p.y > SIDE || p.y < 0)).toBe(true);
    const walled = draws(true);
    expect(walled.length).toBeGreaterThan(3);
    for (const p of walled) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(SIDE);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(SIDE);
    }
  });
});
