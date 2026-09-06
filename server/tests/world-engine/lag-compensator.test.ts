// ⏩ THE AUTOMATIC LAG COMPENSATOR (user ruling 2026-09-05).
//
// The world host clamps every frame at FRAME_DT_CAP_S (0.05 s), so a machine
// that renders a frame in half a second advances the sim by 0.05 s and destroys
// the other 0.45 — the frontier house that finishes in ~560 sim seconds headless
// and took ~45 REAL minutes on screen. With the global toggle on, the frame
// admits the real elapsed time instead, capped at LAG_COMP_MAX_FACTOR × the
// nominal step, and spends it through the EXISTING wide tick.
//
// Pure: a mock WorldView (no GL) + a hand-stepped clock, exactly like
// world-host-carry.test.ts. The dt each frame actually admits is read off
// `deps.onFrame`, which is handed the frame's whole dt (W-①).

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  FRAME_DT_CAP_S,
  LAG_COMP_INNER_STEP_S,
  LAG_COMP_MAX_FRAME_S,
  runWorldHost,
  type WorldHost,
} from "@shared/world-engine/world-host.js";
import {
  LAG_COMP_MAX_FACTOR,
  resetLagCompForTests,
  setLagComp,
} from "@shared/world-engine/lag-comp.js";
import type { WorldView } from "@shared/world-engine/world-view.js";
import type { WorldSpec } from "@shared/world-engine/types.js";

function mockView(): WorldView {
  return {
    screenToWorld: (px, py) => ({ x: px, y: py }),
    render: () => {},
    resize: () => {},
    dispose: () => {},
  };
}

const spec: WorldSpec = {
  engine: "world", engineVersion: 1, meta: { title: "t", locale: "en", theme: "t" },
  manifold: { kind: "flat", width: 60, height: 60 }, terrain: { kind: "flat" },
  spawns: [{ id: "s", x: 5, y: 5, facing: 0 }],
  objects: [], multiplayer: { maxPlayers: 4, authority: "distributed" },
  content: { kind: "sandbox" },
};

interface Rig {
  host: WorldHost;
  /** dt handed to the decision pass, one entry per frame. */
  dts: number[];
  /** Advance the internal loop by `realMs` of WALL CLOCK. */
  tick: (realMs: number) => void;
  /** Drive the EXTERNAL-clock path (the world-lab planet composer's route). */
  extStep: (callerDtS: number, realMs: number) => void;
  now: () => number;
}

function rig(): Rig {
  let frameCb: ((now: number) => void) | null = null;
  let now = 0;
  const dts: number[] = [];
  const host = runWorldHost({
    view: mockView(),
    spec,
    localId: "me",
    spawnIndex: 0,
    scheduleFrame: (cb) => { frameCb = cb; return () => {}; },
    now: () => now,
    onFrame: (_s, dt) => { dts.push(dt); },
  });
  host.start();
  return {
    host,
    dts,
    tick: (realMs) => { now += realMs; frameCb?.(now); },
    extStep: (callerDtS, realMs) => { now += realMs; host.step(callerDtS, now); },
    now: () => now,
  };
}

/** Frames the compensator can be handed without any lag at all. */
const SMOOTH_MS = 16;

describe("lag compensator — OFF (the default) is exactly today", () => {
  beforeEach(() => resetLagCompForTests());
  afterEach(() => resetLagCompForTests());

  it("clamps a slow frame to the 0.05 s cap and throws the rest away, as it always has", () => {
    const r = rig();
    for (let i = 0; i < 6; i++) r.tick(500); // 0.5 s frames — brutal lag
    r.host.stop();
    // Every frame admitted the cap and no more: 3 s of wall clock bought 0.3 s
    // of world. THIS is the bug the compensator exists to answer.
    expect(r.dts).toEqual(new Array(6).fill(FRAME_DT_CAP_S));
    const p = r.host.lagProbe();
    expect(p.on).toBe(false);
    expect(p.factor).toBe(1);
    expect(p.substeps).toBe(1);
  });

  it("leaves a healthy frame alone", () => {
    const r = rig();
    for (let i = 0; i < 4; i++) r.tick(SMOOTH_MS);
    r.host.stop();
    expect(r.dts).toEqual(new Array(4).fill(SMOOTH_MS / 1000));
  });

  it("the external-clock path is the same clamp (this is text mode's route)", () => {
    const r = rig();
    for (let i = 0; i < 4; i++) r.extStep(1 / 20, 900); // fixed 0.05 s pump, slow wall clock
    r.host.stop();
    expect(r.dts).toEqual(new Array(4).fill(0.05));
    expect(r.host.lagProbe().on).toBe(false);
  });
});

describe("lag compensator — ON", () => {
  beforeEach(() => { resetLagCompForTests(); setLagComp(true); });
  afterEach(() => { setLagComp(false); resetLagCompForTests(); });

  it("admits the REAL elapsed seconds of a lagging frame", () => {
    const r = rig();
    r.tick(200);
    r.host.stop();
    expect(r.dts[0]).toBeCloseTo(0.2, 6);
    const p = r.host.lagProbe();
    expect(p.on).toBe(true);
    expect(p.realS).toBeCloseTo(0.2, 6);
    expect(p.admittedS).toBeCloseTo(0.2, 6);
    expect(p.droppedS).toBe(0);
    // ×4 = the four frames' worth of world time today's clamp would have binned.
    expect(p.factor).toBeCloseTo(0.2 / FRAME_DT_CAP_S, 6);
    expect(p.factor).toBeCloseTo(4, 6);
  });

  it("does nothing at all when there is no lag", () => {
    const r = rig();
    for (let i = 0; i < 4; i++) r.tick(SMOOTH_MS);
    r.host.stop();
    expect(r.dts).toEqual(new Array(4).fill(SMOOTH_MS / 1000));
    const p = r.host.lagProbe();
    expect(p.factor).toBe(1); // admitted === what today would have admitted
    expect(p.substeps).toBe(1);
    expect(p.droppedS).toBe(0);
  });

  it("CAPS at ×10 and DROPS the remainder — never banks it (anti-spiral law)", () => {
    const r = rig();
    r.tick(1200); // 1.2 s frame: 0.5 s admitted, 0.7 s gone for good
    r.tick(SMOOTH_MS); // …and the next healthy frame is NOT paid the backlog
    r.host.stop();
    expect(LAG_COMP_MAX_FRAME_S).toBeCloseTo(LAG_COMP_MAX_FACTOR * FRAME_DT_CAP_S, 9);
    expect(r.dts[0]).toBeCloseTo(LAG_COMP_MAX_FRAME_S, 6);
    expect(r.dts[0]).toBeCloseTo(0.5, 6);
    expect(r.dts[1]).toBeCloseTo(SMOOTH_MS / 1000, 6); // no catch-up: a spiral would start here
    const p = r.host.lagProbe();
    expect(p.factor).toBe(1); // the healthy frame's own reading
    // The capped frame's own numbers, re-derived: 1.2 real, 0.5 admitted, 0.7 dropped.
    expect(1.2 - LAG_COMP_MAX_FRAME_S).toBeCloseTo(0.7, 6);
  });

  it("reports the drop while the cap is biting", () => {
    const r = rig();
    r.tick(1200);
    const p = r.host.lagProbe();
    r.host.stop();
    expect(p.admittedS).toBeCloseTo(0.5, 6);
    expect(p.droppedS).toBeCloseTo(0.7, 6);
    expect(p.factor).toBeCloseTo(LAG_COMP_MAX_FACTOR, 6);
  });

  it("substeps the MOTION arms at a normal physics step (physics is not fast-forwarded)", () => {
    const r = rig();
    r.tick(500); // 0.5 s admitted ⇒ ceil(0.5 / 0.1) = 5 motion substeps
    expect(r.host.lagProbe().substeps).toBe(Math.ceil(0.5 / LAG_COMP_INNER_STEP_S));
    expect(r.host.lagProbe().substeps).toBe(5);
    r.tick(80); // 0.08 s ⇒ still inside one inner step
    expect(r.host.lagProbe().substeps).toBe(1);
    r.tick(250); // 0.25 s ⇒ 3 substeps of 0.0833 s, each ≤ the inner cap
    expect(r.host.lagProbe().substeps).toBe(3);
    r.host.stop();
    // ⚖️ every substep is ≤ WORLD_ENGINE_DEFAULTS.maxStep (0.1), so the engine's
    // own clamp can never truncate one — there is only ever ONE clock.
    expect(LAG_COMP_INNER_STEP_S).toBeLessThanOrEqual(0.1);
  });

  it("recovers the lost world time — the sim tracks the wall clock again", () => {
    const off = (() => {
      resetLagCompForTests();
      setLagComp(false);
      const r = rig();
      for (let i = 0; i < 10; i++) r.tick(300); // 3 s of wall clock
      r.host.stop();
      return r.dts.reduce((a, b) => a + b, 0);
    })();
    setLagComp(true);
    const on = (() => {
      const r = rig();
      for (let i = 0; i < 10; i++) r.tick(300);
      r.host.stop();
      return r.dts.reduce((a, b) => a + b, 0);
    })();
    expect(off).toBeCloseTo(0.5, 6); // 10 × 0.05 — 3 real seconds bought half a second
    expect(on).toBeCloseTo(3.0, 6); // 10 × 0.3  — 3 real seconds bought 3 seconds
    expect(on / off).toBeCloseTo(6, 6);
  });

  it("compensates the EXTERNAL-clock path off `now`, not the caller's clamped dt", () => {
    // The world-lab planet composer clamps its own dt to 0.1 s before handing it
    // down (games/world-lab/src/main.ts frame()), so the caller's dt cannot say
    // how long the frame really took — `now` can.
    const r = rig();
    r.extStep(0.1, 400); // first compensated frame: no previous stamp ⇒ base dt
    r.extStep(0.1, 400);
    r.extStep(0.1, 400);
    r.host.stop();
    expect(r.dts[0]).toBeCloseTo(FRAME_DT_CAP_S, 6); // fell back to today's clamp
    expect(r.dts[1]).toBeCloseTo(0.4, 6);
    expect(r.dts[2]).toBeCloseTo(0.4, 6);
  });

  it("never NARROWS a frame — compensation only ever adds time", () => {
    const r = rig();
    // A clock that does not advance: realS is 0, base is 0 ⇒ nothing to admit,
    // and nothing negative can reach the sim.
    r.tick(0);
    r.tick(0);
    r.host.stop();
    expect(r.dts.every((d) => d >= 0)).toBe(true);
    expect(r.dts).toEqual([0, 0]);
  });

  it("goes inert the moment it is switched off, mid-run", () => {
    const r = rig();
    r.tick(500);
    expect(r.host.lagProbe().on).toBe(true);
    setLagComp(false);
    r.tick(500);
    r.host.stop();
    expect(r.dts[0]).toBeCloseTo(0.5, 6);
    expect(r.dts[1]).toBeCloseTo(FRAME_DT_CAP_S, 6); // today's clamp, immediately
    const p = r.host.lagProbe();
    expect(p.on).toBe(false);
    expect(p.factor).toBe(1);
    expect(p.substeps).toBe(1);
    expect(p.droppedS).toBe(0);
  });

  it("a PAUSED host is never compensated (no lost sim time to recover)", () => {
    const r = rig();
    r.host.setPaused(true);
    r.tick(800);
    r.tick(800);
    r.host.stop();
    expect(r.dts).toEqual([0, 0]);
  });
});

describe("lag compensator — the headless / text-mode paths cannot move", () => {
  beforeEach(() => { resetLagCompForTests(); setLagComp(true); });
  afterEach(() => { setLagComp(false); resetLagCompForTests(); });

  it("THE BENCH'S OWN SHAPE is immune even with the toggle forced on", () => {
    // `npm run world:text -- --dt 1/20` builds NO wideTick (0.05 ≤ the 0.1 inner
    // step), so the exemption above does not cover it — but its pump is
    // fixed-step and its clock is synthetic: `now` advances by exactly the same
    // 50 ms it asks for. Real elapsed IS the caller's dt, so there is nothing to
    // recover and the transcript cannot move. (In the real bench the toggle is
    // off anyway: node has no `localStorage`.)
    const cbs: Array<(now: number) => void> = [];
    let now = 0;
    const dts: number[] = [];
    const host = runWorldHost({
      view: mockView(), spec, localId: "me", spawnIndex: 0,
      scheduleFrame: (cb) => { cbs.push(cb); return () => {}; },
      now: () => now,
      onFrame: (_s, dt) => { dts.push(dt); },
    });
    host.start();
    for (let i = 0; i < 8; i++) { now += 50; host.step(0.05, now); }
    host.stop();
    expect(dts).toEqual(new Array(8).fill(0.05));
    expect(host.lagProbe().factor).toBe(1);
    expect(host.lagProbe().substeps).toBe(1);
  });

  it("a host that declared its own frame policy keeps it, toggle or no toggle", () => {
    const cbs: Array<(now: number) => void> = [];
    let now = 0;
    const dts: number[] = [];
    const host = runWorldHost({
      view: mockView(), spec, localId: "me", spawnIndex: 0,
      wideTick: { innerStepS: 0.1, maxFrameS: 0.5 }, // exactly what text mode builds
      scheduleFrame: (cb) => { cbs.push(cb); return () => {}; },
      now: () => now,
      onFrame: (_s, dt) => { dts.push(dt); },
    });
    host.start();
    // The text pump's route: an explicit, fixed dt through step().
    for (let i = 0; i < 4; i++) { now += 3000; host.step(0.05, now); }
    // …and its own loop, if it ever used one: its own 0.5 s ceiling, not ours.
    now += 9000; cbs[cbs.length - 1]?.(now);
    host.stop();
    expect(dts.slice(0, 4)).toEqual([0.05, 0.05, 0.05, 0.05]); // untouched by 3 s frames
    expect(dts[4]).toBeCloseTo(0.5, 6); // the wide tick's own maxFrameS
    expect(host.lagProbe().on).toBe(false); // the compensator never engaged
  });
});
