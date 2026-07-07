/**
 * Body-pose geometry — posture classification + the conservative fall hint.
 * Coarse by design and HIGH-STAKES (this population has atypical postures), so
 * we pin the thresholds and especially that fall detection does NOT fire on
 * benign transitions. Landmarks are hand-built (normalized, y down).
 */

import { describe, it, expect } from "@jest/globals";
import {
  classifyPosture, poseBoundingBox, armsRaised, handToHead, detectFall,
  poseHeadNearFace, POSE_IDX, type PoseLandmark,
} from "../../shared/aac/pose-classify.js";

/** Build a 33-slot landmark array with the indices we set, rest off-screen. */
function pose(set: Partial<Record<number, PoseLandmark>>): PoseLandmark[] {
  const lm: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [i, p] of Object.entries(set)) lm[+i] = p;
  return lm;
}
const v = (x: number, y: number): PoseLandmark => ({ x, y, visibility: 0.9 });

// Upright torso: shoulders above hips, level.
const upright = () => pose({
  [POSE_IDX.leftShoulder]: v(0.45, 0.30), [POSE_IDX.rightShoulder]: v(0.55, 0.30),
  [POSE_IDX.leftHip]: v(0.46, 0.60), [POSE_IDX.rightHip]: v(0.54, 0.60),
  [POSE_IDX.nose]: v(0.5, 0.15),
});
// Lying: shoulders and hips at similar height, spread horizontally.
const lying = () => pose({
  [POSE_IDX.leftShoulder]: v(0.30, 0.50), [POSE_IDX.rightShoulder]: v(0.30, 0.40),
  [POSE_IDX.leftHip]: v(0.70, 0.52), [POSE_IDX.rightHip]: v(0.70, 0.42),
});

describe("classifyPosture", () => {
  it("reads an upright torso as upright", () => {
    expect(classifyPosture(upright())).toBe("upright");
  });

  it("reads a horizontal torso as lying", () => {
    expect(classifyPosture(lying())).toBe("lying");
  });

  it("reads a tilted torso as leaning", () => {
    const leaning = pose({
      [POSE_IDX.leftShoulder]: v(0.55, 0.30), [POSE_IDX.rightShoulder]: v(0.62, 0.30),
      [POSE_IDX.leftHip]: v(0.42, 0.60), [POSE_IDX.rightHip]: v(0.49, 0.60),
    });
    expect(classifyPosture(leaning)).toMatch(/leaning/);
  });

  it("returns unknown when the torso isn't clearly visible", () => {
    expect(classifyPosture(pose({}))).toBe("unknown");
  });
});

describe("armsRaised / handToHead", () => {
  it("detects a wrist above the shoulder line", () => {
    const lm = upright();
    lm[POSE_IDX.leftWrist] = v(0.45, 0.10); // above shoulders (y=0.30)
    expect(armsRaised(lm)).toBe(true);
  });
  it("detects a wrist near the head", () => {
    const lm = upright();
    lm[POSE_IDX.rightWrist] = v(0.5, 0.16); // ~at the nose (0.5,0.15)
    expect(handToHead(lm)).toBe(true);
  });
  it("is false with hands down and away", () => {
    const lm = upright();
    lm[POSE_IDX.leftWrist] = v(0.4, 0.75);
    lm[POSE_IDX.rightWrist] = v(0.6, 0.75);
    expect(armsRaised(lm)).toBe(false);
    expect(handToHead(lm)).toBe(false);
  });
});

describe("detectFall — conservative", () => {
  it("fires on a fast big drop into lying", () => {
    expect(detectFall({ prevPosture: "upright", currPosture: "lying", centroidYDelta: 0.25, dtMs: 800 })).toBe(true);
  });
  it("does NOT fire on a slow lie-down (small drop)", () => {
    expect(detectFall({ prevPosture: "upright", currPosture: "lying", centroidYDelta: 0.05, dtMs: 800 })).toBe(false);
  });
  it("does NOT fire when already lying", () => {
    expect(detectFall({ prevPosture: "lying", currPosture: "lying", centroidYDelta: 0.3, dtMs: 800 })).toBe(false);
  });
  it("does NOT fire when the end posture isn't lying (just leaned)", () => {
    expect(detectFall({ prevPosture: "upright", currPosture: "leaning-left", centroidYDelta: 0.3, dtMs: 800 })).toBe(false);
  });
  it("does NOT fire if the drop took too long (outside the window)", () => {
    expect(detectFall({ prevPosture: "upright", currPosture: "lying", centroidYDelta: 0.3, dtMs: 5000 })).toBe(false);
  });
});

describe("poseHeadNearFace — link body to the mirrored face", () => {
  // Face box centred on the upright pose's nose (0.5, 0.15), ~0.12 tall.
  const faceOnPose = { x: 0.44, y: 0.09, w: 0.12, h: 0.12 };

  it("links when the pose head sits on the face", () => {
    expect(poseHeadNearFace(upright(), faceOnPose)).toBe(true);
  });

  it("does NOT link a body whose head is far from the face (other person)", () => {
    // Same pose, but a face detected over on the far side of the frame.
    const farFace = { x: 0.02, y: 0.09, w: 0.12, h: 0.12 };
    expect(poseHeadNearFace(upright(), farFace)).toBe(false);
  });

  it("returns false with no face to link to", () => {
    expect(poseHeadNearFace(upright(), null)).toBe(false);
  });

  it("falls back to the shoulder midpoint when the head isn't visible", () => {
    // Head landmarks off (visibility 0); shoulders at y=0.30, so the estimated
    // head sits just above them — a face there still links.
    const noHead = pose({
      [POSE_IDX.leftShoulder]: v(0.45, 0.30), [POSE_IDX.rightShoulder]: v(0.55, 0.30),
    });
    expect(poseHeadNearFace(noHead, { x: 0.44, y: 0.18, w: 0.12, h: 0.12 })).toBe(true);
  });

  it("returns false when neither head nor shoulders are visible", () => {
    expect(poseHeadNearFace(pose({}), { x: 0.44, y: 0.09, w: 0.12, h: 0.12 })).toBe(false);
  });
});

describe("poseBoundingBox", () => {
  it("spans the visible landmarks", () => {
    const bb = poseBoundingBox(upright())!;
    expect(bb.x).toBeGreaterThanOrEqual(0);
    expect(bb.w).toBeGreaterThan(0);
    expect(bb.h).toBeGreaterThan(0);
  });
  it("is null with too few visible points", () => {
    expect(poseBoundingBox(pose({ [POSE_IDX.nose]: v(0.5, 0.1) }))).toBeNull();
  });
});
