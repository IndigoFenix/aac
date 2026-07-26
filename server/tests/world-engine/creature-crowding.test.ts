// CREATURE CROWDING AVOIDANCE — bodies should not stand overlapping when they
// mill around or work at the same spot. The rule is emergent, not per-activity:
// a candidate position too close to ANOTHER body (within their COMBINED radii)
// is undesirable, so the chooser prefers a nearby free offset. Separation
// scales with body size, never a magic constant (pathfinding-clearance
// contract). Pure + deterministic — no DOM, no GL.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  createWorldState,
  expandWorldBuildings,
  steerAvatar,
  type AvatarState,
  type WorldState,
} from "@shared/world-engine/engine.js";
import { createNpcController } from "@shared/world-engine/npc-controller.js";
import {
  bodiesClear,
  nearestClearSpot,
  sameRoomAs,
  separateBodies,
  standClear,
  standPointFor,
  type SeparableBody,
} from "@shared/world-engine/interaction/quest/stand-points.js";
import type { BuildingSpec, ObjectSpec, WorldSpec } from "@shared/world-engine/types.js";

const DT = 1 / 60;
const BODY_R = 0.4; // the design species radius (creatures/species DEFAULT_BODY_RADIUS_M)
const COMBINED = BODY_R + BODY_R; // two default bodies must sit ≥ this apart

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Milling: the wander waypoint chooser keeps clear of other bodies
// ---------------------------------------------------------------------------

describe("milling creatures avoid standing on each other", () => {
  const openWalk = () => true; // an open field — every draw is structurally walkable

  it("a milling body never picks a waypoint within combined radii of another body", () => {
    // Two creatures share a home and a tight roam disc — WITHOUT the crowding
    // rule they pile onto the same random spots. Each frame each body's chosen
    // waypoint (the returned wander aim) must sit ≥ their combined radii from
    // the OTHER body's current position — the occupancy oracle the host builds.
    const home = { x: 40, y: 30 };
    const mk = (id: string, x: number) =>
      createNpcController({ id, x, y: 30, behavior: { movement: "wander", home, wanderRadius: 5 } });
    const state = createWorldState(
      {
        engine: "world",
        engineVersion: 1,
        meta: { title: "t", locale: "en", theme: "t" },
        manifold: { kind: "flat", width: 80, height: 60 },
        terrain: { kind: "flat" },
        spawns: [{ id: "s", x: 3, y: 3 }],
        objects: [],
        buildings: [],
        multiplayer: { maxPlayers: 2, authority: "distributed" },
        content: { kind: "sandbox" },
      } as WorldSpec,
      "you",
    );
    const a = addLocalAvatar(state, "a", 38, 30);
    const b = addLocalAvatar(state, "b", 42, 30);
    const ctrlA = mk("a", 38);
    const ctrlB = mk("b", 42);
    const rng = makeRng(9);

    const occupiedFor = (selfId: string) => (p: { x: number; y: number }, r: number) => {
      for (const o of Object.values(state.avatars)) {
        if (o.id === selfId) continue;
        if (Math.hypot(o.x - p.x, o.y - p.y) < r + BODY_R) return true;
      }
      return false;
    };

    let checks = 0;
    let prevA: { x: number; y: number } | null = null;
    let prevB: { x: number; y: number } | null = null;
    for (let t = 0; t < 600; t++) {
      state.time += DT;
      const ctxA = { self: a, humans: [] as AvatarState[], now: state.time, width: 80, height: 60, rng, radius: BODY_R, walkable: openWalk, occupied: occupiedFor("a") };
      const ctxB = { self: b, humans: [] as AvatarState[], now: state.time, width: 80, height: 60, rng, radius: BODY_R, walkable: openWalk, occupied: occupiedFor("b") };
      const aimA = ctrlA.computeAim(ctxA);
      const aimB = ctrlB.computeAim(ctxB);
      // A FRESH pick (null → non-null) is a newly chosen waypoint: it must clear
      // the OTHER body's current position by the combined radii.
      if (aimA && !prevA) { expect(dist(aimA, b)).toBeGreaterThanOrEqual(COMBINED - 1e-9); checks++; }
      if (aimB && !prevB) { expect(dist(aimB, a)).toBeGreaterThanOrEqual(COMBINED - 1e-9); checks++; }
      prevA = aimA;
      prevB = aimB;
      steerAvatar(state, "a", aimA, DT);
      steerAvatar(state, "b", aimB, DT);
    }
    expect(checks).toBeGreaterThan(4); // the invariant was actually exercised
  });

  it("crowding avoidance cuts the time two bodies spend overlapping", () => {
    // Same tight shared roam disc, run WITH and WITHOUT the occupancy oracle.
    // The rule is a preference, so it can't guarantee zero overlap every frame
    // (bodies still cross while walking) — but it must markedly reduce it.
    const run = (withOracle: boolean): number => {
      const home = { x: 40, y: 30 };
      const state = createWorldState(
        {
          engine: "world",
          engineVersion: 1,
          meta: { title: "t", locale: "en", theme: "t" },
          manifold: { kind: "flat", width: 80, height: 60 },
          terrain: { kind: "flat" },
          spawns: [{ id: "s", x: 3, y: 3 }],
          objects: [],
          buildings: [],
          multiplayer: { maxPlayers: 2, authority: "distributed" },
          content: { kind: "sandbox" },
        } as WorldSpec,
        "you",
      );
      const a = addLocalAvatar(state, "a", 40, 30);
      const b = addLocalAvatar(state, "b", 40, 30);
      const ctrlA = createNpcController({ id: "a", x: 40, y: 30, behavior: { movement: "wander", home, wanderRadius: 3 } });
      const ctrlB = createNpcController({ id: "b", x: 40, y: 30, behavior: { movement: "wander", home, wanderRadius: 3 } });
      const rng = makeRng(4);
      const occ = (selfId: string) => (p: { x: number; y: number }, r: number) => {
        for (const o of Object.values(state.avatars)) {
          if (o.id === selfId) continue;
          if (Math.hypot(o.x - p.x, o.y - p.y) < r + BODY_R) return true;
        }
        return false;
      };
      let overlap = 0;
      for (let t = 0; t < 4000; t++) {
        state.time += DT;
        const base = { humans: [] as AvatarState[], now: state.time, width: 80, height: 60, rng, radius: BODY_R, walkable: openWalk };
        const aimA = ctrlA.computeAim({ self: a, ...base, ...(withOracle ? { occupied: occ("a") } : {}) });
        const aimB = ctrlB.computeAim({ self: b, ...base, ...(withOracle ? { occupied: occ("b") } : {}) });
        steerAvatar(state, "a", aimA, DT);
        steerAvatar(state, "b", aimB, DT);
        if (dist(a, b) < COMBINED) overlap++;
      }
      return overlap;
    };
    const withoutOracle = run(false);
    const withOracle = run(true);
    expect(withoutOracle).toBeGreaterThan(0); // they DO crowd without the rule
    expect(withOracle).toBeLessThan(withoutOracle); // the rule spreads them out
  });
});

// ---------------------------------------------------------------------------
// Working: two creatures at the same fixture get shoulder-off stand points
// ---------------------------------------------------------------------------

function spec(buildings: BuildingSpec[], objects: ObjectSpec[] = [], size = 40): WorldSpec {
  return {
    engine: "world",
    engineVersion: 1,
    meta: { title: "t", locale: "en", theme: "t" },
    manifold: { kind: "flat", width: size, height: size },
    terrain: { kind: "flat" },
    spawns: [{ id: "s", x: 3, y: 3 }],
    objects,
    buildings,
    multiplayer: { maxPlayers: 2, authority: "distributed" },
    content: { kind: "sandbox" },
  };
}

const fixture = (id: string, x: number, y: number, radius: number, kind: string): ObjectSpec => ({
  id,
  x,
  y,
  shape: "box",
  radius,
  fixture: kind as ObjectSpec["fixture"],
  interactions: [],
});

// ---------------------------------------------------------------------------
// Standing separation: already-OVERLAPPING bodies are pushed apart (the actual
// dollhouse bug — locomotion never collides bodies with each other, and the
// crowding oracle only biases target SELECTION, so two bodies that arrive on the
// same spot, or walk a parallel errand in lockstep, stay fused forever).
// ---------------------------------------------------------------------------

describe("separateBodies unmerges overlapping stationary/lockstep bodies", () => {
  const R = () => BODY_R;

  it("two bodies stacked on the SAME point part to at least their combined radii", () => {
    // The observed pile: two residents arrived on one spot and stand there. No
    // AIM moves them — only the separation pass does. Run it to convergence.
    const bodies: SeparableBody[] = [
      { id: "a", x: 10, y: 10, floor: 0 },
      { id: "b", x: 10, y: 10, floor: 0 }, // exactly stacked
    ];
    for (let t = 0; t < 200; t++) separateBodies(bodies, DT, { radiusOf: R });
    expect(dist(bodies[0]!, bodies[1]!)).toBeGreaterThanOrEqual(COMBINED - 1e-6);
  });

  it("nearly-merged bodies (lockstep walkers) reach a clean gap", () => {
    const bodies: SeparableBody[] = [
      { id: "a", x: 20, y: 20, floor: 0 },
      { id: "b", x: 20.09, y: 20, floor: 0 }, // the observed 0.09 m lockstep gap
    ];
    for (let t = 0; t < 200; t++) separateBodies(bodies, DT, { radiusOf: R });
    expect(dist(bodies[0]!, bodies[1]!)).toBeGreaterThanOrEqual(COMBINED - 1e-6);
  });

  it("is GENTLE — no single frame teleports a body more than the rate allows", () => {
    const bodies: SeparableBody[] = [
      { id: "a", x: 5, y: 5, floor: 0 },
      { id: "b", x: 5, y: 5, floor: 0 },
    ];
    const rate = 1.5;
    const a0 = { ...bodies[0]! };
    separateBodies(bodies, DT, { radiusOf: R, rate });
    // Each body moves at most half the per-frame correction (rate × dt).
    expect(dist(bodies[0]!, a0)).toBeLessThanOrEqual(rate * DT + 1e-9);
  });

  it("does NOT oscillate — once apart, positions are STABLE frame to frame", () => {
    const bodies: SeparableBody[] = [
      { id: "a", x: 0, y: 0, floor: 0 },
      { id: "b", x: 0, y: 0, floor: 0 },
    ];
    for (let t = 0; t < 300; t++) separateBodies(bodies, DT, { radiusOf: R });
    const before = bodies.map((b) => ({ x: b.x, y: b.y }));
    for (let t = 0; t < 60; t++) separateBodies(bodies, DT, { radiusOf: R });
    // Settled: not one body drifted after reaching the clean gap.
    bodies.forEach((b, i) => {
      expect(Math.abs(b.x - before[i]!.x)).toBeLessThan(1e-9);
      expect(Math.abs(b.y - before[i]!.y)).toBeLessThan(1e-9);
    });
  });

  it("leaves well-separated bodies untouched", () => {
    const bodies: SeparableBody[] = [
      { id: "a", x: 0, y: 0, floor: 0 },
      { id: "b", x: 5, y: 0, floor: 0 }, // 5 m apart — no overlap
    ];
    separateBodies(bodies, DT, { radiusOf: R });
    expect(bodies[0]!.x).toBe(0);
    expect(bodies[1]!.x).toBe(5);
  });

  it("ignores bodies on different storeys (an upstairs body is not in the way)", () => {
    const bodies: SeparableBody[] = [
      { id: "a", x: 3, y: 3, floor: 0 },
      { id: "b", x: 3, y: 3, floor: 1 }, // same x/y, different floor
    ];
    separateBodies(bodies, DT, { radiusOf: R });
    expect(bodies[0]!).toMatchObject({ x: 3, y: 3 });
    expect(bodies[1]!).toMatchObject({ x: 3, y: 3 });
  });

  it("never MOVES an immovable (spark-driven) body — the neighbour parts around it", () => {
    const bodies: SeparableBody[] = [
      { id: "player", x: 8, y: 8, floor: 0 },
      { id: "npc", x: 8, y: 8, floor: 0 },
    ];
    const opts = { radiusOf: R, movable: (id: string) => id !== "player" };
    for (let t = 0; t < 200; t++) separateBodies(bodies, DT, opts);
    // The player never budged; the NPC took the FULL separation.
    expect(bodies[0]!).toMatchObject({ x: 8, y: 8 });
    expect(dist(bodies[0]!, bodies[1]!)).toBeGreaterThanOrEqual(COMBINED - 1e-6);
  });

  it("is WALKABILITY-GATED — a push into a wall is dropped, not forced through", () => {
    // `b` is pinned against a wall to `a`'s right (positive x blocked): the pass
    // must not shove `a` rightward into that wall. Model the wall as a canStand
    // that forbids x > 10. Since `a` starts left of `b`, it is pushed to smaller
    // x (away from the wall) — fine — while `b` (pushed toward the wall) is
    // gated. The room stays sane: no body ever lands in the blocked half.
    const bodies: SeparableBody[] = [
      { id: "a", x: 9.9, y: 0, floor: 0 },
      { id: "b", x: 10, y: 0, floor: 0 }, // b is at the wall
    ];
    const canStand = (p: { x: number; y: number }) => p.x <= 10; // wall at x = 10
    for (let t = 0; t < 200; t++) separateBodies(bodies, DT, { radiusOf: R, canStand });
    // No body was pushed past the wall.
    expect(bodies[0]!.x).toBeLessThanOrEqual(10 + 1e-9);
    expect(bodies[1]!.x).toBeLessThanOrEqual(10 + 1e-9);
  });

  it("relaxes a whole PILE — three stacked bodies all end mutually clear", () => {
    const bodies: SeparableBody[] = [
      { id: "a", x: 15, y: 15, floor: 0 },
      { id: "b", x: 15.1, y: 15, floor: 0 },
      { id: "c", x: 15, y: 15.1, floor: 0 },
    ];
    for (let t = 0; t < 400; t++) separateBodies(bodies, DT, { radiusOf: R });
    expect(dist(bodies[0]!, bodies[1]!)).toBeGreaterThanOrEqual(COMBINED - 1e-3);
    expect(dist(bodies[0]!, bodies[2]!)).toBeGreaterThanOrEqual(COMBINED - 1e-3);
    expect(dist(bodies[1]!, bodies[2]!)).toBeGreaterThanOrEqual(COMBINED - 1e-3);
  });
});

describe("working creatures at one fixture stand shoulder-off, not fused", () => {
  const room: BuildingSpec = {
    id: "A",
    footprint: { x: 0, y: 0, w: 12, h: 10 },
    floors: 1,
    wallThickness: 0.4,
    doorways: [{ edge: "south", offset: 6, width: 1.4 }],
  };

  it("standPointFor gives the second body a spot clear of the first", () => {
    const s: WorldState = createWorldState(expandWorldBuildings(spec([room], [fixture("chest", 6, 5, 0.55, "chest")])), "me");
    const body = { x: 6, y: 8 };
    // First creature's stand point (no other bodies yet).
    const spotA = standPointFor(s, "chest", { x: 6, y: 5 }, body, BODY_R);
    expect(standClear(s, spotA, BODY_R)).toBe(true);
    // Park creature A there, then plan for creature B at the SAME chest.
    addLocalAvatar(s, "cA", spotA.x, spotA.y);
    const spotB = standPointFor(s, "chest", { x: 6, y: 5 }, body, BODY_R, {
      selfId: "cB",
      radiusOf: () => BODY_R,
    });
    expect(standClear(s, spotB, BODY_R)).toBe(true);
    expect(sameRoomAs(s, { x: 6, y: 5 }, spotB)).toBe(true);
    // B stands off A's spot by at least their combined radii.
    expect(dist(spotB, spotA)).toBeGreaterThanOrEqual(COMBINED - 1e-9);
    expect(bodiesClear(s, spotB, "cB", BODY_R, () => BODY_R)).toBe(true);
  });

  it("nearestClearSpot nudges a body off a spot a neighbour already holds", () => {
    const s: WorldState = createWorldState(expandWorldBuildings(spec([room], [])), "me");
    const raw = { x: 6, y: 5 }; // open floor, structurally clear
    // A neighbour is already standing on that exact spot.
    addLocalAvatar(s, "cA", raw.x, raw.y);
    const spotB = nearestClearSpot(s, raw, { x: 6, y: 8 }, BODY_R, { selfId: "cB", radiusOf: () => BODY_R });
    expect(dist(spotB, { x: 6, y: 5 })).toBeGreaterThanOrEqual(COMBINED - 1e-9);
    expect(standClear(s, spotB, BODY_R)).toBe(true);
  });

  it("falls back to a structural spot when the room is too crowded to separate (termination over fidelity)", () => {
    // A tiny 3×3 closet with the chest in the middle — every stand cardinal is
    // occupied by a body. The chooser must still return a usable (structurally
    // clear) spot rather than hang.
    const closet: BuildingSpec = {
      id: "C",
      footprint: { x: 0, y: 0, w: 3, h: 3 },
      floors: 1,
      wallThickness: 0.4,
      doorways: [{ edge: "south", offset: 1.5, width: 1.0 }],
    };
    const s: WorldState = createWorldState(expandWorldBuildings(spec([closet], [fixture("chest", 1.5, 1.5, 0.4, "chest")])), "me");
    // Crowd every side.
    addLocalAvatar(s, "n1", 1.5, 0.6);
    addLocalAvatar(s, "n2", 1.5, 2.4);
    addLocalAvatar(s, "n3", 0.6, 1.5);
    addLocalAvatar(s, "n4", 2.4, 1.5);
    const spot = standPointFor(s, "chest", { x: 1.5, y: 1.5 }, { x: 1.5, y: 2.5 }, BODY_R, { selfId: "cB", radiusOf: () => BODY_R });
    // It returned SOMETHING (never hangs) and stays in the room.
    expect(Number.isFinite(spot.x)).toBe(true);
    expect(Number.isFinite(spot.y)).toBe(true);
    expect(sameRoomAs(s, { x: 1.5, y: 1.5 }, spot)).toBe(true);
  });
});
