// Tests for shared/gaze-smoothing.ts — the pixel-space One-Euro + fixation-lock
// filter applied to raw hardware eye-tracker streams (Tobii etc.). Pure logic,
// no DOM — safe in `npm test`.
//
// The behaviour these guard: a still eye produces trembling raw samples, and
// the filter must (a) crush that tremor, (b) NOT lag a real saccade, and
// (c) forget its state cleanly when tracking is lost and reacquired.

import { describe, it, expect } from "@jest/globals";
import {
  GazeSmoother,
  smoothingConfigForStrength,
  DEFAULT_SMOOTHING_STRENGTH,
} from "@shared/gaze-smoothing.js";

const FRAME_MS = 1000 / 60;

/** Deterministic pseudo-jitter (no Math.random → reproducible). */
function jitter(i: number, amp: number): number {
  return amp * Math.sin(i * 1.7) * Math.cos(i * 0.9);
}

function spread(points: Array<{ x: number; y: number }>) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x: Math.max(...xs) - Math.min(...xs),
    y: Math.max(...ys) - Math.min(...ys),
  };
}

describe("GazeSmoother — jitter suppression", () => {
  it("reduces the spread of a trembling still gaze", () => {
    const s = new GazeSmoother();
    const raw: Array<{ x: number; y: number }> = [];
    const out: Array<{ x: number; y: number }> = [];

    for (let i = 0; i < 120; i++) {
      const rx = 500 + jitter(i, 8);
      const ry = 300 + jitter(i + 50, 8);
      raw.push({ x: rx, y: ry });
      out.push(s.filter(rx, ry, i * FRAME_MS));
    }

    // Compare the settled tail (skip warm-up).
    const rawSpread = spread(raw.slice(30));
    const outSpread = spread(out.slice(30));
    expect(outSpread.x).toBeLessThan(rawSpread.x * 0.25);
    expect(outSpread.y).toBeLessThan(rawSpread.y * 0.25);
  });

  it("locks to a stable centroid once a fixation is established", () => {
    const s = new GazeSmoother();
    let last = { x: 0, y: 0 };
    for (let i = 0; i < 120; i++) {
      last = s.filter(400 + jitter(i, 6), 200 + jitter(i + 20, 6), i * FRAME_MS);
    }
    // After ~2s of a jittery-but-stationary gaze the output must be pinned
    // near the true center, with sub-pixel movement between frames.
    const next = s.filter(400 + jitter(121, 6), 200 + jitter(141, 6), 121 * FRAME_MS);
    expect(Math.hypot(next.x - 400, next.y - 200)).toBeLessThan(6);
    expect(Math.hypot(next.x - last.x, next.y - last.y)).toBeLessThan(0.5);
  });
});

describe("GazeSmoother — saccade responsiveness", () => {
  it("follows a large jump without excessive lag", () => {
    const s = new GazeSmoother();
    // Hold at (100,100) to settle/lock.
    for (let i = 0; i < 60; i++) s.filter(100, 100, i * FRAME_MS);

    // Jump to (900,700); measure how fast the output converges.
    let out = { x: 0, y: 0 };
    let framesToArrive = Infinity;
    for (let i = 60; i < 90; i++) {
      out = s.filter(900, 700, i * FRAME_MS);
      if (Math.hypot(out.x - 900, out.y - 700) < 20 && framesToArrive === Infinity) {
        framesToArrive = i - 60;
      }
    }
    // One-Euro raises its cutoff during the jump, so it should arrive within
    // a handful of frames (well under a quarter second at 60Hz).
    expect(framesToArrive).toBeLessThanOrEqual(12);
    expect(Math.hypot(out.x - 900, out.y - 700)).toBeLessThan(5);
  });

  it("releases the fixation lock when the eye moves to a new target", () => {
    const s = new GazeSmoother();
    for (let i = 0; i < 60; i++) s.filter(300, 300, i * FRAME_MS); // lock here

    // Move decisively away; the lock must let go, not pin us at (300,300).
    let out = { x: 0, y: 0 };
    for (let i = 60; i < 80; i++) out = s.filter(700, 500, i * FRAME_MS);
    expect(Math.hypot(out.x - 300, out.y - 300)).toBeGreaterThan(100);
  });
});

describe("GazeSmoother — reset semantics", () => {
  it("snaps to the first sample after reset (no drag across a tracking gap)", () => {
    const s = new GazeSmoother();
    for (let i = 0; i < 60; i++) s.filter(100, 100, i * FRAME_MS);

    s.reset();
    // Eye reacquired far away — first post-reset sample must not be pulled
    // toward the old (100,100) position.
    const out = s.filter(900, 900, 61 * FRAME_MS);
    expect(out.x).toBeCloseTo(900, 5);
    expect(out.y).toBeCloseTo(900, 5);
  });

  it("tolerates zero/negative/huge timestamp deltas without producing NaN", () => {
    const s = new GazeSmoother();
    const a = s.filter(200, 200, 1000);
    const b = s.filter(210, 205, 1000);       // dt = 0
    const c = s.filter(220, 210, 999);        // dt < 0
    const d = s.filter(230, 215, 999 + 5000); // dt huge
    for (const p of [a, b, c, d]) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("smoothingConfigForStrength — clinician presets", () => {
  it("maps 'off' to no smoothing", () => {
    expect(smoothingConfigForStrength("off")).toBe(false);
  });

  it("defaults unknown/nullish to medium (module defaults)", () => {
    expect(DEFAULT_SMOOTHING_STRENGTH).toBe("medium");
    expect(smoothingConfigForStrength("medium")).toEqual({});
    expect(smoothingConfigForStrength(null)).toEqual({});
    expect(smoothingConfigForStrength(undefined)).toEqual({});
  });

  it("orders strength: 'strong' smooths a jittery hold tighter than 'light'", () => {
    const run = (level: "light" | "strong") => {
      const cfg = smoothingConfigForStrength(level);
      const s = new GazeSmoother(cfg === false ? { fixation: false } : cfg);
      // Disable the lock so we measure the One-Euro band, not a pinned centroid.
      const noLock = new GazeSmoother({
        ...(cfg === false ? {} : cfg),
        fixation: false,
      });
      const out: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 120; i++) {
        out.push(noLock.filter(500 + jitter(i, 10), 300 + jitter(i + 30, 10), i * FRAME_MS));
      }
      void s;
      return spread(out.slice(40));
    };
    const light = run("light");
    const strong = run("strong");
    // Stronger smoothing → smaller residual spread on a shaky still gaze.
    expect(strong.x).toBeLessThan(light.x);
    expect(strong.y).toBeLessThan(light.y);
  });
});

describe("GazeSmoother — fixation lock disabled", () => {
  it("still smooths but never pins the output when fixation:false", () => {
    const s = new GazeSmoother({ fixation: false });
    let prev = s.filter(500 + jitter(0, 6), 500, 0);
    let moved = 0;
    for (let i = 1; i < 120; i++) {
      const out = s.filter(500 + jitter(i, 6), 500 + jitter(i + 10, 6), i * FRAME_MS);
      if (Math.hypot(out.x - prev.x, out.y - prev.y) > 0) moved++;
      prev = out;
    }
    // Without the lock the One-Euro output keeps moving frame-to-frame.
    expect(moved).toBeGreaterThan(100);
  });
});
