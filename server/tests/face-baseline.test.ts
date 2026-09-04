/**
 * L2 — the per-student baseline. The layer the accuracy comes from, and the
 * one with the most ways to be quietly wrong.
 *
 * What is being protected:
 *   * ROBUSTNESS — the median must not follow a two-minute smile, or the smile
 *     stops registering as one. That is why it is a median, not a mean.
 *   * ABSENCE — a channel a session never observed keeps its stored value. Same
 *     rule the seizure baseline follows for a limb that was out of frame.
 *   * THE CAPS — a first real session dominates an empty profile, one odd
 *     session barely moves an established one, and an established one still
 *     eventually yields to a face that genuinely changed.
 *   * DEAD CHANNELS — a channel this model never moves must be excluded from
 *     composites rather than silently contributing a constant (D2).
 */

import { describe, it, expect } from "@jest/globals";
import {
  emptyHistogram, observeChannel, channelStats, zScore, binOf, binCenter,
  mergeFaceBaseline, coerceFaceBaseline, faceBaselineReliability,
  createFaceBaselineAccumulator, channelUsable,
  FACE_BASELINE_BINS, FACE_BASELINE_MIN_SAMPLES, FACE_BASELINE_MIN_SESSIONS,
  FACE_SESSION_MIN_SAMPLES, FACE_SESSION_WEIGHT_CAP, FACE_MEMORY_CAP,
  FACE_Z_CLAMP, CHANNEL_DEAD_MIN_SAMPLES,
  type ChannelHistogram, type FaceBaselineProfile, type SessionFaceObservation,
} from "../../shared/aac/face-baseline.js";
import { auChannel, geomChannel } from "../../shared/aac/face-aus.js";

const ISO = "2026-09-02T00:00:00.000Z";
const CH = auChannel("AU12");

/** A histogram over the given samples. */
function histOf(values: number[], channel = CH): ChannelHistogram {
  const h = emptyHistogram();
  for (const v of values) observeChannel(h, channel, v);
  return h;
}

/** Deterministic pseudo-random in [0,1) — mulberry32. Never Math.random in a
 *  test that asserts on a distribution. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const obs = (channels: Record<string, ChannelHistogram>, n: number): SessionFaceObservation =>
  ({ channels, n });

// ---------------------------------------------------------------------------

describe("binning", () => {
  it("clamps out-of-range values into the end bins rather than dropping them", () => {
    expect(binOf(CH, -5)).toBe(0);
    expect(binOf(CH, 5)).toBe(FACE_BASELINE_BINS - 1);
  });

  it("round-trips a value to within half a LOCAL bin", () => {
    // Local, not global: AU bins are warped, so a bin near full scale spans
    // more value than one near zero. Half the local width is the honest bound.
    for (const v of [0.02, 0.31, 0.5, 0.87]) {
      const b = binOf(CH, v);
      const width = Math.abs(binCenter(CH, Math.min(b + 1, FACE_BASELINE_BINS - 1)) - binCenter(CH, Math.max(b - 1, 0)))
        / (Math.min(b + 1, FACE_BASELINE_BINS - 1) - Math.max(b - 1, 0));
      expect(Math.abs(binCenter(CH, b) - v)).toBeLessThanOrEqual(width / 2 + 1e-9);
    }
  });

  it("uses the channel's own declared range for geometry, LINEARLY", () => {
    const c = geomChannel("mouthWidth");   // spans 0.4 .. 2.0
    expect(binOf(c, 0.4)).toBe(0);
    expect(binOf(c, 2.0)).toBe(FACE_BASELINE_BINS - 1);
    // Linear: the value a quarter of the way up the range lands a quarter of
    // the way up the bins.
    expect(binOf(c, 0.8)).toBe(Math.floor(FACE_BASELINE_BINS / 4));
  });

  it("WARPS AU bins toward zero, where these channels actually live", () => {
    // sqrt binning: the bottom 1% of the intensity range gets ~10% of the bins,
    // which is what makes an attenuated channel resolvable at all.
    expect(binOf(CH, 0.01)).toBeGreaterThanOrEqual(2);
    expect(binOf(CH, 0)).toBe(0);
    expect(binOf(CH, 1)).toBe(FACE_BASELINE_BINS - 1);
    // Still monotone — a warp that reorders values would corrupt every quantile.
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.01) {
      const b = binOf(CH, v);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it("ignores a non-finite sample instead of creating a NaN bin", () => {
    const h = emptyHistogram();
    observeChannel(h, CH, NaN);
    observeChannel(h, CH, Infinity);
    expect(h.n).toBe(0);
    expect(Object.keys(h.bins)).toEqual([]);
  });
});

describe("channelStats", () => {
  it("finds the median of a tight distribution", () => {
    const h = histOf(Array.from({ length: 200 }, () => 0.2));
    const s = channelStats(h, CH);
    expect(s.median).toBeCloseTo(0.2, 1);
    expect(s.rawMad).toBe(0);
    expect(s.n).toBe(200);
  });

  it("is ROBUST: a long high excursion does not drag the centre", () => {
    // 70% of the session at rest, 30% smiling hard.
    const rest = Array.from({ length: 700 }, () => 0.1);
    const smile = Array.from({ length: 300 }, () => 0.9);
    const s = channelStats(histOf([...rest, ...smile]), CH);
    expect(s.median).toBeLessThan(0.2);
    // A mean would have landed near 0.34 and the smile would stop registering.
    const mean = (700 * 0.1 + 300 * 0.9) / 1000;
    expect(s.median).toBeLessThan(mean - 0.1);
  });

  it("measures spread on a genuinely variable channel", () => {
    const r = rng(7);
    const s = channelStats(histOf(Array.from({ length: 800 }, () => 0.3 + (r() - 0.5) * 0.4)), CH);
    expect(s.median).toBeCloseTo(0.3, 1);
    expect(s.rawMad).toBeGreaterThan(0.05);
    expect(s.rawMad).toBeLessThan(0.2);
  });

  it("FLOORS the mad at the LOCAL bin width — a histogram cannot resolve finer", () => {
    const s = channelStats(histOf(Array.from({ length: 500 }, () => 0.2)), CH);
    expect(s.rawMad).toBe(0);
    expect(s.mad).toBeGreaterThan(0);
    expect(s.mad).toBeLessThan(0.05);
  });

  it("floors TIGHTER near zero than near full scale, because the bins are", () => {
    const low = channelStats(histOf(Array.from({ length: 500 }, () => 0.01)), CH);
    const high = channelStats(histOf(Array.from({ length: 500 }, () => 0.9)), CH);
    expect(low.mad).toBeLessThan(high.mad / 4);
  });

  it("marks a never-moving channel DEAD once there is enough evidence", () => {
    const few = channelStats(histOf(Array.from({ length: 50 }, () => 0)), CH);
    const many = channelStats(histOf(Array.from({ length: CHANNEL_DEAD_MIN_SAMPLES }, () => 0)), CH);
    // Not enough samples to call it dead yet — absence of evidence.
    expect(few.dead).toBe(false);
    expect(many.dead).toBe(true);
    expect(channelUsable(many)).toBe(false);
  });

  it("does NOT call a channel dead just because the student is CONSISTENT", () => {
    // A steady HIGH value is a real resting state (a mouth that habitually
    // rests open), not a channel the model never reports. Marking it dead would
    // drop it to the absolute path and report "mouth open" forever — D8 again.
    const steady = channelStats(histOf(Array.from({ length: 600 }, () => 0.62)), CH);
    expect(steady.dead).toBe(false);
    expect(channelUsable(steady)).toBe(true);
    expect(zScore(steady, 0.62)).toBeCloseTo(0, 0);
    expect(zScore(steady, 0.95)).toBeGreaterThan(3);
  });

  it("does NOT call a channel dead just because it is attenuated", () => {
    // Small values, but they move. Attenuation is exactly what z-scoring fixes.
    const r = rng(11);
    const s = channelStats(histOf(Array.from({ length: 600 }, () => r() * 0.09)), CH);
    expect(s.dead).toBe(false);
    expect(channelUsable(s)).toBe(true);
  });

  it("returns a usable, non-throwing result for an unseen channel", () => {
    const s = channelStats(undefined, CH);
    expect(s.n).toBe(0);
    expect(s.mad).toBeGreaterThan(0);
    expect(Number.isFinite(s.median)).toBe(true);
  });
});

describe("zScore", () => {
  const stats = channelStats(histOf(Array.from({ length: 800 }, (_, i) => 0.2 + ((i % 7) - 3) * 0.02)), CH);

  it("is zero at this person's own median", () => {
    expect(Math.abs(zScore(stats, stats.median))).toBeLessThan(0.5);
  });

  it("grows with the deviation, in both directions", () => {
    expect(zScore(stats, stats.median + 0.2)).toBeGreaterThan(zScore(stats, stats.median + 0.1));
    expect(zScore(stats, stats.median - 0.2)).toBeLessThan(0);
  });

  it("stays FINITE on a channel that barely moves — the mad floor's whole job", () => {
    const pinned = channelStats(histOf(Array.from({ length: 500 }, () => 0)), CH);
    const z = zScore(pinned, 0.5);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeLessThanOrEqual(FACE_Z_CLAMP);
    expect(z).toBeGreaterThan(3);
  });

  it("makes an ATTENUATED channel usable — the reason to score per person", () => {
    // A channel this model never pushes past 0.1. Against a global 0.5
    // threshold it is invisible; against its own distribution, a 0.09 reading
    // is a large deviation.
    const r = rng(3);
    const weak = channelStats(histOf(Array.from({ length: 600 }, () => r() * 0.02)), CH);
    expect(zScore(weak, 0.09)).toBeGreaterThan(2.5);
  });

  it("returns 0 rather than NaN for a junk value", () => {
    expect(zScore(stats, NaN)).toBe(0);
  });
});

describe("reliability", () => {
  it("is zero for a missing or empty profile", () => {
    expect(faceBaselineReliability(null)).toBe(0);
    expect(faceBaselineReliability({ channels: {}, n: 0, sessions: 0, updatedAt: ISO })).toBe(0);
  });

  it("requires BOTH samples and sessions — one long sitting is one sitting", () => {
    const oneHugeSession = faceBaselineReliability({
      channels: {}, n: 100_000, sessions: 1, updatedAt: ISO,
    });
    expect(oneHugeSession).toBeCloseTo(1 / FACE_BASELINE_MIN_SESSIONS, 3);
  });

  it("reaches 1 only with both", () => {
    expect(faceBaselineReliability({
      channels: {}, n: FACE_BASELINE_MIN_SAMPLES, sessions: FACE_BASELINE_MIN_SESSIONS, updatedAt: ISO,
    })).toBe(1);
  });
});

describe("mergeFaceBaseline", () => {
  it("discards a session too short to describe anything", () => {
    const stored: FaceBaselineProfile = { channels: { [CH]: histOf([0.2, 0.2]) }, n: 500, sessions: 3, updatedAt: ISO };
    const merged = mergeFaceBaseline(stored, obs({ [CH]: histOf([0.9]) }, FACE_SESSION_MIN_SAMPLES - 1), ISO);
    expect(merged).toEqual(stored);
  });

  it("adopts a channel never seen before", () => {
    const merged = mergeFaceBaseline(undefined, obs({ [CH]: histOf(Array(100).fill(0.3)) }, 100), ISO)!;
    expect(channelStats(merged.channels[CH], CH).median).toBeCloseTo(0.3, 1);
    expect(merged.sessions).toBe(1);
    expect(merged.n).toBe(100);
  });

  it("LEAVES an unobserved channel untouched — absent is not zero", () => {
    const other = geomChannel("mouthAspect");
    const stored: FaceBaselineProfile = {
      channels: { [CH]: histOf(Array(400).fill(0.2)), [other]: histOf(Array(400).fill(0.3), other) },
      n: 400, sessions: 2, updatedAt: ISO,
    };
    // A session where the mouth channel was never computable (no landmarks).
    const merged = mergeFaceBaseline(stored, obs({ [CH]: histOf(Array(100).fill(0.25)) }, 100), ISO)!;
    expect(merged.channels[other]).toEqual(stored.channels[other]);
  });

  it("moves an ESTABLISHED channel only slightly on one odd session", () => {
    const stored: FaceBaselineProfile = {
      channels: { [CH]: histOf(Array(5000).fill(0.2)) }, n: 5000, sessions: 20, updatedAt: ISO,
    };
    const merged = mergeFaceBaseline(stored, obs({ [CH]: histOf(Array(300).fill(0.9)) }, 300), ISO)!;
    expect(channelStats(merged.channels[CH], CH).median).toBeLessThan(0.3);
  });

  it("still CONVERGES when the student's face genuinely changes", () => {
    let p = mergeFaceBaseline(undefined, obs({ [CH]: histOf(Array(400).fill(0.2)) }, 400), ISO);
    for (let i = 0; i < 40; i++) {
      p = mergeFaceBaseline(p, obs({ [CH]: histOf(Array(400).fill(0.7)) }, 400), ISO);
    }
    expect(channelStats(p!.channels[CH], CH).median).toBeGreaterThan(0.6);
  });

  it("CAPS one session's weight — a marathon session cannot swamp the profile", () => {
    const stored: FaceBaselineProfile = {
      channels: { [CH]: histOf(Array(2000).fill(0.2)) }, n: 2000, sessions: 10, updatedAt: ISO,
    };
    const long = mergeFaceBaseline(
      stored, obs({ [CH]: histOf(Array(FACE_SESSION_WEIGHT_CAP * 20).fill(0.9)) }, FACE_SESSION_WEIGHT_CAP * 20), ISO)!;
    const normal = mergeFaceBaseline(
      stored, obs({ [CH]: histOf(Array(FACE_SESSION_WEIGHT_CAP).fill(0.9)) }, FACE_SESSION_WEIGHT_CAP), ISO)!;
    expect(channelStats(long.channels[CH], CH).median)
      .toBeCloseTo(channelStats(normal.channels[CH], CH).median, 2);
  });

  it("CAPS the stored side too, so the baseline never freezes", () => {
    const huge: FaceBaselineProfile = {
      channels: { [CH]: histOf(Array(FACE_MEMORY_CAP * 5).fill(0.2)) },
      n: FACE_MEMORY_CAP * 5, sessions: 200, updatedAt: ISO,
    };
    const merged = mergeFaceBaseline(huge, obs({ [CH]: histOf(Array(600).fill(0.9)) }, 600), ISO)!;
    // The stored side counts at most FACE_MEMORY_CAP, so 600 new samples still
    // move it measurably rather than being lost in a million old ones.
    expect(merged.channels[CH].n).toBeLessThanOrEqual(FACE_MEMORY_CAP + FACE_SESSION_WEIGHT_CAP + 1);
  });

  it("keeps the tail when scaling — the tail is what says how much a channel moves", () => {
    const r = rng(23);
    const spread = histOf(Array.from({ length: FACE_MEMORY_CAP * 3 }, () => 0.3 + (r() - 0.5) * 0.5));
    const stored: FaceBaselineProfile = { channels: { [CH]: spread }, n: spread.n, sessions: 50, updatedAt: ISO };
    const merged = mergeFaceBaseline(stored, obs({ [CH]: histOf(Array(100).fill(0.3)) }, 100), ISO)!;
    const before = channelStats(spread, CH);
    const after = channelStats(merged.channels[CH], CH);
    expect(after.rawMad).toBeGreaterThan(before.rawMad * 0.6);
  });

  it("counts every session and every real sample, caps notwithstanding", () => {
    let p = mergeFaceBaseline(undefined, obs({ [CH]: histOf(Array(100).fill(0.2)) }, 100), ISO);
    p = mergeFaceBaseline(p, obs({ [CH]: histOf(Array(100).fill(0.2)) }, 100), ISO);
    expect(p!.sessions).toBe(2);
    expect(p!.n).toBe(200);
  });
});

describe("coerceFaceBaseline", () => {
  it("returns undefined for junk rather than throwing", () => {
    expect(coerceFaceBaseline(null)).toBeUndefined();
    expect(coerceFaceBaseline("nonsense")).toBeUndefined();
    expect(coerceFaceBaseline({ channels: 5, n: 1, sessions: 1 })).toBeUndefined();
    expect(coerceFaceBaseline({ channels: {}, n: 1, sessions: 1 })).toBeUndefined();
  });

  it("keeps a well-formed profile", () => {
    const p = coerceFaceBaseline({
      channels: { [CH]: { bins: { "6": 100, "7": 50 }, n: 150 } },
      n: 150, sessions: 2, updatedAt: ISO,
    })!;
    expect(p.n).toBe(150);
    expect(p.channels[CH].n).toBe(150);
  });

  it("drops out-of-range bins and non-numeric counts instead of importing them", () => {
    const p = coerceFaceBaseline({
      channels: { [CH]: { bins: { "6": 100, "999": 20, "x": 5, "7": "nope" }, n: 125 } },
      n: 125, sessions: 1,
    })!;
    expect(Object.keys(p.channels[CH].bins)).toEqual(["6"]);
    // n is RECOMPUTED from the surviving bins, not trusted from the payload.
    expect(p.channels[CH].n).toBe(100);
  });
});

describe("the session accumulator", () => {
  it("scores against the SEEDED profile from the very first frame", () => {
    const seed = mergeFaceBaseline(undefined, obs({ [CH]: histOf(Array(800).fill(0.1)) }, 800), ISO)!;
    const acc = createFaceBaselineAccumulator(seed);
    acc.observe(new Map([[CH, 0.7]]));
    // One frame of its own, but 800 samples of stored evidence behind the read.
    // The merge caps one session at FACE_SESSION_WEIGHT_CAP, so the stored
    // histogram holds 600 of the 800, not all of them.
    expect(acc.stats(CH).n).toBeGreaterThan(500);
    expect(zScore(acc.stats(CH), 0.7)).toBeGreaterThan(3);
  });

  it("learns within the session when there is nothing stored", () => {
    const acc = createFaceBaselineAccumulator(null);
    for (let i = 0; i < 300; i++) acc.observe(new Map([[CH, 0.1]]));
    expect(acc.stats(CH).n).toBe(300);
    expect(acc.stats(CH).median).toBeCloseTo(0.1, 1);
    expect(zScore(acc.stats(CH), 0.6)).toBeGreaterThan(3);
  });

  it("does NOT double-count the seed in what it sends home", () => {
    const seed = mergeFaceBaseline(undefined, obs({ [CH]: histOf(Array(800).fill(0.1)) }, 800), ISO)!;
    const acc = createFaceBaselineAccumulator(seed);
    for (let i = 0; i < FACE_SESSION_MIN_SAMPLES + 10; i++) acc.observe(new Map([[CH, 0.2]]));
    const sent = acc.sessionObservation()!;
    expect(sent.n).toBe(FACE_SESSION_MIN_SAMPLES + 10);
    expect(sent.channels[CH].n).toBe(FACE_SESSION_MIN_SAMPLES + 10);
  });

  it("sends nothing home from a session too short to mean anything", () => {
    const acc = createFaceBaselineAccumulator(null);
    for (let i = 0; i < FACE_SESSION_MIN_SAMPLES - 1; i++) acc.observe(new Map([[CH, 0.2]]));
    expect(acc.sessionObservation()).toBeNull();
  });

  it("counts a frame once however many channels it carried", () => {
    const acc = createFaceBaselineAccumulator(null);
    for (let i = 0; i < 100; i++) {
      acc.observe(new Map([[CH, 0.2], [geomChannel("mouthAspect"), 0.3]]));
    }
    expect(acc.sessionObservation()!.n).toBe(100);
  });

  it("ignores an empty frame entirely", () => {
    const acc = createFaceBaselineAccumulator(null);
    for (let i = 0; i < 200; i++) acc.observe(new Map());
    expect(acc.sessionObservation()).toBeNull();
  });

  it("counts the session in progress toward reliability, or a cold student is pinned at zero", () => {
    const acc = createFaceBaselineAccumulator(null);
    expect(acc.reliability()).toBe(0);
    for (let i = 0; i < FACE_BASELINE_MIN_SAMPLES; i++) acc.observe(new Map([[CH, 0.2]]));
    expect(acc.reliability()).toBeCloseTo(1 / FACE_BASELINE_MIN_SESSIONS, 3);
  });

  it("caches stats without going stale enough to matter", () => {
    const acc = createFaceBaselineAccumulator(null);
    for (let i = 0; i < 100; i++) acc.observe(new Map([[CH, 0.1]]));
    const before = acc.stats(CH).median;
    for (let i = 0; i < 400; i++) acc.observe(new Map([[CH, 0.9]]));
    // The cache is keyed on the sample count, so a real shift still shows.
    expect(acc.stats(CH).median).toBeGreaterThan(before + 0.3);
  });

  it("resets cleanly back to the seed", () => {
    const seed = mergeFaceBaseline(undefined, obs({ [CH]: histOf(Array(800).fill(0.1)) }, 800), ISO)!;
    const acc = createFaceBaselineAccumulator(seed);
    for (let i = 0; i < 200; i++) acc.observe(new Map([[CH, 0.9]]));
    acc.reset();
    expect(acc.sessionObservation()).toBeNull();
    expect(acc.stats(CH).median).toBeCloseTo(0.1, 1);
  });
});
