// Tests for the shared gaze input kit (smoothing + dwell-to-activate).
// Pure-logic, no DOM — safe in the default `npm test` run.

import { describe, it, expect } from "@jest/globals";
import { DwellTracker, GazeSmoother } from "@shared/gaze-kit.js";

describe("GazeSmoother", () => {
  it("converges toward a held point", () => {
    const smoother = new GazeSmoother({ timeConstantMs: 80 });
    smoother.update({ x: 0, y: 0 }, 0);
    let p = { x: 0, y: 0 };
    for (let t = 16; t <= 480; t += 16) {
      p = smoother.update({ x: 100, y: 50 }, t);
    }
    expect(p.x).toBeGreaterThan(95);
    expect(p.y).toBeGreaterThan(47);
    expect(p.x).toBeLessThanOrEqual(100);
  });

  it("snaps on saccade-sized jumps", () => {
    const smoother = new GazeSmoother({ timeConstantMs: 80, snapDistance: 150 });
    smoother.update({ x: 0, y: 0 }, 0);
    const p = smoother.update({ x: 400, y: 0 }, 16);
    expect(p.x).toBe(400);
  });

  it("smooths sub-snap jitter instead of following it", () => {
    const smoother = new GazeSmoother({ timeConstantMs: 80, snapDistance: 150 });
    smoother.update({ x: 100, y: 100 }, 0);
    const p = smoother.update({ x: 130, y: 100 }, 16);
    expect(p.x).toBeGreaterThan(100);
    expect(p.x).toBeLessThan(115); // partial step, not the full 30px
  });
});

describe("DwellTracker", () => {
  it("fires after dwellMs on a held target, with monotonic progress", () => {
    const tracker = new DwellTracker({ dwellMs: 600 });
    let lastProgress = 0;
    let fired: string | null = null;
    for (let t = 0; t <= 700 && !fired; t += 50) {
      const sample = tracker.update("a", t);
      expect(sample.progress).toBeGreaterThanOrEqual(lastProgress);
      lastProgress = sample.progress;
      fired = sample.fired;
    }
    expect(fired).toBe("a");
  });

  it("does not refire while the gaze stays on the fired target", () => {
    const tracker = new DwellTracker({ dwellMs: 100 });
    tracker.update("a", 0);
    expect(tracker.update("a", 120).fired).toBe("a");
    for (let t = 140; t < 1000; t += 20) {
      expect(tracker.update("a", t).fired).toBeNull();
    }
  });

  it("re-arms after the gaze leaves the target", () => {
    const tracker = new DwellTracker({ dwellMs: 100 });
    tracker.update("a", 0);
    expect(tracker.update("a", 120).fired).toBe("a");
    tracker.update(null, 400); // leave
    tracker.update("a", 600); // return — restart dwell
    expect(tracker.update("a", 650).fired).toBeNull();
    expect(tracker.update("a", 720).fired).toBe("a");
  });

  it("tolerates off-target jitter within the grace window", () => {
    const tracker = new DwellTracker({ dwellMs: 400, graceMs: 150 });
    tracker.update("a", 0);
    tracker.update("a", 200);
    tracker.update(null, 250); // brief flicker off
    const back = tracker.update("a", 300); // within grace — progress kept
    expect(back.progress).toBeGreaterThan(0.5);
    expect(tracker.update("a", 420).fired).toBe("a");
  });

  it("resets progress when off-target beyond the grace window", () => {
    const tracker = new DwellTracker({ dwellMs: 400, graceMs: 100 });
    tracker.update("a", 0);
    tracker.update("a", 300);
    tracker.update(null, 450); // beyond grace — target dropped
    const back = tracker.update("a", 500);
    expect(back.progress).toBeLessThan(0.1);
  });

  it("switching targets restarts the dwell", () => {
    const tracker = new DwellTracker({ dwellMs: 300 });
    tracker.update("a", 0);
    tracker.update("a", 200);
    const onB = tracker.update("b", 250);
    expect(onB.progress).toBeLessThan(0.1);
    expect(tracker.update("b", 500).fired).toBeNull();
    expect(tracker.update("b", 560).fired).toBe("b");
  });

  it("honors a finite rearmMs cooldown", () => {
    const tracker = new DwellTracker({ dwellMs: 100, rearmMs: 500 });
    tracker.update("a", 0);
    expect(tracker.update("a", 110).fired).toBe("a");
    tracker.update(null, 200); // leave
    tracker.update("a", 300); // back too soon (off for 100 < 500) — disarmed
    expect(tracker.update("a", 450).fired).toBeNull();
    tracker.update(null, 500); // leave again
    tracker.update("a", 1100); // off since 500 → re-armed; dwell restarts
    expect(tracker.update("a", 1250).fired).toBe("a");
  });
});
