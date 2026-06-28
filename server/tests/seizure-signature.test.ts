/**
 * Seizure motion signature (PROTOTYPE) — the point of these tests is to show the
 * signal SEPARATES a synthetic tonic-clonic pattern from Rett-like hand
 * stereotypy, which is the whole specificity problem. Landmarks are synthesized
 * (normalized, y down) at a 15 fps cadence (≥10 fps so the clonic band is
 * resolvable). All readings are coarse HINTS the Observer adjudicates.
 */

import { describe, it, expect } from "@jest/globals";
import {
  analyzeWindow, updateBaseline, emptyBaseline, summarizeSignature, suspectSeizure,
  recentDownwardSlump,
  type PoseFrame, type MotionBaseline,
} from "../../shared/aac/seizure-signature.js";
import { POSE_IDX, type PoseLandmark } from "../../shared/aac/pose-classify.js";

const FPS = 15;
const DT = 1000 / FPS;

/** Neutral seated upright pose; per-landmark offsets are layered on top. */
function basePose(offsets: Partial<Record<number, { dx: number; dy: number }>> = {}): PoseLandmark[] {
  const home: Record<number, { x: number; y: number }> = {
    [POSE_IDX.nose]: { x: 0.5, y: 0.15 },
    [POSE_IDX.leftEar]: { x: 0.46, y: 0.15 },
    [POSE_IDX.rightEar]: { x: 0.54, y: 0.15 },
    [POSE_IDX.leftShoulder]: { x: 0.45, y: 0.30 },
    [POSE_IDX.rightShoulder]: { x: 0.55, y: 0.30 },
    [POSE_IDX.leftElbow]: { x: 0.42, y: 0.42 },
    [POSE_IDX.rightElbow]: { x: 0.58, y: 0.42 },
    [POSE_IDX.leftWrist]: { x: 0.44, y: 0.52 },
    [POSE_IDX.rightWrist]: { x: 0.56, y: 0.52 },
    [POSE_IDX.leftHip]: { x: 0.46, y: 0.60 },
    [POSE_IDX.rightHip]: { x: 0.54, y: 0.60 },
  };
  const lm: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [i, p] of Object.entries(home)) {
    const o = offsets[+i] ?? { dx: 0, dy: 0 };
    lm[+i] = { x: p.x + o.dx, y: p.y + o.dy, visibility: 0.9 };
  }
  return lm;
}

function frames(n: number, fn: (i: number, t: number) => PoseLandmark[]): PoseFrame[] {
  return Array.from({ length: n }, (_, i) => ({ ts: i * DT, landmarks: fn(i, i * DT) }));
}

/** Quiet: tiny incidental drift only. */
const quiet = () => frames(30, () => basePose());

/** Rett-like stereotypy: rhythmic ~2.5 Hz hand-wringing — BOTH wrists oscillate
 *  near the midline, but ASYMMETRIC (anti-phase) and DISTAL only (no torso/head,
 *  shoulders/elbows still). The realistic false-positive to reject. */
function stereotypy(): PoseFrame[] {
  const f = 2.5;
  return frames(30, (i, t) => {
    const ph = 2 * Math.PI * f * (t / 1000);
    const a = 0.03 * Math.sin(ph);
    return basePose({
      [POSE_IDX.leftWrist]: { dx: a, dy: 0 },
      [POSE_IDX.rightWrist]: { dx: -a, dy: 0 }, // anti-phase → low bilateral symmetry
    });
  });
}

/** Tonic-clonic clonic phase: ~3.3 Hz, BILATERAL-synchronous, whole-limb +
 *  axial (wrists, elbows, shoulders, head, hips all jerk together, in phase). */
function clonic(): PoseFrame[] {
  const f = 3.3;
  return frames(30, (i, t) => {
    const ph = 2 * Math.PI * f * (t / 1000);
    const j = 0.04 * Math.sin(ph); // shared phase across the body
    return basePose({
      [POSE_IDX.leftWrist]: { dx: j, dy: j },
      [POSE_IDX.rightWrist]: { dx: j, dy: j },
      [POSE_IDX.leftElbow]: { dx: j * 0.7, dy: j * 0.7 },
      [POSE_IDX.rightElbow]: { dx: j * 0.7, dy: j * 0.7 },
      [POSE_IDX.leftShoulder]: { dx: j * 0.4, dy: j * 0.4 },
      [POSE_IDX.rightShoulder]: { dx: j * 0.4, dy: j * 0.4 },
      [POSE_IDX.nose]: { dx: j * 0.5, dy: j * 0.5 },
      [POSE_IDX.leftHip]: { dx: j * 0.3, dy: 0 },
      [POSE_IDX.rightHip]: { dx: j * 0.3, dy: 0 },
    });
  });
}

/** Build a baseline warmed up on quiet windows (so ratios are meaningful). */
function warmBaseline(): MotionBaseline {
  let b = emptyBaseline();
  for (let k = 0; k < 8; k++) {
    const sig = analyzeWindow(quiet(), b);
    b = updateBaseline(b, sig.regionEnergy);
  }
  return b;
}

// Rate-parameterized builders for the cross-rate (watch-bump) tests.
function framesAt(fps: number, durationMs: number, fn: (t: number) => PoseLandmark[]): PoseFrame[] {
  const dt = 1000 / fps;
  const n = Math.round(durationMs / dt);
  return Array.from({ length: n }, (_, i) => ({ ts: i * dt, landmarks: fn(i * dt) }));
}
const quietAt = (fps: number) => framesAt(fps, 4000, () => basePose());
const clonicAt = (fps: number) => framesAt(fps, 4000, (t) => {
  const j = 0.04 * Math.sin(2 * Math.PI * 3.3 * (t / 1000));
  return basePose({
    [POSE_IDX.leftWrist]: { dx: j, dy: j }, [POSE_IDX.rightWrist]: { dx: j, dy: j },
    [POSE_IDX.leftElbow]: { dx: j * 0.7, dy: j * 0.7 }, [POSE_IDX.rightElbow]: { dx: j * 0.7, dy: j * 0.7 },
    [POSE_IDX.leftShoulder]: { dx: j * 0.4, dy: j * 0.4 }, [POSE_IDX.rightShoulder]: { dx: j * 0.4, dy: j * 0.4 },
    [POSE_IDX.nose]: { dx: j * 0.5, dy: j * 0.5 },
    [POSE_IDX.leftHip]: { dx: j * 0.3, dy: 0 }, [POSE_IDX.rightHip]: { dx: j * 0.3, dy: 0 },
  });
});
function warmBaselineAt(fps: number): MotionBaseline {
  let b = emptyBaseline();
  for (let k = 0; k < 8; k++) b = updateBaseline(b, analyzeWindow(quietAt(fps), b).regionEnergy);
  return b;
}

/** Shift the whole torso (the 4 landmarks the centroid uses) down by dy(t). */
const torsoShift = (dy: number) => basePose({
  [POSE_IDX.leftShoulder]: { dx: 0, dy }, [POSE_IDX.rightShoulder]: { dx: 0, dy },
  [POSE_IDX.leftHip]: { dx: 0, dy }, [POSE_IDX.rightHip]: { dx: 0, dy },
});
// Sudden seated slump: upright, then a fast drop ~0.15 over ~0.6s that HOLDS.
const slump = () => frames(30, (i, t) =>
  torsoShift(t > 1100 ? 0.15 : t > 500 ? 0.15 * (t - 500) / 600 : 0));
// Voluntary bob: down and back up within the window (net ~0) — must be rejected.
const bob = () => frames(30, (i, t) =>
  torsoShift(0.15 * Math.max(0, Math.sin(Math.PI * t / 1500))));

describe("analyzeWindow — quiet baseline", () => {
  it("reports no event and near-baseline energy when still", () => {
    const sig = analyzeWindow(quiet(), warmBaseline());
    expect(sig.phase).toBe("none");
    expect(sig.confidence).toBe(0);
  });

  it("returns 'none' with too few frames rather than guessing", () => {
    expect(analyzeWindow(quiet().slice(0, 4), warmBaseline()).phase).toBe("none");
  });
});

describe("specificity — stereotypy must NOT read as clonic", () => {
  it("does not call clonic on distal anti-phase hand-wringing", () => {
    const sig = analyzeWindow(stereotypy(), warmBaseline());
    expect(sig.phase).not.toBe("clonic");
  });

  it("sees stereotypy as low bilateral symmetry and narrow extent", () => {
    const sig = analyzeWindow(stereotypy(), warmBaseline());
    expect(sig.bilateralSymmetry).toBeLessThan(0.5);
    expect(sig.involvedRegions).not.toContain("torso");
  });
});

describe("sensitivity — synthetic clonic SHOULD read as clonic", () => {
  const sig = analyzeWindow(clonic(), warmBaseline());

  it("calls the clonic phase", () => {
    expect(sig.phase).toBe("clonic");
  });
  it("recovers a frequency in the clonic band", () => {
    expect(sig.dominantHz).toBeGreaterThanOrEqual(2);
    expect(sig.dominantHz).toBeLessThanOrEqual(6);
  });
  it("sees high bilateral symmetry and axial involvement", () => {
    expect(sig.bilateralSymmetry).toBeGreaterThanOrEqual(0.5);
    expect(sig.involvedRegions.length).toBeGreaterThanOrEqual(3);
    expect(sig.involvedRegions.some(r => r === "torso" || r === "head")).toBe(true);
  });
  it("assigns higher confidence to clonic than to stereotypy", () => {
    const stereo = analyzeWindow(stereotypy(), warmBaseline());
    expect(sig.confidence).toBeGreaterThan(stereo.confidence);
  });
});

describe("summarizeSignature — the [MOTION SIGNATURE] line", () => {
  it("renders a hedged convulsive line (with duration) for a confident clonic call", () => {
    const sig = analyzeWindow(clonic(), warmBaseline());
    const line = summarizeSignature(sig, 22_000);
    expect(line).toContain("[MOTION SIGNATURE]");
    expect(line).toContain("tonic-clonic");
    expect(line).toContain("ongoing ~22s");
    expect(line!.toLowerCase()).toContain("verify"); // self-skeptical
  });

  it("returns null for a quiet window (nothing to surface)", () => {
    expect(summarizeSignature(analyzeWindow(quiet(), warmBaseline()))).toBeNull();
  });

  it("returns null for a low-confidence clonic call (below the escalate floor)", () => {
    const weak = { ...analyzeWindow(clonic(), warmBaseline()), confidence: 0.2 };
    expect(summarizeSignature(weak)).toBeNull();
  });
});

describe("suspectSeizure — low-fps watch trigger", () => {
  it("fires on broad axial anomalous motion (clonic-like)", () => {
    expect(suspectSeizure(analyzeWindow(clonic(), warmBaseline()))).toBe(true);
  });
  it("does NOT fire on distal hand stereotypy", () => {
    expect(suspectSeizure(analyzeWindow(stereotypy(), warmBaseline()))).toBe(false);
  });
  it("does NOT fire on a quiet window", () => {
    expect(suspectSeizure(analyzeWindow(quiet(), warmBaseline()))).toBe(false);
  });
});

describe("energy is frame-rate invariant (enables the watch bump)", () => {
  it("flags the SAME convulsive motion whether baseline is 2.5fps and window 15fps or vice-versa", () => {
    // Baseline learned at the cheap rate; the closer-look window at the bumped
    // rate. Per-second energy keeps energyVsBaseline comparable across rates —
    // per-FRAME energy would collapse ~6× and miss it.
    const lowBaseline = warmBaselineAt(2.5);
    const hiWindow = analyzeWindow(clonicAt(15), lowBaseline);
    expect(hiWindow.energyVsBaseline).toBeGreaterThan(2.5);
    expect(suspectSeizure(hiWindow)).toBe(true);

    const hiBaseline = warmBaselineAt(15);
    const lowWindow = analyzeWindow(clonicAt(2.5), hiBaseline);
    expect(lowWindow.energyVsBaseline).toBeGreaterThan(2.5);
  });
});

describe("atonic drop attack — sudden seated collapse", () => {
  it("calls atonic with the drop flag on a fast persisting slump", () => {
    const sig = analyzeWindow(slump(), warmBaseline());
    expect(sig.phase).toBe("atonic");
    expect(sig.atonicDrop).toBe(true);
    expect(sig.confidence).toBeGreaterThan(0.5);
  });

  it("renders a slump [MOTION SIGNATURE] line for a drop", () => {
    const line = summarizeSignature(analyzeWindow(slump(), warmBaseline()));
    expect(line).toContain("[MOTION SIGNATURE]");
    expect(line!.toLowerCase()).toContain("slump");
  });

  it("does NOT flag a voluntary bob (down and back up — nets to zero)", () => {
    const sig = analyzeWindow(bob(), warmBaseline());
    expect(sig.atonicDrop).toBeFalsy();
  });

  it("a plain still window does not escalate (summary null without a drop)", () => {
    // Baseline warmed on MOTION so stillness reads atonic-flat, but no drop.
    let b = emptyBaseline();
    for (let k = 0; k < 8; k++) b = updateBaseline(b, analyzeWindow(stereotypy(), b).regionEnergy);
    const sig = analyzeWindow(quiet(), b);
    expect(sig.phase).toBe("atonic");
    expect(sig.atonicDrop).toBeFalsy();
    expect(summarizeSignature(sig)).toBeNull();
  });
});

describe("recentDownwardSlump — collapse about to leave frame", () => {
  it("true when the torso drifted down over the recent window", () => {
    const fr = slump();
    expect(recentDownwardSlump(fr, fr[fr.length - 1].ts)).toBe(true);
  });
  it("false when the body is still", () => {
    const fr = quiet();
    expect(recentDownwardSlump(fr, fr[fr.length - 1].ts)).toBe(false);
  });
  it("false for upward motion (standing up, not slumping)", () => {
    const fr = framesAt(15, 2000, (t) => torsoShift(0.15 - 0.15 * Math.min(1, t / 1100)));
    expect(recentDownwardSlump(fr, fr[fr.length - 1].ts)).toBe(false);
  });
  it("catches a SMALL slump (low threshold by design)", () => {
    const fr = framesAt(15, 2000, (t) => torsoShift(t > 800 ? 0.06 : 0));
    expect(recentDownwardSlump(fr, fr[fr.length - 1].ts)).toBe(true);
  });
});

describe("flat state — atonic / post-ictal candidate", () => {
  it("flags near-zero motion as atonic (caller upgrades to post-ictal by history)", () => {
    // Baseline warmed on MOVING windows so stillness reads as below-baseline.
    let b = emptyBaseline();
    for (let k = 0; k < 8; k++) b = updateBaseline(b, analyzeWindow(stereotypy(), b).regionEnergy);
    const sig = analyzeWindow(quiet(), b);
    expect(sig.phase).toBe("atonic");
  });
});
