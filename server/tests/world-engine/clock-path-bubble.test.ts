// THE CLOCK-PATH BUBBLE (clock-path-dodging.md + its pinned decisions) — a
// clocked errand rides a schedule ANCHOR that advances along the plan at
// CLOCK_SCHEDULE_RATE × walk speed; the body is free within CLOCK_BUBBLE_R of
// it: it dodges neighbours locally (an AIM bend fading to pass-through at the
// bubble edge — never a position push), can never LEAD the schedule, and only
// a real disruption (forced out of the bubble) demotes it to a physics walk.
// Driven with the REAL controller + REAL engine locomotion (steerAvatar), the
// same composition world-host runs. Pure + deterministic — no DOM, no GL.

import { describe, it, expect } from "@jest/globals";
import {
  addLocalAvatar,
  createWorldState,
  steerAvatar,
  WORLD_ENGINE_DEFAULTS,
  type AvatarState,
  type WorldEngineConfig,
  type WorldState,
} from "@shared/world-engine/engine.js";
import {
  CLOCK_BUBBLE_R,
  CLOCK_SCHEDULE_RATE,
  createNpcController,
  type NpcController,
  type NpcErrand,
} from "@shared/world-engine/npc-controller.js";
import {
  clockDodgeAim,
  separateBodies,
  type SeparableBody,
} from "@shared/world-engine/interaction/quest/stand-points.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

const DT = 1 / 60;
const BODY_R = 0.4;
/** Production resident pace (quest-host registers 0.8–1.1) — the bubble's
 *  slack math is tuned for walking speeds, so the harness walks at one. */
const WALK: WorldEngineConfig = { ...WORLD_ENGINE_DEFAULTS, steerMaxSpeed: 1.0 };

function mkState(): WorldState {
  return createWorldState(
    {
      engine: "world",
      engineVersion: 1,
      meta: { title: "t", locale: "en", theme: "t" },
      manifold: { kind: "flat", width: 120, height: 60 },
      terrain: { kind: "flat" },
      spawns: [{ id: "s", x: 3, y: 3 }],
      objects: [],
      buildings: [],
      multiplayer: { maxPlayers: 2, authority: "distributed" },
      content: { kind: "sandbox" },
    } as WorldSpec,
    "you",
  );
}

const rngOf = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

interface Walker {
  ctrl: NpcController;
  body: AvatarState;
  doneAt: number;
  lostClock: boolean;
}

function mkWalker(
  state: WorldState,
  id: string,
  from: { x: number; y: number },
  points: NpcErrand["points"],
  clocked: boolean,
): Walker {
  const body = addLocalAvatar(state, id, from.x, from.y);
  const ctrl = createNpcController({ id, x: from.x, y: from.y, behavior: { movement: "wander", home: from, wanderRadius: 1 } });
  const w: Walker = { ctrl, body, doneAt: -1, lostClock: false };
  ctrl.setErrand({
    points,
    clocked,
    onClockLost: () => { w.lostClock = true; },
    onDone: () => { w.doneAt = state.time; },
  });
  return w;
}

/** One frame of the world-host composition: aim → clock dodge → locomotion. */
function stepWalkers(state: WorldState, walkers: Walker[], rng: () => number): void {
  state.time += DT;
  const bodies = walkers.map((w) => w.body);
  for (const w of walkers) {
    let aim = w.ctrl.computeAim({
      self: w.body,
      humans: [],
      now: state.time,
      width: 120,
      height: 60,
      rng,
      radius: BODY_R,
      walkable: () => true,
      maxSpeed: WALK.steerMaxSpeed,
    });
    const clock = w.ctrl.clockState();
    if (aim && clock) {
      aim = clockDodgeAim(w.body, aim, bodies, {
        selfId: w.ctrl.npcId,
        radiusOf: () => BODY_R,
        scale: clock.scale,
      });
    }
    steerAvatar(state, w.ctrl.npcId, aim, DT, WALK);
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("the clock anchor paces a clocked walker", () => {
  it("a clocked walk holds the schedule rate — measurably slower than a free walk", () => {
    const path = [{ x: 25, y: 20 }];
    const run = (clocked: boolean): number => {
      const state = mkState();
      const w = mkWalker(state, "w", { x: 5, y: 20 }, path, clocked);
      const rng = rngOf(1);
      for (let t = 0; t < 60 / DT && w.doneAt < 0; t++) stepWalkers(state, [w], rng);
      expect(w.doneAt).toBeGreaterThan(0); // both must ARRIVE
      return w.doneAt;
    };
    const free = run(false);
    const clocked = run(true);
    // 20 m at 1.0 vs at the 0.8 schedule: the clocked walk takes meaningfully
    // longer — the anchor, not the legs, sets the pace.
    expect(clocked).toBeGreaterThan(free * 1.1);
    // …but never pathologically longer (the body rides just behind the anchor).
    expect(clocked).toBeLessThan((20 / (WALK.steerMaxSpeed * CLOCK_SCHEDULE_RATE)) * 1.4);
  });

  it("the body never LEADS the schedule and never leaves the bubble on a clear road", () => {
    const state = mkState();
    const w = mkWalker(state, "w", { x: 5, y: 20 }, [{ x: 45, y: 20 }], true);
    const rng = rngOf(2);
    for (let t = 0; t < 70 / DT && w.doneAt < 0; t++) {
      stepWalkers(state, [w], rng);
      // The anchor's arc after `state.time` seconds caps the body's advance
      // (+ the carrot lead and a step of slack).
      const anchorX = 5 + state.time * WALK.steerMaxSpeed * CLOCK_SCHEDULE_RATE;
      expect(w.body.x).toBeLessThanOrEqual(Math.min(45, anchorX) + 1.3);
      if (w.doneAt < 0) expect(w.lostClock).toBe(false); // a clear road never disrupts
    }
    expect(w.doneAt).toBeGreaterThan(0);
  });

  it("a dwell point holds the schedule — the anchor waits with the body", () => {
    const state = mkState();
    const arrivals: number[] = [];
    const body = addLocalAvatar(state, "w", 5, 20);
    const ctrl = createNpcController({ id: "w", x: 5, y: 20, behavior: { movement: "wander", home: { x: 5, y: 20 }, wanderRadius: 1 } });
    const w: Walker = { ctrl, body, doneAt: -1, lostClock: false };
    ctrl.setErrand({
      points: [{ x: 12, y: 20, dwell: 2 }, { x: 19, y: 20 }],
      clocked: true,
      onArrive: () => arrivals.push(state.time),
      onClockLost: () => { w.lostClock = true; },
      onDone: () => { w.doneAt = state.time; },
    });
    const rng = rngOf(3);
    for (let t = 0; t < 40 / DT && w.doneAt < 0; t++) stepWalkers(state, [w], rng);
    expect(w.doneAt).toBeGreaterThan(0);
    expect(w.lostClock).toBe(false); // waiting out a dwell is ON schedule
    expect(arrivals.length).toBe(2);
    // The dwell really held (its 2 s sit between the two arrivals).
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThanOrEqual(2);
  });
});

describe("clocked walkers dodge — and disruption demotes", () => {
  it("two clocked walkers meeting HEAD-ON pass to opposite sides, both on schedule", () => {
    const state = mkState();
    const a = mkWalker(state, "a", { x: 5, y: 20 }, [{ x: 45, y: 20 }], true);
    const b = mkWalker(state, "b", { x: 45, y: 20 }, [{ x: 5, y: 20 }], true);
    const rng = rngOf(4);
    let minD = Infinity;
    for (let t = 0; t < 80 / DT && (a.doneAt < 0 || b.doneAt < 0); t++) {
      stepWalkers(state, [a, b], rng);
      minD = Math.min(minD, dist(a.body, b.body));
    }
    // Both ARRIVE, neither is disrupted, and the pass kept real clearance —
    // the dead-ahead tiebreak (id order) sent them to opposite sides.
    expect(a.doneAt).toBeGreaterThan(0);
    expect(b.doneAt).toBeGreaterThan(0);
    expect(a.lostClock).toBe(false);
    expect(b.lostClock).toBe(false);
    expect(minD).toBeGreaterThan(BODY_R * 2 * 0.8);
  });

  it("forced out of the bubble ⇒ demoted once, keeps walking, still arrives", () => {
    const state = mkState();
    const w = mkWalker(state, "w", { x: 5, y: 20 }, [{ x: 35, y: 20 }], true);
    const rng = rngOf(5);
    for (let t = 0; t < 5 / DT; t++) stepWalkers(state, [w], rng);
    expect(w.ctrl.clockState()).not.toBeNull();
    // The shove the bubble exists to measure: a displacement past its radius.
    w.body.y += CLOCK_BUBBLE_R + 0.5;
    stepWalkers(state, [w], rng);
    expect(w.lostClock).toBe(true);
    expect(w.ctrl.clockState()).toBeNull(); // the exemptions end immediately
    expect(w.ctrl.hasErrand()).toBe(true); // the ERRAND survives the demotion
    for (let t = 0; t < 60 / DT && w.doneAt < 0; t++) stepWalkers(state, [w], rng);
    expect(w.doneAt).toBeGreaterThan(0); // a physics walk finishes the trip
  });
});

describe("clockDodgeAim — the pure bend", () => {
  const opts = { selfId: "a", radiusOf: () => BODY_R, scale: 1 };
  const self: SeparableBody = { id: "a", x: 0, y: 0, floor: 0 };
  const aim = { x: 2, y: 0 };

  it("bends around a blocker ahead, away from its side", () => {
    const blocker: SeparableBody = { id: "b", x: 1, y: 0.2, floor: 0 }; // ahead-LEFT
    const out = clockDodgeAim(self, aim, [self, blocker], opts);
    expect(out.y).toBeLessThan(0); // dodges RIGHT
  });

  it("dead-ahead ties split by id order — the two parties pick OPPOSITE sides", () => {
    const other: SeparableBody = { id: "b", x: 1, y: 0, floor: 0 };
    const mine = clockDodgeAim(self, aim, [self, other], opts);
    const theirs = clockDodgeAim(
      other,
      { x: -1, y: 0 },
      [self, other],
      { ...opts, selfId: "b" },
    );
    expect(Math.sign(mine.y)).not.toBe(0);
    // Walking opposite directions, opposite aim-side signs = the SAME world
    // side kept clear between them.
    expect(Math.sign(mine.y)).toBe(Math.sign(theirs.y));
  });

  it("scale 0 (the bubble edge) passes THROUGH — the aim is untouched", () => {
    const blocker: SeparableBody = { id: "b", x: 1, y: 0, floor: 0 };
    const out = clockDodgeAim(self, aim, [self, blocker], { ...opts, scale: 0 });
    expect(out).toBe(aim);
  });

  it("a dodge onto blocked ground is DROPPED (pass through, never clip)", () => {
    const blocker: SeparableBody = { id: "b", x: 1, y: 0.1, floor: 0 };
    const out = clockDodgeAim(self, aim, [self, blocker], { ...opts, canStand: () => false });
    expect(out).toBe(aim);
  });

  it("ignores bodies past the look range and on other storeys", () => {
    const far: SeparableBody = { id: "b", x: 10, y: 0, floor: 0 };
    const upstairs: SeparableBody = { id: "c", x: 1, y: 0, floor: 1 };
    expect(clockDodgeAim(self, aim, [self, far, upstairs], opts)).toBe(aim);
  });
});

describe("separateBodies — the walker-vs-stander share asymmetry", () => {
  const R = () => BODY_R;

  it("a stander absorbs the WHOLE correction when its partner is walking", () => {
    const walker: SeparableBody = { id: "a", x: 10, y: 10, floor: 0, vx: 1, vy: 0 };
    const stander: SeparableBody = { id: "b", x: 10.5, y: 10, floor: 0 };
    separateBodies([walker, stander], DT, { radiusOf: R });
    expect(walker.x).toBe(10); // the walker holds its route
    expect(stander.x).toBeGreaterThan(10.5); // the stander steps aside
  });

  it("two WALKERS still split 50/50 (the lockstep unmerge is preserved)", () => {
    const a: SeparableBody = { id: "a", x: 10, y: 10, floor: 0, vx: 1, vy: 0 };
    const b: SeparableBody = { id: "b", x: 10.5, y: 10, floor: 0, vx: 1, vy: 0 };
    separateBodies([a, b], DT, { radiusOf: R });
    expect(a.x).toBeLessThan(10);
    expect(b.x).toBeGreaterThan(10.5);
    expect(Math.abs(10 - a.x)).toBeCloseTo(Math.abs(b.x - 10.5), 9);
  });

  it("two STANDERS still split 50/50 (the fused-pile unmerge is preserved)", () => {
    const a: SeparableBody = { id: "a", x: 10, y: 10, floor: 0 };
    const b: SeparableBody = { id: "b", x: 10.5, y: 10, floor: 0 };
    separateBodies([a, b], DT, { radiusOf: R });
    expect(a.x).toBeLessThan(10);
    expect(b.x).toBeGreaterThan(10.5);
  });
});
