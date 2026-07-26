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

// ─── Selection-area mode ──────────────────────────────────────────
// The problem it solves: with whole-button dwell a student can't read a label
// without selecting it. A small confirm area (the eye mark) becomes the only
// thing that fills the timer, and glancing at the label merely pauses/drains it
// rather than cancelling outright.
describe("DwellEngine — selection area", () => {
  const POINT = { x: 100, y: 100 };

  /** Tick the engine at 50ms intervals over one area target; returns the last result. */
  function run(
    engine: DwellEngine<string>,
    target: string,
    startAt: number,
    endAt: number,
    inArea: boolean,
  ) {
    let last = engine.update(target, POINT, startAt, startAt, inArea);
    for (let t = startAt + 50; t <= endAt; t += 50) {
      last = engine.update(target, POINT, t, t, inArea);
      if (last.fired) return last;
    }
    return last;
  }

  it("fills only while the gaze is inside the area, and fires there", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    const r = run(engine, "a", 0, 700, true);
    expect(r.fired).toBe("a");
  });

  it("never fires from gaze that stays on the button but off the area", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    const r = run(engine, "a", 0, 10000, false);
    expect(r.fired).toBeNull();
    expect(r.progress).toBe(0);
    // Nothing to drain, so nothing is reported as draining either.
    expect(r.draining).toBe(false);
  });

  it("holds progress through the pause window, then drains", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    const filled = run(engine, "a", 0, 300, true).progress;
    expect(filled).toBeCloseTo(0.5, 2);

    // Default pauseMs is 500 — nothing moves for the first half-second off-area.
    const paused = run(engine, "a", 350, 800, false);
    expect(paused.progress).toBeCloseTo(filled, 5);
    expect(paused.draining).toBe(false);

    const drained = run(engine, "a", 850, 1400, false);
    expect(drained.progress).toBeLessThan(filled);
    expect(drained.draining).toBe(true);
  });

  it("drains faster the longer the gaze stays off the area", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: 20000 }); // long, so it can't empty
    run(engine, "a", 0, 10000, true); // fill well past halfway

    const start = run(engine, "a", 10050, 11000, false).progress; // past the pause window
    const afterFirst = run(engine, "a", 11050, 13000, false).progress;
    const afterSecond = run(engine, "a", 13050, 15000, false).progress;

    const firstLoss = start - afterFirst;
    const secondLoss = afterFirst - afterSecond;
    expect(firstLoss).toBeGreaterThan(0);
    expect(secondLoss).toBeGreaterThan(firstLoss);
  });

  it("resumes from the drained level when the gaze returns to the area", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    run(engine, "a", 0, 300, true);
    const drained = run(engine, "a", 350, 1400, false).progress;
    expect(drained).toBeGreaterThan(0); // partial loss, not a reset

    const resumed = run(engine, "a", 1450, 1550, true);
    expect(resumed.progress).toBeGreaterThan(drained);
    expect(resumed.draining).toBe(false);
  });

  it("resets to zero when the gaze leaves the button entirely", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    run(engine, "a", 0, 300, true);

    // Off the board completely — the target goes null.
    engine.update(null, POINT, 350, 350);

    expect(engine.update("a", POINT, 400, 400, true).progress).toBe(0);
    // And it needs a fresh full dwell, not the remainder of the old one.
    expect(engine.update("a", POINT, 700, 700, true).fired).toBeNull();
  });

  it("never drains below zero", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    run(engine, "a", 0, 100, true); // barely any progress
    const r = run(engine, "a", 150, 20000, false);
    expect(r.progress).toBe(0);
  });

  it("leaves area-less targets on whole-button dwell (mixed board)", () => {
    const engine = new DwellEngine<string>({ dwellTimeMs: DWELL_MS });
    // Undefined inArea = no selection area on this button: plain wall-clock.
    expect(runUntilFired(engine, "plain", POINT, 0, 700, (t) => t)).toBe("plain");
  });
});
