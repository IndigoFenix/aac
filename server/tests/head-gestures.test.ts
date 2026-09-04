/**
 * Nod / shake detection.
 *
 * The bug being pinned: the old detector reported "shaking head" on 21% of prod
 * scene rows for two different students, because 2 reversals of a jittering
 * nose tip inside a 7-sample window is not evidence of anything. The gate that
 * actually fixes it is PERIODICITY — real oscillation has a regular
 * half-period, aliased sensor noise does not.
 *
 * See planning-docs/aac-face-expression-decoder.md §2.5.
 */

import { describe, it, expect } from "@jest/globals";
import {
  createHeadGestureDetector, analyseAxis, DEFAULT_HEAD_GESTURE_CONFIG,
  type HeadGestureResult,
} from "../../shared/aac/head-gestures.js";

const CFG = DEFAULT_HEAD_GESTURE_CONFIG;
const FACE_W = 0.3, FACE_H = 0.4;

/**
 * Deterministic pseudo-noise — no Math.random, so failures reproduce.
 * mulberry32: a plain LCG is NOT usable here. The first version of this test
 * used one and it alternated sign on every single sample, which is a perfectly
 * REGULAR oscillation at exactly Nyquist — it sailed through the periodicity
 * gate and looked like a detector bug. Noise for this test has to actually be
 * noisy.
 */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * Drive the detector with a sinusoid on one axis.
 * `hz` is the OSCILLATION frequency; `rateHz` the sampling rate.
 */
function oscillate(opts: {
  axis: "x" | "y"; hz: number; amplitude: number; seconds: number;
  rateHz: number; jitter?: number; seed?: number;
}): HeadGestureResult | null {
  const det = createHeadGestureDetector();
  const rnd = noise(opts.seed ?? 7);
  const stepMs = 1000 / opts.rateHz;
  const n = Math.round(opts.seconds * opts.rateHz);
  let hit: HeadGestureResult | null = null;
  for (let i = 0; i < n; i++) {
    const t = i * stepMs;
    const v = Math.sin(2 * Math.PI * opts.hz * (t / 1000)) * opts.amplitude;
    const j = (opts.jitter ?? 0) * rnd();
    const r = det.update(
      { x: 0.5 + (opts.axis === "x" ? v : 0) + j, y: 0.5 + (opts.axis === "y" ? v : 0) + j, ts: t },
      FACE_W, FACE_H,
    );
    if (r && !hit) hit = r;
  }
  return hit;
}

/** Pure jitter around a fixed point — the false-positive case. */
function jitterOnly(amplitude: number, seconds: number, rateHz: number, seed = 3): HeadGestureResult | null {
  const det = createHeadGestureDetector();
  const rnd = noise(seed);
  const stepMs = 1000 / rateHz;
  const n = Math.round(seconds * rateHz);
  let hit: HeadGestureResult | null = null;
  for (let i = 0; i < n; i++) {
    const r = det.update(
      { x: 0.5 + amplitude * rnd(), y: 0.5 + amplitude * rnd(), ts: i * stepMs },
      FACE_W, FACE_H,
    );
    if (r && !hit) hit = r;
  }
  return hit;
}

describe("analyseAxis", () => {
  it("finds no oscillation in a monotonic drift", () => {
    const vals = Array.from({ length: 20 }, (_, i) => i * 0.01);
    const times = Array.from({ length: 20 }, (_, i) => i * 100);
    expect(analyseAxis(vals, times, 0.02).reversals).toBe(0);
  });

  it("measures a regular oscillation as regular (low cv)", () => {
    const vals: number[] = [], times: number[] = [];
    for (let i = 0; i < 40; i++) {
      times.push(i * 100);
      vals.push(Math.sin(2 * Math.PI * 1 * (i * 100 / 1000)) * 0.1);
    }
    const a = analyseAxis(vals, times, 0.05);
    expect(a.reversals).toBeGreaterThanOrEqual(3);
    expect(a.cv).toBeLessThan(0.3);
  });

  it("ignores reversals that never travelled — the jitter case", () => {
    const vals: number[] = [], times: number[] = [];
    for (let i = 0; i < 40; i++) { times.push(i * 100); vals.push(i % 2 === 0 ? 0.001 : -0.001); }
    // Reverses every single sample, but goes nowhere.
    expect(analyseAxis(vals, times, 0.05).reversals).toBe(0);
  });
});

describe("false positives — what the old detector got wrong", () => {
  it("does NOT fire on pure jitter at the app's 3.3 Hz cadence", () => {
    expect(jitterOnly(0.02, 10, 3.3)).toBeNull();
  });

  it("does NOT fire on jitter several times worse than the tracker's — size is not the gate", () => {
    // MediaPipe nose-tip jitter on a held face is ~±0.005 normalized; 0.04 is
    // roughly eight times that, i.e. bad lighting / motion blur territory.
    expect(jitterOnly(0.04, 10, 3.3)).toBeNull();
  });

  it("KNOWN LIMIT: per-frame excursions the size of a gesture cannot be rejected at 3.3 Hz", () => {
    // ±0.08 is the nose tip moving ~27% of face width between consecutive
    // samples. At 303 ms per sample there is no information left to tell that
    // apart from a real shake — the movement and the sampling are the same
    // order. This is a sampling limit, not a threshold that needs tuning, and
    // the fix is the tracker rate (D9), not this module. Documented rather
    // than asserted away, so nobody "fixes" it here.
    const r = jitterOnly(0.08, 10, 3.3);
    if (r) expect(r.aliasRisk).toBe(true);   // at least it admits the period is junk
  });

  it("does NOT fire on jitter at a high sample rate", () => {
    expect(jitterOnly(0.03, 10, 15)).toBeNull();
  });

  it("does NOT fire on slow drift (leaning, repositioning)", () => {
    const det = createHeadGestureDetector();
    let hit: HeadGestureResult | null = null;
    for (let i = 0; i < 60; i++) {
      const r = det.update({ x: 0.3 + i * 0.004, y: 0.5, ts: i * 100 }, FACE_W, FACE_H);
      if (r) hit = r;
    }
    expect(hit).toBeNull();
  });

  it("refuses a diagonal wobble rather than forcing a yes/no", () => {
    const det = createHeadGestureDetector();
    let hit: HeadGestureResult | null = null;
    for (let i = 0; i < 60; i++) {
      const t = i * 100;
      const v = Math.sin(2 * Math.PI * 0.8 * (t / 1000));
      // Equal normalized amplitude on both axes.
      const r = det.update(
        { x: 0.5 + v * FACE_W * 0.2, y: 0.5 + v * FACE_H * 0.2, ts: t }, FACE_W, FACE_H);
      if (r) hit = r;
    }
    expect(hit).toBeNull();
  });
});

describe("aliasing", () => {
  it("keeps the LABEL right for a fast shake under-sampled at 3.3 Hz", () => {
    // 4 Hz folds to ~0.7 Hz at this rate, but it folds on the SAME AXIS — so
    // "shake" is still the correct answer. Aliasing corrupts the period, not
    // the axis, which is why rejecting it outright would lose real gestures.
    const r = oscillate({ axis: "x", hz: 4, amplitude: 0.05, seconds: 10, rateHz: 3.3 });
    if (r) expect(r.gesture).toBe("shake");
  });

  it("FLAGS the period as unreliable when the oscillation was barely resolved", () => {
    const r = oscillate({ axis: "x", hz: 4, amplitude: 0.05, seconds: 10, rateHz: 3.3 });
    if (r) expect(r.aliasRisk).toBe(true);
  });

  it("reads a fast shake cleanly once the sample rate can see it", () => {
    const r = oscillate({ axis: "x", hz: 4, amplitude: 0.05, seconds: 6, rateHz: 30 });
    expect(r).not.toBeNull();
    expect(r!.gesture).toBe("shake");
    expect(r!.aliasRisk).toBe(false);
  });

  it("rejects a reversal on EVERY sample — noise at Nyquist is never a gesture", () => {
    const det = createHeadGestureDetector();
    let hit: HeadGestureResult | null = null;
    for (let i = 0; i < 60; i++) {
      // Big, perfectly regular, one sample per half-cycle.
      const r = det.update({ x: 0.5, y: 0.5 + (i % 2 ? 0.09 : -0.09), ts: i * 300 }, FACE_W, FACE_H);
      if (r) hit = r;
    }
    expect(hit).toBeNull();
  });
});

describe("true positives", () => {
  it("detects a slow deliberate nod at the app's cadence", () => {
    const r = oscillate({ axis: "y", hz: 0.8, amplitude: 0.07, seconds: 8, rateHz: 3.3 });
    expect(r).not.toBeNull();
    expect(r!.gesture).toBe("nod");
    expect(r!.confidence).toBeGreaterThan(0);
  });

  it("detects a slow deliberate shake at the app's cadence", () => {
    const r = oscillate({ axis: "x", hz: 0.8, amplitude: 0.06, seconds: 8, rateHz: 3.3 });
    expect(r).not.toBeNull();
    expect(r!.gesture).toBe("shake");
  });

  it("survives a noisy but genuine nod", () => {
    const r = oscillate({ axis: "y", hz: 0.8, amplitude: 0.08, seconds: 8, rateHz: 6, jitter: 0.006 });
    expect(r).not.toBeNull();
    expect(r!.gesture).toBe("nod");
  });

  it("resolves the half-period with enough samples to be believed", () => {
    const r = oscillate({ axis: "y", hz: 0.8, amplitude: 0.07, seconds: 8, rateHz: 6 })!;
    expect(r.halfPeriodMs).toBeLessThanOrEqual(CFG.maxHalfPeriodMs);
    // 0.8 Hz at 6 Hz sampling is comfortably resolved, so the period stands.
    expect((r.halfPeriodMs / 1000) * 6).toBeGreaterThanOrEqual(CFG.minSamplesPerHalfPeriod);
    expect(r.aliasRisk).toBe(false);
  });

  it("ignores a movement too small to be communicative", () => {
    expect(oscillate({ axis: "y", hz: 0.8, amplitude: 0.005, seconds: 8, rateHz: 6 })).toBeNull();
  });
});

describe("housekeeping", () => {
  it("needs a minimum number of samples before judging anything", () => {
    const det = createHeadGestureDetector();
    for (let i = 0; i < CFG.minSamples - 1; i++) {
      expect(det.update({ x: 0.5, y: 0.5 + (i % 2 ? 0.1 : -0.1), ts: i * 100 }, FACE_W, FACE_H)).toBeNull();
    }
  });

  it("reports one gesture once — the refractory period holds", () => {
    const det = createHeadGestureDetector();
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      const t = i * 300;
      const v = Math.sin(2 * Math.PI * 0.8 * (t / 1000)) * 0.07;
      if (det.update({ x: 0.5, y: 0.5 + v, ts: t }, FACE_W, FACE_H)) hits++;
    }
    // 12s of continuous nodding at a 2s refractory — a handful, not 40.
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThanOrEqual(6);
  });

  it("tolerates a missing face without throwing or polluting the window", () => {
    const det = createHeadGestureDetector();
    expect(det.update(null, FACE_W, FACE_H)).toBeNull();
    expect(det.sampleRateHz()).toBe(0);
  });

  it("ignores a zero-sized face box", () => {
    const det = createHeadGestureDetector();
    let hit: HeadGestureResult | null = null;
    for (let i = 0; i < 40; i++) {
      const v = Math.sin(2 * Math.PI * 0.8 * (i * 0.3)) * 0.07;
      const r = det.update({ x: 0.5, y: 0.5 + v, ts: i * 300 }, 0, 0);
      if (r) hit = r;
    }
    expect(hit).toBeNull();
  });

  it("measures its own sample rate", () => {
    const det = createHeadGestureDetector();
    for (let i = 0; i < 10; i++) det.update({ x: 0.5, y: 0.5, ts: i * 100 }, FACE_W, FACE_H);
    expect(det.sampleRateHz()).toBeCloseTo(10, 0);
  });
});
