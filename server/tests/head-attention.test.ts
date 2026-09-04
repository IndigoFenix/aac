/**
 * Head-attention debouncer — the replacement for the per-tick head_turn events.
 *
 * The bug being pinned here is not hypothetical: on real prod sessions the old
 * path produced 45% "turned left", 21% "shaking head" and only 4% "facing
 * camera", with left and right inside the SAME 8-second window. So the central
 * test is the chatter one — a signal dithering across the threshold must commit
 * NOTHING. See planning-docs/aac-face-expression-decoder.md §2.5.
 */

import { describe, it, expect } from "@jest/globals";
import {
  createHeadAttentionTracker, classifyDeviation, describeAttention,
  neutralReliability, mergeNeutralProfile, reportedSpread,
  DEFAULT_HEAD_ATTENTION_CONFIG,
  NEUTRAL_MIN_SAMPLES, NEUTRAL_MIN_SESSIONS, NEUTRAL_SPREAD_FLOOR,
  NEUTRAL_SESSION_MIN_SAMPLES, NEUTRAL_SESSION_SPREAD_MAX, NEUTRAL_MAX_STEP,
  type AttentionReading, type HeadPoseInput, type HeadNeutralProfile,
} from "../../shared/aac/head-attention.js";

const CFG = DEFAULT_HEAD_ATTENTION_CONFIG;

/** Feed a tracker a run of identical samples at `stepMs`, returning every
 *  reading. Time starts at `t0` so tests can chain runs. */
function feed(
  tracker: ReturnType<typeof createHeadAttentionTracker>,
  pose: HeadPoseInput | null,
  count: number,
  t0: number,
  stepMs = 100,
): { readings: AttentionReading[]; endMs: number } {
  const readings: AttentionReading[] = [];
  let t = t0;
  for (let i = 0; i < count; i++) {
    readings.push(tracker.update(pose, t));
    t += stepMs;
  }
  return { readings, endMs: t };
}

/** Push past the neutral warm-up while facing straight ahead. */
function warmedTracker(overrides?: Parameters<typeof createHeadAttentionTracker>[0]) {
  const tr = createHeadAttentionTracker(overrides);
  const { endMs } = feed(tr, { yaw: 0, pitch: 0 }, 60, 0);   // 6s > 4s warmup
  return { tr, t: endMs };
}

const last = <T,>(a: T[]) => a[a.length - 1];

describe("classifyDeviation", () => {
  it("reports centre inside both thresholds", () => {
    expect(classifyDeviation(0.1, 0.1, 0.3, 0.3)).toEqual({ away: false, direction: null });
  });

  it("signs yaw as the subject's own left/right", () => {
    expect(classifyDeviation(0.5, 0, 0.3, 0.3).direction).toBe("right");
    expect(classifyDeviation(-0.5, 0, 0.3, 0.3).direction).toBe("left");
  });

  it("signs pitch down-positive", () => {
    expect(classifyDeviation(0, 0.5, 0.3, 0.3).direction).toBe("down");
    expect(classifyDeviation(0, -0.5, 0.3, 0.3).direction).toBe("up");
  });

  it("picks the axis that most exceeds ITS OWN threshold, not the larger raw value", () => {
    // pitch is numerically larger, but yaw is further past its (much smaller)
    // threshold. The old code compared |yaw| to |pitch| directly and would have
    // said "down" here.
    expect(classifyDeviation(0.3, 0.4, 0.1, 0.9).direction).toBe("right");
  });
});

describe("dwell", () => {
  it("ignores an excursion shorter than minDwellMs", () => {
    const { tr, t } = warmedTracker();
    // 3 samples at 100ms = 200ms elapsed, well under the 500ms dwell.
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 3, t);
    expect(readings.every(r => r.state === "attending")).toBe(true);
    expect(readings.every(r => r.episode === null)).toBe(true);
  });

  it("commits once the candidate has held long enough", () => {
    const { tr, t } = warmedTracker();
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 12, t);
    const end = last(readings);
    expect(end.state).toBe("away");
    expect(end.direction).toBe("right");
  });

  it("emits exactly ONE episode per transition, not one per tick", () => {
    const { tr, t } = warmedTracker();
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 30, t);
    expect(readings.filter(r => r.episode !== null)).toHaveLength(1);
  });

  it("the episode describes the state that just ENDED", () => {
    const { tr, t } = warmedTracker();
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 12, t);
    const ep = readings.find(r => r.episode)!.episode!;
    expect(ep.state).toBe("attending");
    expect(ep.durationMs).toBeGreaterThan(0);
  });
});

describe("hysteresis", () => {
  it("holds away while between exit and enter", () => {
    const { tr, t } = warmedTracker();
    const a = feed(tr, { yaw: 0.9, pitch: 0 }, 12, t);
    expect(last(a.readings).state).toBe("away");

    // 0.24 sits between exit (0.18) and enter (0.30) — must NOT release.
    const b = feed(tr, { yaw: 0.24, pitch: 0 }, 20, a.endMs);
    expect(last(b.readings).state).toBe("away");
  });

  it("releases once below the exit threshold", () => {
    const { tr, t } = warmedTracker();
    const a = feed(tr, { yaw: 0.9, pitch: 0 }, 12, t);
    const b = feed(tr, { yaw: 0.05, pitch: 0 }, 20, a.endMs);
    expect(last(b.readings).state).toBe("attending");
  });

  it("requires the ENTER threshold to switch direction while away", () => {
    const { tr, t } = warmedTracker();
    const a = feed(tr, { yaw: 0.9, pitch: 0 }, 12, t);
    expect(last(a.readings).direction).toBe("right");

    // Opposite side, but only past EXIT — not enough to flip the direction.
    const b = feed(tr, { yaw: -0.22, pitch: 0 }, 20, a.endMs);
    expect(last(b.readings).direction).toBe("right");

    // Clearly past ENTER on the other side — now it flips.
    const c = feed(tr, { yaw: -0.9, pitch: 0 }, 20, b.endMs);
    expect(last(c.readings).direction).toBe("left");
  });
});

describe("chatter immunity (the regression this module exists for)", () => {
  it("commits NOTHING when the signal dithers across the enter threshold", () => {
    const { tr, t } = warmedTracker();
    let time = t;
    const readings: AttentionReading[] = [];
    // 200 samples alternating either side of enterYaw — the exact pattern that
    // produced "turned left, turned right x6" in one window.
    for (let i = 0; i < 200; i++) {
      readings.push(tr.update({ yaw: i % 2 === 0 ? 0.32 : 0.28, pitch: 0 }, time));
      time += 100;
    }
    expect(readings.filter(r => r.episode !== null)).toHaveLength(0);
    expect(readings.every(r => r.state === "attending")).toBe(true);
  });

  it("does not oscillate between left and right", () => {
    const { tr, t } = warmedTracker();
    let time = t;
    const dirs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = tr.update({ yaw: i % 2 === 0 ? 0.4 : -0.4, pitch: 0 }, time);
      time += 100;
      if (r.state === "away") dirs.add(String(r.direction));
    }
    // Whatever it settles on, it must not be flip-flopping between both.
    expect(dirs.size).toBeLessThanOrEqual(1);
  });
});

describe("running neutral", () => {
  it("absorbs a constant offset — the pitch-offset case", () => {
    // Landmark 4 is not halfway between 10 and 152, so a LEVEL head reads a
    // non-zero pitch. Under the old absolute 0.15 threshold that alone read as
    // "turned down" forever.
    const tr = createHeadAttentionTracker();
    const { readings } = feed(tr, { yaw: 0, pitch: 0.2 }, 200, 0);
    expect(last(readings).state).toBe("attending");
    expect(last(readings).neutral.pitch).toBeCloseTo(0.2, 2);
  });

  it("still detects a turn away from a non-zero neutral", () => {
    const tr = createHeadAttentionTracker();
    const a = feed(tr, { yaw: 0, pitch: 0.2 }, 200, 0);
    expect(last(a.readings).state).toBe("attending");
    const b = feed(tr, { yaw: 0, pitch: 0.6 }, 20, a.endMs);
    expect(last(b.readings).state).toBe("away");
    expect(last(b.readings).direction).toBe("down");
  });

  it("does not chase a sustained genuine turn onto itself", () => {
    const { tr, t } = warmedTracker();
    // Hold a big turn for a long time; the neutral must stay near 0 so the
    // state remains "away" rather than quietly becoming the new normal.
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 600, t);
    expect(last(readings).state).toBe("away");
    expect(Math.abs(last(readings).neutral.yaw)).toBeLessThan(CFG.neutralMaxDev);
  });
});

describe("missing pose", () => {
  it("holds the committed state instead of asserting attention", () => {
    const { tr, t } = warmedTracker();
    const a = feed(tr, { yaw: 0.9, pitch: 0 }, 12, t);
    expect(last(a.readings).state).toBe("away");

    const b = feed(tr, null, 10, a.endMs);
    expect(last(b.readings).state).toBe("away");
  });

  it("treats a non-finite pose as missing", () => {
    const { tr, t } = warmedTracker();
    const r = tr.update({ yaw: NaN, pitch: 0 }, t);
    expect(r.state).toBe("attending");
    expect(r.episode).toBeNull();
  });
});

describe("describeAttention", () => {
  it("says nothing while attending — the default needs no words", () => {
    const { tr, t } = warmedTracker();
    expect(describeAttention(last(feed(tr, { yaw: 0, pitch: 0 }, 5, t).readings))).toBeNull();
  });

  it("says nothing while still calibrating", () => {
    const tr = createHeadAttentionTracker();
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 5, 0);
    expect(describeAttention(last(readings))).toBeNull();
  });

  it("names the direction once away", () => {
    const { tr, t } = warmedTracker();
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 12, t);
    expect(describeAttention(last(readings))).toMatch(/looking away to the right/);
  });

  it("adds a duration once the state has been held a while", () => {
    const { tr, t } = warmedTracker();
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 60, t);
    expect(describeAttention(last(readings))).toMatch(/\(\d+s\)/);
  });
});

// ---------------------------------------------------------------------------
// Accumulated cross-session neutral
// ---------------------------------------------------------------------------
//
// The concern this section exists for: a simple average swings wildly early on.
// Same discipline as the voice/face galleries — gate intake on quality, carry
// the accumulated totals, floor the spread, weight merges by count.

const ISO = "2026-09-02T00:00:00.000Z";

const profile = (p: Partial<HeadNeutralProfile> = {}): HeadNeutralProfile => ({
  yaw: 0, pitch: 0,
  yawSpread: NEUTRAL_SPREAD_FLOOR, pitchSpread: NEUTRAL_SPREAD_FLOOR,
  n: 0, sessions: 0, updatedAt: ISO, ...p,
});

const obs = (yaw: number, pitch = 0, n = 500, spread = 0.05) =>
  ({ yaw, pitch, yawSpread: spread, pitchSpread: spread, n });

describe("neutralReliability", () => {
  it("is 0 for a missing profile — never-learned reads the same as untrusted", () => {
    expect(neutralReliability(null)).toBe(0);
    expect(neutralReliability(undefined)).toBe(0);
    expect(neutralReliability(profile())).toBe(0);
  });

  it("needs BOTH samples and sessions — a huge n from one sitting is one chair", () => {
    expect(neutralReliability(profile({ n: 10_000, sessions: 1 }))).toBeLessThan(0.5);
    expect(neutralReliability(profile({ n: 20, sessions: 10 }))).toBeLessThan(0.5);
  });

  it("reaches 1 only once both floors are met", () => {
    expect(neutralReliability(profile({
      n: NEUTRAL_MIN_SAMPLES, sessions: NEUTRAL_MIN_SESSIONS,
    }))).toBe(1);
  });

  it("rises monotonically with accumulated data", () => {
    const a = neutralReliability(profile({ n: 100, sessions: 3 }));
    const b = neutralReliability(profile({ n: 300, sessions: 3 }));
    expect(b).toBeGreaterThan(a);
  });
});

describe("reportedSpread", () => {
  it("floors a razor-thin spread — a 3-sample profile is not precise", () => {
    expect(reportedSpread(0)).toBe(NEUTRAL_SPREAD_FLOOR);
    expect(reportedSpread(0.001)).toBe(NEUTRAL_SPREAD_FLOOR);
  });

  it("passes a real spread through", () => {
    expect(reportedSpread(0.12)).toBeCloseTo(0.12, 6);
  });
});

describe("mergeNeutralProfile", () => {
  it("adopts the first usable session wholesale — there is nothing else yet", () => {
    const merged = mergeNeutralProfile(null, obs(0.2), ISO);
    expect(merged.yaw).toBeCloseTo(0.2, 6);
    expect(merged.sessions).toBe(1);
    expect(merged.n).toBe(500);
  });

  it("REJECTS a session too short to mean anything", () => {
    const stored = profile({ yaw: 0.1, n: 1000, sessions: 5 });
    const merged = mergeNeutralProfile(stored, obs(0.9, 0, NEUTRAL_SESSION_MIN_SAMPLES - 1), ISO);
    expect(merged).toEqual(stored);
  });

  it("REJECTS a restless session rather than averaging the fidgeting in", () => {
    const stored = profile({ yaw: 0.1, n: 1000, sessions: 5 });
    const merged = mergeNeutralProfile(
      stored, obs(0.9, 0, 500, NEUTRAL_SESSION_SPREAD_MAX + 0.1), ISO);
    expect(merged).toEqual(stored);
  });

  it("moves an ESTABLISHED profile only slightly for one odd session", () => {
    const stored = profile({ yaw: 0, n: 5000, sessions: 20 });
    const merged = mergeNeutralProfile(stored, obs(0.5), ISO);
    expect(Math.abs(merged.yaw)).toBeLessThan(0.05);
  });

  it("never moves further than the step clamp in a single merge", () => {
    const stored = profile({ yaw: 0, n: 100, sessions: 1 });
    const merged = mergeNeutralProfile(stored, obs(0.9), ISO);
    expect(Math.abs(merged.yaw - stored.yaw)).toBeLessThanOrEqual(NEUTRAL_MAX_STEP + 1e-9);
  });

  it("converges toward a genuinely changed seating over repeated sessions", () => {
    // A remounted tablet must eventually win — the memory cap is what allows it.
    let p = profile({ yaw: 0, n: 500, sessions: 2 });
    for (let i = 0; i < 40; i++) p = mergeNeutralProfile(p, obs(0.4), ISO);
    expect(p.yaw).toBeGreaterThan(0.25);
    expect(p.sessions).toBe(42);
  });

  it("accumulates totals so reliability can grow", () => {
    let p: HeadNeutralProfile | null = null;
    for (let i = 0; i < 3; i++) p = mergeNeutralProfile(p, obs(0.1, 0, 200), ISO);
    expect(p!.n).toBe(600);
    expect(p!.sessions).toBe(3);
    expect(neutralReliability(p)).toBe(1);
  });

  it("keeps the spread floored after merging", () => {
    const merged = mergeNeutralProfile(null, obs(0.2, 0, 500, 0), ISO);
    expect(merged.yawSpread).toBe(NEUTRAL_SPREAD_FLOOR);
  });
});

describe("tracker + accumulated profile", () => {
  it("skips warm-up when seeded from a TRUSTED profile", () => {
    const tr = createHeadAttentionTracker(undefined, profile({
      yaw: 0.2, pitch: 0.2, n: NEUTRAL_MIN_SAMPLES, sessions: NEUTRAL_MIN_SESSIONS,
    }));
    const first = tr.update({ yaw: 0.2, pitch: 0.2 }, 0);
    expect(first.calibrating).toBe(false);
    expect(first.neutralTrust).toBe(1);
    expect(first.neutral.yaw).toBeCloseTo(0.2, 6);
  });

  it("still calibrates when the stored profile is too thin to trust", () => {
    const tr = createHeadAttentionTracker(undefined, profile({
      yaw: 0.2, pitch: 0, n: 10, sessions: 1,
    }));
    const first = tr.update({ yaw: 0.2, pitch: 0 }, 0);
    expect(first.calibrating).toBe(true);
    expect(first.neutralTrust).toBeGreaterThan(0);
    expect(first.neutralTrust).toBeLessThan(0.5);
  });

  it("detects a turn IMMEDIATELY when seeded — no blind opening minutes", () => {
    const tr = createHeadAttentionTracker(undefined, profile({
      yaw: 0.2, pitch: 0, n: NEUTRAL_MIN_SAMPLES, sessions: NEUTRAL_MIN_SESSIONS,
    }));
    const { readings } = feed(tr, { yaw: 0.9, pitch: 0 }, 12, 0);
    expect(last(readings).state).toBe("away");
    expect(last(readings).direction).toBe("right");
  });

  it("reports no session observation until enough accepted samples accrue", () => {
    const tr = createHeadAttentionTracker();
    // One under the floor (the very first sample seeds the neutral and is not
    // itself an observation, so feed floor+1 poses to land on floor-1 samples).
    feed(tr, { yaw: 0, pitch: 0 }, NEUTRAL_SESSION_MIN_SAMPLES, 0);
    expect(tr.sessionObservation()).toBeNull();

    feed(tr, { yaw: 0, pitch: 0 }, 5, NEUTRAL_SESSION_MIN_SAMPLES * 100);
    expect(tr.sessionObservation()).not.toBeNull();
  });

  it("produces a session observation centred on the settled pose", () => {
    const tr = createHeadAttentionTracker();
    feed(tr, { yaw: 0.12, pitch: -0.05 }, 300, 0);
    const o = tr.sessionObservation()!;
    expect(o).not.toBeNull();
    expect(o.yaw).toBeCloseTo(0.12, 2);
    expect(o.pitch).toBeCloseTo(-0.05, 2);
    expect(o.n).toBeGreaterThanOrEqual(NEUTRAL_SESSION_MIN_SAMPLES);
  });

  it("does NOT accumulate neutral evidence while committed away", () => {
    const { tr, t } = warmedTracker();
    expect(tr.sessionObservation()).toBeNull();
    const a = feed(tr, { yaw: 0.9, pitch: 0 }, 400, t);
    expect(last(a.readings).state).toBe("away");
    const after = tr.sessionObservation();
    // A long turn must not teach the profile that turned IS neutral.
    if (after) expect(Math.abs(after.yaw)).toBeLessThan(0.3);
  });

  it("round-trips: observe a session, merge it, seed the next session from it", () => {
    const tr1 = createHeadAttentionTracker();
    feed(tr1, { yaw: 0.25, pitch: 0.1 }, 300, 0);
    let p = mergeNeutralProfile(null, tr1.sessionObservation()!, ISO);

    const tr2 = createHeadAttentionTracker(undefined, p);
    feed(tr2, { yaw: 0.25, pitch: 0.1 }, 300, 0);
    p = mergeNeutralProfile(p, tr2.sessionObservation()!, ISO);

    const tr3 = createHeadAttentionTracker(undefined, p);
    feed(tr3, { yaw: 0.25, pitch: 0.1 }, 300, 0);
    p = mergeNeutralProfile(p, tr3.sessionObservation()!, ISO);

    expect(p.sessions).toBe(3);
    expect(neutralReliability(p)).toBe(1);
    expect(p.yaw).toBeCloseTo(0.25, 2);

    // Session 4 opens already tuned: the habitual pose reads as attending.
    const tr4 = createHeadAttentionTracker(undefined, p);
    const r = tr4.update({ yaw: 0.25, pitch: 0.1 }, 0);
    expect(r.calibrating).toBe(false);
    expect(r.state).toBe("attending");
  });
});
