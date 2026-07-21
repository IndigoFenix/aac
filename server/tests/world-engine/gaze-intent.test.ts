// Headless tests for the gaze INTENT interpreter (the layer between the raw
// pointer/gaze pixel and the engine's single `aim`). It's pure math, so the
// fixation gate, weakening, and auto-sit latch are all unit-testable without a GPU
// or DOM — exactly like the world engine itself.

import { describe, it, expect } from "@jest/globals";
import { createGazeInterpreter } from "@shared/world-engine/gaze-intent.js";
import type { Vec2 } from "@shared/world-engine/types.js";

const DT = 1 / 60;
/** Identity-ish mapping: 10 screen px = 1 world unit (so realistic px magnitudes
 *  drive the saccade gate while world distances stay small). Avatar at the origin. */
const screenToWorld = (px: number, py: number): Vec2 | null => ({ x: px / 10, y: py / 10 });
const AVATAR: Vec2 = { x: 0, y: 0 };

/** Run `frames` ticks holding the pointer at one pixel; returns the last intent. */
function hold(
  interp: ReturnType<typeof createGazeInterpreter>,
  pointer: { x: number; y: number } | null,
  frames: number,
  startMs: number,
) {
  let last = interp.update({ pointer, screenToWorld, avatar: AVATAR, dt: DT, nowMs: startMs });
  for (let i = 1; i < frames; i++) {
    last = interp.update({ pointer, screenToWorld, avatar: AVATAR, dt: DT, nowMs: startMs + i * DT * 1000 });
  }
  return last;
}

describe("gaze interpreter — fixation tracking", () => {
  it("settles onto a steady far gaze and steers there", () => {
    const interp = createGazeInterpreter();
    const out = hold(interp, { x: 100, y: 0 }, 40, 0); // world (10,0)
    expect(out.aim).not.toBeNull();
    expect(out.aim!.x).toBeGreaterThan(9); // weakening has eased out → near the point
    expect(out.unsettled).toBeLessThan(0.1);
    expect(out.sitting).toBe(false);
    expect(out.gazeDistance).toBeCloseTo(10, 1);
  });
});

describe("gaze interpreter — saccade gate", () => {
  it("HOLDS the committed aim through a fast flick instead of chasing it", () => {
    const interp = createGazeInterpreter();
    // Settle far to the +x side.
    hold(interp, { x: 100, y: 0 }, 40, 0);
    // One-frame flick across the screen (200 px ⇒ ~12000 px/s ≫ saccade gate).
    const flick = interp.update({
      pointer: { x: -100, y: 0 },
      screenToWorld,
      avatar: AVATAR,
      dt: DT,
      nowMs: 40 * DT * 1000,
    });
    // The committed aim must NOT have jumped to the −x side mid-saccade…
    expect(flick.aim!.x).toBeGreaterThan(0);
    expect(flick.unsettled).toBeGreaterThan(0.2);
    // …but once the gaze settles at the new spot, the aim follows it over.
    const after = hold(interp, { x: -100, y: 0 }, 40, 41 * DT * 1000);
    expect(after.aim!.x).toBeLessThan(0);
  });
});

describe("gaze interpreter — auto-sit on idle", () => {
  it("latches sitting after idle, and a fresh far gaze breaks it", () => {
    const interp = createGazeInterpreter();
    // Gaze parked ON the avatar (world 0.5 < sitGazeRadius) past idleSitMs (2.5 s).
    const sat = hold(interp, { x: 5, y: 0 }, 200, 0); // ~3.3 s
    expect(sat.sitting).toBe(true);
    expect(sat.aim).toBeNull(); // sitting ⇒ avatar idles

    // A sustained far gaze resumes travelling (sitting clears, aim returns).
    const moving = hold(interp, { x: 100, y: 0 }, 40, 200 * DT * 1000);
    expect(moving.sitting).toBe(false);
    expect(moving.aim).not.toBeNull();
    expect(moving.aim!.x).toBeGreaterThan(1);
  });

  it("coasts (null aim) and can sit when the pointer leaves the surface", () => {
    const interp = createGazeInterpreter();
    const out = hold(interp, null, 200, 0);
    expect(out.aim).toBeNull();
    expect(out.sitting).toBe(true);
  });
});
