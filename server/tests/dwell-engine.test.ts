// Tests for the shared dwell-selection engine (the decision core behind the
// AAC's EyeTrackingDwellContext). Pure-logic, no DOM — safe in `npm test`.
//
// The regression these tests guard against: with the gaze point frozen
// (covered camera / tracker lost the eyes / user left), board rebuilds kept
// placing new buttons under the stationary point and selections fired in a
// loop, so the conversation drove itself with nobody at the device.

import { describe, it, expect } from "@jest/globals";
import { DwellEngine } from "@shared/dwell-engine.js";

const DWELL_MS = 600;
const STALE_MS = 500;

/** Run ticks at 50ms intervals over a held target; returns the fired value (if any). */
function runUntilFired<T>(
  engine: DwellEngine<T>,
  target: T,
  point: { x: number; y: number },
  startAt: number,
  durationMs: number,
  lastSampleAt: (now: number) => number,
): T | null {
  for (let t = startAt; t <= startAt + durationMs; t += 50) {
    const r = engine.update(target, point, t, lastSampleAt(t));
    if (r.fired) return r.fired;
  }
  return null;
}

describe("DwellEngine — basic dwell", () => {
  it("fires after dwellTimeMs on a held target, with monotonic progress", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    const point = { x: 100, y: 100 };
    let lastProgress = 0;
    let fired: string | null = null;
    for (let t = 0; t <= 700 && !fired; t += 50) {
      const r = engine.update("a", point, t, t);
      expect(r.progress).toBeGreaterThanOrEqual(lastProgress);
      lastProgress = r.progress;
      fired = r.fired;
    }
    expect(fired).toBe("a");
  });

  it("resets progress when the target changes", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    const point = { x: 100, y: 100 };
    engine.update("a", point, 0, 0);
    expect(engine.update("a", point, 400, 400).progress).toBeGreaterThan(0.5);
    expect(engine.update("b", point, 450, 450).progress).toBe(0);
    // "b" only accumulates from t=450, so no fire at t=900
    expect(engine.update("b", point, 900, 900).fired).toBeNull();
  });

  it("clearTarget restarts the timer for the same target", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    const point = { x: 100, y: 100 };
    engine.update("a", point, 0, 0);
    engine.clearTarget(); // e.g. gaze point briefly disappeared
    expect(engine.update("a", point, 590, 590).progress).toBe(0);
    expect(engine.update("a", point, 1100, 1100).fired).toBeNull();
  });
});

describe("DwellEngine — movement-only re-arm (board rebuild regression)", () => {
  it("never fires again on a stationary point, no matter how targets churn", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    const point = { x: 100, y: 100 };

    expect(runUntilFired(engine, "btn-1", point, 0, 700, (t) => t)).toBe("btn-1");

    // Board rebuilds: a different element appears under the unchanged point
    // every few seconds. None of them may fire.
    let t = 1000;
    for (let rebuild = 0; rebuild < 5; rebuild++) {
      const swapped = `rebuilt-${rebuild}`;
      const fired = runUntilFired(engine, swapped, point, t, 2000, (now) => now);
      expect(fired).toBeNull();
      t += 2000;
    }
  });

  it("stays disarmed below the reactivation distance", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS, reactivationPx: 40 });
    expect(runUntilFired(engine, "a", { x: 100, y: 100 }, 0, 700, (t) => t)).toBe("a");

    // 30px of drift is jitter, not intent
    const nearby = { x: 130, y: 100 };
    const r = engine.update("b", nearby, 1000, 1000);
    expect(r.hoverEnabled).toBe(false);
    expect(r.movementFromAnchor).toBeCloseTo(30);
    expect(runUntilFired(engine, "b", nearby, 1050, 2000, (t) => t)).toBeNull();
  });

  it("re-arms after genuine movement and can select again", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS, reactivationPx: 40 });
    const origin = { x: 100, y: 100 };
    expect(runUntilFired(engine, "a", origin, 0, 700, (t) => t)).toBe("a");

    const farAway = { x: 100, y: 300 };
    expect(engine.update("b", farAway, 1000, 1000).hoverEnabled).toBe(true);
    expect(runUntilFired(engine, "b", farAway, 1050, 700, (t) => t)).toBe("b");
  });
});

describe("DwellEngine — stale gaze suspension", () => {
  it("suspends dwell when samples stop arriving (covered camera)", () => {
    // Realistic dwell time (the AAC default). Note the known boundary: a
    // dwell already within staleGazeMs of completing when the signal freezes
    // can still fire once during the grace window — that window is what
    // tolerates blinks. Suspension guards every dwell that isn't ≥75% done.
    const engine = new DwellEngine<string>({ dwellTimeMs: 2000, staleGazeMs: STALE_MS });
    const point = { x: 100, y: 100 };

    // Signal freezes at t=200, early in the dwell. It must never fire.
    const lastSample = (now: number) => Math.min(now, 200);
    for (let t = 0; t <= 10000; t += 50) {
      const r = engine.update("a", point, t, lastSample(t));
      expect(r.fired).toBeNull();
      if (t - 200 > STALE_MS) {
        expect(r.gazeStale).toBe(true);
        expect(r.target).toBeNull();
      }
    }
  });

  it("tolerates gaps shorter than staleGazeMs (blinks)", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS, staleGazeMs: STALE_MS });
    const point = { x: 100, y: 100 };
    // Samples arrive with up to 300ms gaps — never stale, dwell completes.
    let fired: string | null = null;
    for (let t = 0; t <= 700 && !fired; t += 50) {
      const lastSampleAt = t - (t % 300);
      const r = engine.update("a", point, t, lastSampleAt);
      expect(r.gazeStale).toBe(false);
      fired = r.fired;
    }
    expect(fired).toBe("a");
  });

  it("restarts the dwell from zero once the signal returns", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS, staleGazeMs: STALE_MS });
    const point = { x: 100, y: 100 };
    engine.update("a", point, 0, 0);
    engine.update("a", point, 400, 400);

    // Signal lost for 2s
    engine.update("a", point, 2400, 400);

    // Signal back: progress restarts, fires only a full dwellTimeMs later
    expect(engine.update("a", point, 2450, 2450).progress).toBe(0);
    expect(engine.update("a", point, 2500, 2500).fired).toBeNull();
    expect(runUntilFired(engine, "a", point, 2550, 700, (t) => t)).toBe("a");
  });

  it("does not gate cursor-control mode (staleGazeMs null) — stillness is the gesture", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS, staleGazeMs: null });
    const point = { x: 100, y: 100 };
    // Mouse hasn't moved since t=0; dwell still completes.
    expect(runUntilFired(engine, "a", point, 0, 700, () => 0)).toBe("a");
  });
});
