/**
 * L1 — the normalized feature frame.
 *
 * Three things are being protected. The GAZE fix (D6): one conjugate
 * implementation, where there used to be four and two of them read a single
 * eye. The GEOMETRY invariants: a ratio that changes when the student leans
 * closer or tilts their head is not a feature, it is a distance sensor, and
 * every downstream z-score would inherit the error. And the ANISOTROPY
 * correction, which is easy to drop and silently wrong when it is.
 */

import { describe, it, expect } from "@jest/globals";
import {
  FACE_LANDMARK_INDICES, FACE_LANDMARK_SUBSET, pickFaceLandmarks,
  gazeVector, computeGeometry, computeQuality, landmarkJitter,
  QUALITY_MIN_READ, QUALITY_MAX_POSE,
  type FaceLandmarkSet, type Point2,
} from "../../shared/aac/face-features.js";

// ---------------------------------------------------------------------------
// A synthetic face, built in isotropic FACE units and then projected into
// image-normalized coordinates. Building it this way is the point: the tests
// below change the projection (scale, position, roll, frame aspect) and assert
// the features do not move.
// ---------------------------------------------------------------------------

/** Face-space layout. Interocular distance is exactly 1. */
const FACE_SPACE: Record<string, Point2> = {
  eyeInnerRight: { x: -0.5, y: 0 }, eyeInnerLeft: { x: 0.5, y: 0 },
  eyeOuterRight: { x: -1.1, y: 0 }, eyeOuterLeft: { x: 1.1, y: 0 },
  noseBridge: { x: 0, y: -0.1 }, noseTip: { x: 0, y: 0.6 },
  tragionRight: { x: -1.5, y: 0.1 }, tragionLeft: { x: 1.5, y: 0.1 },
  forehead: { x: 0, y: -1.2 }, chin: { x: 0, y: 1.8 },
  eyeRUpperA: { x: -0.85, y: -0.15 }, eyeRUpperB: { x: -0.7, y: -0.15 },
  eyeRLowerA: { x: -0.85, y: 0.15 }, eyeRLowerB: { x: -0.7, y: 0.15 },
  eyeRLid: { x: -0.8, y: -0.15 },
  eyeLUpperA: { x: 0.85, y: -0.15 }, eyeLUpperB: { x: 0.7, y: -0.15 },
  eyeLLowerA: { x: 0.85, y: 0.15 }, eyeLLowerB: { x: 0.7, y: 0.15 },
  eyeLLid: { x: 0.8, y: -0.15 },
  browRight: { x: -0.8, y: -0.45 }, browLeft: { x: 0.8, y: -0.45 },
  browInnerRight: { x: -0.35, y: -0.4 }, browInnerLeft: { x: 0.35, y: -0.4 },
  mouthCornerRight: { x: -0.45, y: 1.1 }, mouthCornerLeft: { x: 0.45, y: 1.1 },
  lipUpperInner: { x: 0, y: 1.05 }, lipLowerInner: { x: 0, y: 1.15 },
  lipUpperOuter: { x: 0, y: 0.95 }, lipLowerOuter: { x: 0, y: 1.25 },
};

interface Projection {
  /** Frame width / height. */
  aspect?: number;
  /** Face size in image-height units. */
  scale?: number;
  /** Centre of the face in normalized image coords. */
  cx?: number; cy?: number;
  /** Head roll, radians. */
  roll?: number;
  /** Per-point overrides in FACE space, applied before projection. */
  overrides?: Record<string, Point2>;
}

function project(p: Projection = {}): FaceLandmarkSet {
  const { aspect = 1, scale = 0.12, cx = 0.5, cy = 0.5, roll = 0, overrides = {} } = p;
  const cos = Math.cos(roll), sin = Math.sin(roll);
  const out: FaceLandmarkSet = {};
  for (const name of Object.keys(FACE_LANDMARK_INDICES)) {
    const src = overrides[name] ?? FACE_SPACE[name];
    if (!src) continue;
    const rx = src.x * cos - src.y * sin;
    const ry = src.x * sin + src.y * cos;
    // x is divided by aspect because image-normalized x spans a WIDER physical
    // extent than y; computeGeometry multiplies it back.
    (out as Record<string, Point2>)[name] = { x: cx + (rx * scale) / aspect, y: cy + ry * scale };
  }
  return out;
}

const bsMap = (o: Record<string, number>) => new Map(Object.entries(o));

// ---------------------------------------------------------------------------

describe("landmark subset", () => {
  it("is de-duplicated and ascending", () => {
    expect(FACE_LANDMARK_SUBSET).toEqual([...FACE_LANDMARK_SUBSET].sort((a, b) => a - b));
    expect(new Set(FACE_LANDMARK_SUBSET).size).toBe(FACE_LANDMARK_SUBSET.length);
  });

  it("is far smaller than the full mesh — that is the point", () => {
    expect(FACE_LANDMARK_SUBSET.length).toBeLessThan(60);
    expect(Math.max(...FACE_LANDMARK_SUBSET)).toBeLessThan(468);
  });

  it("refuses a short array rather than returning a half-filled set", () => {
    expect(pickFaceLandmarks(null)).toBeNull();
    expect(pickFaceLandmarks(new Array(100).fill({ x: 0, y: 0 }))).toBeNull();
  });

  it("picks every named point out of a full mesh", () => {
    const all = Array.from({ length: 478 }, (_, i) => ({ x: i / 478, y: 1 - i / 478 }));
    const picked = pickFaceLandmarks(all)!;
    expect(picked.noseTip).toEqual({ x: 4 / 478, y: 1 - 4 / 478 });
    expect(Object.keys(picked).length).toBe(Object.keys(FACE_LANDMARK_INDICES).length);
  });

  it("drops a non-finite point instead of importing NaN", () => {
    const all: Point2[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    all[FACE_LANDMARK_INDICES.noseTip] = { x: NaN, y: 0.5 };
    expect(pickFaceLandmarks(all)!.noseTip).toBeUndefined();
  });
});

describe("gazeVector — the one implementation (D6)", () => {
  it("reads BOTH eyes for a horizontal glance", () => {
    // Looking to the subject's right: left eye rotates IN, right eye rotates OUT.
    const g = gazeVector(bsMap({ eyeLookInLeft: 0.4, eyeLookOutRight: 0.4 }));
    expect(g.x).toBeCloseTo(0.4);
    expect(g.y).toBeCloseTo(0);
  });

  it("halves the reading when only one eye reports — the old bug's signature", () => {
    const both = gazeVector(bsMap({ eyeLookInLeft: 0.4, eyeLookOutRight: 0.4 }));
    const one = gazeVector(bsMap({ eyeLookOutRight: 0.4 }));
    expect(one.x).toBeCloseTo(both.x / 2);
  });

  it("does NOT read vertical gaze from the left eye alone", () => {
    // `eyeLookUpLeft ?? eyeLookUpRight` was always the left eye, because ?? only
    // falls through on undefined. A right-eye-only reading must still register.
    const g = gazeVector(bsMap({ eyeLookUpLeft: 0, eyeLookUpRight: 0.6 }));
    expect(g.y).toBeLessThan(0);
    expect(Math.abs(g.y)).toBeCloseTo(0.3);
  });

  it("signs match headPose: +x right, +y down", () => {
    expect(gazeVector(bsMap({ eyeLookOutLeft: 0.5, eyeLookInRight: 0.5 })).x).toBeLessThan(0);
    expect(gazeVector(bsMap({ eyeLookDownLeft: 0.5, eyeLookDownRight: 0.5 })).y).toBeGreaterThan(0);
  });

  it("is zero on an empty map, not NaN", () => {
    const g = gazeVector(undefined);
    expect(g.x).toBe(0);
    expect(g.magnitude).toBe(0);
  });
});

describe("computeGeometry", () => {
  it("returns nothing rather than guessing when landmarks are absent", () => {
    expect(computeGeometry(null, 1)).toEqual({});
    expect(computeGeometry({ noseTip: { x: 0.5, y: 0.5 } }, 1)).toEqual({});
  });

  it("derives the ratios the blendshape head does not give", () => {
    const g = computeGeometry(project(), 1);
    expect(g.eyeAspectLeft).toBeCloseTo(0.5, 3);
    expect(g.eyeAspectRight).toBeCloseTo(0.5, 3);
    expect(g.mouthWidth).toBeCloseTo(0.9, 3);
    expect(g.mouthAspect).toBeCloseTo(0.1 / 0.9, 3);
    expect(g.browLidGapLeft).toBeCloseTo(0.3, 3);
    expect(g.cornerAsymmetry).toBeCloseTo(0, 3);
  });

  it("is INVARIANT to how close the face is", () => {
    const near = computeGeometry(project({ scale: 0.3 }), 1);
    const far = computeGeometry(project({ scale: 0.06 }), 1);
    expect(near.mouthAspect).toBeCloseTo(far.mouthAspect!, 5);
    expect(near.eyeAspectLeft).toBeCloseTo(far.eyeAspectLeft!, 5);
    expect(near.interocular!).toBeGreaterThan(far.interocular!);
  });

  it("is INVARIANT to where in frame the face sits", () => {
    const a = computeGeometry(project({ cx: 0.2, cy: 0.3 }), 1);
    const b = computeGeometry(project({ cx: 0.8, cy: 0.7 }), 1);
    expect(a.mouthWidth).toBeCloseTo(b.mouthWidth!, 6);
  });

  it("is INVARIANT to head roll — the ratio must not track the tilt", () => {
    const level = computeGeometry(project(), 1);
    for (const roll of [0.3, -0.5, 1.0]) {
      const tilted = computeGeometry(project({ roll }), 1);
      expect(tilted.mouthAspect).toBeCloseTo(level.mouthAspect!, 4);
      expect(tilted.mouthWidth).toBeCloseTo(level.mouthWidth!, 4);
      expect(tilted.eyeAspectRight).toBeCloseTo(level.eyeAspectRight!, 4);
      expect(tilted.cornerAsymmetry!).toBeCloseTo(level.cornerAsymmetry!, 4);
    }
  });

  it("is INVARIANT to frame aspect once corrected", () => {
    const square = computeGeometry(project({ aspect: 1 }), 1);
    const wide = computeGeometry(project({ aspect: 16 / 9 }), 16 / 9);
    expect(wide.mouthWidth).toBeCloseTo(square.mouthWidth!, 5);
    expect(wide.eyeAspectLeft).toBeCloseTo(square.eyeAspectLeft!, 5);
  });

  it("is WRONG when the aspect correction is skipped — proving the term does work", () => {
    const correct = computeGeometry(project({ aspect: 16 / 9 }), 16 / 9);
    const skipped = computeGeometry(project({ aspect: 16 / 9 }), 1);
    // Pick a ratio of a VERTICAL to a HORIZONTAL distance. `mouthWidth` cannot
    // show this: it divides one horizontal distance by another, so anisotropy
    // cancels and it looks correct even when the term is missing.
    expect(skipped.mouthAspect).not.toBeCloseTo(correct.mouthAspect!, 2);
    expect(skipped.mouthAspect!).toBeCloseTo(correct.mouthAspect! * (16 / 9), 3);
    expect(skipped.mouthWidth).toBeCloseTo(correct.mouthWidth!, 6);
  });

  it("reads a raised lip corner as positive elevation", () => {
    const smile = computeGeometry(project({
      overrides: {
        mouthCornerRight: { x: -0.45, y: 0.95 },
        mouthCornerLeft: { x: 0.45, y: 0.95 },
      },
    }), 1);
    expect(smile.lipCornerElevLeft!).toBeGreaterThan(0.1);
    expect(smile.lipCornerElevRight!).toBeGreaterThan(0.1);
    expect(smile.cornerAsymmetry!).toBeCloseTo(0, 3);
  });

  it("reports a UNILATERAL pull as signed asymmetry, not as an average", () => {
    const g = computeGeometry(project({
      overrides: { mouthCornerLeft: { x: 0.45, y: 0.9 } },
    }), 1);
    expect(g.cornerAsymmetry!).toBeGreaterThan(0.1);
  });

  it("keeps the asymmetry sign stable through a head roll", () => {
    const level = computeGeometry(project({
      overrides: { mouthCornerLeft: { x: 0.45, y: 0.9 } },
    }), 1);
    const tilted = computeGeometry(project({
      roll: 0.6, overrides: { mouthCornerLeft: { x: 0.45, y: 0.9 } },
    }), 1);
    expect(Math.sign(tilted.cornerAsymmetry!)).toBe(Math.sign(level.cornerAsymmetry!));
    expect(tilted.cornerAsymmetry!).toBeCloseTo(level.cornerAsymmetry!, 3);
  });
});

describe("computeQuality — unreadable is not neutral (D4)", () => {
  const good = { boundingBox: { x: 0.3, y: 0.2, width: 0.3, height: 0.4 }, headPose: { yaw: 0, pitch: 0, roll: 0 }, present: true };

  it("scores a big frontal still face at full marks", () => {
    const q = computeQuality({ ...good, jitter: 0 });
    expect(q.score).toBeCloseTo(1, 5);
    expect(q.reasons).toEqual([]);
  });

  it("is zero with no face, and says so", () => {
    const q = computeQuality({ present: false });
    expect(q.score).toBe(0);
    expect(q.reasons).toContain("no face detected");
  });

  it("falls below the read floor when the face is turned far away", () => {
    const q = computeQuality({ ...good, headPose: { yaw: QUALITY_MAX_POSE, pitch: 0, roll: 0 } });
    expect(q.score).toBe(0);
    expect(q.score).toBeLessThan(QUALITY_MIN_READ);
    expect(q.reasons).toContain("face turned away");
  });

  it("MULTIPLIES penalties — two half-problems are not half a problem", () => {
    const small = computeQuality({ ...good, boundingBox: { x: 0, y: 0, width: 0.1, height: 0.1 } });
    const turned = computeQuality({ ...good, headPose: { yaw: 0.33, pitch: 0, roll: 0 } });
    const both = computeQuality({
      ...good,
      boundingBox: { x: 0, y: 0, width: 0.1, height: 0.1 },
      headPose: { yaw: 0.33, pitch: 0, roll: 0 },
    });
    expect(both.score).toBeLessThan(Math.min(small.score, turned.score) + 1e-9);
    expect(both.score).toBeLessThan((small.score + turned.score) / 2);
  });

  it("does NOT penalise an unknown jitter — a missing measurement is not a fault", () => {
    expect(computeQuality({ ...good, jitter: undefined }).score).toBeCloseTo(1, 5);
  });

  it("penalises real motion blur", () => {
    const q = computeQuality({ ...good, jitter: 0.2 });
    expect(q.score).toBe(0);
    expect(q.reasons).toContain("motion blur");
  });
});

describe("landmarkJitter", () => {
  it("is zero for an unmoved face", () => {
    const lm = project();
    const g = computeGeometry(lm, 1);
    expect(landmarkJitter(lm, lm, 1, g.interocular)).toBeCloseTo(0, 9);
  });

  it("is undefined — NOT zero — without a previous frame", () => {
    const lm = project();
    expect(landmarkJitter(null, lm, 1, 0.12)).toBeUndefined();
  });

  it("is scale-free: the same movement relative to the face reads the same", () => {
    const a1 = project({ scale: 0.3 }), a2 = project({ scale: 0.3, cx: 0.53 });
    const b1 = project({ scale: 0.1 }), b2 = project({ scale: 0.1, cx: 0.51 });
    const ja = landmarkJitter(a1, a2, 1, computeGeometry(a1, 1).interocular)!;
    const jb = landmarkJitter(b1, b2, 1, computeGeometry(b1, 1).interocular)!;
    expect(ja).toBeCloseTo(jb, 6);
  });
});
